# 部署说明

一句话形态：**一个 Node 进程同时托管页面、`/ws` 和 `/health`**，不需要单独的静态服务器或反向代理也能跑。生产建议放在它前面加一层 Nginx/Caddy 处理 TLS。

## 先看这两条硬约束

1. **只能单实例。** 房间、对局、断线宽限期全部存在进程内存里（`server/room_manager.js`、`server/match_manager.js`），没有数据库。多副本 + 负载均衡会让同一房间的两个玩家落到不同进程，表现是"创建成功但对手永远进不来"。重启进程 = 所有房间清空，这在对局中途是明确的失败，不要在比赛期间滚动重启。
2. **页面和 WebSocket 必须同源同进程。** 服务端给静态资源发 `Cross-Origin-Opener-Policy: same-origin` 和 `Cross-Origin-Embedder-Policy: require-corp`，这是 ziap WASM 共享内存（`crossOriginIsolated`）的前提。把前端挂到 GitHub Pages / 对象存储上，这两个响应头拿不到，"智能 15 步"会静默降级成 JavaScript 求解器（能用，但慢很多）。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址，容器里保持默认 |
| `ALLOWED_ORIGINS` | 空 | 额外允许的跨域来源，逗号分隔、不带尾部斜杠。**同源部署不要设**，见上面第 2 条 |
| `MATCH_TARGET_TILE` | `2048` | 对局目标方块 |
| `MATCH_DURATION_MS` | `480000` | 对局时长，8 分钟 |

## 方式一：Docker

仓库自带 `Dockerfile`（`node:22-alpine`、只装生产依赖、非 root 用户、内置 `/health` 健康检查）：

```bash
docker build -t remote2048 .
docker run -d --name remote2048 -p 3000:3000 --restart unless-stopped remote2048
```

换端口和演示参数：

```bash
docker run -d --name remote2048 -p 8080:3000 --restart unless-stopped \
  -e MATCH_TARGET_TILE=512 -e MATCH_DURATION_MS=180000 remote2048
```

状态检查与升级：

```bash
docker logs -f remote2048          # 启动后打印“2048 服务已启动：http://localhost:3000”
docker inspect --format '{{.State.Health.Status}}' remote2048   # healthy
docker stop remote2048 && docker rm remote2048   # 会走 SIGTERM 优雅退出
```

## 方式二：直接跑 Node（VPS）

Node.js 18 以上，建议 22 LTS。**不要装 devDependencies**：`style/main.css` 已经提交，运行期不需要 Dart Sass。

```bash
git clone git@github.com:Tech-luoyi/Remote2048.git
cd Remote2048
npm ci --omit=dev
PORT=3000 NODE_ENV=production npm start
```

用 systemd 托管：

```ini
# /etc/systemd/system/remote2048.service
[Unit]
Description=Remote2048
After=network.target

[Service]
WorkingDirectory=/srv/Remote2048
ExecStart=/usr/bin/node server/server.js
Environment=NODE_ENV=production
Environment=PORT=3000
User=www-data
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now remote2048
curl -s localhost:3000/health        # {"status":"ok","protocolVersion":1}
```

## 反向代理与 HTTPS

浏览器端 WebSocket 地址是**同源推导**的（`js/websocket_client.js`）：HTTPS 页面自动用 `wss://同域/ws`，无需任何配置。你只需要把 `/ws` 的升级头透传上去。

Caddy（自动申请证书，自动处理 Upgrade，最省事）：

```caddyfile
example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Nginx：

```nginx
# 放在 http {} 里：只在真的带 Upgrade 时才转发 Connection 头
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl http2;
    server_name example.com;

    # ssl_certificate / ssl_certificate_key ...

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        # 对局期间没有请求体，但长连接的读超时要留够，否则 60 秒就被掐断
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_buffering off;
    }

    location = /health {
        proxy_pass http://127.0.0.1:3000/health;
        access_log off;
    }
}
```

代理层要守住的三件事：

- **不要剥掉或改写 `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy`。** Nginx 和 Caddy 默认原样透传；会出事的是 CDN 的 HTML 优化、Rocket Loader 一类的自动重写。上线后在浏览器控制台确认 `crossOriginIsolated === true`。
- **`/ws` 不能被缓存或做压缩缓冲。** 关掉对它的 `proxy_buffering`，别让 CDN 缓存 `/ws`。
- **健康检查打 `/health`**，它只返回一个小 JSON，不碰房间状态。

## 上线前检查清单

- [ ] `npm test` 全绿（含协议、房间、预测回滚、联机界面、CSS 一致性）
- [ ] `npm run check:css` 通过——本地改过 `style/main.scss` 的话，`style/main.css` 必须一起提交
- [ ] 服务器 Node ≥ 18，`npm ci --omit=dev` 装得干净（没有 `sass`）
- [ ] 只有一个实例在跑；`docker ps` / `systemctl status` 里没有第二个副本
- [ ] HTTPS 页面下控制台 `crossOriginIsolated === true`，"智能 15 步"走的是 WASM 而不是降级求解器
- [ ] 两个浏览器窗口至少完整打完一局（创建、加入、准备、倒计时、干扰、结算、再来一局）
- [ ] 手动验一次刷新重连：对局中刷新页面，能回到同一局且分数不丢
- [ ] 确认重启进程会清空房间，且已安排在无人对局的时间窗

## 演示配置

招新演示通常不需要打满 8 分钟：

```bash
PORT=3001 MATCH_TARGET_TILE=512 MATCH_DURATION_MS=180000 npm start
```

局域网演示直接用本机 IP 即可（默认 `HOST=0.0.0.0`），注意浏览器的共享内存要求安全上下文：`localhost` 或 HTTPS 才行，`http://192.168.x.x` 会降级成 JS 求解器。演示机上是同一个浏览器开两个窗口时，这点只影响"智能 15 步"的性能。

## 相关文档

- 协议、阶段划分与设计取舍：[技术方案](remote-duel-plan-zh.md)
- 本地运行、玩法与依赖说明：[README](../README.md)
