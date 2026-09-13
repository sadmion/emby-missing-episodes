# Emby 缺集检测工具
# 基于 Alpine + Node，镜像很小，容器内跑本地代理绕开浏览器 CORS
FROM node:22-alpine

LABEL org.opencontainers.image.title="Emby 缺集检测工具"
LABEL org.opencontainers.image.description="以 TMDB 官方集数为准，找出 Emby 库中缺少剧集的剧"

WORKDIR /app

# 只拷贝运行时需要的两个文件
COPY emby-proxy.js /app/emby-proxy.js
COPY emby-missing-episodes.html /app/emby-missing-episodes.html

# 健康检查：确认代理端口正常响应
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8787)+'/__health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

EXPOSE 8787

# 用 node 直接跑，不用 npm，避免多余依赖
CMD ["node", "/app/emby-proxy.js"]
