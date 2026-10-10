/*
 * 联机界面与房间流程检查。
 *
 * 纯查询（屏幕切换、倒计时、结算文案、错误文案）用 Object.create 直接验证；
 * 面板显隐与消息发送用最小 DOM / 假客户端驱动真实构造函数。
 */
"use strict";

var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var vm = require("node:vm");
var GameLogic = require("../js/game_logic");
var MultiplayerManager = require("../js/multiplayer_manager");

/* ---------------- 最小 DOM ---------------- */

var classes = {};
var sent = [];
var fakeClient = {
  send: function (type, fields) { sent.push({ type: type, fields: fields }); return true; },
  subscribe: function () { return function () {}; },
  connect: function () {}, close: function () {}
};

var selectors = ["#duel-overlay", "#duel-entry", "#duel-hud", "#duel-connection", "#duel-status",
  "#duel-hint", "#duel-code", "#duel-room-code", "#duel-players", "[data-duel-action='ready']",
  "#duel-timer", "#duel-opponent-score", "#duel-hud-room", "#duel-countdown",
  "#duel-result-title", "#duel-result-detail", "#duel-result-score", "#best-label",
  "#duel-skill", "#duel-skill-label", "#duel-energy", "#duel-opponent-energy", "#duel-skill-notice",
  "#duel-opponent-board", "#duel-opponent-max", "#duel-opponent-empty",
  "#duel-opponent-preview", "#duel-rematch", "#duel-rematch-hint"];

function makeElement() {
  var element = {
    textContent: "", children: [], firstChild: null, attributes: {}, listeners: {},
    setAttribute: function (k, v) { this.attributes[k] = String(v); },
    removeAttribute: function (k) { delete this.attributes[k]; },
    getAttribute: function (k) { return this.attributes[k] === undefined ? null : this.attributes[k]; },
    addEventListener: function (t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    // firstChild 必须跟随子节点变化：清空列表依赖它。
    appendChild: function (n) { this.children.push(n); this.firstChild = this.children[0]; },
    removeChild: function (n) {
      var i = this.children.indexOf(n);
      if (i >= 0) this.children.splice(i, 1);
      this.firstChild = this.children.length ? this.children[0] : null;
    },
    get lastChild() { return this.children[this.children.length - 1] || null; },
    getElementsByTagName: function () { return []; }
  };
  // 真实 DOM 会把赋值强制转成字符串，桩也必须如此，否则断言会假阳性。
  var text = "";
  Object.defineProperty(element, "textContent", {
    get: function () { return text; },
    set: function (value) { text = value === null || value === undefined ? "" : String(value); }
  });
  return element;
}

var elements = {};
selectors.forEach(function (s) { elements[s] = makeElement(); });
var screens = { lobby: makeElement(), waiting: makeElement(), result: makeElement() };
screens.lobby.setAttribute("data-duel-screen", "lobby");
screens.waiting.setAttribute("data-duel-screen", "waiting");
screens.result.setAttribute("data-duel-screen", "result");

var context = vm.createContext({
  GameLogic: GameLogic,
  MultiplayerManager: MultiplayerManager,
  // 计时器用桩替代：这些测试只验证调度关系，不需要真实时钟。
  setInterval: function () { return { unref: function () {} }; },
  clearInterval: function () {},
  document: {
    documentElement: { classList: { toggle: function (k, v) { classes[k] = v; } } },
    querySelector: function (s) { return elements[s] || null; },
    querySelectorAll: function (s) {
      if (s === "[data-duel-screen]") return [screens.lobby, screens.waiting, screens.result];
      return [];
    },
    createElement: function () { return makeElement(); }
  }
});
["grid", "tile", "view_state", "duel_controller"].forEach(function (file) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/" + file + ".js"), "utf8"), context);
});
var DuelController = context.DuelController;

var passed = 0;
function check(name, fn) { fn(); passed++; console.log("Passed: " + name); }

// 报文对象来自 vm 上下文，deepStrictEqual 会比较原型，这里只比内容。
function takeSent(expected) {
  var actual = sent.pop();
  assert.ok(actual, "应当发出报文 " + expected.type);
  assert.equal(actual.type, expected.type);
  assert.equal(JSON.stringify(actual.fields), JSON.stringify(expected.fields));
}

/* ---------------- 测试骨架 ---------------- */

function bare(overrides) {
  var controller = Object.create(DuelController.prototype);
  controller.active = true;
  controller.players = [];
  controller.status = "";
  controller.renderedHash = null;
  controller.elements = {};
  controller.client = fakeClient;
  controller.now = Date.now;
  controller.manager = {
    roomCode: null, phase: "waiting", offset: 0, startsAt: 0, deadlineAt: 0,
    playerId: "p1", opponent: null, result: null, connectionStatus: "connected",
    energy: 0, opponentEnergy: 0, cooldownUntil: 0, skillReadyIn: function () { return 0; }
  };
  Object.keys(overrides || {}).forEach(function (key) {
    if (key === "manager") Object.assign(controller.manager, overrides[key]);
    else controller[key] = overrides[key];
  });
  return controller;
}

function live(actuator) {
  sent.length = 0;
  return new DuelController(actuator || { actuate: function () {} }, { client: fakeClient });
}

/* ---------------- 屏幕切换 ---------------- */

check("屏幕按房间与阶段切换：大厅 / 等待 / 对局 / 结算", function () {
  var controller = bare();
  assert.equal(controller.screenFor(), "lobby");

  controller.manager.roomCode = "AB7KQ2";
  controller.manager.phase = "waiting";
  assert.equal(controller.screenFor(), "waiting");

  controller.manager.phase = "countdown";
  assert.equal(controller.screenFor(), "playing");

  controller.manager.phase = "playing";
  assert.equal(controller.screenFor(), "playing");

  controller.manager.phase = "finished";
  assert.equal(controller.screenFor(), "result");

  controller.manager.roomCode = null;
  assert.equal(controller.screenFor(), "lobby", "离开房间后必须回到大厅");
});

/* ---------------- 房间码 ---------------- */

check("加入房间：小写归一化后发送，非法房间码不发包", function () {
  var controller = live();

  assert.equal(controller.join("ab7kq2"), true);
  takeSent({ type: "join_room", fields: { roomCode: "AB7KQ2" } });   // 房间码必须转成大写再发送

  assert.equal(controller.join("  ab7kq2  "), true, "两侧空白应被忽略");
  assert.equal(sent.pop().fields.roomCode, "AB7KQ2");

  ["AB7KQ", "AB7KQ23", "", "AB7KQ0", "AB7KQI", "AB7KQO", "AB7KQ1", "AB-KQ2"].forEach(function (code) {
    sent.length = 0;
    assert.equal(controller.join(code), false, "应拒绝房间码 " + JSON.stringify(code));
    assert.equal(sent.length, 0, "非法房间码不得发包：" + code);
  });
  assert.match(controller.status, /6 位/, "应给出可读的房间码提示");
});

check("创建房间与准备状态发送正确的报文", function () {
  var controller = live();
  controller.manager.playerId = "p1";        // 身份由 assigned 报文绑定
  sent.length = 0;

  controller.create();
  takeSent({ type: "create_room", fields: undefined });

  controller.players = [{ playerId: "p1", status: "connected", ready: false }];
  assert.equal(controller.isReady(), false);
  controller.setReady(true);
  takeSent({ type: "ready", fields: { ready: true } });

  controller.players = [{ playerId: "p1", status: "connected", ready: true }];
  assert.equal(controller.isReady(), true);
  controller.setReady(!controller.isReady());
  takeSent({ type: "ready", fields: { ready: false } });   // 准备状态必须可撤销
});

/* ---------------- 计时 ---------------- */

check("倒计时与剩余时间使用服务端时钟，不受本地时间漂移影响", function () {
  var controller = bare();
  var now = Date.now();
  controller.manager.offset = 5000;              // 服务端比本地快 5 秒
  controller.manager.startsAt = now + 5000 + 2000;   // 服务端时间下还有 2 秒
  controller.manager.deadlineAt = now + 5000 + 60000;
  controller.manager.phase = "countdown";

  assert.equal(controller.countdown(), 2, "倒计时应按服务端时间算");
  assert.equal(controller.timeLeft(), 60000);

  controller.manager.phase = "playing";
  assert.equal(controller.countdown(), null, "对局中不显示倒计时");
  assert.equal(controller.timeLeft(), 60000);

  controller.manager.deadlineAt = now;           // 已过截止时间
  assert.equal(controller.timeLeft(), 0, "剩余时间不得为负");
});

/* ---------------- 结算 ---------------- */

check("结算文案区分胜负平并翻译结束原因", function () {
  var controller = bare();
  controller.manager.playerId = "p2";
  controller.manager.result = {
    winner: "p2", reason: "target_reached", scores: { p1: 120, p2: 340 }
  };
  var text = controller.resultText();
  assert.equal(text.title, "你赢了！");
  assert.equal(text.detail, "率先合成目标方块");
  assert.equal(text.mine, 340, "自己的分数必须按 playerId 取");
  assert.equal(text.theirs, 120);

  controller.manager.result.winner = "p1";
  assert.equal(controller.resultText().title, "你输了");

  controller.manager.result.winner = null;
  assert.equal(controller.resultText().title, "平局");

  var reasons = { both_stuck: "双方都无路可走", opponent_disconnected: "对手断线超时",
    timeout: "时间到，按分数结算", opponent_left: "对手退出了对局" };
  Object.keys(reasons).forEach(function (reason) {
    controller.manager.result.reason = reason;
    assert.equal(controller.resultText().detail, reasons[reason]);
  });

  controller.manager.result = null;
  assert.equal(controller.resultText().title, "对局结束", "没有结果时不能崩");
});

/* ---------------- 错误 ---------------- */

check("错误按 code 翻译成中文，回滚类错误不打扰玩家", function () {
  var controller = live();
  controller.active = true;                  // 只有联机模式下才提示错误
  assert.equal(controller.errorText("ROOM_FULL"), "房间已经满了");
  assert.equal(controller.errorText("ROOM_NOT_FOUND"), "房间不存在或已过期");
  assert.match(controller.errorText("SOMETHING_NEW"), /SOMETHING_NEW/, "未知错误码要保留原文");

  controller.onError({ code: "ROOM_FULL" });
  assert.equal(controller.status, "房间已经满了");

  controller.status = "";
  ["RATE_LIMITED", "SEQ_OUT_OF_ORDER", "INVALID_DIRECTION"].forEach(function (code) {
    controller.onError({ code: code });
    assert.equal(controller.status, "", code + " 由回滚自动消化，不应显示给玩家");
  });
});

/* ---------------- 渲染节流 ---------------- */

check("棋盘只在状态真正变化时重绘，避免打断动画", function () {
  var renders = 0;
  var controller = live({ actuate: function () { renders++; } });

  function payload(extra) {
    var state = GameLogic.createInitialState(42, { startTiles: 0 });
    state.score = 8;
    return Object.assign({ state: state, opponent: null, events: null }, extra || {});
  }

  var first = payload();
  controller.renderBoard(first);
  assert.equal(renders, 1);

  controller.renderBoard(payload());          // 同一状态（clock / 对手更新）
  assert.equal(renders, 1, "状态未变时不得重绘");

  var moved = payload();
  moved.state.cells[0][0] = { position: { x: 0, y: 0 }, value: 4, interference: false };
  controller.renderBoard(moved);
  assert.equal(renders, 2, "状态变化必须重绘");

  controller.renderBoard({ state: null });
  assert.equal(renders, 3, "没有状态时渲染空盘");
});

check("联机对局不写入单机最高分：最佳分数栏改为展示对手", function () {
  var meta = null;
  var controller = live({ actuate: function (grid, m) { meta = m; } });
  elements["#best-label"].textContent = "最高分";

  var state = GameLogic.createInitialState(7, { startTiles: 0 });
  state.score = 100;
  controller.renderBoard({ state: state, opponent: { score: 250 }, events: null });

  assert.equal(meta.bestScore, 250, "第二栏显示对手分数");
  assert.equal(meta.terminated, false, "联机结算由面板负责，不能弹出单机结算层");
  assert.equal(meta.over, false);
  assert.equal(meta.won, false);

  controller.setBestLabel("对手");
  assert.equal(elements["#best-label"].textContent, "对手");
});

/* ---------------- 面板显隐 ---------------- */

check("面板显隐：等待显示等待页，对局隐藏遮罩并显示 HUD", function () {
  var controller = live();

  controller.enter();
  assert.equal(classes["duel-mode"], true, "进入联机要打上 duel-mode");
  assert.equal(elements["#duel-overlay"].getAttribute("hidden"), null, "大厅要显示遮罩");
  assert.equal(screens.lobby.getAttribute("hidden"), null, "大厅屏可见");
  assert.equal(screens.waiting.getAttribute("hidden"), "hidden", "等待屏隐藏");
  assert.equal(elements["#duel-entry"].getAttribute("hidden"), "hidden", "入口按钮隐藏");

  controller.players = [
    { playerId: "p1", status: "connected", ready: true },
    { playerId: "p2", status: "connected", ready: false }
  ];
  controller.manager.playerId = "p1";
  controller.manager.roomCode = "AB7KQ2";
  controller.manager.phase = "waiting";
  controller.render();

  assert.equal(screens.waiting.getAttribute("hidden"), null, "等待屏可见");
  assert.equal(screens.lobby.getAttribute("hidden"), "hidden");
  assert.equal(elements["#duel-room-code"].textContent, "AB7KQ2");
  assert.equal(elements["[data-duel-action='ready']"].textContent, "取消准备");
  assert.equal(elements["#duel-hint"].textContent, "双方都准备后开始");
  assert.equal(elements["#duel-players"].children.length, 2, "应列出两名玩家");

  controller.manager.phase = "playing";
  controller.render();
  assert.equal(elements["#duel-overlay"].getAttribute("hidden"), "hidden", "对局中收起遮罩");
  assert.equal(elements["#duel-hud"].getAttribute("hidden"), null, "对局中显示 HUD");

  controller.manager.phase = "finished";
  controller.manager.result = { winner: "p1", reason: "timeout", scores: { p1: 10, p2: 4 } };
  controller.render();
  assert.equal(screens.result.getAttribute("hidden"), null, "结算屏可见");
  assert.equal(elements["#duel-result-title"].textContent, "你赢了！");
  assert.equal(elements["#duel-result-detail"].textContent, "时间到，按分数结算");
  assert.equal(elements["#duel-result-score"].textContent, "你 10 · 对手 4");
});

check("对手离线与未准备给出对应提示", function () {
  var controller = live();
  controller.enter();
  controller.manager.playerId = "p1";
  controller.manager.roomCode = "AB7KQ2";
  controller.manager.phase = "waiting";

  controller.players = [{ playerId: "p1", status: "connected", ready: false }];
  controller.render();
  assert.equal(elements["#duel-hint"].textContent, "把房间码发给对手，等待对方加入");

  controller.players = [{ playerId: "p1", status: "connected", ready: true },
    { playerId: "p2", status: "disconnected", ready: false }];
  controller.render();
  assert.equal(elements["#duel-hint"].textContent, "对手已断线，等待重连…");

  controller.players[1].status = "connected";
  controller.render();
  assert.equal(elements["#duel-hint"].textContent, "双方都准备后开始");

  controller.players[1].ready = true;
  controller.render();
  assert.equal(elements["#duel-hint"].textContent, "即将开始…", "双方都准备好后提示即将开始");
});

check("离开与退出：联机时发包，退出后交还单机", function () {
  var exited = 0;
  var controller = live();
  controller.onExit = function () { exited++; };
  controller.enter();
  controller.manager.roomCode = "AB7KQ2";

  sent.length = 0;
  controller.leaveRoom();
  takeSent({ type: "leave_room", fields: undefined });

  sent.length = 0;
  controller.exit();
  assert.equal(exited, 1, "退出联机要通知单机恢复");
  assert.equal(controller.active, false);
  assert.equal(classes["duel-mode"], false, "退出后要摘掉 duel-mode");
  assert.equal(elements["#duel-overlay"].getAttribute("hidden"), "hidden");
  assert.equal(elements["#best-label"].textContent, "最高分", "最高分标签要还原");
  assert.equal(sent.filter(function (m) { return m.type === "leave_room"; }).length, 1,
    "仍在房间内时退出要顺便退房");

  // 未进入联机时不应发包
  var idle = live();
  sent.length = 0;
  idle.move(3);
  assert.equal(idle.move(3), false, "非联机模式下 move 必须返回 false");
  assert.equal(sent.length, 0);
});

check("页面结构：脚本齐全且加载顺序正确，控制器查询的元素都存在", function () {
  var html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  var scripts = (html.match(/<script src="([^"]+)"/g) || []).map(function (tag) {
    return tag.replace(/.*src="([^"]+)".*/, "$1");
  });

  scripts.forEach(function (src) {
    assert.ok(fs.existsSync(path.join(__dirname, "..", src)), "index.html 引用了不存在的脚本：" + src);
  });
  assert.ok(scripts.indexOf("js/view_state.js") >= 0, "缺少 view_state.js");
  assert.ok(scripts.indexOf("js/view_state.js") < scripts.indexOf("js/game_manager.js"),
    "view_state.js 必须在 game_manager.js 之前加载");
  assert.ok(scripts.indexOf("js/multiplayer_manager.js") < scripts.indexOf("js/duel_controller.js"),
    "duel_controller.js 必须在 multiplayer_manager.js 之后加载");

  // 控制器用 querySelector 取这些元素，拼错一个就是静默失效。
  selectors.forEach(function (selector) {
    if (selector.charAt(0) !== "#") return;
    assert.ok(html.indexOf('id="' + selector.slice(1) + '"') >= 0,
      "index.html 缺少控制器依赖的元素：" + selector);
  });
  assert.ok(html.indexOf("data-duel-action='ready'") >= 0 || html.indexOf('data-duel-action="ready"') >= 0,
    "index.html 缺少准备按钮");
  ["lobby", "waiting", "result"].forEach(function (name) {
    assert.ok(html.indexOf('data-duel-screen="' + name + '"') >= 0, "缺少 " + name + " 屏幕");
  });
});

check("握手未就绪时的操作会暂存，并在连接建立后自动补发", function () {
  var offline = {
    ready: false, sent: [],
    send: function (type, fields) {
      if (!this.ready) return false;
      this.sent.push({ type: type, fields: fields });
      return true;
    },
    subscribe: function () { return function () {}; },
    connect: function () {}, close: function () {}
  };
  var controller = new DuelController({ actuate: function () {} }, { client: offline });
  controller.active = true;

  controller.create();
  assert.equal(offline.sent.length, 0, "未就绪时不应发包");
  assert.ok(controller.pendingAction, "意图必须被暂存，否则用户点击看起来毫无反应");
  assert.equal(controller.status, "连接中…");

  offline.ready = true;
  controller.onChange({ connectionStatus: "connected" });
  assert.equal(offline.sent.length, 1, "握手完成后应自动补发");
  assert.equal(offline.sent[0].type, "create_room");
  assert.equal(controller.pendingAction, null, "补发后必须清空");
  assert.equal(controller.status, "");

  offline.ready = false;
  controller.join("ab7kq2");
  offline.ready = true;
  offline.send = function () { return false; };
  controller.flushPending();
  assert.ok(controller.pendingAction, "补发失败必须保留意图");
});

/* 元素名到选择器的映射，与 DuelController.bindDom 保持一致。 */
var ELEMENT_NAMES = {
  overlay: "#duel-overlay", entry: "#duel-entry", hud: "#duel-hud",
  connection: "#duel-connection", statusText: "#duel-status", hint: "#duel-hint",
  codeInput: "#duel-code", roomCode: "#duel-room-code", players: "#duel-players",
  ready: "[data-duel-action='ready']", timer: "#duel-timer",
  opponentScore: "#duel-opponent-score", hudRoom: "#duel-hud-room",
  countdown: "#duel-countdown", resultTitle: "#duel-result-title",
  resultDetail: "#duel-result-detail", resultScore: "#duel-result-score",
  bestLabel: "#best-label", skill: "#duel-skill", skillLabel: "#duel-skill-label",
  energy: "#duel-energy", opponentEnergy: "#duel-opponent-energy",
  skillNotice: "#duel-skill-notice", opponentBoard: "#duel-opponent-board",
  opponentMax: "#duel-opponent-max", opponentEmpty: "#duel-opponent-empty",
  opponentPreview: "#duel-opponent-preview", rematch: "#duel-rematch",
  rematchHint: "#duel-rematch-hint"
};

function withElements(controller) {
  var mapped = {};
  Object.keys(ELEMENT_NAMES).forEach(function (name) {
    mapped[name] = elements[ELEMENT_NAMES[name]];
  });
  controller.elements = mapped;
  return controller;
}

check("技能按钮只在联机对局中出现，能量与冷却决定可用状态", function () {
  var controller = withElements(bare({
    manager: { roomCode: "ABCDEF", phase: "playing", energy: 2, cooldown: 0 }
  }));
  Object.assign(controller.manager, {
    energy: 2, opponentEnergy: 1,
    skillReadyIn: function () { return 0; }
  });

  controller.renderSkill();
  assert.equal(elements["#duel-skill"].getAttribute("hidden"), null, "对局中应显示技能条");
  assert.equal(elements["#duel-skill-label"].textContent, "释放干扰");
  assert.equal(elements["#duel-skill"].disabled, false, "能量足够且无冷却时可点击");
  assert.equal(elements["#duel-energy"].children.length, GameLogic.ENERGY_MAX);
  assert.equal(elements["#duel-energy"].children[0].getAttribute("data-filled"), "true");
  assert.equal(elements["#duel-energy"].children[1].getAttribute("data-filled"), "true");
  assert.equal(elements["#duel-opponent-energy"].children[0].getAttribute("data-filled"), "true");
  assert.equal(elements["#duel-opponent-energy"].children[1].getAttribute("data-filled"), "false");

  controller.manager.energy = 0;
  controller.renderSkill();
  assert.equal(elements["#duel-skill-label"].textContent, "能量不足");
  assert.equal(elements["#duel-skill"].disabled, true);
  assert.equal(elements["#duel-skill"].getAttribute("aria-disabled"), "true");
  assert.equal(elements["#duel-energy"].children[0].getAttribute("data-filled"), "false");

  controller.manager.energy = 1;
  controller.manager.skillReadyIn = function () { return 2400; };
  controller.renderSkill();
  assert.equal(elements["#duel-skill-notice"].textContent, "干扰冷却 3 秒");
  assert.equal(elements["#duel-skill"].disabled, true);

  // 被干扰的提示必须盖过冷却文案，且用告警色。
  controller.manager.lastSkill = { from: "opponent", at: controller.serverNow() };
  controller.renderSkill();
  assert.equal(elements["#duel-skill-notice"].textContent, "对手在你的棋盘上放下了干扰块");
  assert.equal(elements["#duel-skill-notice"].getAttribute("data-tone"), "alert");

  controller.manager.lastSkill = { from: "me", at: controller.serverNow() };
  controller.renderSkill();
  assert.equal(elements["#duel-skill-notice"].textContent, "干扰已释放到对手棋盘");

  // 提示过期后回落到冷却文案，不长期占据位置。
  controller.manager.lastSkill = { from: "opponent", at: controller.serverNow() - 5000 };
  controller.renderSkill();
  assert.equal(elements["#duel-skill-notice"].textContent, "干扰冷却 3 秒");
  assert.equal(elements["#duel-skill-notice"].getAttribute("data-tone"), null);

  controller.manager.phase = "waiting";
  controller.renderSkill();
  assert.equal(elements["#duel-skill"].getAttribute("hidden"), "hidden", "非对局阶段不显示技能条");

  controller.manager.phase = "finished";
  controller.renderSkill();
  assert.equal(elements["#duel-skill"].getAttribute("hidden"), "hidden");
});

check("点击技能按钮发出 use_skill，被本地条件拒绝时给出中文提示", function () {
  sent.length = 0;
  var controller = withElements(bare({
    manager: { roomCode: "ABCDEF", phase: "playing", energy: 1 }
  }));
  Object.assign(controller.manager, {
    energy: 1, skillReadyIn: function () { return 0; }
  });
  controller.client = {
    send: function (type, fields) { sent.push({ type: type, fields: fields }); return true; },
    subscribe: function () { return function () {}; },
    connect: function () {}, close: function () {}
  };
  // 控制器只发"用掉 1 点能量"的请求，位置和数值一律不带。
  controller.manager.useSkill = function () { return controller.send("use_skill"); };
  assert.equal(controller.useSkill(), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "use_skill");
  assert.equal("position" in (sent[0].fields || {}), false, "客户端不得指定干扰位置");
  assert.equal("value" in (sent[0].fields || {}), false, "客户端不得指定干扰数值");

  controller.manager.useSkill = function () { return false; };
  controller.manager.energy = 0;
  assert.equal(controller.useSkill(), false);
  assert.equal(controller.status, "能量不足，连续合并 3 次才能发动干扰");

  controller.manager.energy = 1;
  controller.manager.useSkill = function () { return false; };
  assert.equal(controller.useSkill(), false);
  assert.equal(controller.status, "技能冷却中");
});

check("干扰相关错误码都有中文文案", function () {
  ["NOT_ENOUGH_ENERGY", "NO_TARGET_SPACE", "INTERFERENCE_ACTIVE", "SKILL_ON_COOLDOWN"]
    .forEach(function (code) {
      var controller = bare();
      var text = controller.errorText(code);
      assert.ok(text && text.indexOf(code) < 0, code + " 缺少中文文案，实际为：" + text);
    });
  // 冷却由本地按钮禁用消化，重复弹窗只会干扰操作。
  assert.ok(bare().errorText("SKILL_ON_COOLDOWN").length > 0);
});

function opponentState(tiles, energy) {
  var state = GameLogic.createInitialState(9, { startTiles: 0 });
  tiles.forEach(function (tile) {
    state.cells[tile[0]][tile[1]] = {
      position: { x: tile[0], y: tile[1] }, value: tile[2],
      interference: !!tile[3]
    };
  });
  state.energy = energy || 0;
  return state;
}

check("对手棋盘预览渲染 16 格、标出最大方块与干扰块", function () {
  var controller = withElements(bare({
    manager: { roomCode: "ABCDEF", phase: "playing", playerId: "p1", opponent: null }
  }));
  elements["#duel-opponent-preview"].removeAttribute("hidden");

  // 没有对手状态时显示占位文案
  controller.renderOpponentBoard();
  var board = elements["#duel-opponent-board"];
  assert.equal(board.children.length, 16, "格子数量固定为 16");
  assert.equal(elements["#duel-opponent-empty"].getAttribute("hidden"), null);
  assert.equal(elements["#duel-opponent-max"].textContent, "0");

  controller.manager.opponent = opponentState([[0, 0, 2], [3, 3, 128], [1, 2, 4, true]]);
  controller.renderOpponentBoard();
  assert.equal(elements["#duel-opponent-empty"].getAttribute("hidden"), "hidden", "有方块时隐藏占位");
  assert.equal(elements["#duel-opponent-max"].textContent, "128", "显示对手最大方块");
  assert.equal(board.children[0].getAttribute("data-value"), "2");
  assert.equal(board.children[0].textContent, "2");
  assert.equal(board.children[15].getAttribute("data-value"), "128");
  assert.equal(board.children[1].getAttribute("data-value"), "0", "空格必须显式标记");
  assert.equal(board.children[1].textContent, "");
  // 干扰块在 x=1, y=2，下标 = x * 4 + y = 6
  assert.equal(board.children[6].getAttribute("data-interference"), "true", "干扰块要标出来");
  assert.equal(board.children[6].getAttribute("data-value"), "4");
  assert.equal(board.children[0].getAttribute("data-interference"), "false");

  // 非对局阶段隐藏预览
  controller.manager.phase = "waiting";
  controller.renderOpponentBoard();
  assert.equal(elements["#duel-opponent-preview"].getAttribute("hidden"), "hidden");
});

check("对手棋盘预览只增删差值，不重建格子", function () {
  var controller = withElements(bare({
    manager: { roomCode: "ABCDEF", phase: "playing", playerId: "p1", opponent: null }
  }));
  controller.manager.opponent = opponentState([[0, 0, 2]]);
  controller.renderOpponentBoard();
  var board = elements["#duel-opponent-board"];
  var first = board.children[0];

  controller.manager.opponent = opponentState([[1, 1, 4]]);
  controller.renderOpponentBoard();
  assert.equal(board.children[0], first, "同一个格子对象必须被复用");
  assert.equal(board.children[0].getAttribute("data-value"), "0", "内容随快照更新");
  assert.equal(board.children[5].getAttribute("data-value"), "4");
});

check("再来一局按钮反映双方投票状态并可撤销", function () {
  var controller = withElements(bare({
    manager: { roomCode: "ABCDEF", phase: "finished", playerId: "p1" },
    players: [{ playerId: "p1", status: "connected" }, { playerId: "p2", status: "connected" }]
  }));
  controller.rematchState = { p1: false, p2: false };

  controller.renderRematch();
  assert.equal(elements["#duel-rematch"].textContent, "再来一局");
  assert.equal(elements["#duel-rematch"].getAttribute("aria-pressed"), "false");
  assert.equal(elements["#duel-rematch"].disabled, false);
  assert.equal(elements["#duel-rematch-hint"].textContent, "");

  controller.rematchState = { p1: true, p2: false };
  controller.renderRematch();
  assert.equal(elements["#duel-rematch"].textContent, "取消再来一局");
  assert.equal(elements["#duel-rematch"].getAttribute("aria-pressed"), "true");
  assert.equal(elements["#duel-rematch-hint"].textContent, "等待对手同意…");

  controller.rematchState = { p1: true, p2: true };
  controller.renderRematch();
  assert.equal(elements["#duel-rematch-hint"].textContent, "即将开始…");

  // 对手视角：他们的票和我的票要反过来
  controller.manager.playerId = "p2";
  controller.rematchState = { p1: false, p2: true };
  controller.renderRematch();
  assert.equal(elements["#duel-rematch"].textContent, "取消再来一局", "p2 看到自己的票");
  controller.rematchState = { p1: true, p2: false };
  controller.renderRematch();
  assert.equal(elements["#duel-rematch-hint"].textContent, "对手也点了再来一局");

  // 对手断线时按钮禁用（切回 p1 视角，断线的 p2 才是对手）
  controller.manager.playerId = "p1";
  controller.players = [{ playerId: "p1", status: "connected" }, { playerId: "p2", status: "disconnected" }];
  controller.rematchState = { p1: false, p2: false };
  controller.renderRematch();
  assert.equal(elements["#duel-rematch"].disabled, true);
  assert.equal(elements["#duel-rematch-hint"].textContent, "对手不在线，无法开始新的一局");
});

check("点击再来一局发出 rematch 并乐观翻转按钮", function () {
  sent.length = 0;
  var controller = withElements(bare({
    manager: { roomCode: "ABCDEF", phase: "finished", playerId: "p1" },
    players: [{ playerId: "p1", status: "connected" }, { playerId: "p2", status: "connected" }]
  }));
  controller.rematchState = { p1: false, p2: false };
  controller.client.send = function (type, fields) { sent.push({ type: type, fields: fields }); return true; };

  assert.equal(controller.requestRematch(), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "rematch");
  assert.equal(elements["#duel-rematch"].getAttribute("aria-pressed"), "true", "点击后立即翻转");
  assert.equal(elements["#duel-rematch-hint"].textContent, "等待对手同意…");

  assert.equal(controller.requestRematch(), true);
  assert.equal(sent.length, 2, "再次点击撤销");
  assert.equal(elements["#duel-rematch"].getAttribute("aria-pressed"), "false");
});

check("房间状态带回的投票会纠正乐观显示", function () {
  var controller = withElements(bare({
    manager: { roomCode: "ABCDEF", phase: "finished", playerId: "p1" },
    players: [{ playerId: "p1", status: "connected" }, { playerId: "p2", status: "connected" }]
  }));
  controller.rematchState = { p1: true, p2: false };
  controller.applyRoomState({
    players: [{ playerId: "p1", status: "connected" }, { playerId: "p2", status: "connected" }],
    rematchVotes: { p1: true, p2: true }
  });
  assert.deepEqual(controller.rematchState, { p1: true, p2: true });
  assert.equal(elements["#duel-rematch-hint"].textContent, "即将开始…");
});

check("对手走棋时表头对手分数即时刷新，不依赖我方棋盘重绘", function () {
  var best = [];
  var controller = live({ actuate: function () {}, updateBestScore: function (v) { best.push(v); } });

  controller.manager.opponent = { score: 120 };
  controller.renderTimer();
  assert.equal(best[best.length - 1], 120);
  assert.equal(elements["#duel-opponent-score"].textContent, "120");

  controller.manager.opponent = { score: 340 };
  controller.renderTimer();
  assert.equal(best[best.length - 1], 340, "对手分数变化必须刷新表头");
  assert.equal(elements["#duel-opponent-score"].textContent, "340");
});

console.log("Duel UI checks passed: " + passed);
