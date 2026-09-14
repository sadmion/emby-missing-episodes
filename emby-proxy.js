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
const crypto = require('crypto');
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

// PanSou 盘搜服务地址（网盘资源搜索）。可用 PANSOU_URL 环境变量
// 或 config.json 里的 pansouUrl 覆盖。
const PANSOU_DEFAULT_URL = 'http://47.101.197.200:8788';
// 盘搜搜索通常要聚合多个上游，耗时比 TMDB 长，给宽一点
const PANSOU_TIMEOUT_MS = parseInt(process.env.PANSOU_TIMEOUT || '30000', 10);

// 观影 = 教父.com（xn--wcv59z.com）。直连该站，PoW 与登录都在本代理内完成。
// 站点地址可用 GYING_SITE（环境变量）或 config.json 的 gyingUrl 覆盖。
// 详细的门禁机制见下方「观影（教父.com）直连登录」段落注释。

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

// 判断页面传入的盘搜上游地址是否安全：
// 只允许 http/https，且禁止回环 / 内网 / 链路本地地址（防 SSRF）。
function isAllowedUpstream(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch (e) {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (!host) return false;
  // 回环 / 本机
  if (host === 'localhost' || host === '::1' || /^127\./.test(host)) return false;
  // 私有网段 IPv4
  if (/^10\./.test(host)) return false;
  if (/^192\.168\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false;   // 链路本地
  // 0.0.0.0 / 元数据地址
  if (host === '0.0.0.0' || host === 'metadata.google.internal') return false;
  return true;
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

// ==================== 观影（教父.com）直连登录 ====================
// 直接对 xn--wcv59z.com 操作，两道门都在本代理内解决：
//   ① PoW 工作量验证：GET /res/pow → {N,x,t}
//      解 y = x^(2^t) mod N，POST /res/pow body y=<hex>（必须带 XHR 头）
//      成功后拿到 browser_verified cookie
//   ② 登录：POST /user/login
//      body 固定结构（少字段会被当成页面请求、返回 SPA 外壳）：
//      code=&siteid=1&dosubmit=1&cookietime=10506240&username=..&password=..
//      返回 {code:200} 成功；403 账号/密码错；419 验证过期；captcha 字段表示要人机验证
// 会话保存在进程内存（不落盘）。

// 站点默认地址（可用 GYING_SITE 环境变量或 config.json 的 gyingUrl 覆盖）
const GYING_SITE_DEFAULT = 'https://www.xn--wcv59z.com';
const GYING_TIMEOUT_MS = parseInt(process.env.GYING_TIMEOUT || '30000', 10);
// PoW 难度保护：t 异常大时不至于把 CPU 挂死
const GYING_POW_MAX_T = 5000000;
// browser_verified 实测有效期 24h；这里保守缓存 20 分钟，过期自动重解
const GYING_VERIFY_TTL_MS = 20 * 60 * 1000;

// 观影会话（内存 + 落盘持久化，重启后可恢复登录态）
const gySession = {
  cookie: '',
  user: null,
  loginAt: 0,
  verifiedAt: 0,   // PoW 通过时间
};
// 会话持久化文件（存放 cookie 与账号密码，用于自动保活）
const GY_SESSION_FILE = path.join(DATA_DIR, 'gying-session.json');
// 落盘用的凭据（cookie 会过期，账号密码用于自动重登）
const gySaved = { cookie: '', user: '', password: '', loginAt: 0 };

// 读取持久化会话
function gyLoadSession() {
  try {
    if (!fs.existsSync(GY_SESSION_FILE)) return;
    const j = JSON.parse(fs.readFileSync(GY_SESSION_FILE, 'utf8'));
    if (j && typeof j === 'object') {
      gySaved.cookie = j.cookie || '';
      gySaved.user = j.user || '';
      gySaved.password = j.password || '';
      gySaved.loginAt = j.loginAt || 0;
      // 方案 B：把上次的 cookie 直接灌进内存会话。
      // 这样重启后如果 cookie 还有效，**连重新登录都省了**；
      // 若已失效，搜索时发现 419/未登录会自动用保存的账号重登一次。
      if (gySaved.cookie && gySaved.user) {
        gySession.cookie = gySaved.cookie;
        gySession.user = gySaved.user;
        gySession.loginAt = gySaved.loginAt;
        // PoW 状态不落盘（验证态很短命），这里不设 verifiedAt，
        // 交给 gyEnsureVerified 按需重解。
      }
      log('GY', '已恢复观影登录态（用户 ' + (j.user || '?') +
          (gySaved.cookie ? '，含 cookie' : '，无 cookie') + '）');
    }
  } catch (e) {
    log('GY', '读取观影会话失败: ' + e.message);
  }
}
// 写入持久化会话
function gySaveSession() {
  try {
    ensureDataDir();
    fs.writeFileSync(GY_SESSION_FILE, JSON.stringify({
      cookie: gySession.cookie,
      user: gySession.user || '',
      password: gySaved.password || '',
      loginAt: gySession.loginAt || 0,
      savedAt: Date.now(),
    }, null, 2), 'utf8');
  } catch (e) {
    log('GY', '保存观影会话失败: ' + e.message);
  }
}
// 清空持久化会话
function gyClearSession() {
  try { if (fs.existsSync(GY_SESSION_FILE)) fs.unlinkSync(GY_SESSION_FILE); } catch (e) {}
}

// 生效的站点地址：环境变量 > config.json > 内置默认
function gySiteBase() {
  const f = readConfigFile();
  return (process.env.GYING_SITE || f.gyingUrl || GYING_SITE_DEFAULT).replace(/\/+$/, '');
}

// 极简 cookie 串提取 / 合并（正确处理 deleted 标记）
function gyCookiesOf(headers) {
  const sc = headers['set-cookie'] || [];
  return sc.map((c) => String(c).split(';')[0]).join('; ');
}
function gyMergeCookie(oldCookie, headers) {
  const jar = {};
  String(oldCookie || '').split(';').forEach((kv) => {
    const s = kv.trim(); const i = s.indexOf('=');
    if (i > 0) jar[s.slice(0, i)] = s.slice(i + 1);
  });
  gyCookiesOf(headers).split(';').forEach((kv) => {
    const s = kv.trim(); const i = s.indexOf('=');
    if (i <= 0) return;
    const k = s.slice(0, i), v = s.slice(i + 1);
    if (v === 'deleted') delete jar[k]; else jar[k] = v;
  });
  return Object.keys(jar).map((k) => k + '=' + jar[k]).join('; ');
}

// 发一次请求。opts: {method, cookie, body, ctype, accept, referer, xhr, timeout}
function gyRequest(url, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('地址不合法: ' + url)); }
    const mod = u.protocol === 'https:' ? https : http;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': opts.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Referer': opts.referer || (u.origin + '/'),
    };
    if (opts.cookie) headers.Cookie = opts.cookie;
    // PoW 提交等接口要求 AJAX 语义，否则服务端判为无效请求
    if (opts.xhr) {
      headers['X-Requested-With'] = 'XMLHttpRequest';
      headers['Origin'] = u.origin;
      headers['Sec-Fetch-Site'] = 'same-origin';
      headers['Sec-Fetch-Mode'] = 'cors';
      headers['Sec-Fetch-Dest'] = 'empty';
    }
    if (opts.body) {
      headers['Content-Type'] = opts.ctype || (opts.xhr
        ? 'application/x-www-form-urlencoded; charset=UTF-8'
        : 'application/x-www-form-urlencoded');
      headers['Content-Length'] = Buffer.byteLength(opts.body);
    }
    const r = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: opts.method || 'GET',
      headers, timeout: opts.timeout || GYING_TIMEOUT_MS,
    }, (resp) => {
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => resolve({
        status: resp.statusCode,
        headers: resp.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    r.on('error', (e) => reject(new Error('请求失败: ' + e.message)));
    r.on('timeout', () => { r.destroy(); reject(new Error('请求超时（' + (opts.timeout || GYING_TIMEOUT_MS) + 'ms）')); });
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

// 解 PoW：y = x^(2^t) mod N（BigInt 循环平方）
function gySolvePow(Nhex, xhex, t) {
  let N = BigInt('0x' + String(Nhex).replace(/^0x/i, ''));
  let y = BigInt('0x' + String(xhex).replace(/^0x/i, ''));
  const n = t | 0;
  for (let i = 0; i < n; i++) y = (y * y) % N;
  return y.toString(16);
}

// 确保有过 PoW 的 cookie（20 分钟内复用）
async function gyEnsureVerified(base) {
  const now = Date.now();
  if (gySession.cookie && gySession.verifiedAt && (now - gySession.verifiedAt) < GYING_VERIFY_TTL_MS) {
    return gySession.cookie;
  }
  // 1) 先访问首页拿 browser_pow
  let r = await gyRequest(base + '/');
  gySession.cookie = gyMergeCookie(gySession.cookie, r.headers);

  // 2) 取挑战
  r = await gyRequest(base + '/res/pow', { cookie: gySession.cookie, accept: 'application/json' });
  gySession.cookie = gyMergeCookie(gySession.cookie, r.headers);
  let ch;
  try { ch = JSON.parse(r.body); } catch (e) {
    gySession.verifiedAt = now;
    return gySession.cookie;
  }
  if (!ch || !ch.N || !ch.x || !ch.t) {
    gySession.verifiedAt = now;
    return gySession.cookie;
  }
  if ((ch.t | 0) > GYING_POW_MAX_T) throw new Error('观影 PoW 难度异常（t=' + ch.t + '），已放弃');

  // 3) 求解并提交（必须带 XHR 头）
  const y = gySolvePow(ch.N, ch.x, ch.t);
  r = await gyRequest(base + '/res/pow', {
    method: 'POST', cookie: gySession.cookie,
    body: 'y=' + encodeURIComponent(y),
    accept: 'application/json',
    xhr: true, referer: base + '/',
  });
  gySession.cookie = gyMergeCookie(gySession.cookie, r.headers);
  let j = {};
  try { j = JSON.parse(r.body); } catch (e) {}
  if (!j.success) throw new Error('观影 PoW 提交失败: ' + (r.body || '').slice(0, 120));
  gySession.verifiedAt = Date.now();
  log('GY', 'PoW 通过（t=' + ch.t + '）');
  return gySession.cookie;
}

// 登录。成功后把 cookie 与账号密码落盘，便于重启后恢复与自动保活。
async function gyLogin(username, password, opts) {
  opts = opts || {};
  const base = gySiteBase();
  // 换账号时要先把旧 cookie 清掉，避免串会话
  if (opts.fresh) { gySession.cookie = ''; gySession.verifiedAt = 0; }
  await gyEnsureVerified(base);
  // 该站登录表单是固定结构，少字段会被当页面请求
  const body = 'code=' +
               '&siteid=1' +
               '&dosubmit=1' +
               '&cookietime=10506240' +
               '&username=' + encodeURIComponent(username) +
               '&password=' + encodeURIComponent(password);
  const r = await gyRequest(base + '/user/login', {
    method: 'POST', cookie: gySession.cookie, body: body,
    accept: 'application/json, text/javascript, */*; q=0.01',
    referer: base + '/user/login',
    xhr: true,
  });
  gySession.cookie = gyMergeCookie(gySession.cookie, r.headers);

  let j;
  try {
    j = JSON.parse(r.body);
  } catch (e) {
    const isChal = /浏览器安全验证|pow\.core/.test(r.body || '');
    log('GY', '登录响应非 JSON（status=' + r.status + ', ct=' +
        (r.headers['content-type'] || '?') + ', len=' + (r.body || '').length + '）');
    return {
      ok: false,
      error: isChal
        ? '站点要求浏览器验证（PoW 未生效），请稍后重试。'
        : '登录响应无法解析（HTTP ' + r.status + '）。可能站点改版，请检查。',
    };
  }
  if (j.code === 200) {
    gySession.user = username;
    gySession.loginAt = Date.now();
    gySaved.user = username;
    gySaved.password = password;   // 保存密码用于过期后自动重登
    gySaveSession();
    log('GY', '登录成功并已保存: ' + username);
    return { ok: true, loggedIn: true, username: username, saved: true };
  }
  if (j.code === 419) {
    // 验证态失效 → 清了重试一次（只重试一次，避免死循环）
    gySession.verifiedAt = 0;
    gySession.cookie = '';
    if (!opts.retried) {
      log('GY', '验证过期，自动重试一次');
      return gyLogin(username, password, { fresh: true, retried: true });
    }
    return { ok: false, error: '浏览器验证反复失效，请稍后再试。' };
  }
  if (j.captcha) {
    return {
      ok: false,
      needCaptcha: true,
      error: '站点要求人机验证码（点击图中指定文字），无法自动完成。' +
             '请稍后在浏览器打开该站点登录一次，或等待风控解除后重试。',
    };
  }
  // 账号或密码错：把已保存的失效凭据清掉，避免反复自动重登
  if (/密码|账号|不存在/.test(j.msg || j.message || '')) {
    gySaved.password = '';
    gySaveSession();
  }
  return { ok: false, error: j.msg || j.message || ('登录失败（code=' + j.code + '）') };
}

// 退出：清内存 + 清落盘
async function gyLogout() {
  gySession.cookie = '';
  gySession.user = null;
  gySession.loginAt = 0;
  gySession.verifiedAt = 0;
  gySaved.cookie = ''; gySaved.user = ''; gySaved.password = ''; gySaved.loginAt = 0;
  gyClearSession();
  log('GY', '已退出并清除保存的账号');
  return { ok: true, message: '已退出，并清除了保存的账号密码' };
}

// 查询状态（纯内存，不联网）
function gyStatus() {
  return {
    ok: true,
    loggedIn: !!gySession.user,
    username: gySession.user || '',
    loginAt: gySession.loginAt || 0,
    siteUrl: gySiteBase(),
    savedUser: gySaved.user || '',
    hasSavedPassword: !!gySaved.password,
  };
}

// 确保处于登录态：内存没有则尝试用保存的凭据自动重登。
// 供搜索前调用，避免用户重开工具后还得手动点一次登录。
async function gyEnsureLoggedIn() {
  if (gySession.user && gySession.cookie) {
    // 已有会话，但 cookie 可能已过期 —— 交给搜索去发现
    return true;
  }
  if (!gySaved.user || !gySaved.password) return false;
  log('GY', '尝试用已保存的账号自动登录: ' + gySaved.user);
  try {
    const r = await gyLogin(gySaved.user, gySaved.password);
    return !!r.ok;
  } catch (e) {
    log('GY', '自动登录失败: ' + e.message);
    return false;
  }
}

// 预热：让「打开页面」时就恢复登录态，而不是等用户第一次搜索。
//   ① 内存里已有会话（可能是 gyLoadSession 灌进来的旧 cookie）
//      → 解一次 PoW 探测是否仍然有效
//   ② 无效或没有会话 → 用保存的账号完整登录一次
// 返回 { loggedIn, username, restored } 供页面直接展示状态。
async function gyWarmup() {
  const base = gySiteBase();
  // 已有会话：探测 cookie 是否还活着
  if (gySession.user && gySession.cookie) {
    try {
      await gyEnsureVerified(base);
      const r = await gyRequest(base + '/res/search?q=' + encodeURIComponent('测试') + '&type=&p=1', {
        cookie: gySession.cookie,
        accept: 'application/json, text/javascript, */*; q=0.01',
        xhr: true,
      });
      gySession.cookie = gyMergeCookie(gySession.cookie, r.headers);
      let j = null;
      try { j = JSON.parse(r.body); } catch (e) {}
      // 419 = 验证过期（重解一次再看）；有 inlist/page 说明会话有效
      if (j && j.code === 419) {
        gySession.verifiedAt = 0;
        await gyEnsureVerified(base);
        const r2 = await gyRequest(base + '/res/search?q=' + encodeURIComponent('测试') + '&type=&p=1', {
          cookie: gySession.cookie,
          accept: 'application/json, text/javascript, */*; q=0.01',
          xhr: true,
        });
        gySession.cookie = gyMergeCookie(gySession.cookie, r2.headers);
        try { j = JSON.parse(r2.body); } catch (e) { j = null; }
      }
      if (j && (j.inlist || j.page || j.footer)) {
        log('GY', '预热：旧 cookie 仍有效，登录态已恢复（' + gySession.user + '）');
        gySaveSession();
        return { loggedIn: true, username: gySession.user, restored: true };
      }
      log('GY', '预热：旧 cookie 已失效，转为完整登录');
      gySession.cookie = '';
      gySession.user = null;
      gySession.verifiedAt = 0;
    } catch (e) {
      log('GY', '预热探测失败（' + e.message + '），转为完整登录');
      gySession.cookie = '';
      gySession.user = null;
      gySession.verifiedAt = 0;
    }
  }
  // 走到这里说明需要重新登录
  if (!gySaved.user || !gySaved.password) {
    return { loggedIn: false, username: '' };
  }
  log('GY', '预热：用已保存的账号自动登录 ' + gySaved.user);
  try {
    const r = await gyLogin(gySaved.user, gySaved.password, { fresh: true });
    if (r.ok) return { loggedIn: true, username: gySession.user || gySaved.user, restored: false };
    return { loggedIn: false, username: '', error: r.error || r.needCaptcha ? '需要重新登录' : '' };
  } catch (e) {
    log('GY', '预热登录失败: ' + e.message);
    return { loggedIn: false, username: '', error: e.message };
  }
}

// 搜索：两步走。
//   ① /res/search?q=xxx         → 拿到作品 id（inlist.i[0]）与类型（inlist.d[0]）
//   ② /res/downurl/{dir}/{id}   → 拿资源列表（含磁力哈希与文件大小）
// 站点要求每次调用前 PoW 验证态是新鲜的，所以两步之间要保证 verified。
// 返回结构化结果，页面直接渲染，无需解析 HTML。
async function gySearch(kw) {
  const base = gySiteBase();
  await gyEnsureLoggedIn();
  if (!gySession.user) throw new Error('尚未登录观影，请先在上方登录');

  const XHRH = {
    accept: 'application/json, text/javascript, */*; q=0.01',
    xhr: true,
    referer: base + '/search?q=' + encodeURIComponent(kw),
  };

  // ---- ① 搜索作品 ----
  const doSearch = async () => {
    await gyEnsureVerified(base);
    const r = await gyRequest(base + '/res/search?q=' + encodeURIComponent(kw), Object.assign({ cookie: gySession.cookie }, XHRH));
    gySession.cookie = gyMergeCookie(gySession.cookie, r.headers);
    return r;
  };
  let r = await doSearch();
  let j = safeJson(r.body);
  // 419 / 验证过期 → 重新过 PoW 再试一次
  if (!j || j.code === 419) {
    gySession.verifiedAt = 0;
    r = await doSearch();
    j = safeJson(r.body);
  }
  if (!j) throw new Error('观影搜索返回无法解析：' + String(r.body || '').slice(0, 120));
  if (j.code === 419) throw new Error('观影站点验证反复失效，请稍后重试');
  if (/请先登录|nologin/i.test(j.msg || '')) {
    gySession.user = null; gySession.cookie = '';
    throw new Error('观影登录已失效，请重新登录');
  }

  const il = j.inlist || {};
  const ids = il.i || [];
  const dirs = il.d || [];
  const titles = il.title || [];
  if (!ids.length) {
    return { ok: true, kw: kw, items: [], works: [], message: '没有匹配的作品' };
  }

  // ---- ② 对每个结果取资源列表（一般第一个就够，但合并全部更全）----
  const works = ids.map(function (id, i) {
    return {
      id: id,
      dir: dirs[i] || '',
      title: titles[i] || '',
      year: (il.year || [])[i] || '',
      type: (il.d || [])[i] || '',
      ename: (il.ename || [])[i] || '',
    };
  }).filter(function (w) { return w.id && w.dir; });

  const items = [];
  const seen = {};
  // 最多取前 5 个作品，避免请求过多
  for (const w of works.slice(0, 5)) {
    try {
      const dr = await gyFetchDownurl(base, w, kw);
      (dr.items || []).forEach(function (it) {
        if (seen[it.url]) return;
        seen[it.url] = true;
        items.push(it);
      });
    } catch (e) {
      log('GY', '取资源失败 ' + w.dir + '/' + w.id + ': ' + e.message);
    }
  }

  return {
    ok: true,
    kw: kw,
    works: works,
    items: items,
    total: items.length,
  };
}

// 安全 JSON 解析
function safeJson(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

// 取某作品的资源列表：/res/downurl/{dir}/{id}
// 返回 { items: [{url(magnet), note, size, quality, time}] }
async function gyFetchDownurl(base, work, kw) {
  const doFetch = async () => {
    await gyEnsureVerified(base);
    const r = await gyRequest(base + '/res/downurl/' + encodeURIComponent(work.dir) + '/' + encodeURIComponent(work.id),
      { cookie: gySession.cookie, accept: 'application/json, text/javascript, */*; q=0.01', xhr: true, referer: base + '/' + work.dir + '/' + work.id });
    gySession.cookie = gyMergeCookie(gySession.cookie, r.headers);
    return r;
  };
  let r = await doFetch();
  let j = safeJson(r.body);
  if (!j || j.code === 419) {
    gySession.verifiedAt = 0;
    r = await doFetch();
    j = safeJson(r.body);
  }
  if (!j) throw new Error('资源列表无法解析');
  if (j.code === 419) throw new Error('验证失效');
  if (/请先登录|nologin/i.test(j.msg || '')) {
    gySession.user = null; gySession.cookie = '';
    throw new Error('登录已失效');
  }

  const dl = j.downlist || {};
  const L = dl.list || {};
  const hashes = L.m || [];
  const names = L.t || [];
  const sizes = L.s || [];
  const quals = L.p || [];
  const times = L.n || [];
  // type.b 是清晰度代码，type.a 是对应文字（如 i2=中字1080P, i8=中字4K）
  const qmap = {};
  const qa = (dl.type && dl.type.a) || [];
  const qb = (dl.type && dl.type.b) || [];
  qb.forEach(function (code, i) { qmap[code] = qa[i] || code; });

  const out = [];
  for (let i = 0; i < hashes.length; i++) {
    const h = String(hashes[i] || '').trim();
    if (!h) continue;
    const note = String(names[i] || work.title || ('资源 ' + (i + 1))).trim();
    out.push({
      url: 'magnet:?xt=urn:btih:' + h + '&dn=' + encodeURIComponent(note),
      hash: h,
      note: note,
      size: String(sizes[i] || '').trim(),
      quality: qmap[quals[i]] || String(quals[i] || ''),
      time: String(times[i] || '').trim(),
      work: work.title || '',
      dir: work.dir,
    });
  }
  return { items: out, panlist: j.panlist || null, playlist: j.playlist || null };
}



// ============================================================================
// 网盘离线下载（115 / 光鸭）
// ----------------------------------------------------------------------------
// 目标：把搜索结果里的磁力链接直接推送到网盘做「离线下载」。
//
//  ● 115：成熟的 cookie 认证。四个 cookie（UID/CID/SEID/KID）即可调用
//     web.api.115.com 的离线接口。用户从浏览器 F12 复制整串 Cookie 粘贴进来。
//  ● 光鸭：官方 C 端 API + Bearer token。token 约 2 小时过期，用 refresh_token
//     自动续期。登录走手机号短信验证码（两步：发码 → 填码）。
//  ● 123云盘：走**网页版**接口（login.123pan.com + yun.123pan.com），
//     **账号密码直登**，不需要开发者权益包。
//     接口位置参考 github.com/ssabv/123pan-strm-docker
//     token 失效(code=401)会自动用账号密码重登一次。
//     注意：个人盘频控很严（code 100011 请勿频繁操作），需带间隔与退避重试。
// ============================================================================

const NETDISK_TIMEOUT_MS = parseInt(process.env.NETDISK_TIMEOUT || '30000', 10);
const NETDISK_SESSION_FILE = path.join(DATA_DIR, 'netdisk-session.json');

// 光鸭 API 域名（业务接口：任务/文件）
const GY_API_BASE = 'https://api.guangyapan.com';
// 光鸭账号域名与 client id 在下方「光鸭」段内定义（登录走账号域）

// 各网盘的登录态（内存）。结构统一为 { cookie | token, user, savedAt }
const ndSession = {
  '115': { cookie: '', user: '', savedAt: 0, ok: false },
  '123': { token: '', user: '', password: '', account: '', savedAt: 0, ok: false },
  guangya: {
    token: '', refreshToken: '', user: '', savedAt: 0, ok: false, tokenAt: 0,
    deviceId: '', did: '',            // 设备标识（登录与业务请求都要用，需长期稳定）
    pending: null,                     // 临时登录态：{ id, code?, captchaToken, at }
    tokenExpiresAt: 0,
  },
};

// ---------- 落盘 ----------
function ndLoadSession() {
  try {
    if (!fs.existsSync(NETDISK_SESSION_FILE)) return;
    const j = JSON.parse(fs.readFileSync(NETDISK_SESSION_FILE, 'utf8'));
    if (j && typeof j === 'object') {
      if (j['115']) Object.assign(ndSession['115'], j['115']);
      if (j.guangya) Object.assign(ndSession.guangya, j.guangya);
      const on = [];
      if (ndSession['115'].ok) on.push('115');
      if (ndSession.guangya.ok) on.push('光鸭');
      if (on.length) log('ND', '已恢复网盘登录态: ' + on.join('、'));
    }
  } catch (e) {
    log('ND', '读取网盘会话失败: ' + e.message);
  }
}
function ndSaveSession() {
  try {
    ensureDataDir();
    fs.writeFileSync(NETDISK_SESSION_FILE, JSON.stringify(ndSession, null, 2), 'utf8');
  } catch (e) {
    log('ND', '保存网盘会话失败: ' + e.message);
  }
}

// ---------- 通用请求 ----------
// opts: {method, headers, body, timeout, raw(是否返回 Buffer)}
function ndRequest(url, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('地址不合法: ' + url)); }
    const mod = u.protocol === 'https:' ? https : http;
    const headers = Object.assign({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    }, opts.headers || {});
    if (opts.body != null) {
      headers['Content-Length'] = Buffer.byteLength(opts.body);
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    const r = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: opts.method || 'GET',
      headers, timeout: opts.timeout || NETDISK_TIMEOUT_MS,
    }, (resp) => {
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          status: resp.statusCode,
          headers: resp.headers,
          body: opts.raw ? buf : buf.toString('utf8'),
        });
      });
    });
    r.on('error', (e) => reject(new Error('请求失败: ' + e.message)));
    r.on('timeout', () => { r.destroy(); reject(new Error('请求超时（' + (opts.timeout || NETDISK_TIMEOUT_MS) + 'ms）')); });
    if (opts.body != null) r.write(opts.body);
    r.end();
  });
}

function ndParseJson(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

// ============================== 115 ==============================
// 认证：Cookie 里需含 UID / CID / SEID / KID
function nd115CookieOk(cookie) {
  const jar = String(cookie || '');
  return /(^|;\s*)UID=/.test(jar) && /(^|;\s*)CID=/.test(jar) && /(^|;\s*)SEID=/.test(jar);
}

// 探测登录态：拉用户信息，成功说明 cookie 有效
async function nd115Probe(cookie) {
  const r = await ndRequest('https://webapi.115.com/files?aid=1&cid=0&o=user_ptime&asc=0&offset=0&show_dir=1&limit=1', {
    headers: { Cookie: cookie, Referer: 'https://115.com/' },
  });
  const j = ndParseJson(r.body);
  if (!j) throw new Error('115 返回了非 JSON 响应（可能被风控拦截）');
  if (j.state === false) throw new Error(j.error || j.message || '115 cookie 无效或已过期');
  return true;
}

// 提交离线任务。urls 为磁力链接数组
async function nd115Offline(cookie, urls, opts) {
  opts = opts || {};
  const form = new URLSearchParams();
  urls.forEach((u) => form.append('url[]', u));
  form.append('wp_path_id', opts.pathId || '0');
  const r = await ndRequest('https://webapi.115.com/offline/add_task_urls', {
    method: 'POST',
    headers: {
      Cookie: cookie,
      Referer: 'https://115.com/web/lixian/',
      Origin: 'https://115.com',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: form.toString(),
  });
  const j = ndParseJson(r.body);
  if (!j) throw new Error('115 离线接口返回非 JSON（可能触发风控，请稍后再试）');
  if (j.state === false) throw new Error(j.error || j.message || '115 离线任务提交失败');
  // 统计成功 / 重复
  let added = 0, dup = 0;
  const list = j.data || j.result || [];
  (Array.isArray(list) ? list : []).forEach((it) => {
    const info = it && (it.info_hash || it.url || '');
    const st = String((it && it.status) || '');
    const msg = String((it && it.msg) || (it && it.message) || '');
    if (/已存在|重复|exist/i.test(msg + st)) dup++;
    else if (it && (it.info_hash || st === '1' || /成功|new/i.test(msg))) added++;
    else added++;
  });
  return { ok: true, added: added || urls.length, dup: dup, raw: j };
}

// ============================== 123 云盘 ==============================
// 走**网页版**接口，账号密码直登，不需要开发者权益包。
// 接口位置参考 github.com/ssabv/123pan-strm-docker
//
// 域名：
//   login.123pan.com/api      登录
//   yun.123pan.com/b/api      业务（文件列表/新建/重命名/删除/下载）
//
// 登录：
//   POST /user/sign_in
//     邮箱： {mail, password, type:2}
//     手机： {passport, password, remember:true}
//     → {code:0, data:{token}}
//   401 失效时用保存的账号密码自动重登一次（同观影的保活思路）。
//
// 频控：个人盘很严，返回 code 100011「请勿频繁操作」。
//   所有请求之间留间隔，遇限流指数退避重试。
const P123_LOGIN_BASE = 'https://login.123pan.com/api';
const P123_MAIN_BASE = 'https://yun.123pan.com/b/api';
const P123_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                '(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
// 请求最小间隔（毫秒），避免触发 100011
const P123_MIN_INTERVAL = 350;
let p123LastCall = 0;

function p123Headers(withAuth) {
  const h = {
    'origin': 'https://yun.123pan.com',
    'referer': 'https://yun.123pan.com/',
    'user-agent': P123_UA,
    'platform': 'web',
    'app-version': '3',
  };
  const s = ndSession['123'];
  if (withAuth && s.token) h['authorization'] = 'Bearer ' + s.token;
  return h;
}

// 节流：保证两次请求间隔 >= P123_MIN_INTERVAL
async function p123Throttle() {
  const wait = P123_MIN_INTERVAL - (Date.now() - p123LastCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  p123LastCall = Date.now();
}

// 底层请求。返回 {status, json}
async function p123Raw(method, url, params, body) {
  await p123Throttle();
  let full = url;
  if (params && Object.keys(params).length) {
    const usp = new URLSearchParams();
    Object.keys(params).forEach((k) => {
      if (params[k] !== undefined && params[k] !== null) usp.set(k, String(params[k]));
    });
    full += '?' + usp.toString();
  }
  const opts = {
    method: method,
    headers: p123Headers(true),
    timeout: NETDISK_TIMEOUT_MS,
  };
  if (body) {
    opts.body = JSON.stringify(body);
    opts.headers['Content-Type'] = 'application/json';
  }
  const r = await ndRequest(full, opts);
  return { status: r.status, json: ndParseJson(r.body), raw: r.body };
}

// 登录：POST login.123pan.com/api/user/sign_in
async function p123Login(account, password) {
  const acc = String(account || '').trim();
  const pw = String(password || '');
  if (!acc || !pw) throw new Error('请填写 123 账号和密码');
  // 邮箱 vs 手机号：含 @ 且域名带点 → 走邮箱
  const isMail = acc.indexOf('@') > 0 && /\./.test(acc.split('@')[1] || '');
  const payload = isMail
    ? { mail: acc, password: pw, type: 2 }
    : { passport: acc, password: pw, remember: true };
  const r = await ndRequest(P123_LOGIN_BASE + '/user/sign_in', {
    method: 'POST',
    headers: Object.assign(p123Headers(false), { 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
    timeout: NETDISK_TIMEOUT_MS,
  });
  const j = ndParseJson(r.body);
  if (!j) throw new Error('123 登录响应非 JSON（HTTP ' + r.status + '）');
  // 诊断：把原始响应写进日志（脱敏 token），便于定位结构差异
  const rawSafe = r.body.replace(/("(?:token|access_token|accessToken)"\s*:\s*")[^"]{8,}(")/g, '$1***$2');
  log('ND', '123 登录响应: HTTP ' + r.status + ' ' + rawSafe.slice(0, 500));

  // 兼容多种成功结构（实测 123 登录返回 {code:0, message:"ok", data:{token}}）
  //   {code:0, message:"ok", data:{token}}
  //   {code:0, message:"success", data:{access_token}}
  //   {message:"success", data:{...}}
  const d = j.data || j;
  const token = d.token || d.access_token || d.accessToken || j.token || '';
  const okCode = (j.code === 0 || j.code === undefined || j.code === null);
  const okMsg = (j.message === 'ok' || j.message === 'success' ||
                 j.msg === 'ok' || j.msg === 'success' || !j.message && !j.msg);
  if (okCode && okMsg && token) {
    // 正常成功
  } else if (!token) {
    const msg = j.message || j.msg || '';
    if (j.code === -1 || /密码|账号|错误|不存在/.test(msg)) {
      throw new Error('123 登录失败：账号或密码不正确（请确认用的是 123 网页版的手机号/邮箱 + 密码）');
    }
    throw new Error('123 登录失败：' + (msg || ('code ' + j.code)) + '（原始：' + rawSafe.slice(0, 200) + '）');
  }
  const s = ndSession['123'];
  s.token = token;
  s.user = acc;
  s.account = acc;
  s.password = pw;      // 保存用于 token 失效后自动重登
  s.ok = true;
  s.savedAt = Date.now();
  ndSaveSession();
  log('ND', '123 登录成功（' + acc + '）');
  return { ok: true, user: acc };
}

// Token 直登（用于已有 token 的场景，如从其他工具迁移过来）
async function p123LoginByToken(token) {
  const tk = String(token || '').trim();
  if (!tk) throw new Error('请填写 123 的 token');
  const s = ndSession['123'];
  const old = s.token;
  s.token = tk;
  try {
    const info = await p123UserInfo();
    if (!info) throw new Error('token 无效或已过期');
    s.user = info.name || '123 用户';
    s.account = '';        // token 登录没有账号密码，无法自动重登
    s.password = '';
    s.ok = true;
    s.savedAt = Date.now();
    ndSaveSession();
    log('ND', '123 token 登录成功（' + s.user + '）');
    return { ok: true, user: s.user };
  } catch (e) {
    s.token = old;
    throw new Error('123 token 登录失败：' + e.message);
  }
}

// 业务请求。token 失效自动重登一次。
async function p123Api(method, pathname, params, body, retried) {
  const s = ndSession['123'];
  if (!s.token) throw new Error('123 未登录');
  const r = await p123Raw(method, P123_MAIN_BASE + pathname, params, body);
  const j = r.json;
  if (!j) throw new Error('123 接口返回非 JSON（HTTP ' + r.status + '）');
  if ((j.code === 401 || r.status === 401) && !retried && s.account && s.password) {
    log('ND', '123 token 失效，自动重登后重试');
    await p123Login(s.account, s.password);
    return p123Api(method, pathname, params, body, true);
  }
  return j;
}

// 统一结果包装：code===0 为成功
function p123Ok(j) { return !!j && j.code === 0; }
function p123Err(j) {
  if (!j) return '返回为空';
  return j.message || j.msg || ('code ' + j.code);
}
// 限流判定
function p123IsRateLimited(j) {
  const m = String((j && (j.message || j.msg)) || '');
  return j && (j.code === 100011 || /频繁|稍后再试/.test(m));
}

// 带退避重试的调用（专治 100011）
async function p123ApiRetry(method, pathname, params, body) {
  let last = null;
  for (let i = 0; i < 4; i++) {
    const j = await p123Api(method, pathname, params, body);
    if (!p123IsRateLimited(j)) return j;
    last = j;
    const wait = 1200 * (i + 1);
    log('ND', '123 限流，' + wait + 'ms 后重试（' + (i + 1) + '/4）');
    await new Promise((r) => setTimeout(r, wait));
  }
  return last;
}

// ---------- 文件管理 ----------

// 列目录（自动翻页）
async function p123List(parentFileId) {
  const parent = String(parentFileId || 0);
  let all = [];
  let page = 1;
  for (;;) {
    const params = {
      driveId: '0',
      limit: '100',
      next: '0',
      orderBy: 'file_id',
      orderDirection: 'desc',
      parentFileId: parent,
      trashed: 'false',
      SearchData: '',
      Page: String(page),
      OnlyLookAbnormalFile: '0',
      event: 'homeListFile',
      operateType: '4',
      inDirectSpace: 'false',
    };
    const j = await p123ApiRetry('GET', '/file/list/new', params, null);
    if (!p123Ok(j)) throw new Error('列目录失败：' + p123Err(j));
    const d = j.data || {};
    const list = d.InfoList || [];
    list.forEach((f) => {
      all.push({
        id: String(f.FileId || f.fileId || ''),
        name: f.FileName || f.fileName || '',
        isDir: (f.Type | 0) === 1,
        size: f.Size || f.size || 0,
        ctime: f.CreateAt || f.createAt || '',
        utime: f.UpdateAt || f.updateAt || '',
        etag: f.Etag || f.etag || '',
        s3keyFlag: f.S3KeyFlag || f.s3KeyFlag || '',
      });
    });
    const next = String(d.Next == null ? '-1' : d.Next);
    if (next === '-1' || !list.length || page >= 50) break;
    page++;
  }
  return all;
}

// 新建文件夹（含 5060 同名复用）
async function p123Mkdir(parentFileId, name) {
  // 非法字符替换（照抄参考实现）
  const clean = String(name).replace(/[:/\\*?]/g, (c) => ({
    ':': '：', '/': '／', '\\': '＼', '*': '＊', '?': '？',
  }[c]));
  const body = {
    driveId: 0, etag: '', fileName: clean,
    parentFileId: Number(parentFileId) || 0, size: 0, type: 1,
  };
  const j = await p123ApiRetry('POST', '/file/upload_request', null, body);
  if (p123Ok(j)) {
    const info = (j.data && (j.data.Info || j.data.info)) || {};
    return { ok: true, id: String(info.FileId || info.fileId || ''), name: clean };
  }
  // 5060 = 同名已存在 → 找到它复用
  if (j && j.code === 5060) {
    const items = await p123List(parentFileId);
    const hit = items.find((f) => f.isDir && f.name === clean);
    if (hit) return { ok: true, id: hit.id, name: clean, reused: true };
  }
  throw new Error('新建文件夹失败：' + p123Err(j));
}

// 重命名
async function p123Rename(fileId, newName) {
  const clean = String(newName).replace(/[:/\\*?]/g, (c) => ({
    ':': '：', '/': '／', '\\': '＼', '*': '＊', '?': '？',
  }[c]));
  const j = await p123ApiRetry('POST', '/file/rename', null, {
    driveId: 0, fileId: Number(fileId), fileName: clean,
  });
  if (!p123Ok(j)) throw new Error('重命名失败：' + p123Err(j));
  return { ok: true, name: clean };
}

// 删除（入回收站）
async function p123Trash(items) {
  // items: [{id, name, size, isDir}]
  const list = (Array.isArray(items) ? items : [items]).map((f) => ({
    fileId: Number(f.id || f.fileId),
    fileName: f.name || f.fileName || '',
    size: f.size || 0,
    type: f.isDir ? 1 : 0,
    etag: f.etag || '',
    s3keyFlag: f.s3keyFlag || '',
  }));
  const j = await p123ApiRetry('POST', '/file/trash', null, {
    driveId: 0, event: 'intoRecycle', operatePlace: 1,
    operation: true, fileTrashInfoList: list,
  });
  if (!p123Ok(j)) throw new Error('删除失败：' + p123Err(j));
  return { ok: true, count: list.length };
}

// 彻底删除（回收站内的文件）code 7301 = 成功
async function p123Purge(fileIds) {
  const ids = (Array.isArray(fileIds) ? fileIds : [fileIds]).map((id) => ({ fileId: Number(id) }));
  const j = await p123ApiRetry('POST', '/file/delete', null, {
    fileIdList: ids, event: 'recycleDelete', operatePlace: 1, RequestSource: null,
  });
  if (j && (j.code === 0 || j.code === 7301)) return { ok: true, count: ids.length };
  throw new Error('彻底删除失败：' + p123Err(j));
}

// 下载直链
async function p123DownloadUrl(f) {
  const body = {
    driveId: 0, etag: f.etag || '', fileId: Number(f.id),
    s3keyFlag: f.s3keyFlag || '', type: f.isDir ? 1 : 0,
    fileName: f.name || '', size: f.size || 0,
  };
  const j = await p123ApiRetry('POST', '/file/download_info', null, body);
  if (!p123Ok(j)) throw new Error('获取下载直链失败：' + p123Err(j));
  const d = j.data || {};
  const url = d.DownloadUrl || d.downloadUrl || d.Url || d.url || '';
  if (!url) throw new Error('未取到下载直链');
  return url;
}

// 用户信息（用于校验登录态）
async function p123UserInfo() {
  const j = await p123Api('GET', '/user/info', null, null);
  if (!p123Ok(j)) return null;
  const d = j.data || {};
  return {
    name: d.Nickname || d.nickname || d.Passport || d.passport || '',
    space: d.SpaceUsed || d.spaceUsed || 0,
    spacePermanent: d.SpacePermanent || 0,
  };
}

// ============================== 123 秒传 / 转存 ==============================
// 123 没有「分享转存」公开接口，实际机制是**秒传（etag 复用）**：
//   1) 解析来源（磁力/分享链接）→ 得到每个文件的 {etag, size, fileName}
//   2) POST /b/api/file/upload_request 带 etag → 服务端命中已有文件即直接「复用」，
//      不消耗流量、不上传内容（返回 data.Reuse=true）
//   3) 目录结构：用 type:1 的 upload_request 逐级创建文件夹，拿到 FileId 作为 parentFileId
//
// 注意：123 的 web 接口需要**签名查询参数**（时间戳-随机数-crc32），
// 算法见 p123SignPath()：对 yyyyMMddHHmm 做数字→字母表替换后算 crc32，
// 再与 timestamp|random|path|os|version|timeSign 拼接算第二个 crc32。
//
// 参考：github.com/Bao-qing/123FastLink（sign.js / PanApiClient.js）

// 数字 → 字母替换表（官方前端混淆用）
const P123_SIGN_TABLE = ['a','d','e','f','g','h','l','m','y','i','j','n','o','p','k','q','r','s','t','u','b','c','v','w','s','z'];

// CRC32（用于 123 签名）
let P123_CRC_TABLE = null;
function p123Crc32(str) {
  if (!P123_CRC_TABLE) {
    P123_CRC_TABLE = [];
    for (let e = 0; e < 256; e++) {
      let n = e;
      for (let r = 0; r < 8; r++) n = (n & 1) ? (3988292384 ^ (n >>> 1)) : (n >>> 1);
      P123_CRC_TABLE[e] = n;
    }
  }
  const s = String(str).replace(/\r\n/g, '\n');
  let a = -1;
  for (let i = 0; i < s.length; i++) a = (a >>> 8) ^ P123_CRC_TABLE[255 & (a ^ s.charCodeAt(i))];
  return ((-1 ^ a) >>> 0).toString(10);
}

// 生成 123 的签名查询串：返回 { timeSign, sign }
// timeSign = crc32(替换后的 yyyyMMddHHmm)
// sign     = `${timestamp}-${random}-${crc32(`${timestamp}|${random}|${path}|${os}|${version}|${timeSign}`)}`
function p123SignPath(pathname, os, version) {
  // 北京时间时间戳（+8）
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const timestamp = String(Math.round(now.getTime() / 1000));
  const random = String(Math.round(1e7 * Math.random()));
  const pad = (n) => (n < 10 ? '0' + n : String(n));
  const ymdhm = '' + now.getUTCFullYear() + pad(now.getUTCMonth() + 1) +
                pad(now.getUTCDate()) + pad(now.getUTCHours()) + pad(now.getUTCMinutes());
  let mapped = '';
  for (let i = 0; i < ymdhm.length; i++) mapped += P123_SIGN_TABLE[Number(ymdhm[i])];
  const timeSign = p123Crc32(mapped);
  const dataSign = p123Crc32([timestamp, random, pathname, os, version, timeSign].join('|'));
  return { timeSign: timeSign, sign: [timestamp, random, dataSign].join('-') };
}

// ============================== 123 秒传 ==============================
// 带签名地调 123 web 接口（区别于 p123Raw：会附加 2015049069 签名参数）
async function p123Signed(method, pathname, params, body) {
  const sig = p123SignPath('/b/api' + pathname, 'web', '3');
  const p = Object.assign({}, params || {}, {
    '2015049069': sig.timeSign,
    '2759788': sig.sign,
  });
  return p123Raw(method, P123_MAIN_BASE + pathname, p, body);
}

// 秒传一个文件到指定目录。fileInfo: {etag, size, fileName, parentFileId}
// 返回 { reuse, fileId } 或抛错
async function p123FastUpload(fileInfo, parentFileId) {
  const r = await p123Signed('POST', '/file/upload_request', null, {
    driveId: 0,
    etag: fileInfo.etag,
    fileName: fileInfo.fileName,
    parentFileId: parentFileId === '' ? 0 : parentFileId,
    size: fileInfo.size,
    type: 0,
    duplicate: 1,
    RequestSource: null,
  });
  const j = r.json;
  if (!j) throw new Error('123 秒传返回非 JSON（HTTP ' + r.status + '）');
  if (j.code !== 0) throw new Error(p123Err(j) || '秒传失败');
  const reuse = j.data && j.data.Reuse;
  if (!reuse) throw new Error('未能实现秒传（网盘中不存在该文件，需真实上传）');
  return { reuse: true, fileId: (j.data.Info && j.data.Info.FileId) || 0 };
}

// 创建文件夹（123 用 upload_request + type:1）
async function p123MkdirSigned(parentFileId, folderName) {
  const r = await p123Signed('POST', '/file/upload_request', null, {
    driveId: 0,
    etag: '',
    fileName: folderName,
    parentFileId: parentFileId === '' ? 0 : parentFileId,
    size: 0,
    type: 1,
    duplicate: 1,
    NotReuse: true,
    event: 'newCreateFolder',
    operateType: 1,
    RequestSource: null,
  });
  const j = r.json;
  if (!j) throw new Error('123 建目录返回非 JSON（HTTP ' + r.status + '）');
  // 5060 = 同名文件夹已存在，需查已存在的 ID
  if (j.code === 5060) {
    const exist = await p123FindFolder(parentFileId, folderName);
    if (exist) return exist;
    throw new Error('文件夹已存在但无法获取其 ID');
  }
  if (j.code !== 0) throw new Error(p123Err(j) || '创建文件夹失败');
  return (j.data && j.data.Info && j.data.Info.FileId) || 0;
}

// 在指定目录下查同名文件夹的 FileId
async function p123FindFolder(parentFileId, folderName) {
  const j = await p123Api('GET', '/file/list/new', {
    driveId: 0, limit: 100, next: 0, orderBy: 'file_id', orderDirection: 'desc',
    parentFileId: parentFileId === '' ? 0 : parentFileId, trashed: 'false',
    SearchData: folderName, Page: 1, OnlyLookAbnormalFile: 0,
    event: 'homeListFile', operateType: 4, inDirectSpace: 'false',
  });
  if (!j || j.code !== 0) return 0;
  const list = (j.data && (j.data.InfoList || j.data.infoList)) || [];
  for (const f of list) {
    if (f.FileName === folderName && f.Type === 1) return f.FileId;
  }
  return 0;
}

// 递归确保目录路径存在，返回最后一级的 FileId
// path 形如 ["影视","剧集","深渊无间"]
async function p123EnsurePath(baseParentId, parts) {
  let pid = baseParentId === '' || baseParentId === undefined ? 0 : baseParentId;
  for (const part of parts) {
    const name = String(part || '').trim();
    if (!name) continue;
    pid = await p123MkdirSigned(pid, name);
  }
  return pid;
}

// 解析磁力链接 → 无法拿到 etag，123 秒传需要 etag/size，这里明确不支持
// （磁力走「离线下载」；秒传只适用于秒传链接/分享解析出的 etag 列表）
function p123ParseMagnet(url) {
  const m = /xt=urn:btih:([a-zA-Z0-9]+)/.exec(String(url || ''));
  return m ? { hash: m[1] } : null;
}

// 解析 123 秒传链接（123FLCPV2$path%etag#size#... 或 JSON 数组）
// 返回 [{ path, fileName, etag, size }]
function p123ParseFlashLink(text) {
  const out = [];
  const s = String(text || '').trim();
  if (!s) return out;
  // JSON 形式
  if (s[0] === '[' || s[0] === '{') {
    try {
      const arr = JSON.parse(s);
      const list = Array.isArray(arr) ? arr : [arr];
      list.forEach((x) => {
        const etag = x.etag || x.Etag || x.md5 || x.MD5 || '';
        const size = Number(x.size || x.Size || 0);
        const p = x.path || x.pathName || x.commonPath || '';
        const fn = x.fileName || x.name || x.FileName || '';
        if (etag && fn) out.push({ path: p, fileName: fn, etag: etag, size: size });
      });
      return out;
    } catch (e) { /* 落到纯文本解析 */ }
  }
  // 文本形式：每行  path%etag#size#...
  s.split(/\r?\n/).forEach((line) => {
    const t = line.trim().replace(/^123FLCPV2\$/, '');
    if (!t) return;
    const segs = t.split('#');
    const head = segs[0];
    const at = head.lastIndexOf('%');
    if (at < 0) return;
    const full = head.slice(0, at);
    const etag = head.slice(at + 1);
    const size = Number(segs[1] || 0);
    const slash = full.lastIndexOf('/');
    const path = slash > 0 ? full.slice(0, slash) : '';
    const fileName = slash >= 0 ? full.slice(slash + 1) : full;
    if (etag && fileName) out.push({ path: path, fileName: fileName, etag: etag, size: size });
  });
  return out;
}

// 批量转存：把 [{path,fileName,etag,size}] 秒传到 baseParentId，并保留目录结构
// 返回 { added, failed: [{fileName,error}], targetId }
async function p123Transfer(items, baseParentId, targetParts) {
  const base = await p123EnsurePath(baseParentId, targetParts || []);
  let added = 0;
  const failed = [];
  const dirCache = {};
  for (const it of items) {
    try {
      // 逐级建目录（按 path 分段，缓存已建过的）
      let pid = base;
      const parts = String(it.path || '').split('/').filter(Boolean);
      if (parts.length) {
        const key = parts.join('/');
        if (dirCache[key] === undefined) dirCache[key] = await p123EnsurePath(base, parts);
        pid = dirCache[key];
      }
      await p123FastUpload({ etag: it.etag, size: it.size, fileName: it.fileName }, pid);
      added++;
    } catch (e) {
      failed.push({ fileName: it.fileName, error: e.message });
    }
  }
  return { added: added, failed: failed, targetId: base };
}

// ============================== 123 分享转存 ==============================
// 真正的「保存别人的分享到我的网盘」流程（不需要秒传 JSON）：
//   ① 解析分享链接 → shareKey / sharePwd
//   ② GET /b/api/share/get   读分享内的文件列表（含 **Etag** / Size / FileName）
//   ③ 递归：文件夹逐级在我的网盘建好（upload_request type:1）
//      文件用 upload_request 带 etag 落地（服务端命中即 Reuse，不耗流量）
//   ④ 可选：指定目标目录（parentFileId），或新建子目录
//
// 实测：整条链路可用（读分享 → 建目录 → 转存 → 列目录确认，文件真实落地）

// 解析 123 分享链接，返回 { shareKey, sharePwd }
// 支持：https://123pan.com/s/xxxx?pwd=1234
//       https://123865.com/s/xxxx?提取码:1234
//       https://www.123pan.com/s/xxxx
function p123ParseShareUrl(url) {
  const s = String(url || '').trim();
  if (!s) return null;
  // shareKey：/s/ 后面到 ? 或 # 之前
  let key = '';
  const m1 = /\/s\/([A-Za-z0-9_-]+)/.exec(s);
  if (m1) key = m1[1];
  if (!key) {
    // 也可能是纯 shareKey 形式（如 7Tx1jv-Aeitv）
    const m2 = /^([A-Za-z0-9]+-[A-Za-z0-9]+)$/.exec(s);
    if (m2) key = m2[1];
  }
  if (!key) return null;
  // 提取码：pwd= / 提取码: / 密码:
  let pwd = '';
  const p1 = /(?:pwd=|提取码[:：]?\s*|密码[:：]?\s*)([A-Za-z0-9]{4})/i.exec(s);
  if (p1) pwd = p1[1];
  return { shareKey: key, sharePwd: pwd };
}

// 读取分享根目录下的文件列表（一层）
// 返回 [{ fileId, fileName, etag, size, isDir }]
async function p123ShareList(shareKey, sharePwd, parentFileId) {
  const all = [];
  let page = 1;
  for (;;) {
    const j = await p123Signed('GET', '/share/get', {
      limit: 100, next: 0, orderBy: 'file_id', orderDirection: 'desc',
      parentFileId: parentFileId === undefined || parentFileId === null ? '0' : String(parentFileId),
      Page: page, shareKey: shareKey, SharePwd: sharePwd || '',
    });
    const jj = j.json;
    if (!jj) throw new Error('123 分享接口返回非 JSON（HTTP ' + j.status + '）');
    if (jj.code !== 0) throw new Error(p123Err(jj) || '读取分享失败（链接可能已失效或提取码错误）');
    const list = (jj.data && (jj.data.InfoList || [])) || [];
    list.forEach((f) => all.push({
      fileId: f.FileId,
      fileName: f.FileName,
      etag: f.Etag || '',
      size: f.Size || 0,
      isDir: f.Type === 1,
    }));
    const next = jj.data && jj.data.Next;
    if (!list.length || next === '-1' || next === -1) break;
    page++;
    if (page > 50) break;   // 安全上限
  }
  return all;
}

// 递归把分享文件转存到我的网盘 destParentId
// 返回 { added, failed:[{name,error}], targetId }
async function p123ShareTransfer(shareKey, sharePwd, destParentId, opts) {
  opts = opts || {};
  const maxFiles = opts.maxFiles || 300;    // 避免误点转存几千个文件
  let added = 0;
  const failed = [];
  const base = destParentId === '' || destParentId === undefined ? 0 : destParentId;

  // 把源目录树逐层搬到目标（保持目录结构）
  async function walk(srcParentId, dstParentId, depth) {
    if (depth > 6) return;      // 防魔性嵌套
    let list;
    try {
      list = await p123ShareList(shareKey, sharePwd, srcParentId);
    } catch (e) {
      failed.push({ name: '(读取目录)', error: e.message });
      return;
    }
    for (const f of list) {
      if (added >= maxFiles) return;
      if (f.isDir) {
        // 在目标建同名文件夹
        let subId = 0;
        try {
          subId = await p123MkdirSigned(dstParentId, f.fileName);
        } catch (e) {
          failed.push({ name: f.fileName, error: '建目录失败：' + e.message });
          continue;
        }
        await walk(f.fileId, subId, depth + 1);
      } else {
        if (!f.etag) { failed.push({ name: f.fileName, error: '缺少 etag，无法转存' }); continue; }
        try {
          await p123FastUpload({ etag: f.etag, size: f.size, fileName: f.fileName }, dstParentId);
          added++;
        } catch (e) {
          failed.push({ name: f.fileName, error: e.message });
        }
      }
    }
  }

  await walk(0, base, 0);
  return { added: added, failed: failed, targetId: base };
}

// 分享预览：只列第一层，供前端展示「将转存 N 个文件」
async function p123SharePreview(shareKey, sharePwd) {
  const list = await p123ShareList(shareKey, sharePwd, 0);
  const files = list.filter((f) => !f.isDir);
  const dirs = list.filter((f) => f.isDir);
  const totalSize = files.reduce((a, b) => a + (b.size || 0), 0);
  return {
    files: files.length,
    dirs: dirs.length,
    totalSize: totalSize,
    sample: list.slice(0, 20).map((f) => ({
      name: f.fileName, size: f.size, isDir: f.isDir,
    })),
  };
}

// 列出某目录下的子文件夹（供「选择目标文件夹」用）
async function p123Folders(parentId) {
  const j = await p123Api('GET', '/file/list/new', {
    driveId: 0, limit: 100, next: 0, orderBy: 'file_id', orderDirection: 'desc',
    parentFileId: parentId === '' ? 0 : parentId, trashed: 'false',
    SearchData: '', Page: 1, OnlyLookAbnormalFile: 0,
    event: 'homeListFile', operateType: 4, inDirectSpace: 'false',
  });
  if (!j || j.code !== 0) return [];
  const list = (j.data && (j.data.InfoList || j.data.infoList)) || [];
  return list.filter((f) => f.Type === 1).map((f) => ({
    id: f.FileId, name: f.FileName, updateAt: f.UpdateAt || '',
  }));
}

// ============================== 光鸭 ==============================
// 登录方式：**设备码 OAuth2**（扫码授权），不再用短信验证码。
// 参考实现：github.com/ShukeBta/Guangyadisk
//
// 流程：
//   ① POST account.guangyapan.com/v1/auth/device/code
//        body {scope:"user", client_id} → {device_code, user_code, verification_url, expires_in, interval}
//   ② 用户在浏览器打开 verification_url 并确认（或 App 扫码）
//   ③ 轮询 POST account.guangyapan.com/v1/auth/token
//        body {grant_type:"urn:ietf:params:oauth:grant-type:device_code", device_code, client_id}
//        未确认 → HTTP 400 {error:"authorization_pending"}（继续等）
//        成功   → {access_token, refresh_token}
//
// 刷新：POST account.guangyapan.com/v1/auth/token
//        body {grant_type:"refresh_token", refresh_token, client_id}
//
// 这套方案的优势：无短信、无 captcha、无每日次数限制，一次授权长期有效。
const GY_ACCOUNT_BASE = 'https://account.guangyapan.com';
// 客户端标识（官方 Web 端固定值）
const GY_CLIENT_ID = 'aMe-8VSlkrbQXpUR';
const GY_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
              '(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

// 设备码轮询状态（内存）
// { deviceCode, userCode, verifyUrl, expiresAt, interval }
let gyaDevice = null;

// 设备标识：首次生成后复用（落盘），避免每次请求都像新设备
function gyaDeviceId() {
  const s = ndSession.guangya;
  if (!s.deviceId) {
    s.deviceId = crypto.randomUUID().replace(/-/g, '');
    ndSaveSession();
  }
  return s.deviceId;
}

// 账号域/公共请求头（含全套 x-device-*，缺一不可）
function gyaBaseHeaders(extra) {
  const dev = gyaDeviceId();
  return Object.assign({
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'Referer': 'https://www.guangyupan.com/',
    'User-Agent': GY_UA,
    'Accept-Language': 'zh-CN',
    'X-Client-Id': GY_CLIENT_ID,
    'X-Client-Version': '0.0.1',
    'X-Device-Id': dev,
    'X-Device-Model': 'chrome%2F147.0.0.0',
    'X-Device-Name': 'PC-Chrome',
    'X-Device-Sign': 'wdi10.' + dev + 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    'X-Net-Work-Type': 'NONE',
    'X-Os-Version': 'Win32',
    'X-Platform-Version': '1',
    'X-Protocol-Version': '301',
    'X-Provider-Name': 'NONE',
    'X-Sdk-Version': '9.0.2',
  }, extra || {});
}

// 从 RPC 风格错误体里提取可读文案
function gyaErrText(j) {
  if (!j) return '';
  if (j.error_description) {
    const d = (j.details || []).find((x) => /LocalizedMessage/i.test(x['@type'] || ''));
    if (d && d.message) return d.message;
    return j.error_description;
  }
  return j.msg || j.message || '';
}

// 账号域 POST，返回 {status, json}；不抛错，由调用方判断
async function gyaPost(url, body) {
  const r = await ndRequest(url, {
    method: 'POST',
    headers: gyaBaseHeaders(),
    body: JSON.stringify(body || {}),
  });
  return { status: r.status, json: ndParseJson(r.body), raw: r.body };
}

// ① 申请设备码
async function gyaDeviceCode() {
  const r = await gyaPost(GY_ACCOUNT_BASE + '/v1/auth/device/code', {
    scope: 'user',
    client_id: GY_CLIENT_ID,
  });
  const j = r.json;
  if (!j || !j.device_code) {
    throw new Error('申请设备码失败：' + (gyaErrText(j) || ('HTTP ' + r.status)) + ' ' + String(r.raw).slice(0, 150));
  }
  gyaDevice = {
    deviceCode: j.device_code,
    userCode: j.user_code || '',
    verifyUrl: j.verification_url || j.verification_uri || '',
    verifyUrlComplete: j.verification_uri_complete || j.verification_url || '',
    expiresAt: Date.now() + ((j.expires_in || 120) * 1000),
    interval: Math.max(2, j.interval || 2),
  };
  log('ND', '光鸭设备码已生成（有效期 ' + (j.expires_in || 120) + ' 秒）');
  return {
    ok: true,
    userCode: gyaDevice.userCode,
    verifyUrl: gyaDevice.verifyUrl,
    verifyUrlComplete: gyaDevice.verifyUrlComplete,
    expiresIn: j.expires_in || 120,
    interval: gyaDevice.interval,
  };
}

// ③ 轮询设备码状态
async function gyaPollDevice() {
  if (!gyaDevice || !gyaDevice.deviceCode) {
    return { ok: false, error: '请先点「获取授权链接」' };
  }
  if (Date.now() > gyaDevice.expiresAt) {
    gyaDevice = null;
    return { ok: false, expired: true, error: '授权码已过期，请重新获取' };
  }
  const r = await gyaPost(GY_ACCOUNT_BASE + '/v1/auth/token', {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: gyaDevice.deviceCode,
    client_id: GY_CLIENT_ID,
  });
  const j = r.json || {};
  // 未确认
  if (j.error === 'authorization_pending' || j.error_code === 4050) {
    return { ok: true, waiting: true, message: gyaErrText(j) || '等待授权中…' };
  }
  if (j.access_token) {
    const s = ndSession.guangya;
    s.token = j.access_token;
    s.refreshToken = j.refresh_token || s.refreshToken || '';
    s.ok = true;
    s.savedAt = Date.now();
    if (j.expires_in) s.tokenExpiresAt = Date.now() / 1000 + j.expires_in;
    gyaDevice = null;
    ndSaveSession();
    // 拉一次用户信息，拿到昵称
    try {
      const ui = await gyaFetchUser();
      if (ui) s.user = ui;
    } catch (e) {}
    if (!s.user) s.user = '光鸭用户';
    ndSaveSession();
    log('ND', '光鸭授权成功（' + s.user + '），token 长度 ' + s.token.length);
    return { ok: true, done: true, user: s.user };
  }
  // 其它错误（拒绝/过期）
  if (j.error) {
    const msg = gyaErrText(j) || j.error;
    if (/expired|denied|access_denied/i.test(j.error)) gyaDevice = null;
    return { ok: false, error: msg };
  }
  return { ok: true, waiting: true, message: '等待授权中…' };
}

// 拉用户信息（用于显示昵称，同时验证 token 有效）
async function gyaFetchUser() {
  const s = ndSession.guangya;
  if (!s.token) return '';
  const r = await ndRequest(GY_ACCOUNT_BASE + '/v1/user/me', {
    method: 'GET',
    headers: gyaBaseHeaders({ 'Authorization': 'Bearer ' + s.token, 'accessToken': s.token, 'Did': s.deviceId, 'Dt': '4' }),
  });
  const j = ndParseJson(r.body);
  if (!j || j.error) return '';
  const d = j.data || j;
  return d.nickname || d.name || d.username || d.phone || '';
}

// token 刷新（走账号域 /v1/auth/token）
async function gyaRefresh() {
  const s = ndSession.guangya;
  if (!s.refreshToken) throw new Error('光鸭 refresh_token 缺失，请重新授权');
  const r = await gyaPost(GY_ACCOUNT_BASE + '/v1/auth/token', {
    grant_type: 'refresh_token',
    refresh_token: s.refreshToken,
    client_id: GY_CLIENT_ID,
  });
  const j = r.json || {};
  if (!j.access_token) {
    throw new Error('光鸭 token 续期失败：' + (gyaErrText(j) || ('HTTP ' + r.status)));
  }
  s.token = j.access_token;
  if (j.refresh_token) s.refreshToken = j.refresh_token;
  if (j.expires_in) s.tokenExpiresAt = Date.now() / 1000 + j.expires_in;
  s.tokenAt = Date.now();
  ndSaveSession();
  log('ND', '光鸭 token 已自动续期');
  return s.token;
}

// ============ 光鸭文件管理 ============
// 全部走业务域 api.guangyapan.com，响应风格 {code,msg,data} 或 {msg:"success",data}
// 成功判定统一用 gyaOk()：msg==="success" 或 code===0。
function gyaOk(j) {
  return !!j && (j.msg === 'success' || j.code === 0);
}

// 统一调用：返回 {ok, data, error}
async function gyaFileApi(pathname, body) {
  const j = await gyaApi(pathname, body);
  if (gyaOk(j)) return { ok: true, data: j.data !== undefined ? j.data : j };
  return { ok: false, error: gyaBusinessErr(j) };
}

// 空间信息
async function gyaAssets() {
  const r = await gyaFileApi('/nd.bizassets.s/v1/get_assets', {});
  if (!r.ok) throw new Error(r.error);
  const d = r.data || {};
  return {
    total: d.totalSpaceSize || 0,
    used: d.usedSpaceSize || 0,
    vipStatus: d.vipStatus || 0,
    vipExpire: d.vipExpireTime || 0,
  };
}

// 目录列表
async function gyaList(parentId, page, pageSize) {
  const r = await gyaFileApi('/nd.bizuserres.s/v1/file/get_file_list', {
    parentId: parentId || '',
    page: page || 0,
    pageSize: pageSize || 200,
    orderBy: 3,
    sortType: 1,
    fileTypes: [],
  });
  if (!r.ok) throw new Error(r.error);
  const d = r.data || {};
  const list = (d.list || []).map(function (f) {
    return {
      id: f.fileId || '',
      name: f.fileName || '',
      isDir: (f.dirType | 0) === 1,     // dirType 1=文件夹
      size: f.fileSize || f.size || 0,
      ctime: f.ctime || 0,
      utime: f.utime || 0,
      resType: f.resType || 0,
    };
  });
  return { total: d.total || list.length, list: list };
}

// 新建文件夹
async function gyaMkdir(parentId, name) {
  const r = await gyaFileApi('/nd.bizuserres.s/v1/file/create_dir', {
    parentId: parentId || '', dirName: name, failIfNameExist: false,
  });
  if (!r.ok) throw new Error(r.error);
  return { ok: true };
}

// 重命名
async function gyaRename(fileId, newName) {
  const r = await gyaFileApi('/nd.bizuserres.s/v1/file/rename', {
    fileId: fileId, newName: newName,
  });
  if (!r.ok) throw new Error(r.error);
  return { ok: true };
}

// 删除（多个）
async function gyaDelete(fileIds) {
  const ids = Array.isArray(fileIds) ? fileIds : [fileIds];
  const r = await gyaFileApi('/nd.bizuserres.s/v1/file/delete_file', { fileIds: ids });
  if (!r.ok) throw new Error(r.error);
  return { ok: true, count: ids.length };
}

// 获取下载直链
async function gyaDownloadUrl(fileId) {
  const r = await gyaFileApi('/nd.bizuserres.s/v1/get_res_download_url', { fileId: fileId });
  if (!r.ok) throw new Error(r.error);
  const d = r.data || {};
  // 常见字段：url / downloadUrl / link
  return d.url || d.downloadUrl || d.link || (typeof d === 'string' ? d : '');
}

// 回收站列表（dirType=4 表示回收站）
async function gyaRecycleList() {
  const r = await gyaFileApi('/nd.bizuserres.s/v1/file/get_file_list', {
    parentId: '', page: 0, pageSize: 200, orderBy: 3, sortType: 1,
    fileTypes: [], dirType: 4,
  });
  if (!r.ok) throw new Error(r.error);
  const d = r.data || {};
  return (d.list || []).map(function (f) {
    return {
      id: f.fileId || '', name: f.fileName || '',
      isDir: (f.dirType | 0) === 1, size: f.fileSize || 0, ctime: f.ctime || 0,
    };
  });
}

// 清空回收站（彻底删除）
async function gyaClearRecycle() {
  const items = await gyaRecycleList();
  if (!items.length) return { ok: true, count: 0 };
  const ids = items.map(function (i) { return i.id; }).filter(Boolean);
  if (!ids.length) return { ok: true, count: 0 };
  // 回收站内删除 = 彻底删除
  const r = await gyaFileApi('/nd.bizuserres.s/v1/file/delete_file', { fileIds: ids });
  if (!r.ok) throw new Error(r.error);
  return { ok: true, count: ids.length };
}

// 业务域错误文案（业务接口用 {code, msg}，与账号域的 RPC 风格不同）
function gyaBusinessErr(j) {
  if (!j) return '返回为空';
  if (j.msg && j.msg !== 'success') return j.msg;
  if (j.message) return j.message;
  if (j.error_description) return gyaErrText(j);
  if (j.error) return String(j.error);
  if (j.code != null) return 'code ' + j.code;
  return JSON.stringify(j).slice(0, 160);
}

// 带 token 调业务 API；401 / 认证失效自动续期一次
async function gyaApi(pathname, body) {
  const s = ndSession.guangya;
  if (!s.token) throw new Error('光鸭未登录');
  const call = async (tk) => ndRequest(GY_API_BASE + pathname, {
    method: 'POST',
    headers: gyaBaseHeaders({
      'Authorization': 'Bearer ' + tk, 'accessToken': tk,
      'Did': s.deviceId || '', 'Dt': '4',
    }),
    body: JSON.stringify(body || {}),
  });
  let r = await call(s.token);
  let j = ndParseJson(r.body);
  const txt = String((j && (j.error || j.error_description || j.msg)) || '');
  const bad = !j || r.status === 401 || /unauthenticated|无效token|invalid.?token|token expir|认证失败/i.test(txt);
  if (bad && s.refreshToken) {
    try {
      await gyaRefresh();
      r = await call(s.token);
      j = ndParseJson(r.body);
    } catch (e) {
      log('ND', '光鸭续期失败: ' + e.message);
    }
  }
  if (!j) throw new Error('光鸭接口返回非 JSON（HTTP ' + r.status + '）');
  return j;
}



// 统一登录态查询（不含敏感字段）
function ndStatus() {
  const s115 = ndSession['115'], sg = ndSession.guangya, s123 = ndSession['123'];
  return {
    '115': { ok: !!s115.ok, user: s115.user || '', savedAt: s115.savedAt || 0, hasCookie: !!s115.cookie },
    '123': { ok: !!s123.ok, user: s123.user || '', savedAt: s123.savedAt || 0, hasToken: !!s123.token, hasSavedPassword: !!s123.password },
    guangya: { ok: !!sg.ok, user: sg.user || '', savedAt: sg.savedAt || 0, hasToken: !!sg.token, hasRefresh: !!sg.refreshToken },
  };
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
      pansouUrl: process.env.PANSOU_URL || f.pansouUrl || PANSOU_DEFAULT_URL,
      gyingUrl: gySiteBase(),
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

  // ---------- PanSou 盘搜转发 ----------
  // /__proxy/pansou/search?kw=xxx[&cloud_types=123,quark][&filter={...}][&src=all|tg|plugin]
  // /__proxy/pansou/health
  // 上游地址默认 47.101.197.200:8788，可用 PANSOU_URL 环境变量 / config.json 的 pansouUrl 覆盖。
  if (reqUrl.pathname === '/__proxy/pansou/search' || reqUrl.pathname === '/__proxy/pansou/health') {
    // 地址来源优先级：页面显式指定(upstream) > 环境变量 > config.json > 内置默认
    // 页面指定时做安全校验，避免本代理被当成任意 URL 转发器（SSRF）。
    let upstreamBase = process.env.PANSOU_URL || readConfigFile().pansouUrl || PANSOU_DEFAULT_URL;
    const pageUpstream = reqUrl.searchParams.get('upstream');
    if (pageUpstream) {
      if (!isAllowedUpstream(pageUpstream)) {
        return sendJSON(res, 400, {
          code: -1,
          message: '不允许的盘搜地址（仅允许公网 http/https 地址，且禁止内网/回环地址）',
        });
      }
      upstreamBase = pageUpstream;
    }
    upstreamBase = upstreamBase.replace(/\/+$/, '');
    let pu;
    try {
      pu = new URL(upstreamBase);
    } catch (e) {
      return sendJSON(res, 500, { code: -1, message: 'PanSou 地址不合法: ' + upstreamBase });
    }
    if (pu.protocol !== 'http:' && pu.protocol !== 'https:') {
      return sendJSON(res, 400, { code: -1, message: '盘搜地址必须是 http/https' });
    }
    const apiPath = reqUrl.pathname === '/__proxy/pansou/health' ? '/api/health' : '/api/search';
    const upstream = new URL(pu.origin + apiPath);
    // 白名单透传查询参数，避免变成任意 URL 转发器
    const ALLOW = ['kw', 'res', 'src', 'cloud_types', 'filter', 'channels', 'plugins', 'ext', 'conc', 'refresh'];
    reqUrl.searchParams.forEach((v, k) => {
      if (ALLOW.indexOf(k) >= 0) upstream.searchParams.set(k, v);
    });
    if (apiPath === '/api/search' && !upstream.searchParams.get('kw')) {
      return sendJSON(res, 400, { code: -1, message: '缺少 kw 参数（搜索关键词）' });
    }
    return proxy(upstream.toString(), req, res, PANSOU_TIMEOUT_MS);
  }

  // ---------- 网盘离线下载（115 / 光鸭） ----------
  // GET  /__proxy/netdisk/status                     各网盘登录态
  // POST /__proxy/netdisk/115/login   {cookie}       保存 115 cookie 并校验
  // POST /__proxy/netdisk/115/logout                 清除 115 登录态
  // POST /__proxy/netdisk/gy/send_code {phone}       光鸭：发送短信验证码
  // POST /__proxy/netdisk/gy/login     {phone,code}  光鸭：短信登录换 token
  // POST /__proxy/netdisk/gy/logout                  光鸭：清除登录态
  // POST /__proxy/netdisk/offline      {disk,urls[]} 提交离线任务
  if (reqUrl.pathname.indexOf('/__proxy/netdisk/') === 0) {
    const action = reqUrl.pathname.slice('/__proxy/netdisk/'.length);
    const bodyOf = (fn) => readBody(req)
      .then((raw) => {
        let b = {};
        try { b = JSON.parse(raw); } catch (e) { return sendJSON(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }
        return fn(b);
      })
      .catch((e) => { if (!res.headersSent) sendJSON(res, 400, { ok: false, error: e.message }); });

    if (action === 'status') {
      return sendJSON(res, 200, Object.assign({ ok: true }, ndStatus()));
    }

    if (action === '115/login') {
      return bodyOf(async (b) => {
        const cookie = String(b.cookie || '').trim();
        if (!cookie) return sendJSON(res, 400, { ok: false, error: '请粘贴 115 的 Cookie' });
        if (!nd115CookieOk(cookie)) {
          return sendJSON(res, 400, { ok: false, error: 'Cookie 不完整：需至少包含 UID、CID、SEID 三项' });
        }
        try {
          await nd115Probe(cookie);
        } catch (e) {
          return sendJSON(res, 200, { ok: false, error: '校验失败：' + e.message });
        }
        const s = ndSession['115'];
        s.cookie = cookie; s.ok = true; s.savedAt = Date.now();
        // 用户名从 cookie 里能拿到的信息有限，用 UID 的后 4 位做个标识
        const m = /(^|;\s*)UID=(\d+)/.exec(cookie);
        s.user = m ? 'UID…' + m[2].slice(-4) : '115 用户';
        ndSaveSession();
        log('ND', '115 登录成功');
        return sendJSON(res, 200, { ok: true, user: s.user });
      });
    }

    if (action === '115/logout') {
      const s = ndSession['115'];
      s.cookie = ''; s.user = ''; s.ok = false; s.savedAt = 0;
      ndSaveSession();
      return sendJSON(res, 200, { ok: true });
    }

    // 光鸭：设备码 OAuth2（扫码/点链接授权）
    if (action === 'gy/device_code') {
      return gyaDeviceCode()
        .then((r) => sendJSON(res, 200, r))
        .catch((e) => {
          log('ND', '光鸭申请设备码失败: ' + e.message);
          sendJSON(res, 200, { ok: false, error: e.message });
        });
    }

    if (action === 'gy/poll') {
      return gyaPollDevice()
        .then((r) => sendJSON(res, 200, r))
        .catch((e) => {
          log('ND', '光鸭轮询失败: ' + e.message);
          sendJSON(res, 200, { ok: false, error: e.message });
        });
    }

    if (action === 'gy/logout') {
      const s = ndSession.guangya;
      s.token = ''; s.refreshToken = ''; s.user = ''; s.ok = false;
      s.savedAt = 0; s.tokenAt = 0; s.tokenExpiresAt = 0;
      gyaDevice = null;
      ndSaveSession();
      return sendJSON(res, 200, { ok: true });
    }

    // ---------- 123 云盘（账号密码登录 + 文件管理） ----------
    // POST /__proxy/netdisk/123/login    {account,password}
    // POST /__proxy/netdisk/123/logout
    // GET  /__proxy/netdisk/123/user     用户信息（校验登录态）
    // GET  /__proxy/netdisk/123/files?parentId=        列目录
    // POST /__proxy/netdisk/123/mkdir    {parentId,name}
    // POST /__proxy/netdisk/123/rename   {fileId,name}
    // POST /__proxy/netdisk/123/delete   {items[]}      入回收站
    // POST /__proxy/netdisk/123/purge    {fileIds[]}    彻底删除
    // POST /__proxy/netdisk/123/download {file}         取直链
    if (action.indexOf('123/') === 0) {
      const sub = action.slice(4);
      const guard = (fn) => Promise.resolve()
        .then(fn)
        .then((r) => sendJSON(res, 200, Object.assign({ ok: true }, r)))
        .catch((e) => sendJSON(res, 200, { ok: false, error: e.message }));

      if (sub === 'logout') {
        const s = ndSession['123'];
        s.token = ''; s.user = ''; s.password = ''; s.account = ''; s.ok = false; s.savedAt = 0;
        ndSaveSession();
        return sendJSON(res, 200, { ok: true });
      }
      if (sub === 'user') {
        return guard(async () => {
          const s = ndSession['123'];
          if (!s.ok || !s.token) throw new Error('请先登录 123 云盘');
          const info = await p123UserInfo();
          if (!info) throw new Error('123 登录态已失效，请重新登录');
          if (info.name && info.name !== s.user) { s.user = info.name; ndSaveSession(); }
          return { user: info.name || s.user, space: info.space, spacePermanent: info.spacePermanent };
        });
      }
      // 列出子文件夹（供「选择转存目标目录」用）
      if (sub === 'folders') {
        return guard(async () => {
          const s = ndSession['123'];
          if (!s.ok || !s.token) throw new Error('请先登录 123 云盘');
          const pid = reqUrl.searchParams.get('parentId') || '';
          const list = await p123Folders(pid);
          return { parentId: pid, list: list };
        });
      }
      // 分享预览：解析分享链接，返回文件数量/大小（前端展示确认）
      // body { url }
      if (sub === 'share_preview') {
        return readBody(req).then(async (raw) => {
          let bb = {}; try { bb = JSON.parse(raw); } catch (e) {}
          const s = ndSession['123'];
          if (!s.ok || !s.token) return sendJSON(res, 200, { ok: false, error: '请先登录 123 云盘' });
          try {
            const p = p123ParseShareUrl(bb.url);
            if (!p) return sendJSON(res, 200, { ok: false, error: '无法识别 123 分享链接' });
            const r = await p123SharePreview(p.shareKey, p.sharePwd);
            return sendJSON(res, 200, Object.assign({ ok: true, shareKey: p.shareKey, sharePwd: p.sharePwd }, r));
          } catch (e) {
            return sendJSON(res, 200, { ok: false, error: e.message });
          }
        });
      }
      // 分享转存：把分享内容保存到指定目录
      // body { url, parentId, path?[] }  path = 在目标下新建的子目录层级
      if (sub === 'share_transfer') {
        return readBody(req).then(async (raw) => {
          let bb = {}; try { bb = JSON.parse(raw); } catch (e) {}
          const s = ndSession['123'];
          if (!s.ok || !s.token) return sendJSON(res, 200, { ok: false, error: '请先登录 123 云盘' });
          try {
            const p = p123ParseShareUrl(bb.url);
            if (!p) return sendJSON(res, 200, { ok: false, error: '无法识别 123 分享链接' });
            // 目标目录：先建可选子目录，再转存
            let dest = bb.parentId || '';
            if (bb.path && bb.path.length) dest = await p123EnsurePath(dest, bb.path);
            const r = await p123ShareTransfer(p.shareKey, p.sharePwd, dest, { maxFiles: bb.maxFiles || 300 });
            log('ND', '123 分享转存完成：成功 ' + r.added + '，失败 ' + r.failed.length);
            return sendJSON(res, 200, {
              ok: true, added: r.added, failed: r.failed,
              failedCount: r.failed.length, targetId: r.targetId,
            });
          } catch (e) {
            return sendJSON(res, 200, { ok: false, error: e.message });
          }
        });
      }
      // 转存：把解析出的文件秒传到指定目录
      // body { content?:string(秒传链接/JSON), items?:[{etag,size,fileName}], parentId, path?:string[] }
      if (sub === 'transfer') {
        return readBody(req).then(async (raw) => {
          let bb = {};
          try { bb = JSON.parse(raw); } catch (e) {}
          const s = ndSession['123'];
          if (!s.ok || !s.token) return sendJSON(res, 200, { ok: false, error: '请先登录 123 云盘' });
          try {
            let items = Array.isArray(bb.items) ? bb.items : [];
            if (!items.length && bb.content) items = p123ParseFlashLink(bb.content);
            if (!items.length) return sendJSON(res, 200, { ok: false, error: '没有解析到可转存的文件（需要含 etag 的秒传链接或 JSON）' });
            const r = await p123Transfer(items, bb.parentId || '', bb.path || []);
            log('ND', '123 转存 ' + items.length + ' 个，成功 ' + r.added);
            return sendJSON(res, 200, Object.assign({ ok: true, total: items.length }, r));
          } catch (e) {
            return sendJSON(res, 200, { ok: false, error: e.message });
          }
        });
      }
      // 批量转存（一次多个来源）
      if (sub === 'transfer_batch') {
        return readBody(req).then(async (raw) => {
          let bb = {};
          try { bb = JSON.parse(raw); } catch (e) {}
          const s = ndSession['123'];
          if (!s.ok || !s.token) return sendJSON(res, 200, { ok: false, error: '请先登录 123 云盘' });
          try {
            const groups = Array.isArray(bb.groups) ? bb.groups : [];
            if (!groups.length) return sendJSON(res, 200, { ok: false, error: '没有要转存的内容' });
            let added = 0, total = 0;
            const failed = [];
            for (const g of groups) {
              const items = g.items || p123ParseFlashLink(g.content || '');
              total += items.length;
              const r = await p123Transfer(items, bb.parentId || '', (bb.path || []).concat(g.path || []));
              added += r.added;
              failed.push.apply(failed, r.failed);
            }
            log('ND', '123 批量转存 ' + total + ' 个，成功 ' + added);
            return sendJSON(res, 200, { ok: true, added: added, total: total, failed: failed });
          } catch (e) {
            return sendJSON(res, 200, { ok: false, error: e.message });
          }
        });
      }
      if (sub === 'files') {
        return guard(async () => {
          const s = ndSession['123'];
          if (!s.ok || !s.token) throw new Error('请先登录 123 云盘');
          const list = await p123List(reqUrl.searchParams.get('parentId') || '0');
          return { list: list, total: list.length };
        });
      }
      return bodyOf((b) => {
        if (sub === 'login') {
          return guard(async () => {
            const r = await p123Login(b.account, b.password);
            // 登录成功后再拉一次用户信息（顺便验证 token 可用）
            try {
              const info = await p123UserInfo();
              if (info && info.name) {
                ndSession['123'].user = info.name;
                ndSaveSession();
              }
            } catch (e) {}
            return r;
          });
        }
        if (sub === 'token') {
          return guard(() => p123LoginByToken(b.token));
        }
        if (sub === 'mkdir') {
          return guard(async () => {
            const s = ndSession['123'];
            if (!s.ok || !s.token) throw new Error('请先登录 123 云盘');
            if (!b.name) throw new Error('请填写文件夹名');
            return await p123Mkdir(b.parentId || '0', b.name);
          });
        }
        if (sub === 'rename') {
          return guard(async () => {
            const s = ndSession['123'];
            if (!s.ok || !s.token) throw new Error('请先登录 123 云盘');
            if (!b.fileId || !b.name) throw new Error('缺少 fileId 或新名称');
            return await p123Rename(b.fileId, b.name);
          });
        }
        if (sub === 'delete') {
          return guard(async () => {
            const s = ndSession['123'];
            if (!s.ok || !s.token) throw new Error('请先登录 123 云盘');
            const items = Array.isArray(b.items) ? b.items : (b.items ? [b.items] : []);
            if (!items.length) throw new Error('缺少要删除的文件');
            return await p123Trash(items);
          });
        }
        if (sub === 'purge') {
          return guard(async () => {
            const s = ndSession['123'];
            if (!s.ok || !s.token) throw new Error('请先登录 123 云盘');
            if (!b.fileIds) throw new Error('缺少 fileIds');
            return await p123Purge(b.fileIds);
          });
        }
        if (sub === 'download') {
          return guard(async () => {
            const s = ndSession['123'];
            if (!s.ok || !s.token) throw new Error('请先登录 123 云盘');
            if (!b.file) throw new Error('缺少文件信息');
            const url = await p123DownloadUrl(b.file);
            return { url: url };
          });
        }
        return sendJSON(res, 404, { ok: false, error: '未知的 123 接口: ' + sub });
      });
    }

    // ---------- 光鸭文件管理 ----------
    // GET  /__proxy/netdisk/gy/files?parentId=&page=   列目录
    // GET  /__proxy/netdisk/gy/assets                  空间信息
    // GET  /__proxy/netdisk/gy/recycle                 回收站
    // POST /__proxy/netdisk/gy/mkdir   {parentId,name}
    // POST /__proxy/netdisk/gy/rename  {fileId,name}
    // POST /__proxy/netdisk/gy/delete  {fileIds[]}
    // POST /__proxy/netdisk/gy/download {fileId}       取直链
    // POST /__proxy/netdisk/gy/clear_recycle           清空回收站
    if (action.indexOf('gy/files') === 0 || action === 'gy/assets' || action === 'gy/recycle' ||
        action.indexOf('gy/mkdir') === 0 || action.indexOf('gy/rename') === 0 ||
        action.indexOf('gy/delete') === 0 || action.indexOf('gy/download') === 0 ||
        action === 'gy/clear_recycle') {
      const guard = (fn) => Promise.resolve()
        .then(fn)
        .then((r) => sendJSON(res, 200, Object.assign({ ok: true }, r)))
        .catch((e) => sendJSON(res, 200, { ok: false, error: e.message }));

      if (action === 'gy/assets') return guard(() => gyaAssets());
      if (action === 'gy/recycle') return guard(() => gyaRecycleList());
      if (action === 'gy/clear_recycle') return guard(() => gyaClearRecycle());
      if (action.indexOf('gy/files') === 0) {
        return guard(() => gyaList(
          reqUrl.searchParams.get('parentId') || '',
          parseInt(reqUrl.searchParams.get('page') || '0', 10)
        ));
      }
      return bodyOf((b) => {
        if (action.indexOf('gy/mkdir') === 0) {
          if (!b.name) return sendJSON(res, 400, { ok: false, error: '请填写文件夹名' });
          return guard(() => gyaMkdir(b.parentId, b.name));
        }
        if (action.indexOf('gy/rename') === 0) {
          if (!b.fileId || !b.name) return sendJSON(res, 400, { ok: false, error: '缺少 fileId 或新名称' });
          return guard(() => gyaRename(b.fileId, b.name));
        }
        if (action.indexOf('gy/delete') === 0) {
          if (!b.fileIds) return sendJSON(res, 400, { ok: false, error: '缺少 fileIds' });
          return guard(() => gyaDelete(b.fileIds));
        }
        if (action.indexOf('gy/download') === 0) {
          if (!b.fileId) return sendJSON(res, 400, { ok: false, error: '缺少 fileId' });
          return guard(async () => {
            const url = await gyaDownloadUrl(b.fileId);
            if (!url) throw new Error('未取到下载直链');
            return { url: url };
          });
        }
        return sendJSON(res, 404, { ok: false, error: '未知的文件操作: ' + action });
      });
    }

    if (action === 'offline') {
      return bodyOf(async (b) => {
        const disk = String(b.disk || '').trim();
        let urls = Array.isArray(b.urls) ? b.urls : (b.url ? [b.url] : []);
        urls = urls.map((u) => String(u || '').trim()).filter(Boolean);
        if (!urls.length) return sendJSON(res, 400, { ok: false, error: '缺少要离线的链接' });
        // 磁力与 http(s) 两种都放行（115 对磁力支持良好）
        const bad = urls.find((u) => !/^(magnet:|https?:\/\/)/i.test(u));
        if (bad) return sendJSON(res, 400, { ok: false, error: '不支持的链接格式：' + String(bad).slice(0, 40) });

        if (disk === '115') {
          const s = ndSession['115'];
          if (!s.ok || !s.cookie) return sendJSON(res, 200, { ok: false, needLogin: '115', error: '请先登录 115' });
          try {
            const r = await nd115Offline(s.cookie, urls, { pathId: b.pathId });
            log('ND', '115 离线提交 ' + urls.length + ' 条，新增 ' + r.added + (r.dup ? '，重复 ' + r.dup : ''));
            return sendJSON(res, 200, { ok: true, disk: '115', added: r.added, dup: r.dup, total: urls.length });
          } catch (e) {
            // cookie 失效 → 标记需重登
            if (/登录|过期|invalid|未登录/i.test(e.message)) {
              s.ok = false;
              return sendJSON(res, 200, { ok: false, needLogin: '115', error: e.message });
            }
            return sendJSON(res, 200, { ok: false, error: e.message });
          }
        }

        if (disk === 'guangya') {
          const s = ndSession.guangya;
          if (!s.ok || !s.token) return sendJSON(res, 200, { ok: false, needLogin: 'guangya', error: '请先登录光鸭' });
          let added = 0; const errs = [];
          for (const u of urls) {
            try {
              const j = await gyaApi('/nd.bizcloudcollection.s/v1/create_task', {
                url: u,
                parentId: b.parentId || '',
              });
              // 成功：{"msg":"success","data":{"taskId":...}}
              // 失败：{"code":352,"msg":"BT文件不存在"} 或 {error:...}
              const okTask = j && j.msg === 'success' && j.data && j.data.taskId;
              if (okTask) added++;
              else errs.push(gyaBusinessErr(j));
            } catch (e) {
              errs.push(e.message);
            }
          }
          if (!added && errs.length) {
            const needLogin = /token|登录|授权|过期|unauthenticated/i.test(errs.join(' '));
            if (needLogin) s.ok = false;
            log('ND', '光鸭离线失败: ' + errs[0]);
            return sendJSON(res, 200, { ok: false, needLogin: needLogin ? 'guangya' : '', error: errs[0] });
          }
          log('ND', '光鸭离线提交 ' + urls.length + ' 条，成功 ' + added);
          return sendJSON(res, 200, {
            ok: true, disk: 'guangya', added: added, total: urls.length,
            error: errs.length ? (errs.length + ' 条失败：' + errs[0]) : '',
          });
        }

        return sendJSON(res, 400, { ok: false, error: '未知网盘: ' + disk });
      });
    }

    return sendJSON(res, 404, { ok: false, error: '未知的网盘接口: ' + action });
  }

  // ---------- 观影（教父.com / xn--wcv59z.com）直连转发 ----------
  // 代理内自行完成 ① PoW 工作量验证 ② 表单登录，并持有会话。
  // 站点地址可用 ?site= 覆盖（含 SSRF 校验），便于不改配置就换地址。
  // /__proxy/gy/status   GET                       查询登录状态
  // /__proxy/gy/login    POST {username,password} 登录（内部过 PoW）
  // /__proxy/gy/logout   POST                      清除会话
  // /__proxy/gy/search   GET ?kw=xxx               搜索（登录后）
  if (reqUrl.pathname.indexOf('/__proxy/gy/') === 0) {
    const action = reqUrl.pathname.slice('/__proxy/gy/'.length);

    const siteOverride = reqUrl.searchParams.get('site');
    if (siteOverride && !isAllowedUpstream(siteOverride)) {
      return sendJSON(res, 400, { ok: false, error: '观影站点地址不合法（必须是公网 http/https，禁止内网/回环）' });
    }

    if (action === 'status') {
      return sendJSON(res, 200, gyStatus());
    }
    // 预热：页面打开时调用，让登录态在用户搜索前就恢复
    if (action === 'warmup') {
      return gyWarmup()
        .then((r) => sendJSON(res, 200, Object.assign({ ok: true }, gyStatus(), r)))
        .catch((e) => sendJSON(res, 200, Object.assign({ ok: false, error: e.message }, gyStatus())));
    }
    if (action === 'logout') {
      return gyLogout()
        .then((r) => sendJSON(res, 200, Object.assign({ loggedIn: false }, r)))
        .catch((e) => sendJSON(res, 502, { ok: false, error: e.message }));
    }
    if (action === 'login') {
      return readBody(req)
        .then((raw) => {
          let body;
          try { body = JSON.parse(raw); } catch (e) {
            return sendJSON(res, 400, { ok: false, error: '请求体不是合法 JSON' });
          }
          const username = String(body.username || '').trim();
          const password = String(body.password || '');
          if (!username || !password) {
            return sendJSON(res, 400, { ok: false, error: '请填写用户名和密码' });
          }
          return gyLogin(username, password, { fresh: true })
            .then((r) => sendJSON(res, 200, r))
            .catch((e) => sendJSON(res, 502, { ok: false, error: e.message }));
        })
        .catch((e) => {
          if (!res.headersSent) sendJSON(res, 400, { ok: false, error: e.message });
        });
    }
    if (action === 'search') {
      const kw = reqUrl.searchParams.get('kw') || '';
      if (!kw) return sendJSON(res, 400, { ok: false, error: '缺少 kw 参数' });
      return gySearch(kw)
        .then((r) => sendJSON(res, 200, r))
        .catch((e) => sendJSON(res, 502, { ok: false, error: e.message }));
    }
    return sendJSON(res, 404, { ok: false, error: '未知的观影接口: ' + action });
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
  const dirOk =   ensureDataDir();
  gyLoadSession();   // 恢复上次的观影登录态与保存的账号
  ndLoadSession();   // 恢复上次的网盘（115 / 光鸭）登录态
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
