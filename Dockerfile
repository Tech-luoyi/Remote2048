# 运行期只需要 ws 一个依赖；样式已提交，镜像里不需要 Dart Sass。
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

WORKDIR /app

# 先装依赖：改业务代码不会让这一层缓存失效。
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 只复制运行需要的静态资源和 server/：页面、样式、脚本、图标、服务端。
# --chown 不是装饰：容器以 node 用户运行，而构建上下文里的文件权限原样保留
# （开发机上可能是 600 的 owner-only），不改属主会直接 EACCES 起不来。
COPY --chown=node:node index.html favicon.ico LICENSE.txt ./
COPY --chown=node:node js ./js
COPY --chown=node:node style ./style
COPY --chown=node:node meta ./meta
COPY --chown=node:node server ./server

# 进程不写磁盘（房间状态在内存里），所以可以用非 root 用户跑。
USER node
EXPOSE 3000

# 镜像里没有 curl，用 node 请求自己的 /health。
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT,path:'/health'},function(r){process.exit(r.statusCode===200?0:1)}).on('error',function(){process.exit(1)})"

# server.js 已处理 SIGTERM，docker stop 可以干净退出。
CMD ["node", "server/server.js"]
