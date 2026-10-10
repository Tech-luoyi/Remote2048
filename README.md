# 2048 数字合成

这是一个基于原生 HTML、CSS 和 JavaScript 的 2048 开源衍生版本。已完成共享纯逻辑、房间服务、权威对战协议、客户端预测恢复和联机界面接入：默认仍是单机，点页面底部的"联机对战"进入大厅，创建或加入房间后开打。

原版在线地址：[https://gabrielecirulli.github.io/2048/](https://gabrielecirulli.github.io/2048/)

## 本地运行

单机版本不需要构建工具或游戏引擎。直接在浏览器打开 `index.html` 即可游玩；也可以用任意静态 HTTP 服务托管项目目录。

服务端使用 Node.js 18 或更高版本，建议 Node.js 22 LTS。在项目目录运行：

```bash
npm ci
npm start
```

默认网页地址为 `http://localhost:3000`，WebSocket 地址为 `ws://localhost:3000/ws`，健康检查为 `/health`。使用 `HOST` 和 `PORT` 环境变量调整监听地址，默认 `HOST=0.0.0.0`，局域网内可用本机 IP 访问。

```bash
PORT=3001 npm start
```

WebSocket 默认允许与请求主机同源的 HTTP/HTTPS 页面，也允许没有 Origin 的命令行客户端。前后端分开部署时，通过 `ALLOWED_ORIGINS` 配置额外允许的完整来源，多个来源用逗号分隔，不带尾部斜杠。例如：

```bash
ALLOWED_ORIGINS=https://example.github.io npm start
```

协议支持 `hello`、`create_room`、`join_room`、`rejoin`、`ready`、`move`、`use_skill`、`rematch`、`resync` 和 `leave_room`。首次连接须先发 `hello`，所有消息带 `protocolVersion: 1`。双方准备后倒计时 3 秒，服务器计算各自棋盘和胜负，广播 `match_start`、`move_ack`、`opponent_update`、`skill_result`、`clock` 和 `match_end`；重连返回本人及对手的完整快照。详细字段与阶段边界见 [技术方案](docs/remote-duel-plan-zh.md)。

## 部署

一个 Node 进程同时托管页面、`/ws` 和 `/health`。房间和对局状态保存在进程内存里（没有数据库），因此**只能单实例运行**，重启会清空所有房间。Docker：

```bash
docker build -t remote2048 .
docker run -d -p 3000:3000 --restart unless-stopped remote2048
```

或者直接跑 Node（运行期不需要 `sass`）：

```bash
npm ci --omit=dev
PORT=3000 npm start
```

反向代理、HTTPS/wss、systemd 示例和上线检查清单见 [部署说明](docs/deploy-zh.md)。

## 干扰玩法

对局中每次产生合并就累积连击，连续 3 次合并获得 1 点能量（上限 2 点）。消耗 1 点能量可以向对手棋盘放一个数值为 `4` 的干扰块，冷却 3 秒。干扰块带珊瑚色描边，参与合并后消失，所以对手棋盘上最多同时存在一个。

位置和数值完全由服务端决定，客户端只能请求"花掉 1 点能量"。干扰是一次跨棋盘写入：对手收到 `skill_result` 后会作废全部推测状态，按服务端快照重建棋盘再重放未确认输入——这不是可选的优化，而是预测机制成立的前提，详见技术方案 §8。

能量不足、对手没有空位、对手已有干扰块或冷却未结束时，请求都会被拒绝且不扣能量。

## 对手棋盘与再来一局

主棋盘下方常驻一块只读的对手棋盘预览（刻意做得比主棋盘小，作用是让玩家知道对手在做什么），显示对手最大方块，干扰块同样用珊瑚色描边标出。

结算后可以点"再来一局"：双方都同意才开新局，房间码不变但会重新发牌，分数、能量、冷却全部归零。点错可以再点一次撤销。对手不在线时按钮置灰。

默认目标为 2048、时长为 8 分钟。演示时可调整：

```bash
PORT=3001 MATCH_TARGET_TILE=512 MATCH_DURATION_MS=180000 npm start
```

客户端模块为 `js/websocket_client.js`、`js/multiplayer_manager.js` 和 `js/duel_controller.js`。前两者负责安全的 WebSocket 地址、会话内 token、自动重连、最多 8 步预测，以及拒绝、确认超时和权威快照后的回滚；`js/duel_controller.js` 负责大厅 / 等待 / 对局 / 结算四屏的状态切换和按钮绑定，入口是页面底部的"联机对战"。联机状态不写入单机存档。

运行全部检查，或只运行房间协议检查：

```bash
npm test
npm run test:protocol
npm run test:match
npm run test:solver
```

阶段一的纯逻辑检查也可以单独运行，只依赖 Node.js 内置模块：

```bash
node test/logic.test.js
```

共享逻辑位于 `js/game_logic.js`，浏览器通过 UMD 全局对象加载，Node.js 可以直接 `require`。它负责棋盘状态、移动、合并、计分、确定性随机、干扰块和状态哈希；页面适配器位于 `js/game_manager.js`。

## 样式维护

`style/main.scss` 是唯一的页面样式源文件。安装依赖后，运行 `npm run build:css` 生成浏览器使用的 `style/main.css`，或运行 `npm run watch:css` 自动编译。两个文件一起提交；`npm run check:css` 和 `npm test` 会检查它们是否一致。构建只使用本地 Dart Sass，不需要 Ruby 或全局安装工具。浏览器直接打开页面时不需要构建。

WebSocket 发送队列上限为 64 KB，连续超限 30 次的连接会被终止；偶发限流仍返回关联的 `RATE_LIMITED`，恢复额度后可继续请求。

## 操作方式

- 使用方向键、WASD 或 HJKL 移动方块；
- 手机端可以在棋盘上滑动；
- 两个相同数字相碰时会合并；
- 达到目标方块后可以选择继续挑战；
- 联机对局中能量足够时可以释放干扰，冷却结束前按钮保持禁用；
- 对局中可随时查看对手棋盘预览，结算后可与对手约定再来一局；
- 点击棋盘下方的“智能 15 步”自动移动，执行时再次点击可停止；执行期间方向键和滑动暂停，重启会取消道具。

动效采用方块滑入、接触后轻微回弹及分数栏反馈，保留原版暖色。每次得分都会在分数栏下方显示 `+N` 上浮淡出，连续得分只保留最新一条，无得分的移动让飞字继续播完。重启、窗口缩放和关闭动效会统一清理动画；系统减少动态效果优先于页面开关。`npm run test:ui` 覆盖桌面与移动端格距、合并时序、15 步连播、同帧操作、加分飞字和取消清理。

智能道具目前接入单机模式，可以重复使用。它用 Expectimax 期望搜索评估随机生成的 2/4 和后续局面，每一步重新计算方向；每批执行 15 次有效移动，合成 2048 后自动继续挑战，无路可走时提前结束。自动模式按约 175 毫秒的步进节奏运行，搜索耗时计入间隔；计算更慢时等待搜索完成，方块动画同步两倍速。算法只使用可见棋盘，不查看随机种子；有限深度的搜索提供近似最优方向，不保证整局最优或必胜。

HTTP 页面优先使用 [ziap/2048-ai](https://github.com/ziap/2048-ai) 的原版 WASM 与原版 worker pool，共享 64 MiB 内存，采用位棋盘、预计算查表、转置缓存和基于局面复杂度的搜索深度分配。默认按 `navigator.hardwareConcurrency` 使用计算线程；URL 的 `threads` 参数可覆盖，限制为 1–32（上游最多 31 个辅助线程）。正常停止和批次结束保留线程及缓存，每批首次搜索只调用上游的 `reset_depth`；重启棋盘或进入联机模式才释放。WASM 和源码随项目本地分发，不依赖 CDN。版本、许可证和重建说明见 [上游说明](js/vendor/ziap/UPSTREAM.md)。搜索预算、方向和返回 `-1` 时的轮换方向沿用上游，WASM 搜索无两秒强制中断。实际移动始终通过 `GameLogic.applyMove` 完成。

共享 WASM 内存需要安全上下文和跨源隔离；本项目服务端已发送 `Cross-Origin-Opener-Policy: same-origin` 和 `Cross-Origin-Embedder-Policy: require-corp`，通过 `localhost` 或 HTTPS 访问即可启用。使用其他静态服务器时也需要这两个响应头，否则自动使用 JavaScript 求解器。WASM 初始化失败、不支持相关特性、棋盘不是 4×4 或包含干扰块时同样降级；运行中的 WASM 搜索异常则停止道具。编码完全沿用上游：32768 对应 rank 15，更大的值和非二次幂也编码为 rank 15，这是原算法的表示限制，不再切换另一套算法。直接打开本地 HTML 或 Worker 不可用时，在页面内使用 JavaScript 求解器的较小预算。

JavaScript 降级求解器在 rank 空间（`log2(数值)`，0 表示空格）里操作扁平棋盘，自行实现滑动合并，把“合并”变成整数加一，因此评估时不必逐格求对数，也不必构造方块事件。节点预算只统计真实展开：转置表命中率很高，缓存命中若计入预算会把额度提前耗尽。改这套实现时先跑 `npm run test:solver`：它用 `test/fixtures/solver-decisions.json` 锁定固定搜索深度下的方向，防止优化悄悄改变棋力。

## 项目来源

本项目改编自 [gabrielecirulli/2048](https://github.com/gabrielecirulli/2048)，玩法受到 [1024](https://play.google.com/store/apps/details?id=com.veewo.a1024) 和 [Threes](https://asherv.com/threes/) 启发。原作者和贡献者信息见仓库历史记录及页面说明。

## 许可证

项目使用 [MIT License](LICENSE.txt)。许可证正文和原版权声明保持原文。
