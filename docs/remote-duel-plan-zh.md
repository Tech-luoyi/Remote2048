# 2048 远程双人对战方案 v3

## 1. 项目目标

在原版 2048 的基础上增加远程双人对战，同时保留单机模式。玩家通过房间码进入同一房间，各自操作自己的棋盘，在限定时间内竞争分数或率先合成 2048。

第一版的目标是：

- 浏览器直接打开即可游玩；
- 两名玩家可以通过房间码联机；
- 服务器负责计算棋盘、分数、随机生成和胜负；
- 所有游戏界面默认使用简体中文；
- 加入一个有实际对抗价值、规则明确的原创玩法；
- 支持招新现场使用两个浏览器快速演示。

第一版不追求账号、排位或长期数据，优先完成一局稳定、可重连、可解释的联机对战。

## 2. 当前源码与改造边界

源码来自 `gabrielecirulli/2048`，当前检出提交为 `478b6ec`，许可证为 MIT。

项目是原生 HTML、CSS 和 JavaScript，没有前端框架、构建工具或游戏引擎。当前关键文件如下：

| 文件 | 当前职责 | 联机改造方向 |
| --- | --- | --- |
| `js/game_manager.js` | 游戏状态、移动、合并、计分 | 改为单机适配器，调用共享逻辑 |
| `js/grid.js` | 旧版 `Grid` 棋盘对象 | 迁移期兼容适配层：在旧单机渲染链路与纯数据状态之间转换，不拥有权威状态 |
| `js/tile.js` | 旧版方块对象和动画运行时字段 | 视图/动画适配器：把逻辑状态和动画事件转换为渲染对象，不承载游戏规则或权威状态 |
| `js/html_actuator.js` | 棋盘、分数和结果渲染 | 增加对手状态、能量和连接状态 |
| `js/keyboard_input_manager.js` | 键盘、触摸输入 | 联机模式下发出移动事件 |
| `js/local_storage_manager.js` | 单机存档和最高分 | 联机模式不读写单机存档 |
| `js/application.js` | 浏览器启动入口 | 根据模式创建单机或联机控制器 |
| `index.html` | 页面结构和静态文案 | 增加房间、对手和技能面板 |
| `style/main.scss` | 样式源文件 | 在现有 `style/` 目录内扩展 |
| `style/main.css` | 浏览器实际加载的样式 | 由 `npm run build:css` 生成，提交前用 `npm run check:css` 校验 |

保留 `LICENSE.txt` 原文、原版权声明和原项目来源。许可证文件不参与中文化，不得翻译或改写许可条款。

## 3. 总体架构

```text
玩家 A 浏览器 ── WebSocket ──┐
                             ├── Node.js 对战服务器
玩家 B 浏览器 ── WebSocket ──┘          │
                                        ├── 房间生命周期
                                        ├── 权威游戏逻辑
                                        ├── 状态同步与重连
                                        └── 胜负与限流
```

### 前端

- 继续使用现有原生 JavaScript 和 CSS；
- 单机模式继续使用本地 `GameManager`；
- 联机模式使用 `MultiplayerManager`、`WebSocketClient` 和 `RoomUI`；
- 自己的棋盘允许本地乐观执行，等待服务端确认；
- 对手棋盘只使用服务端下发的事件和状态渲染。

### 服务端

- Node.js + `ws`；
- HTTP 服务同时托管静态网页和 WebSocket；
- 房间状态暂存在内存中；
- 服务端执行共享的纯游戏逻辑；
- 第一版不引入数据库、账号系统或 Redis。

## 4. 共享游戏逻辑与模块方案

当前仓库通过 `<script>` 顺序加载全局函数，没有 CommonJS 或 ES Module。不能直接在 Node.js 中 `require` 当前的 `game_manager.js`。

### 方案

新增 `js/game_logic.js`，只实现与 DOM 无关的纯函数：

- `createInitialState(seed)`；
- `applyMove(state, direction)`；
- `applyInterference(state, position, value)`；其中 `value` 只能省略或等于固定值 `4`，棋盘上已有干扰块时拒绝插入；
- `hasMoves(state)`；
- `serializeState(state)`；
- `hashState(state)`。

文件使用无构建 UMD 形式，同时支持浏览器和 Node.js：

```js
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.GameLogic = factory();
  }
}(typeof self !== "undefined" ? self : this, function () {
  // 返回 createInitialState、applyMove 等纯函数
}));
```

浏览器在 `game_manager.js` 之前加载它，服务器通过 `require("../js/game_logic.js")` 使用它。逻辑模块不依赖 `window`、DOM、`Grid` 或 `Tile`。

### 状态归属与 `applyMove` 契约

- `game_logic.js` 是唯一的领域状态所有者，负责 `cells[x][y]`、分数、确定性随机状态、方块生成、移动合并以及 `won` / `stuck`；
- `Grid` 和 `Tile` 不属于共享领域逻辑。`grid.js` 只作为迁移期兼容适配层，`tile.js` 只负责视图和动画对象转换；服务器权威逻辑不依赖这两个文件；
- `applyMove` 是纯函数，不修改传入的 `state`，固定返回以下结构：

  ```js
  applyMove(state, direction)
    // -> { state, events, moved, won, stuck }
  ```

- `state` 是移动后的新逻辑状态；`events` 是用于渲染动画的事件对象，至少包含 `moved`、`merges` 和 `spawn` 字段；
- `moved === false` 时，`state` 在逻辑上与入参完全相同，`events` 为空事件集，不生成方块、不增加分数，也不消耗随机数；
- 方向不属于 `0`、`1`、`2`、`3` 时，返回同样的无效移动结果并附带 `error: "INVALID_DIRECTION"`，调用方不得把它当作普通按键忽略；
- 有效移动时返回新的状态和对应事件，`won`、`stuck` 与返回状态一致。客户端重放器可以直接循环调用该函数，不需要额外猜测随机数消耗。

### 确定性要求

客户端预测能成立的前提是“同样的状态 + 同样的输入 ⇒ 同样的结果”。因此：

- **随机生成必须使用共享的确定性 PRNG**（建议 xorshift32），禁止在 `game_logic.js` 内出现 `Math.random()`。原 `grid.js` 的 `randomAvailableCell()` 仅保留为非随机兼容入口，不得被共享逻辑复用。
- **取随机空位的顺序必须固定**：按 `x` 升序、再按 `y` 升序枚举空位后取下标，不得依赖对象键顺序或 `Array.sort` 的不稳定行为。
- **每次移动消耗的随机数个数必须固定**：一次有效移动恰好消耗一次随机取位 + 一次 2/4 取值。无效移动不消耗随机数。
- **`hashState` 必须是纯 JavaScript 实现**（建议 FNV-1a），不得依赖 Node 的 `crypto`，否则浏览器端无法计算同一个值。哈希输入为字段顺序固定的规范字符串，字段顺序一旦发布不得更改。

服务器在比赛开始时分配 seed 并写入权威状态；客户端据此预测自己的下一步，由 `stateHash` 校验，不一致时以服务器快照为准（见 §8）。

## 5. 权威状态和序列化格式

所有棋盘坐标统一使用现有源码的 **`cells[x][y]`，先 x 后 y**。协议不使用裸数字数组，也不让客户端自行解释坐标方向。

### 权威状态

```json
{
  "version": 1,
  "size": 4,
  "targetTile": 2048,
  "cells": [
    [null, {"position":{"x":0,"y":1},"value":2,"interference":false}, null, null],
    [null, null, null, null],
    [null, null, {"position":{"x":2,"y":2},"value":4,"interference":false}, null],
    [null, null, null, null]
  ],
  "score": 1280,
  "won": false,
  "stuck": false,
  "energy": 1,
  "combo": 2,
  "moveSeq": 12,
  "rngState": 184467
}
```

`cells[x][y]` 中的方块格式兼容现有 `Tile.serialize()` 的 `position` 和 `value`，新增 `interference` 布尔字段。旧状态没有该字段时按 `false` 处理。

### 状态哈希的覆盖范围

`hashState` 只覆盖**玩法状态**，用于回答“我的预测是否与服务端一致”：

| 字段 | 是否参与哈希 | 原因 |
| --- | --- | --- |
| `size`、`targetTile`、`cells`、`score`、`won`、`stuck` | ✅ | 客户端可完整预测 |
| `energy`、`combo` | ✅ | 由合并序列确定性推导 |
| `rngState` | ❌ | 会话元数据；客户端在硬同步时直接采用服务端值 |
| `moveSeq` | ❌ | 传输层计数；纳入会让传输变动污染状态哈希 |

客户端在采纳服务端快照时，必须**连同 `rngState` 一起采纳**，否则重放（§8）会继续使用已经分叉的随机流。

### 动画事件不是权威状态

`previousPosition` 和 `mergedFrom` 是 `html_actuator.js` 使用的运行时字段，不能放进持久化状态。每次移动同时返回事件：

```json
{
  "moved": [
    {"from":{"x":0,"y":1},"to":{"x":0,"y":0},"value":2,"interference":false}
  ],
  "merges": [
    {
      "from":[
        {"position":{"x":1,"y":0},"value":2,"interference":false},
        {"position":{"x":2,"y":0},"value":2,"interference":false}
      ],
      "to":{"x":0,"y":0},
      "value":4
    }
  ],
  "spawn":{"position":{"x":3,"y":2},"value":2,"interference":false}
}
```

`moved` 和 `merges.from` 中的 `interference` 用于恢复干扰块的动画样式；普通方块固定为 `false`。

客户端根据事件临时重建 `previousPosition` 和 `mergedFrom`，因此联机模式仍然有滑动和合并动画。收到权威快照时，客户端清理旧的动画对象，再从快照和未确认输入重新渲染。

## 6. 联机模式与胜负规则

### 房间流程

1. 玩家点击“创建房间”；
2. 服务端生成 6 位大写房间码；
3. 第二名玩家输入房间码加入；
4. 服务端分配 `p1` 或 `p2`，并返回各自的重连 token；
5. 双方点击“准备”；
6. 服务端发送开始时间和 3 秒倒计时；
7. 双方同时进入对局；
8. 结束后显示结果和“再来一局”。

### 比赛状态

`waiting` → `countdown` → `playing` → `finished`。

### 第一版胜负优先级

服务端把所有命令放进**单一队列串行处理**，每条命令处理完后按以下顺序检查：

1. **提前终结**：某次移动首次合成目标方块时，该玩家立即获胜，比赛结束；
2. **无路可走**：棋盘无路可走的玩家进入 `stuck`，不能继续移动，但比赛不结束；
3. **双方都 `stuck`**：比较分数，分数高者获胜；分数相同时比较最高方块，再相同则平局；
4. **一方断线超过宽限期**：该玩家判负（见 §10）；
5. **达到比赛截止时间**：比较分数；分数相同时比较最高方块，再相同则平局。

因为命令是串行处理的，**不存在“双方同时达成”的情况**，无需为此单独定义规则：队列中先被处理的那条命令获胜。

终局时 `match_end` 的 `reason` 取以下枚举之一：

| `reason` | 触发规则 |
| --- | --- |
| `target_reached` | 规则 1 |
| `both_stuck` | 规则 3 |
| `opponent_disconnected` | 规则 4 |
| `timeout` | 规则 5 |
| `opponent_left` | 房间内对手主动退出 |

### 时长与目标方块

比赛时长与目标方块是**配置项**，不是硬编码：

- `MATCH_TARGET_TILE`，默认 `2048`；
- `MATCH_DURATION_MS`，默认 8 分钟。

**为什么默认 8 分钟而不是 5 分钟**：新手在 5 分钟内几乎不可能合成 2048，规则 1 会形同虚设，绝大多数对局实际由规则 5（超时比分）判定。8 分钟给规则 1 一个现实窗口。

**招新演示建议**：把 `MATCH_TARGET_TILE` 设为 `512`、`MATCH_DURATION_MS` 设为 3 分钟。目标可达、胜负在一局内能明确产生，现场节奏更好。

无论取值如何，**主力判胜条件始终是超时比分，规则 1 是提前终结的奖励路径**。这是设计预期，不是缺陷。

客户端只根据服务端时间显示倒计时（见 §10）。

## 7. 完整消息协议

所有消息都是 JSON，必须带 `type` 和 `protocolVersion: 1`。服务端消息中的 `messageKey` 用于客户端显示中文，不直接信任服务端传入的任意文本。

### 客户端 → 服务端

| 报文 | 作用 | 关键字段 |
| --- | --- | --- |
| `hello` | 建立连接 | `protocolVersion`, `reconnectToken` |
| `create_room` | 创建房间 | `requestId` |
| `join_room` | 加入房间 | `roomCode`, `requestId` |
| `ready` | 设置准备状态 | `ready`, `requestId` |
| `move` | 提交方向 | `matchId`, `direction`, `seq`, `baseVersion` |
| `use_skill` | 使用干扰技能 | `matchId`, `skill`, `requestId`；不得携带位置或数值 |
| `rejoin` | 断线后恢复 | `roomCode`, `reconnectToken` |
| `rematch` | 请求再来一局 | `requestId`；再次发送即撤销自己的同意 |
| `resync` | 请求当前完整快照 | `requestId` |
| `leave_room` | 主动退出房间 | `requestId` |

### 服务端 → 客户端

| 报文 | 作用 | 关键字段 |
| --- | --- | --- |
| `hello` | 确认握手成功 | `serverNow` |
| `assigned` | 绑定身份 | `playerId`, `roomCode`, `reconnectToken` |
| `room_state` | 房间和准备状态 | `players`, `phase`；结算阶段附带 `rematchVotes` |
| `player_update` | 玩家加入、离开、重连 | `playerId`, `status` |
| `match_start` | 开始比赛 | `matchId`, `phase`, `serverNow`, `startsAt`, `deadlineAt`, `state`, `stateVersion`, `lastAcceptedSeq`, `opponent` |
| `move_ack` | 确认自己的移动 | `matchId`, `playerId`, `seq`, `stateVersion`, `stateHash`, `state`, `events` |
| `opponent_update` | 更新对手可见状态 | `matchId`, `playerId`, `stateVersion`, `state`, `events` |
| `skill_result` | 技能结果 | `source`, `target`, `position`, `value`, `cooldownUntil`, `stateVersion`, `state`, `lastAcceptedSeq`；发起方另带 `opponent` |
| `resync` | 全量状态重同步 | 与 `match_start` 相同，另含终局 `result` |
| `clock` | 校准服务器时间 | `serverNow` |
| `match_end` | 宣布结果 | `matchId`, `winner`, `reason`, `scores`, `states`, `serverNow` |
| `left_room` | 确认退出并解绑 | `roomCode`, `requestId` |
| `error` | 拒绝请求 | `code`, `messageKey`, `requestId`, `retryable`；移动错误关联 `matchId` 和 `seq` |

### 身份绑定

`assigned` 是连接与 `playerId` 的唯一绑定消息。客户端只把 `playerId` 等于自己的状态渲染到主棋盘，把另一个玩家状态渲染到对手面板。

### 错误格式

```json
{
  "type":"error",
  "protocolVersion":1,
  "code":"SEQ_OUT_OF_ORDER",
  "messageKey":"error.seqOutOfOrder",
  "requestId":"req-17",
  "retryable":false
}
```

至少定义以下错误码：`PROTOCOL_MISMATCH`、`INVALID_MESSAGE`、`ROOM_FULL`、`ROOM_NOT_FOUND`、`ROOM_LIMIT_REACHED`、`MATCH_NOT_READY`、`MATCH_FINISHED`、`INVALID_DIRECTION`、`SEQ_OUT_OF_ORDER`、`RATE_LIMITED`、`PLAYER_STUCK`、`NOT_ENOUGH_ENERGY`、`SKILL_ON_COOLDOWN`、`NO_TARGET_SPACE`、`INTERFERENCE_ACTIVE`、`OPPONENT_OFFLINE`、`RECONNECT_EXPIRED`。

其中 `SEQ_OUT_OF_ORDER` 的含义是「`seq` 重复或回退」，**不包括跳号**——服务端允许跳号，原因见 §8 的 `seq` 契约。

### requestId 与回滚的关系

`requestId` 由客户端生成，在单条连接内唯一，仅用于把服务端的 `error` 关联回具体请求（`move` 使用 `seq`，不使用 `requestId`）。

`error` 不只是提示，它是**回滚触发器**：当 `error` 对应的请求是一个已经乐观执行过的 `move` 或 `use_skill` 时，客户端必须先撤销该次预测再展示错误文案。哪些错误触发回滚见 §8。

## 8. 客户端预测、确认与回滚

### 前提：预测的安全条件

乐观执行成立的条件**不是**“两个棋盘相互独立”——这个前提被 §9 的干扰玩法打破了：对手可以随时向自己棋盘写入一个干扰块，而客户端无法预测它的位置和时机。

正确的条件是：

> 在两次服务端权威快照之间，自己棋盘的全部变化都只由自己的 `move` 引起。

因此本节采用**「预测 + 硬同步」两段式，不做增量对账**：预测只在没有跨棋盘写入介入时有效；一旦对手的干扰落到自己棋盘上，立即放弃全部推测状态，以服务端快照重建。

这也是为什么 §9 的干扰块位置、数值全部由服务端决定，且客户端不参与预测。

### 正常流程（无干扰介入）

1. 用户按方向键，客户端给本地状态生成 `seq`；
2. 客户端立即调用 `GameLogic.applyMove`，用返回事件播放动画；
3. 客户端发送 `move(seq, direction, baseVersion)`；
4. 服务端验证后返回 `move_ack`；
5. 客户端比较 `stateHash` 和 `stateVersion`；
6. 一致则确认本地预测，丢弃对应的推测记录；
7. 不一致则按下方「回滚触发条件」处理。

### 回滚触发条件

以下任一命中，即执行**硬同步**：采纳服务端 `state`（含 `rngState`)，清空全部推测状态，再按顺序重放仍然未确认的输入。

| 触发 | 来源 | 处理 |
| --- | --- | --- |
| 哈希或版本不一致 | `move_ack` 的 `stateHash` 与本地预测不符 | 采纳服务端 `state` 与 `rngState`，重放未确认输入 |
| 自己棋盘被写入干扰 | `skill_result` 且 `target` 是自己 | 作废全部推测状态，采纳 `state` 与 `rngState`，重放未确认输入 |
| 全量重同步 | `resync` | 未确认输入全部作废，不重放 |
| `move` 被拒绝 | `error` 且 `seq` 对应一个推测中的 `move` | 撤销该次预测，回退到最近一次已确认状态，重放其余输入 |
| 限流 | `error` 且 `code = RATE_LIMITED` | 同上；且客户端不得因被拒绝而认为该 `seq` 已生效 |

**注意**：被拒绝的 `move` 不会返回 `move_ack`，因此没有 `stateHash` 可比。若只依赖哈希对账，这类分叉永远不会被清理，表现为“按键无反应、棋盘与服务端不一致、必须刷新”。上表第 4、5 行是必须实现的路径。

### `seq` 契约

`seq` 同时服务于“确认”和“拒绝后回滚”，两者必须一致，因此规定：

- `seq` 由客户端生成，每一条**由玩家真实输入产生**的 `move` 递增 1；
- 服务端只拒绝 `seq <= lastAcceptedSeq`（重复或回退),**允许跳号**；
- 客户端在收到 `move_ack` 或明确的 `error` 回执之前，该 `seq` 视为未了结；
- 被拒绝的 `seq` **不得复用**，由下一个真实输入继续递增。

若服务端改为“严格递增、跳号即拒”，则一次 `RATE_LIMITED` 就会让客户端后续所有 `seq` 永久跳号，对局直接卡死且必须重连才能恢复。这是必须避免的组合。

### 重放的正确性要求

- 重放**必须先采纳服务端快照中的 `rngState`**，否则会继续使用已经分叉的随机流，重放结果必然再次不一致；
- 重放使用与服务器同一份 `game_logic.js` 和同一 PRNG；
- 重放步数设置上限（建议 8 步），超过上限直接硬同步并丢弃未确认输入，避免高延迟下无限重放。

### 对手棋盘

对手棋盘不做预测，只按 `opponent_update` 中的 `events` 和 `state` 播放动画。若对手棋盘状态与本地渲染不一致，同样以服务端快照为准重建。

## 9. 原创玩法：连击能量和干扰块

### 明确定义

- 一次移动产生至少一次合并时，`combo` 加 1；
- 一次有效移动没有产生合并时，`combo` 重置为 0；
- 每连续 3 次产生合并的移动获得 1 点能量；
- 能量上限为 2 点；
- 消耗 1 点能量发送一次干扰，技能冷却 3 秒；
- 干扰块的数值为 `4`，不是普通的 `2`；
- 干扰块使用 `interference: true` 标记，合并后标记消失；
- 对手棋盘上最多同时存在 1 个干扰块（合并后标记消失，方可再次干扰）；

这样一次干扰的成本是 3 次连续有效合并，收益是一个有实际占位压力的 `4`，不会被原版每步自动生成的 `2` 完全抵消。

### 边界规则

- 干扰是**立即生效**的：对手有空位时，服务端立刻选定空位插入干扰块，不存在排队或延迟生效的“待处理”状态；
- 干扰块插入是对手棋盘上的一次**跨棋盘写入**，会作废对手客户端的全部推测状态并触发硬同步（见 §8）；
- 对手没有空位时，技能不消耗能量，返回 `NO_TARGET_SPACE`；
- 对手棋盘上已有 1 个未消除的干扰块时，返回 `NOT_ENOUGH_ENERGY` 以外的专用拒绝理由（沿用 `NO_TARGET_SPACE` 或新增 `INTERFERENCE_ACTIVE`）；
- 干扰导致对手没有可用移动时，对手进入 `stuck`，不会立即判负；
- `stuck` 玩家**不能移动，但仍可使用已有能量发动干扰**。能量不会再增长（不再产生合并），但剩余能量可以打出去，避免 stuck 后无事可做；
- 干扰块生成、位置和数值都由服务端决定；
- 不允许客户端指定干扰位置或方块数值。

## 10. 房间、重连和限流

### 单机实验道具：智能 15 步

现已在单机界面加入可重复使用的智能道具：Expectimax 搜索当前可见棋盘，每次有效移动后重新计算，每批自动走 15 次有效移动。执行期间锁定方向输入，可以停止或重启取消；合成 2048 后自动继续挑战，stuck 时提前结束。HTTP 页面优先调用固定版本的 ziap WASM 与未经修改的原版 worker pool（上游版本、源码和 MIT 许可证位于 `js/vendor/ziap`），共享 64 MiB 内存，按约 175ms（两倍速）的节奏运行。默认使用硬件并发线程数，可用 `threads` 查询参数覆盖，范围 1–32。每批只重置搜索深度预测，停止和批次结束保留线程及缓存；重启或进入联机模式才释放。WASM 搜索沿用原预算和方向兜底，无两秒强制中断。本地服务提供 COOP/COEP 响应头；无法启用共享 WASM 内存或初始化失败时使用原 JavaScript 求解器，离线环境可用页面内受限预算降级。非 4×4 或有干扰块的局面使用 JS；高数值沿用上游 rank 15 饱和编码，不再切换算法。

求解器把滑动合并与 90% 的 2 / 10% 的 4 随机生成分开评估，不读取 `rngState` 来预测未来。它是有限预算下的近似最优搜索，不保证整局必胜。当前不改变对战协议或比赛能量；在线道具的次数、成本和服务端授权待联机界面及道具规则阶段接入。

JavaScript 降级求解器内部改用 rank 空间的扁平棋盘并自带滑动实现，因为 `GameLogic.moveTiles` 每次调用都会克隆棋盘、记录来源坐标并做一次状态深校验，而这些在每个搜索节点上都是纯开销。合并语义仍与 `GameLogic.slideMove` 逐格一致，由 `test/fixtures/solver-decisions.json` 在固定搜索深度下锁定方向来保证；后续改动评估权重必须同步更新该文件，并说明棋力变化。该文件可用 `npm run gen:solver-decisions` 重算（沿用原局面，只重算期望决策）。

棋力基线由 `npm run bench:solver` 复现（Node 22 / 10 核，出厂档 16000 节点 + 60ms）：400 步短盘均分约 6180，整局 16 局配对达 2048 为 14 局、均分约 36000；实际采用深度多为 2–3 层，因为每层展开数约 88 / 1907 / 26601 / 294106（×14 递增）。两条已实测的结论：时钟改为每 64 次进节点检查后 `timeBudgetMs` 才真的是上限，且这一改动 16 局配对与 315 条冻结决策全部逐位不变；把转置表键改成只含棋盘、条目记剩余深度以便跨层复用，命中率虽从 14%–27% 升到 64%–68%，但条目对象化使每步耗时 +42%，整局 2048 率反而从 14/16 掉到 10/16，已回退。

### 重连

- `assigned` 返回一次随机重连 token；
- 客户端把 token 保存在 `sessionStorage`，不把它当作玩家昵称或密码；
- 断线后房间保留 30 秒宽限期；
- 客户端使用 `rejoin(roomCode, reconnectToken)` 恢复身份；
- 恢复成功后服务端发送 `resync` 全量状态；
- 超过宽限期未恢复，则该玩家认输，房间进入结束状态。

### 房间生命周期

- 房间码统一转为大写，并只使用不易混淆的字母和数字；
- 生成房间码时冲突自动重试，最多 5 次；
- 等待中的空房间 30 分钟后清理；
- 已结束房间 5 分钟后清理；
- 进程内房间数设置上限，达到上限时返回 `ROOM_LIMIT_REACHED`；
- 两名玩家都离开后立即清理或进入短暂结束状态。

### 限流

- 单连接消息大小上限 8 KB；
- 单连接最多 30 条消息/秒；
- `move` 两次接受之间至少间隔 50 ms；
- `seq` 由客户端递增，服务端只拒绝重复或回退（`seq <= lastAcceptedSeq`），**允许跳号**；完整契约见 §8；
- `use_skill` 额外受 3 秒冷却限制，返回 `SKILL_ON_COOLDOWN`；
- 超过限制只返回错误，不推进游戏状态。

### 心跳与协议地址

服务器每 15 秒发送 WebSocket 协议层 `ping`；**浏览器内核会自动回 `pong`，客户端 JavaScript 无法也无需主动发送**（`WebSocket` API 不暴露 pong 方法，也没有 `onping` 事件）。

因此实现方式是：服务端发送 ping 后，监听 `ws` 库的 `'pong'` 事件维护 `isAlive` 标记；连续两次未收到 pong 则断开连接。

如果需要客户端参与探活（例如检测“页面假死”而非“连接断开”），改用应用层报文：服务端发 `{"type":"ping"}`，客户端回 `{"type":"pong"}`，并加入 §7 的报文表。

客户端根据页面协议生成 WebSocket 地址，避免 HTTPS 页面调用不安全的 `ws://`：

```js
var protocol = window.location.protocol === "https:" ? "wss" : "ws";
var socketUrl = protocol + "://" + window.location.host + "/ws";
```

如果前后端分开部署，则通过页面配置注入完整的 `wss://` 地址。

### 时钟同步

`match_start` 和每 5 秒一次的 `clock` 都携带 `serverNow`。客户端使用服务器时间和本地时间的偏移量计算倒计时，不直接使用本地时钟决定比赛结束。

## 11. 代码组织计划

```text
2048-remote-duel/
├── index.html
├── style/
│   ├── main.css
│   ├── main.scss
│   ├── helpers.scss
│   └── fonts/
├── js/
│   ├── game_logic.js
│   ├── game_manager.js            # 单机适配器，联机期间由 setActive(false) 停用
│   ├── view_state.js              # 纯状态 + 动画事件 → Grid/Tile，单机与联机共用
│   ├── grid.js                    # 迁移期兼容适配层，不拥有权威状态
│   ├── tile.js                    # 视图/动画适配器，不承载游戏规则
│   ├── multiplayer_manager.js
│   ├── websocket_client.js
│   ├── duel_controller.js         # 房间面板、屏幕切换、计时与输入路由（§11 原 room_ui.js）
│   ├── game_solver.js             # 单机实验道具：智能 15 步
│   ├── solver_worker.js
│   ├── html_actuator.js
│   ├── keyboard_input_manager.js
│   ├── local_storage_manager.js
│   ├── application.js
│   └── *_polyfill.js
├── server/
│   ├── server.js
│   ├── room_manager.js
│   ├── match_manager.js
│   ├── protocol.js
│   └── rate_limiter.js
├── test/
│   ├── logic.test.js
│   ├── protocol.test.js
│   ├── match.test.js
│   ├── duel.test.js
│   ├── solver.test.js
│   ├── style.test.js
│   └── ui.test.js
├── docs/
│   └── remote-duel-plan-zh.md
├── LICENSE.txt
└── package.json
```

服务器权威逻辑只依赖 `game_logic.js`；`grid.js` 和 `tile.js` 仅为旧单机渲染链路提供兼容转换，迁移完成后仍可逐步收缩其职责。

第一版只有一种语言，不新增完整的 `i18n.js` 抽象层。静态文案直接改为中文，动态错误由 `duel_controller.js` 按错误码映射为中文。后续需要英文时再拆出语言包。

## 12. 全局中文化

在 `index.html` 增加 `<html lang="zh-CN">`，默认页面语言为简体中文。

需要翻译和重写：

- 页面标题、网页描述和按钮；
- 分数、最高分、重新开始、新游戏；
- 继续挑战、再试一次、游戏结束；
- 创建房间、加入房间、房间码；
- 等待对手、准备、对战中；
- 连接中、已断开、正在重连；
- 你赢了、你输了、平局；
- 对手分数、能量、连击和干扰提示；
- README、启动说明和部署说明。

以下内容不翻译：

- `LICENSE.txt` 的许可证正文；
- 原作者版权声明；
- 第三方仓库地址和代码标识符。

联机模式不调用 `LocalStorageManager.setBestScore`，避免在线分数污染单机最高分。若以后保存在线纪录，使用独立的 `onlineBestScore` 键。

## 13. 开发阶段

当前进度：阶段一至阶段五已实现，页面可以在浏览器里完成一整局联机对战并互相释放干扰；阶段六部署尚未完成。

### 阶段一：整理纯逻辑和状态

- 新增 UMD 形式的 `game_logic.js`；
- 明确定义 `cells[x][y]` 和权威状态格式；
- 从 `game_manager.js` 抽取移动、合并、计分和随机生成；
- 返回移动事件，供动画和服务端协议使用；
- 添加零依赖 Node 单测。

### 阶段二：建立服务端和房间

- 添加 `package.json` 和 `ws` 依赖；
- 添加 HTTP 静态文件服务；
- 实现 `hello`、`create_room`、`join_room`、`assigned`；
- 实现房间码、TTL、玩家状态和心跳。

阶段二已落地的具体约定：

- Node HTTP 服务托管 `/`、`js/`、`style/`、`meta/` 等游戏资源，`/health` 提供健康检查；服务端源码、依赖、测试和 Git 文件不对外提供；
- WebSocket 地址为 `/ws`，连接后 10 秒内必须发送 `hello`，服务端用 `hello(serverNow)` 回执；第一版只接受 `protocolVersion: 1`；
- `hello` 可携带 `reconnectToken`，服务端在现有房间中查找身份；也可先完成握手再发送 `rejoin(roomCode, reconnectToken)`；
- `assigned` 仅向本人发送 token，公开的 `room_state.players` 是包含 `playerId`、`status`、`ready` 的数组；`requestId` 如有提供则原样关联到 `assigned` 或 `error`；
- `status` 使用 `connected`、`disconnected`、`expired`，`ready` 暂为 `false`；同一连接仅绑定一个座位，在线身份拒绝另一个连接占用；
- 等待阶段断线后保留座位 30 秒，达到宽限期时广播 `expired` 并释放座位，新玩家可加入；空等待房间自最后一次连接状态变化起保留 30 分钟，在线等待房间不因空房 TTL 被清理；
- 已结束房间按 `finishedAt` 保留 5 分钟，重连不延长该期限；进程内房间上限 1000，房间码碰撞最多重试 5 次；
- 每连接限制 8 KB / 30 条消息每秒，二进制报文拒绝；超大报文由 WebSocket 关闭，关闭码为 `1009`；每 15 秒 ping，连续两次未收到 pong 后终止连接；
- 每连接发送队列上限为 64 KB（包括本次发送负载和帧头预留），超限立即终止连接；连续限流仅首次发送关联错误，30 次连续拒绝后终止连接，正常获准请求重置拒绝计数；
- 阶段二重连返回 `assigned` 和 `room_state`，阶段三有权威棋盘后再追加 `resync`，比赛中的断线判负也由阶段三实现；
- 新增房间错误码 `HELLO_REQUIRED`、`ALREADY_ASSIGNED`、`PLAYER_CONNECTED`，错误消息均包含可供中文界面映射的 `messageKey`。

### 阶段三：接入对战协议

- 实现 `ready`、`match_start`、`move` 和 `move_ack`；
- 接入服务器权威逻辑和状态哈希；
- 实现客户端预测、确认和回滚，**包含被 `error` 拒绝请求的回滚路径与重放上限**；
- 实现 `clock`、`match_end` 和完整错误回执。

阶段三已落地的具体约定：

- `server/match_manager.js` 复用同一共享逻辑，Node 消息回调同步串行执行；双方使用相同 seed，各自独立随机流，默认倒计时 3 秒、比赛 8 分钟、目标 2048；
- `ready` 仅接受布尔值，等待阶段可撤销；等待阶段断线会清掉准备标记；双方在线且准备后才进入倒计时；
- `match_start` 和 `resync` 返回本人 `state`、`stateVersion`、`stateHash`、`lastAcceptedSeq` 及 `opponent: { playerId, state, stateVersion }`，包含完整 `rngState`；
- `move` 必须带当前 `matchId`、方向、正整数 `seq`、非负整数 `baseVersion`，拒绝旧比赛的在途输入；`baseVersion` 用于预测对账，服务器始终从自身状态计算，客户端分数或棋盘字段无效；
- `stateVersion` 是每名玩家本局获准命令的计数，包括无效方向之外的无位移移动；无位移移动确认序号但不生成方块、计分或消耗随机数。被拒绝的命令不推进计数；
- 重复或回退序号被拒绝，跳号被接受，两次获准移动至少相隔 50ms；移动错误关联 `seq` 和 `matchId`，全连接限流仍保留阶段二的首回包及关闭保护；
- `js/multiplayer_manager.js` 维护已确认快照与最多 8 步未确认输入，校验哈希、版本和随机状态；拒绝后删除对应预测并重放其余输入，`resync` 则丢弃所有旧预测；
- 两秒未确认时主动请求 `resync`，避免持续限流省略错误回包留下预测；同步期间暂停输入，服务器时钟到达时可重试同步；
- `js/websocket_client.js` 按页面协议生成 `ws` / `wss`，用 `sessionStorage` 保存 token，断线暂停预测并自动握手重连；身份恢复后以权威快照继续，联机状态不使用单机存储；
- 每 5 秒发送 `clock`，倒计时前、比赛截止后、stuck 和终局都拒绝移动；先达到目标立即获胜，双方 stuck 或超时按分数及最高方块比较，完全相同为平局；
- 断线宽限期与比赛截止按实际时间先后裁决；同刻双方断线且同时超过宽限期为平局；主动 `leave_room` 在对局中判负并解绑，返回 `left_room`，连接可重新建房；
- `match_end.states` 携带两名玩家的最终 `state`、`stateVersion`、`lastAcceptedSeq`，客户端清空在途预测；重连已结束比赛会在 `resync.result` 里返回同一结果；
- 阶段三尚不接 `rematch` 或 `use_skill`，浏览器按钮与对手面板在阶段四接入；干扰快照的客户端硬同步路径已实现并测试，服务端技能写入留到阶段五。

### 阶段四：中文化和界面

- 修改 `index.html` 静态文案；
- 修改 `html_actuator.js` 的胜负提示；
- 在现有 `style/` 目录增加房间、对手、能量和连接状态样式；
- 确认桌面和移动端布局。

阶段四已落地的具体约定：

- 单机文案与 `<html lang="zh-CN">` 已完成；联机界面新增 `js/duel_controller.js`，承担 §11 中 `room_ui.js` 的房间面板职责与整局流程编排；
- 单机与联机**共用同一个 `HTMLActuator` 和 `KeyboardInputManager`**：两个实例会各自维护 `renderVersion` 与分数基数却写同一份 DOM，导致动画互相打断、"+N" 飘字错乱；`application.js` 用共享包装器注入，`GameManager.setActive(false)` 让单机在联机期间既不推进也不再写 `localStorage`；
- 新增 `js/view_state.js`，把"纯状态 + 动画事件 → Grid/Tile 视图对象"收敛成唯一实现，单机与联机共用，避免两条渲染链路各自演化；
- 联机时表头第二栏由"最高分"改为"对手"，值取自服务端下发的对手状态；联机对局**不写单机最高分**；
- 棋盘重绘按 `stateHash` 节流：`clock` 与 `opponent_update` 也会触发 `notify`，无变化时不得重绘，否则会打断进行中的滑动/合并动画；对手分数单独刷新，不依赖棋盘重绘；
- 连接握手完成前的操作会暂存为一次待发意图，`hello` 回执后自动补发，避免冷启动期间点击"创建房间"看起来毫无反应；
- 屏幕由"是否有房间 + 阶段"推导：无房间→大厅、`waiting`→等待页、`countdown`/`playing`→收起遮罩进入对局、`finished`→结算页；倒计时与剩余时间一律按服务端时钟偏移计算；
- 房间码在前端先归一化为大写并校验 `^[A-HJ-NP-Z2-9]{6}$`，非法输入不发包并给出可读提示；
- 错误按 `code` 映射为中文；`RATE_LIMITED`、`SEQ_OUT_OF_ORDER`、`INVALID_DIRECTION` 由预测回滚自动消化，不弹给玩家。

阶段四的中文化和界面已完成；`rematch` 与对手棋盘预览已在阶段五一并接入（见下）。

### 阶段五：加入干扰玩法

- 实现连续合并、能量上限和冷却；
- 实现服务端插入 `4` 干扰块；
- 实现跨棋盘写入触发的客户端硬同步（见 §8）；
- 处理满棋盘、无路可走和技能拒绝；
- 添加干扰块动画和中文提示。

阶段五已落地的具体约定：

- `use_skill` 只接受 `skill: "interference"`，客户端不携带也不得携带 `position`、`value` 或 `energy`；位置由服务端 `pickFactory` 在空位中挑选，与对局 `rngState` 完全独立，因此干扰不消耗随机数、可安全重放；
- 拒绝码：`NOT_ENOUGH_ENERGY`、`SKILL_ON_COOLDOWN`、`NO_TARGET_SPACE`、`INTERFERENCE_ACTIVE`，全部不扣能量、不进冷却；冷却中重复请求不弹窗（按钮本身已禁用）；
- 能量住在权威 `state` 里，`skill_result`、`move_ack`、`opponent_update`、`match_start`/`resync` 都要同步它。**漏掉 `move_ack` 那一步会让技能按钮永远禁用**；
- `energy` 参与 `hashState`，因此释放方也必须采纳权威 `state`：它只改了能量，但哈希已经变了；
- 冷却用服务器时钟判断（`cooldownUntil` 是服务器毫秒），避免本机时间漂移导致提前可用；
- 能量在 HUD 用实心/空心格子表示（上限 2），不显示数字以免与分数争夺注意力；干扰提示 4 秒后自动回落到冷却文案；
- 干扰块沿用 `tile-interference` 的珊瑚色描边，另加一次 `interference-land` 落位脉冲；合并后标记消失、动画一并消失；
- `stuck` 玩家不能移动但仍可打出剩余能量，单方 stuck 不判负；
- 冷却时长由 `skillCooldownMs` 配置（默认 3000ms），服务端与客户端读同一份。

### 对手棋盘预览

只读快照，不预测也不播动画。放在主棋盘下方、`duel-bar` 之上，宽度固定 116px（格子约 25px）——**刻意做得比主棋盘小很多**：它的作用是让玩家知道对手在做什么，不是替代对手棋盘；撑满会在手机上把页面从 690px 撑到 1280px。

实现上没有复用 `HTMLActuator`：它写死了 `.tile-container` 并依赖 `.tile-*` 的滑动/合并动画，给它加第二个容器会波及单机链路。预览单独渲染 16 个静态格子，只借用同一套 tile 颜色变量保持观感一致。格子对象只创建一次，之后每次只改 `data-value` 和 `data-interference`，避免 200ms 定时刷新时重建 DOM。

干扰块在预览里同样用珊瑚色描边标出，玩家不必切回主棋盘确认。

### 再来一局（`rematch`）

- 只有结算页可以请求；对局进行中返回 `MATCH_FINISHED`；
- 任一方请求后即可**撤销**（再次发送即取消自己的票），避免误点无法反悔；
- `room_state` 在 `phase === "finished"` 且双方都在场时携带 `rematchVotes: { p1, p2 }`，客户端据此显示"等待对手同意…"/"对手也点了再来一局"；
- 双方都同意才开新局。`finish()` 会清空上一局的票，因此残留投票不会直接触发开局；
- 新局复用同一个房间码，**重新抽取 seed 重新发牌**，`matchId`、分数、能量、冷却、`stateVersion` 全部归零。seed 必须每局不同，否则 rematch 会拿到同一个棋盘；
- 对手断线时返回 `OPPONENT_OFFLINE`，按钮同时置灰。

### 阶段六：招新演示和部署

- 两个浏览器窗口完成完整对局；
- 测试延迟、刷新、断线、重连和服务端重启；
- 部署 Node 服务，并确认 HTTPS 页面使用 `wss://`；
- 编写启动说明、项目介绍页和演示流程。

## 14. 测试计划

### 纯逻辑测试

使用 Node 内置 `assert`，不依赖测试框架，覆盖：

- 四个方向的移动和合并；
- 相同方块每次移动只合并一次；
- 无效移动不生成新方块、不增加分数；
- 合成 2048 设置 `won`；
- 无可用移动设置 `stuck`；
- 干扰块标记保留，合并后标记清除；
- 固定 seed 下客户端和服务端生成相同结果；
- 固定 seed 下同一输入序列产生相同的 `rngState` 与 `stateHash`。

### 预测与回滚测试

这是最容易出错、也最难在人工测试中复现的部分，必须有自动化覆盖：

- 无干扰时，客户端预测的 `stateHash` 与服务端 `move_ack` 一致；
- 干扰块插入自己棋盘后，客户端作废推测状态，重放剩余输入后与服务端结果一致；
- 反向用例：重放前不采纳服务端 `rngState` 时结果必然不一致，以此锁定该约束；
- `error` 拒绝一个推测中的 `move` 后，客户端回退到最近确认状态且对局可继续；
- 限流拒绝后继续操作，不出现永久 `SEQ_OUT_OF_ORDER`（对应 §8 的 `seq` 契约）；
- 未确认输入超过重放步数上限时，转为硬同步并丢弃未确认输入。

### 协议和房间测试

- 房间创建、加入、满员和不存在房间；
- `assigned` 正确绑定 `playerId`；
- `seq` 重复或回退被拒、**跳号被接受**、非法方向被拒；
- 断线宽限期内 `rejoin` 和过期失败；
- 限流不会推进游戏状态；
- 技能能量不足、冷却、无空位和干扰块已存在时的拒绝；
- 比赛截止时间和胜负优先级；
- 五条终局路径分别产生正确的 `match_end.reason`。

### 联机界面测试

`test/duel.test.js` 用最小 DOM 桩驱动真实的 `DuelController`，覆盖：

- 屏幕按"是否有房间 + 阶段"切换到大厅 / 等待 / 对局 / 结算；
- 房间码归一化为大写并校验，非法输入不发包；
- 创建、准备、撤销准备、离开、退出各自发出正确报文；
- 倒计时与剩余时间按服务端时钟偏移计算，不受本地时间漂移影响；
- 结算文案区分胜负平并翻译五条结束原因；
- 错误码映射为中文，回滚类错误不打扰玩家；
- 棋盘按 `stateHash` 节流重绘，对手分数单独刷新；
- 面板显隐、玩家列表、对手离线提示；
- 握手未就绪时的操作会暂存并在连接后补发；
- 页面结构检查：`index.html` 引用的脚本都存在、加载顺序正确、控制器查询的元素都在页面上。

### 人工浏览器测试

- 两个浏览器完成创建、加入、准备和对局；
- 移动动画和合并动画正常；
- 对手状态、能量和干扰提示正确；
- 刷新和断线后的提示明确；
- HTTPS 页面可以建立 `wss://` 连接。

## 15. 第一版明确不做

- 用户注册和账号系统；
- 数据库和长期战绩；
- 排位、好友和聊天；
- 观战；
- 多种技能；
- 跨服务器匹配；
- 复杂反作弊系统；
- 服务端重启后的比赛状态持久化。

服务端重启时，双方必须在 5 秒内看到明确提示，并能重新创建房间；不承诺恢复已经中断的比赛。

## 16. 验收标准

- 两个浏览器可以通过房间码完成一局对战；
- 客户端无法伪造分数、棋盘、能量或干扰位置；
- 自己的棋盘具有本地预测和滑动、合并动画；
- 服务器确认不一致时可以回滚到权威快照；
- 对手使用干扰后，自己棋盘能正确硬同步，不出现动画错乱或棋盘与分数不一致；
- 被限流或被拒绝的移动能自动回滚，**无需刷新页面**即可继续对局；
- 进入 `stuck` 后界面给出明确提示，且剩余能量仍可发动干扰；
- 单机模式仍然可以离线运行；
- 默认界面和动态提示无英文残留；
- 断线后 30 秒内可以使用 token 重连并恢复状态；
- 超过宽限期后双方收到明确的比赛结束提示；
- HTTPS 部署下 WebSocket 使用 `wss://`；
- 服务端重启后双方在 5 秒内看到可理解的失败提示；
- 招新现场可以在 1 分钟内创建房间并开始游戏。

## 17. 部署说明

GitHub Pages 只能继续承载单机静态版本，不能承载 WebSocket 服务端。联机版本采用以下方式之一：

1. Node.js 服务同时托管静态文件和 WebSocket，部署到 Render、Railway 或 Fly.io；
2. 静态网页部署到 Pages，Node.js 服务单独部署，前端使用配置的 `wss://` 地址。

招新演示优先选择方案 1，减少跨域、地址配置和 HTTPS 证书问题。

本地服务端运行环境为 Node.js 18+，建议 22 LTS：在仓库目录运行 `npm ci` 和 `npm start`，打开 `http://localhost:3000`。`HOST` 默认 `0.0.0.0`，`PORT` 默认 `3000`。静态单机界面也可以继续直接打开 `index.html`。

WebSocket 默认校验页面来源与请求主机相同，命令行客户端可以省略 Origin；跨来源页面通过 `ALLOWED_ORIGINS` 配置完整来源（逗号分隔）。反向代理需要转发 WebSocket 升级和原始 Host，并在外部配置 HTTPS；浏览器端接入时按页面协议使用 `ws://` 或 `wss://`。

`npm test` 运行逻辑、房间协议、对战与预测恢复、渲染适配和样式一致性检查；`npm run test:protocol` 只检查房间与连接，`npm run test:match` 只检查对战和预测。依赖由 `package-lock.json` 锁定，`node_modules/` 已加入忽略列表。

## 18. 遗留事项

### 已决事项

**`game_logic.js` 与 `grid.js` / `tile.js` 的状态归属已经确定。**

- `game_logic` 是唯一的状态所有者，只处理纯数据；
- `game_manager.js` 退化为适配器，单机模式也调用 `game_logic`；
- `grid.js` 是迁移期兼容适配层，`tile.js` 降级为由逻辑状态和动画事件重建的视图对象（保留 `previousPosition`、`mergedFrom`）；
- `Grid` 的棋盘结构由 `game_logic` 吸收，`grid.js`、`tile.js` 不再作为服务器或共享逻辑的状态容器；
- 原 `Grid.randomAvailableCell()` 的 `Math.random()` 路径废弃。

### 影响范围小、可随后补充

| 项 | 说明 |
| --- | --- |
| `rematch` 流程 | 已实现：`room_state` 在结算阶段携带 `rematchVotes`，双方都同意才开新局，seed 每局重抽 |
| `INTERFERENCE_ACTIVE` | 已实现为独立错误码，不再复用 `NO_TARGET_SPACE` |
