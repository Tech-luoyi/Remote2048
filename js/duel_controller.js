/*
 * 联机对战控制器（方案 §11 中 room_ui.js 的职责 + 对局流程编排）。
 *
 * 分工：
 *   WebSocketClient   负责连接、重连与 sessionStorage 里的重连 token；
 *   MultiplayerManager 负责权威状态、预测与回滚（本文件不改动它）；
 *   DuelController     负责界面屏幕切换、房间面板、计时显示与输入路由。
 *
 * 单机与联机共用同一个 HTMLActuator：联机时把最佳分数那一栏改成"对手"。
 */
function DuelController(actuator, options) {
  options = options || {};
  this.actuator = actuator;
  this.onExit = options.onExit || function () {};
  this.onEnter = options.onEnter || function () {};
  this.client = options.client || new WebSocketClient();
  this.manager = new MultiplayerManager(this.client, {
    onChange: this.onChange.bind(this),
    onError: this.onError.bind(this)
  });

  this.active = false;
  this.players = [];
  this.status = "";
  this.pendingAction = null;
  this.renderedHash = null;
  this.timer = null;
  this.elements = {};

  var self = this;
  this.unsubscribeRoom = this.client.subscribe(function (message) {
    if (message && message.type === "room_state") self.applyRoomState(message);
  });
  this.bindDom();
}

/* ---------------- 文案 ---------------- */

var CONNECTION_TEXT = {
  connecting: "连接中…",
  reconnecting: "连接已断开，正在重连…",
  connected: "",
  disconnected: "连接已断开",
  unavailable: "当前环境不支持联机"
};

var ERROR_TEXT = {
  PROTOCOL_MISMATCH: "客户端版本不一致，请刷新页面",
  INVALID_MESSAGE: "请求格式不正确",
  ROOM_FULL: "房间已经满了",
  ROOM_NOT_FOUND: "房间不存在或已过期",
  ROOM_LIMIT_REACHED: "服务器房间已满，请稍后再试",
  RECONNECT_EXPIRED: "重连已过期，请重新创建房间",
  RATE_LIMITED: "操作太快了，请稍候",
  HELLO_REQUIRED: "连接尚未就绪，请稍候",
  ALREADY_ASSIGNED: "你已经在一个房间里了",
  PLAYER_CONNECTED: "这个身份已在其他窗口连接",
  NOT_ASSIGNED: "你还没有加入房间",
  MATCH_NOT_READY: "对局尚未开始",
  MATCH_FINISHED: "对局已经结束",
  INVALID_DIRECTION: "无效的方向",
  SEQ_OUT_OF_ORDER: "操作顺序异常，正在同步",
  PLAYER_STUCK: "你已经无路可走了",
  OPPONENT_OFFLINE: "对手不在线",
  NOT_ENOUGH_ENERGY: "能量不足，连续合并 3 次才能发动干扰",
  NO_TARGET_SPACE: "对手棋盘已满，干扰无法落下",
  INTERFERENCE_ACTIVE: "对手棋盘上已有一个干扰块",
  SKILL_ON_COOLDOWN: "技能冷却中"
};

// 这些错误由预测回滚自动消化，弹给玩家只会造成困惑。
var SILENT_ERRORS = ["RATE_LIMITED", "SEQ_OUT_OF_ORDER", "INVALID_DIRECTION", "SKILL_ON_COOLDOWN"];

var SKILL_NAME = "interference";

var REASON_TEXT = {
  target_reached: "率先合成目标方块",
  both_stuck: "双方都无路可走",
  opponent_disconnected: "对手断线超时",
  timeout: "时间到，按分数结算",
  opponent_left: "对手退出了对局"
};

var ROOM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;

function setHidden(element, hidden) {
  if (!element) return;
  if (hidden) element.setAttribute("hidden", "hidden");
  else element.removeAttribute("hidden");
}

function formatClock(ms) {
  var total = Math.ceil(Math.max(0, ms) / 1000);
  var minutes = Math.floor(total / 60);
  var seconds = total % 60;
  return minutes + ":" + (seconds < 10 ? "0" : "") + seconds;
}

/* ---------------- 纯查询（便于测试） ---------------- */

DuelController.prototype.screenFor = function () {
  if (!this.manager.roomCode) return "lobby";
  if (this.manager.phase === "finished") return "result";
  if (this.manager.phase === "waiting") return "waiting";
  return "playing";
};

DuelController.prototype.serverNow = function () {
  return Date.now() + (this.manager.offset || 0);
};

DuelController.prototype.timeLeft = function () {
  if (!this.manager.deadlineAt) return null;
  return Math.max(0, this.manager.deadlineAt - this.serverNow());
};

DuelController.prototype.countdown = function () {
  if (this.manager.phase !== "countdown" || !this.manager.startsAt) return null;
  return Math.max(0, Math.ceil((this.manager.startsAt - this.serverNow()) / 1000));
};

DuelController.prototype.me = function () {
  var players = this.players.filter(function (player) {
    return player.playerId === this.manager.playerId;
  }, this);
  return players.length ? players[0] : null;
};

DuelController.prototype.opponentEntry = function () {
  var players = this.players.filter(function (player) {
    return player.playerId !== this.manager.playerId;
  }, this);
  return players.length ? players[0] : null;
};

DuelController.prototype.isReady = function () {
  var me = this.me();
  return !!(me && me.ready);
};

DuelController.prototype.errorText = function (code) {
  return ERROR_TEXT[code] || "发生未知错误（" + code + "）";
};

DuelController.prototype.resultText = function () {
  var result = this.manager.result;
  if (!result) return { title: "对局结束", detail: "", mine: 0, theirs: 0 };
  var me = this.manager.playerId;
  var other = me === "p1" ? "p2" : "p1";
  var scores = result.scores || {};
  return {
    title: result.winner === null || result.winner === undefined
      ? "平局" : (result.winner === me ? "你赢了！" : "你输了"),
    detail: REASON_TEXT[result.reason] || "对局结束",
    mine: scores[me] || 0,
    theirs: scores[other] || 0
  };
};

/* ---------------- 生命周期 ---------------- */

DuelController.prototype.bindDom = function () {
  if (typeof document === "undefined") return;

  var names = {
    overlay: "#duel-overlay",
    entry: "#duel-entry",
    hud: "#duel-hud",
    connection: "#duel-connection",
    statusText: "#duel-status",
    hint: "#duel-hint",
    codeInput: "#duel-code",
    roomCode: "#duel-room-code",
    players: "#duel-players",
    ready: "[data-duel-action='ready']",
    timer: "#duel-timer",
    opponentScore: "#duel-opponent-score",
    hudRoom: "#duel-hud-room",
    countdown: "#duel-countdown",
    resultTitle: "#duel-result-title",
    resultDetail: "#duel-result-detail",
    resultScore: "#duel-result-score",
    bestLabel: "#best-label",
    skill: "#duel-skill",
    skillLabel: "#duel-skill-label",
    energy: "#duel-energy",
    opponentEnergy: "#duel-opponent-energy",
    skillNotice: "#duel-skill-notice",
    opponentBoard: "#duel-opponent-board",
    opponentMax: "#duel-opponent-max",
    opponentEmpty: "#duel-opponent-empty",
    opponentPreview: "#duel-opponent-preview",
    rematch: "#duel-rematch",
    rematchHint: "#duel-rematch-hint"
  };
  for (var key in names) {
    this.elements[key] = document.querySelector(names[key]);
  }
  this.screens = {};
  var screens = document.querySelectorAll("[data-duel-screen]");
  for (var i = 0; i < screens.length; i++) {
    this.screens[screens[i].getAttribute("data-duel-screen")] = screens[i];
  }

  var self = this;
  function onClick(event) {
    var action = this.getAttribute("data-duel-action");
    if (action === "create") self.create();
    else if (action === "join") self.join(self.elements.codeInput && self.elements.codeInput.value);
    else if (action === "ready") self.setReady(!self.isReady());
    else if (action === "leave") self.leaveRoom();
    else if (action === "skill") self.useSkill();
    else if (action === "rematch") self.requestRematch();
    else if (action === "solo") self.exit();
    else if (action === "copy") self.copyCode();
    event.preventDefault();
  }
  var actions = document.querySelectorAll("[data-duel-action]");
  for (var j = 0; j < actions.length; j++) {
    actions[j].addEventListener("click", onClick);
  }
  if (this.elements.entry) {
    this.elements.entry.addEventListener("click", function (event) {
      event.preventDefault();
      self.enter();
    });
  }
  if (this.elements.overlay) {
    this.elements.overlay.addEventListener("submit", function (event) {
      event.preventDefault();
      self.join(self.elements.codeInput && self.elements.codeInput.value);
    });
  }
};

DuelController.prototype.enter = function () {
  if (this.active) return;
  this.active = true;
  this.status = "";
  this.renderedHash = null;
  this.setBestLabel("对手");
  this.onEnter();
  this.renderBoard(null);
  this.client.connect();
  this.startTimer();
  this.render();
};

DuelController.prototype.exit = function () {
  if (!this.active) return;
  if (this.manager.roomCode) this.client.send("leave_room");
  this.active = false;
  this.players = [];
  this.status = "";
  this.pendingAction = null;
  this.renderedHash = null;
  this.stopTimer();
  this.client.close();
  this.setBestLabel("最高分");
  this.render();
  this.onExit();
};

/* ---------------- 动作 ---------------- */

/*
 * 连接尚未就绪时发包会静默失败。冷启动的服务器握手可能要几秒，
 * 用户点了"创建房间"却毫无反应就会反复点，所以这里暂存一次意图，
 * 握手完成后自动补发。
 */
DuelController.prototype.send = function (type, fields) {
  if (this.client.send(type, fields)) return true;
  this.pendingAction = { type: type, fields: fields };
  this.status = CONNECTION_TEXT.connecting;
  return false;
};

DuelController.prototype.flushPending = function () {
  var action = this.pendingAction;
  if (!action || !this.client.ready) return;
  this.pendingAction = null;
  this.status = "";
  if (!this.client.send(action.type, action.fields)) this.pendingAction = action;
};

DuelController.prototype.create = function () {
  this.status = "";
  this.send("create_room", undefined);
  this.render();
};

DuelController.prototype.join = function (code) {
  var normalized = String(code === undefined || code === null ? "" : code).trim().toUpperCase();
  if (!ROOM_CODE_PATTERN.test(normalized)) {
    this.status = "房间码是 6 位字母或数字，不含 0 O 1 I";
    this.render();
    return false;
  }
  this.status = "";
  this.send("join_room", { roomCode: normalized });
  this.render();
  return true;
};

DuelController.prototype.setReady = function (value) {
  this.send("ready", { ready: !!value });
  this.render();
};

DuelController.prototype.leaveRoom = function () {
  if (this.manager.roomCode) this.client.send("leave_room");
  this.status = "";
  this.render();
};

/*
 * 能量、冷却和干扰提示都来自服务端权威值；本地只做镜像显示。
 * 冷却用服务器时钟判断，避免本机时间漂移导致提前可用。
 */
DuelController.prototype.skillState = function () {
  var energy = this.manager.energy || 0;
  var opponentEnergy = this.manager.opponentEnergy || 0;
  var remaining = this.manager.skillReadyIn();
  var playing = this.manager.phase === "playing" && !!this.manager.roomCode;
  var max = GameLogic.ENERGY_MAX;
  return {
    energy: energy, opponentEnergy: opponentEnergy, max: max,
    cooldown: remaining, playing: playing,
    ready: playing && energy >= 1 && remaining <= 0,
    label: energy >= 1 ? "释放干扰" : "能量不足",
    hint: energy >= 1
      ? "连续合并 3 次获得 1 点能量，最多存 2 点"
      : "连续合并 3 次获得 1 点能量"
  };
};

DuelController.prototype.useSkill = function () {
  if (!this.active) return false;
  this.status = "";
  if (!this.manager.useSkill()) {
    this.status = this.errorText(this.manager.energy >= 1
      ? "SKILL_ON_COOLDOWN"
      : "NOT_ENOUGH_ENERGY");
    this.render();
    return false;
  }
  this.render();
  return true;
};

DuelController.prototype.renderSkill = function () {
  var skillButton = this.el("skill");
  var skill = this.skillState();
  setHidden(skillButton, !skill.playing);
  if (skillButton) {
    skillButton.disabled = !skill.ready;
    skillButton.setAttribute("aria-disabled", skill.ready ? "false" : "true");
    skillButton.title = skill.cooldown > 0
      ? "冷却 " + Math.ceil(skill.cooldown / 1000) + " 秒"
      : skill.hint;
  }
  var skillLabel = this.el("skillLabel");
  if (skillLabel) skillLabel.textContent = skill.label;

  // 能量用实心/空心格子表示，不显示数字，避免和分数争夺注意力。
  var energy = this.el("energy");
  if (energy) this.renderPips(energy, skill.energy, skill.max);
  var opponentEnergy = this.el("opponentEnergy");
  if (opponentEnergy) this.renderPips(opponentEnergy, skill.opponentEnergy, skill.max);

  // 干扰提示优先于冷却文案：被干扰是玩家最需要立刻知道的事。
  var notice = this.el("skillNotice");
  if (notice) {
    var last = this.manager.lastSkill;
    var fresh = last && this.serverNow() - last.at < 4000;
    if (fresh && last.from === "opponent") {
      notice.textContent = "对手在你的棋盘上放下了干扰块";
      notice.setAttribute("data-tone", "alert");
    } else if (fresh && last.from === "me") {
      notice.textContent = "干扰已释放到对手棋盘";
      notice.setAttribute("data-tone", "info");
    } else {
      notice.removeAttribute("data-tone");
      if (skill.cooldown > 0) {
        notice.textContent = "干扰冷却 " + Math.ceil(skill.cooldown / 1000) + " 秒";
      } else if (skill.energy >= 1) {
        notice.textContent = skill.hint;
      } else {
        notice.textContent = "";
      }
    }
  }
};

DuelController.prototype.renderPips = function (container, filled, max) {
  if (typeof document === "undefined" || !container.children) return;
  // 复用已有节点，只增删差值，避免每 200ms 重建 DOM。
  while (container.children.length > max) {
    container.removeChild(container.lastChild);
  }
  while (container.children.length < max) {
    var pip = document.createElement("span");
    pip.className = "energy-pip";
    container.appendChild(pip);
  }
  for (var i = 0; i < max; i++) {
    container.children[i].setAttribute("data-filled", i < filled ? "true" : "false");
  }
};

/*
 * 对手棋盘预览：只读快照，不做预测也不播动画。
 *
 * 这里没有复用 HTMLActuator —— 它写死了 .tile-container 和 .tile-* 动画，
 * 给它加第二个容器会波及单机链路。预览只需要 16 个静态格子，所以单独渲染，
 * 只借用同一套 tile 颜色变量以保持观感一致。
 */
DuelController.prototype.renderOpponentBoard = function () {
  var board = this.el("opponentBoard");
  if (!board || typeof document === "undefined") return;
  var state = this.manager.opponent;
  var playing = this.manager.phase === "playing" || this.manager.phase === "countdown";

  setHidden(this.el("opponentPreview") || document.querySelector("#duel-opponent-preview"),
    !(this.active && playing));
  if (!playing) return;

  var cells = [];
  var max = 0;
  if (state && state.cells) {
    for (var x = 0; x < 4; x++) {
      for (var y = 0; y < 4; y++) {
        var tile = state.cells[x] && state.cells[x][y];
        if (tile) max = Math.max(max, tile.value);
        cells.push(tile);
      }
    }
  }
  setHidden(this.el("opponentEmpty"), cells.length > 0);

  // 格子数量固定为 16，只在首次创建，之后只改内容，避免每次刷新重建 DOM。
  while (board.children.length > 16) board.removeChild(board.lastChild);
  while (board.children.length < 16) {
    var cell = document.createElement("span");
    cell.className = "opponent-cell";
    board.appendChild(cell);
  }
  for (var i = 0; i < 16; i++) {
    var tile = cells[i];
    var node = board.children[i];
    node.textContent = tile ? String(tile.value) : "";
    node.setAttribute("data-value", tile ? String(tile.value) : "0");
    node.setAttribute("data-interference", tile && tile.interference ? "true" : "false");
  }
  var maxLabel = this.el("opponentMax");
  if (maxLabel) maxLabel.textContent = String(max);
};

DuelController.prototype.rematchVotes = function () {
  var votes = this.rematchState || { p1: false, p2: false };
  var me = this.manager.playerId === "p1";
  return {
    mine: !!(me ? votes.p1 : votes.p2),
    theirs: !!(me ? votes.p2 : votes.p1),
    offline: !this.opponentEntry() || this.opponentEntry().status !== "connected"
  };
};

DuelController.prototype.renderRematch = function () {
  if (this.screenFor() !== "result") return;
  var button = this.el("rematch");
  var votes = this.rematchVotes();
  if (button) {
    button.textContent = votes.mine ? "取消再来一局" : "再来一局";
    button.setAttribute("aria-pressed", votes.mine ? "true" : "false");
    button.disabled = votes.offline;
  }
  var hint = this.el("rematchHint");
  if (hint) {
    if (votes.offline) hint.textContent = "对手不在线，无法开始新的一局";
    else if (votes.mine && votes.theirs) hint.textContent = "即将开始…";
    else if (votes.theirs) hint.textContent = "对手也点了再来一局";
    else if (votes.mine) hint.textContent = "等待对手同意…";
    else hint.textContent = "";
  }
};

DuelController.prototype.requestRematch = function () {
  if (!this.active) return false;
  this.status = "";
  var sent = this.send("rematch", undefined);
  // 乐观翻转，让按钮立刻有反馈；服务端 room_state 回来后会纠正。
  var votes = this.rematchState || { p1: false, p2: false };
  if (this.manager.playerId === "p1") votes.p1 = !votes.p1;
  else votes.p2 = !votes.p2;
  this.rematchState = votes;
  this.renderRematch();
  return sent;
};

DuelController.prototype.copyCode = function () {
  var code = this.manager.roomCode;
  if (!code || typeof navigator === "undefined" || !navigator.clipboard) return;
  navigator.clipboard.writeText(code).then(function () {}, function () {});
};

DuelController.prototype.move = function (direction) {
  if (!this.active) return false;
  return this.manager.move(direction);
};

/* ---------------- 事件 ---------------- */

DuelController.prototype.applyRoomState = function (message) {
  this.players = message && Array.isArray(message.players) ? message.players : [];
  if (message && message.rematchVotes) this.rematchState = message.rematchVotes;
  this.render();
};

DuelController.prototype.onChange = function (payload) {
  if (!this.active) return;
  if (payload.connectionStatus === "connected") this.flushPending();
  this.renderBoard(payload);
  this.render();
};

DuelController.prototype.onError = function (message) {
  if (!this.active || !message) return;
  if (SILENT_ERRORS.indexOf(message.code) >= 0) return;
  this.status = this.errorText(message.code);
  this.render();
};

/* ---------------- 渲染 ---------------- */

DuelController.prototype.renderBoard = function (payload) {
  var state = payload && payload.state ? payload.state : null;
  if (!state) state = GameLogic.createInitialState(1, { startTiles: 0, size: 4 });

  var hash = GameLogic.hashState(state);
  // clock 与 opponent_update 也会触发 notify；无变化时不动棋盘，否则会打断进行中的动画。
  if (hash === this.renderedHash && !(payload && payload.events)) return;
  this.renderedHash = hash;

  var opponent = payload && payload.opponent ? payload.opponent : null;
  var grid = ViewState.buildGrid(state, payload ? payload.events : null);
  this.actuator.actuate(grid, {
    score: state.score,
    over: false,
    won: false,
    bestScore: opponent ? opponent.score : 0,
    terminated: false
  });
};

DuelController.prototype.setBestLabel = function (text) {
  var label = this.el("bestLabel");
  if (label) label.textContent = text;
};

DuelController.prototype.el = function (name) {
  return this.elements[name] || null;
};

DuelController.prototype.render = function () {
  if (typeof document === "undefined") return;
  var screen = this.screenFor();
  var self = this;

  document.documentElement.classList.toggle("duel-mode", this.active);

  setHidden(this.el("overlay"), !this.active || screen === "playing");
  for (var name in this.screens) {
    setHidden(this.screens[name], name !== screen);
  }
  setHidden(this.el("hud"), !(this.active && this.manager.roomCode));
  setHidden(this.el("entry"), this.active);

  // 大厅与等待阶段的提示写在遮罩内，对局中的提示写在棋盘下方。
  var statusText = this.active
    ? (this.status || CONNECTION_TEXT[this.manager.connectionStatus] || "")
    : "";
  var tone = this.status ? "error" : "info";
  ["connection", "statusText"].forEach(function (name) {
    var element = self.el(name);
    if (!element) return;
    element.textContent = statusText;
    element.setAttribute("data-tone", tone);
  });

  var roomCode = this.el("roomCode");
  if (roomCode) roomCode.textContent = this.manager.roomCode || "------";
  var hudRoom = this.el("hudRoom");
  if (hudRoom) hudRoom.textContent = this.manager.roomCode || "------";

  this.renderPlayers();
  this.renderResult();
  this.renderTimer();
  this.renderSkill();
  this.renderOpponentBoard();
  this.renderRematch();
};

DuelController.prototype.renderPlayers = function () {
  var me = this.me();
  var readyButton = this.el("ready");
  var ready = !!(me && me.ready);
  if (readyButton) {
    readyButton.textContent = ready ? "取消准备" : "准备";
    readyButton.disabled = !this.manager.roomCode;
  }

  var hint = this.el("hint");
  var opponent = this.opponentEntry();
  if (hint) {
    if (!opponent) hint.textContent = "把房间码发给对手，等待对方加入";
    else if (opponent.status !== "connected") hint.textContent = "对手已断线，等待重连…";
    else if (!opponent.ready || !ready) hint.textContent = "双方都准备后开始";
    else hint.textContent = "即将开始…";
  }

  var list = this.el("players");
  if (!list || typeof document === "undefined") return;
  while (list.firstChild) list.removeChild(list.firstChild);
  this.players.forEach(function (player) {
    var item = document.createElement("li");
    item.className = "duel-player";
    var label = player.playerId === this.manager.playerId ? "你" : "对手";
    var state = player.status !== "connected" ? "已断线"
      : (player.ready ? "已准备" : "未准备");
    item.textContent = label + "（" + player.playerId + "）· " + state;
    list.appendChild(item);
  }, this);
};

DuelController.prototype.renderResult = function () {
  if (this.screenFor() !== "result") return;
  var text = this.resultText();
  var title = this.el("resultTitle");
  var detail = this.el("resultDetail");
  var score = this.el("resultScore");
  if (title) title.textContent = text.title;
  if (detail) detail.textContent = text.detail;
  if (score) score.textContent = "你 " + text.mine + " · 对手 " + text.theirs;
};

DuelController.prototype.renderTimer = function () {
  var opponent = this.manager.opponent;
  var opponentScore = this.el("opponentScore");
  if (opponentScore) opponentScore.textContent = opponent ? opponent.score : 0;

  // 表头第二栏也显示对手分数。棋盘重绘受哈希节流，对手走棋不会触发，
  // 所以这里必须单独刷新，否则对手的分数会一直停在上一帧。
  if (opponent && this.actuator && this.actuator.updateBestScore) {
    this.actuator.updateBestScore(opponent.score);
  }

  var timer = this.el("timer");
  var countdown = this.el("countdown");
  var remaining = this.timeLeft();
  var count = this.countdown();

  if (timer) timer.textContent = remaining === null ? "--:--" : formatClock(remaining);
  if (countdown) {
    setHidden(countdown, count === null);
    if (count !== null) countdown.textContent = count > 0 ? String(count) : "开始";
  }
};

DuelController.prototype.startTimer = function () {
  var self = this;
  if (this.timer) return;
  // 冷却按秒显示，所以连同能量一起每 200ms 刷新一次。
  this.timer = setInterval(function () {
    if (!self.active) return;
    self.renderTimer();
    self.renderSkill();
    self.renderOpponentBoard();
  }, 200);
  if (this.timer && this.timer.unref) this.timer.unref();
};

DuelController.prototype.stopTimer = function () {
  clearInterval(this.timer);
  this.timer = null;
};

DuelController.prototype.destroy = function () {
  this.stopTimer();
  if (this.unsubscribeRoom) this.unsubscribeRoom();
  this.manager.destroy();
  this.client.close();
};
