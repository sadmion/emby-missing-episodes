#!/usr/bin/env node
/**
 * Emby 缺集检测 - 本地代理服务器
 *
 * 作用：绕开浏览器 CORS 限制。
 *   浏览器  -->  本代理  -->  Emby / TMDB
 *
 * 本机用法：
 *   1. 安装 Node.js (>= 18)
 *   2. 在本目录执行：  node emby-proxy.js
 *   3. 浏览器打开：    http://127.0.0.1:8787
 *   4. 页面里照常填 Emby 地址 / API Key / TMDB Key，点开始检测
 *
 * Docker 用法：见 Dockerfile / docker-compose.yml
 *
 * 可选环境变量：
 *   HOST=127.0.0.1            监听地址（Docker 里须设 0.0.0.0）
 *   PORT=8787                 监听端口
 *   TMDB_HOST=api.tmdb.org    TMDB 域名
 *   TMDB_IMAGE_HOST=image.tmdb.org
 *                             TMDB 海报图床域名
 *   TMDB_TIMEOUT=12000        TMDB 请求超时（毫秒）
 *   EMBY_URL=http://...:8096  预设 Emby 地址（页面留空即用这个）
 *   EMBY_KEY=xxx              预设 Emby API Key
 *   TMDB_KEY=xxx              预设 TMDB API Key
 *   DATA_DIR=./data           扫描结果存放目录（服务器端持久化）
 *
 * 扫描结果持久化：
 *   扫描完成后页面会自动把结果 POST 到本服务，存到 DATA_DIR 目录下的
 *   emby-missing-result.json。下次打开页面（经本代理）会自动加载这份结果，
 *   不再依赖浏览器下载 / localStorage。
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = parseInt(process.env.PORT || '8787', 10);
// 监听地址。本机直跑默认只监听 127.0.0.1（更安全）。
// Docker 里必须设 HOST=0.0.0.0，否则容器外访问不到。
const HOST = process.env.HOST || '127.0.0.1';
const HTML_FILE = path.join(__dirname, 'emby-missing-episodes.html');

// TMDB 域名。api.themoviedb.org 在国内常被解析到 Meta 的 IP 段而无法访问，
// api.tmdb.org 走 AWS CloudFront，国内通常可直连。
// 可用 TMDB_HOST 环境变量覆盖。
const TMDB_HOST = process.env.TMDB_HOST || 'api.tmdb.org';
const TMDB_TIMEOUT_MS = parseInt(process.env.TMDB_TIMEOUT || '12000', 10);
// 海报图床域名（与 api 域名不同，可用 TMDB_IMAGE_HOST 覆盖）
const TMDB_IMAGE_HOST = process.env.TMDB_IMAGE_HOST || 'image.tmdb.org';

// 扫描结果存放目录（服务器端持久化）。默认 ./data
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
// 固定文件名，一个实例只保留最新一份扫描结果
const DATA_FILE = path.join(DATA_DIR, 'emby-missing-result.json');
// 单次上传上限，避免被塞爆（扫描结果一般几百 KB）
const MAX_BODY = 8 * 1024 * 1024;

// 确保目录存在（首次启动自动创建）
function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    return true;
  } catch (e) {
    log('ERR', '无法创建数据目录 ' + DATA_DIR + '：' + e.message);
    return false;
  }
}

// 读取同目录下的 config.json（预设 Emby 地址 / Key / 默认库）
// 不存在或格式错误时返回空对象，不影响启动。
let _cfgCache = null;
function readConfigFile() {
  if (_cfgCache) return _cfgCache;
  const p = path.join(__dirname, 'config.json');
  try {
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      _cfgCache = (j && typeof j === 'object') ? j : {};
    } else {
      _cfgCache = {};
    }
  } catch (e) {
    log('WARN', 'config.json 解析失败，忽略：' + e.message);
    _cfgCache = {};
  }
  return _cfgCache;
}

// 读取 URL 查询参数
function qs(reqUrl, name) {
  return reqUrl.searchParams.get(name) || '';
}

// 读取请求体（带大小限制），resolve 字符串
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大（上限 ' + Math.round(MAX_BODY / 1024 / 1024) + 'MB）'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------- 小工具 ----------
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function log(...a) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log('[' + t + ']', ...a);
}

/**
 * 通用转发：流式透传上游响应，不改动内容。
 * timeoutMs: 上游超时，默认 30s。
 * opts.isImage: 图片请求，放行缓存、放宽 Accept。
 */
function proxy(targetUrl, req, res, timeoutMs, opts) {
  timeoutMs = timeoutMs || 30000;
  opts = opts || {};
  let u;
  try {
    u = new URL(targetUrl);
  } catch (e) {
    return sendJSON(res, 400, { error: '非法目标地址: ' + targetUrl });
  }

  const mod = u.protocol === 'https:' ? https : http;
  const options = {
    method: 'GET',
    headers: {
      // 转发 UA，部分 Emby 反代会拦空 UA
      'User-Agent': req.headers['user-agent'] || 'emby-missing-episodes/1.0',
      Accept: opts.isImage ? '*/*' : 'application/json',
    },
  };

  const started = Date.now();
  const up = mod.request(u, options, (upRes) => {
    const code = upRes.statusCode || 502;
    const hdr = {
      'Content-Type': upRes.headers['content-type'] || (opts.isImage ? 'image/jpeg' : 'application/json; charset=utf-8'),
      'Access-Control-Allow-Origin': '*',
    };
    if (opts.isImage) {
      // 图片允许浏览器缓存，避免列表重绘时反复请求
      hdr['Cache-Control'] = 'public, max-age=86400';
    } else {
      hdr['Cache-Control'] = 'no-store';
    }
    res.writeHead(code, hdr);
    upRes.pipe(res);
    // 图片请求不刷日志，避免刷屏
    if (!opts.isImage) log(code, (Date.now() - started) + 'ms', u.host + u.pathname);
  });

  up.on('error', (err) => {
    log('ERR', u.host, err.code || err.message);
    if (!res.headersSent) {
      if (opts.isImage) {
        // 图片失败返回 404，前端会回退到占位图标，不弹错误
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('image unavailable');
      }
      sendJSON(res, 502, {
        error: '无法连接上游: ' + u.host,
        code: err.code || '',
        message: err.message,
        hint: '请检查地址是否正确、Emby 是否在运行、网络是否可达。',
      });
    } else {
      res.end();
    }
  });

  up.setTimeout(timeoutMs, () => {
    up.destroy(new Error('上游响应超时 (' + Math.round(timeoutMs / 1000) + 's)'));
  });

  up.end();
}

// ---------- 路由 ----------
const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, 'http://127.0.0.1');

  // 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    return res.end();
  }

  // 注入预设配置（页面启动时读取）
  // 优先级：环境变量 > config.json > 内置默认
  if (reqUrl.pathname === '/__config') {
    const f = readConfigFile();
    return sendJSON(res, 200, {
      embyUrl: process.env.EMBY_URL || f.embyUrl || '',
      embyKey: process.env.EMBY_KEY || f.embyKey || '',
      tmdbKey: process.env.TMDB_KEY || f.tmdbKey || '',
      libSelect: f.libSelect || '',
    });
  }

  // 健康检查
  if (reqUrl.pathname === '/__health') {
    return sendJSON(res, 200, { ok: true, port: PORT });
  }

  // ---------- 扫描结果服务端持久化 ----------
  // GET  /__result        读取上次保存的扫描结果（没有则返回 {exists:false}）
  // POST /__result        保存扫描结果到 DATA_DIR/emby-missing-result.json
  // DELETE /__result      清除已保存的结果
  // GET  /__result/status 只返回元信息（是否存在、保存时间、大小）
  if (reqUrl.pathname === '/__result') {
    if (req.method === 'POST') {
      return readBody(req)
        .then((raw) => {
          let obj;
          try {
            obj = JSON.parse(raw);
          } catch (e) {
            return sendJSON(res, 400, { ok: false, error: '请求体不是合法 JSON' });
          }
          // 只接受本工具的结果结构，避免误存任意内容
          if (!obj || typeof obj !== 'object' || !Array.isArray(obj.rows)) {
            return sendJSON(res, 400, { ok: false, error: '数据结构不合法（缺少 rows 数组）' });
          }
          obj.savedAt = obj.savedAt || Date.now();
          obj.kind = obj.kind || 'emby-missing-episodes';
          const tmp = DATA_FILE + '.tmp';
          try {
            fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
            fs.renameSync(tmp, DATA_FILE);   // 原子替换，避免写一半崩溃留残档
          } catch (e) {
            log('ERR', '保存结果失败：' + e.message);
            return sendJSON(res, 500, { ok: false, error: '写入失败: ' + e.message });
          }
          log('SAVE', obj.rows.length + ' 条 -> ' + DATA_FILE);
          return sendJSON(res, 200, {
            ok: true,
            savedAt: obj.savedAt,
            rows: obj.rows.length,
            file: DATA_FILE,
          });
        })
        .catch((e) => {
          if (!res.headersSent) sendJSON(res, 400, { ok: false, error: e.message });
        });
    }

    if (req.method === 'DELETE') {
      try {
        if (fs.existsSync(DATA_FILE)) fs.unlinkSync(DATA_FILE);
        log('CLEAR', DATA_FILE);
        return sendJSON(res, 200, { ok: true, cleared: true });
      } catch (e) {
        return sendJSON(res, 500, { ok: false, error: e.message });
      }
    }

    // 默认 GET：返回状态或完整数据（?meta=1 只返回状态）
    const metaOnly = qs(reqUrl, 'meta') === '1';
    if (!fs.existsSync(DATA_FILE)) {
      return sendJSON(res, 200, metaOnly ? { exists: false } : { exists: false, rows: [] });
    }
    try {
      const stat = fs.statSync(DATA_FILE);
      if (metaOnly) {
        let savedAt = null;
        try {
          savedAt = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')).savedAt || null;
        } catch (_) {}
        return sendJSON(res, 200, {
          exists: true,
          savedAt,
          size: stat.size,
          mtime: stat.mtimeMs,
          file: DATA_FILE,
        });
      }
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      return sendJSON(res, 200, data);
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: '读取失败: ' + e.message });
    }
  }

  // Emby 转发：  /__proxy/emby?base=<url编码的Emby地址>&path=<Emby路径>
  if (reqUrl.pathname === '/__proxy/emby') {
    const base = reqUrl.searchParams.get('base');
    const p = reqUrl.searchParams.get('path') || '';
    const key = reqUrl.searchParams.get('api_key') || '';
    if (!base) return sendJSON(res, 400, { error: '缺少 base 参数 (Emby 地址)' });

    let target;
    try {
      target = base.replace(/\/+$/, '') + p;
    } catch (e) {
      return sendJSON(res, 400, { error: '拼接地址失败' });
    }
    // 把 api_key 带上（若无则不加）
    if (key) {
      target += (target.indexOf('?') >= 0 ? '&' : '?') + 'api_key=' + encodeURIComponent(key);
    }
    return proxy(target, req, res);
  }

  // TMDB 海报转发：/__proxy/poster?path=<posterPath>&size=w185
  // posterPath 形如 /abc123.jpg，只允许安全字符，避免变成任意 URL 转发器。
  if (reqUrl.pathname === '/__proxy/poster') {
    const p = reqUrl.searchParams.get('path') || '';
    const size = reqUrl.searchParams.get('size') || 'w185';
    // TMDB 海报路径：以 / 开头，.jpg/.png 结尾，中间是字母数字
    if (!/^\/[A-Za-z0-9]{1,64}\.(jpg|jpeg|png|webp)$/i.test(p)) {
      return sendJSON(res, 400, { error: '非法的海报路径' });
    }
    // 尺寸白名单，避免被用来拉超大图
    const ALLOWED = ['w92', 'w154', 'w185', 'w300', 'w342', 'w500', 'original'];
    if (ALLOWED.indexOf(size) < 0) {
      return sendJSON(res, 400, { error: '不允许的尺寸: ' + size });
    }
    const target = 'https://' + TMDB_IMAGE_HOST + '/t/p/' + size + p;
    return proxy(target, req, res, 15000, { isImage: true });
  }

  // TMDB 转发：  /__proxy/tmdb?api_key=xxx&path=/tv/123  (其余查询参数原样透传)
  if (reqUrl.pathname === '/__proxy/tmdb') {
    const apiKey = reqUrl.searchParams.get('api_key');
    const tmdbPath = reqUrl.searchParams.get('path') || '';
    if (!apiKey) return sendJSON(res, 400, { error: '缺少 api_key 参数 (TMDB Key)' });
    if (!/^\/[A-Za-z0-9_\-./]*$/.test(tmdbPath)) {
      return sendJSON(res, 400, { error: '非法的 TMDB path' });
    }

    // 组装上游查询串：api_key + path 之外的其余参数
    const upstream = new URL('https://' + TMDB_HOST + '/3' + tmdbPath);
    upstream.searchParams.set('api_key', apiKey);
    reqUrl.searchParams.forEach((v, k) => {
      if (k !== 'api_key' && k !== 'path') upstream.searchParams.set(k, v);
    });
    return proxy(upstream.toString(), req, res, TMDB_TIMEOUT_MS);
  }

  // 静态：工具页面
  if (reqUrl.pathname === '/' || reqUrl.pathname === '/index.html') {
    if (!fs.existsSync(HTML_FILE)) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('找不到 ' + HTML_FILE + '\n请确认 emby-missing-episodes.html 与本脚本在同一目录。');
    }
    const html = fs.readFileSync(HTML_FILE);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': html.length,
      'Cache-Control': 'no-store',
    });
    return res.end(html);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404');
});

server.listen(PORT, HOST, () => {
  const dirOk = ensureDataDir();
  console.log('');
  console.log('  Emby 缺集检测工具已启动');
  console.log('  -----------------------------------------');
  console.log('  监听:  ' + HOST + ':' + PORT);
  if (HOST === '127.0.0.1') {
    console.log('  打开:  http://127.0.0.1:' + PORT);
    console.log('  按 Ctrl+C 停止');
  } else {
    console.log('  打开:  http://<本机IP>:' + PORT + '  或  http://localhost:' + PORT);
    console.log('  （Docker 模式，容器内监听 0.0.0.0）');
  }
  console.log('');
  console.log('  已内置本地代理，无需再配置 Emby CORS。');
  console.log('  扫描结果自动保存在: ' + DATA_FILE + (dirOk ? '' : '  (目录创建失败!)'));
  if (fs.existsSync(DATA_FILE)) {
    try {
      const st = fs.statSync(DATA_FILE);
      const dt = new Date(st.mtimeMs).toLocaleString();
      console.log('  检测到已保存的结果（' + dt + '，' + Math.round(st.size / 1024) + ' KB），下次打开页面自动加载');
    } catch (_) {}
  } else {
    console.log('  （暂无已保存结果，首次扫描完成后自动写入）');
  }
  if (process.env.EMBY_URL) console.log('  预设 Emby: ' + process.env.EMBY_URL);
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('\n端口 ' + PORT + ' 已被占用。换一个端口：');
    console.error('   set PORT=8788 && node emby-proxy.js     (Windows CMD)');
    console.error('   $env:PORT=8788; node emby-proxy.js      (PowerShell)\n');
  } else {
    console.error('启动失败:', err.message);
  }
  process.exit(1);
});
