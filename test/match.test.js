"use strict";

var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var vm = require("node:vm");
var GameLogic = require("../js/game_logic");
var MultiplayerManager = require("../js/multiplayer_manager");
var WebSocketClient = require("../js/websocket_client");
var WebSocket = require("ws");
var createServer = require("../server/server").createServer;
var client = require("./ws_client");

function board(tiles, score) {
  var state = GameLogic.createInitialState(123, { startTiles: 0 });
  tiles.forEach(function (tile) {
    state.cells[tile[0]][tile[1]] = { position: { x: tile[0], y: tile[1] }, value: tile[2], interference: false };
  });
  state.score = score || 0;
  state.stuck = !GameLogic.hasMoves(state);
  return state;
}

function prediction(state) {
  var sent = [];
  var transport = {
    subscribe: function () { return function () {}; },
    send: function (type, fields) { sent.push({ type: type, fields: fields }); return true; }
  };
  var manager = new MultiplayerManager(transport, { now: function () { return 1000; } });
  manager.receive({ type: "assigned", playerId: "p1", roomCode: "ABCDEF" });
  manager.receive({ type: "match_start", matchId: "test", phase: "playing", startsAt: 1000,
    deadlineAt: 100000, serverNow: 1000, state: state, stateVersion: 0, lastAcceptedSeq: 0,
    opponent: { state: state, stateVersion: 0 } });
  return { manager: manager, sent: sent };
}

async function until(predicate) {
  var deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("等待状态超时");
    await new Promise(function (resolve) { setTimeout(resolve, 5); });
  }
}

async function run() {
  var passed = 0;
  async function check(name, fn) { await fn(); passed++; console.log("通过：" + name); }
  await check("比赛目标必须为2的幂，时长必须为正安全整数", function () {
    assert.throws(function () { createServer({ matches: { targetTile: 4503599627370495 } }); }, /Invalid targetTile/);
    assert.throws(function () { createServer({ matches: { targetTile: 3 } }); }, /Invalid targetTile/);
    assert.throws(function () { createServer({ matches: { durationMs: 0 } }); }, /Invalid durationMs/);
  });
  await check("浏览器全局计时器不会以管理器实例作为接收者调用", function () {
    var context = vm.createContext({ GameLogic: GameLogic });
    vm.runInContext("function setTimeout() { if (this !== globalThis) throw new Error('Illegal invocation'); return 1; }" +
      "function clearTimeout() { if (this !== globalThis) throw new Error('Illegal invocation'); }", context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/multiplayer_manager.js"), "utf8"), context);
    var m = new context.MultiplayerManager({ subscribe: function () { return function () {}; }, send: function () { return true; } },
      { now: function () { return 1000; } });
    m.receive({ type: "match_start", matchId: "browser", phase: "playing", startsAt: 1000,
      deadlineAt: 10000, stateVersion: 0, lastAcceptedSeq: 0, state: board([[0, 0, 2]]) });
    assert.equal(m.move(1), true);
    m.destroy();
  });
  await check("预测确认保留未确认输入，哈希与服务端一致", function () {
    var start = board([[1, 0, 2], [3, 0, 2], [2, 2, 8]]);
    var m = prediction(start).manager;
    m.move(3); m.move(2);
    var first = GameLogic.applyMove(start, 3).state;
    first.moveSeq = 1;
    m.receive({ type: "move_ack", matchId: "test", seq: 1, stateVersion: 1,
      state: first, stateHash: GameLogic.hashState(first) });
    assert.equal(m.pending.length, 1);
    assert.equal(GameLogic.hashState(m.state), GameLogic.hashState(GameLogic.applyMove(first, 2).state));
    var second = GameLogic.applyMove(first, 2).state;
    second.moveSeq = 2;
    m.receive({ type: "move_ack", matchId: "test", seq: 2, stateVersion: 2,
      state: second, stateHash: GameLogic.hashState(second) });
    assert.equal(m.pending.length, 0);
    assert.deepEqual(m.state, second);
  });
  await check("限流拒绝后回滚和重放，拒绝序号不复用", function () {
    var start = board([[1, 0, 2], [3, 0, 2], [2, 2, 8]]);
    var setup = prediction(start), m = setup.manager;
    m.move(3); m.move(2);
    m.receive({ type: "error", matchId: "test", seq: 1, code: "RATE_LIMITED" });
    var accepted = GameLogic.applyMove(start, 2).state;
    assert.equal(GameLogic.hashState(m.state), GameLogic.hashState(accepted));
    accepted.moveSeq = 2;
    m.receive({ type: "move_ack", matchId: "test", seq: 2, stateVersion: 1,
      state: accepted, stateHash: GameLogic.hashState(accepted) });
    m.move(0);
    assert.equal(setup.sent[2].fields.seq, 3);
    assert.equal(m.confirmedSeq, 2);
  });
  await check("哈希不符先采纳权威随机状态，再重放未确认输入", function () {
    var start = board([[1, 0, 2], [3, 0, 2], [2, 2, 8]]);
    var m = prediction(start).manager;
    m.move(3); m.move(2);
    var authority = GameLogic.applyMove(start, 3).state;
    authority.rngState = 987654;
    authority.score += 4;
    authority.moveSeq = 1;
    m.receive({ type: "move_ack", matchId: "test", seq: 1, stateVersion: 1,
      state: authority, stateHash: GameLogic.hashState(authority) });
    var expected = GameLogic.applyMove(authority, 2).state;
    assert.equal(m.state.rngState, expected.rngState);
    assert.equal(GameLogic.hashState(m.state), GameLogic.hashState(expected));
  });
  await check("玩法哈希相同但随机状态不同时仍采用服务端随机状态", function () {
    var start = board([[1, 0, 2], [3, 0, 2]]), m = prediction(start).manager;
    m.move(3); m.move(2);
    var authority = GameLogic.applyMove(start, 3).state;
    authority.rngState = 987654;
    authority.moveSeq = 1;
    m.receive({ type: "move_ack", matchId: "test", seq: 1, stateVersion: 1,
      state: authority, stateHash: GameLogic.hashState(authority) });
    assert.deepEqual(m.state, Object.assign(GameLogic.applyMove(authority, 2).state, { moveSeq: 2 }));
  });
  await check("超过八步触发 resync，丢弃旧预测和迟到确认", function () {
    var start = board([[0, 0, 2]]), setup = prediction(start), m = setup.manager;
    for (var i = 0; i < 8; i++) assert.equal(m.move(0), true);
    assert.equal(m.move(0), false);
    assert.equal(m.synchronizing, true);
    assert.equal(m.pending.length, 0);
    assert.equal(setup.sent[8].type, "resync");
    m.receive({ type: "resync", matchId: "test", phase: "playing", startsAt: 1000,
      deadlineAt: 100000, serverNow: 1000, state: start, stateVersion: 8, lastAcceptedSeq: 8 });
    m.receive({ type: "move_ack", matchId: "test", seq: 1, stateVersion: 1,
      state: board([[2, 0, 4]]), stateHash: "bad" });
    assert.deepEqual(m.state, start);
    assert.equal(m.synchronizing, false);
    m.move(1);
    assert.equal(setup.sent[9].fields.seq, 9);
  });
  await check("无确认回包两秒后主动同步，对手消息不会延长等待", function () {
    var setup = prediction(board([[0, 0, 2]])), m = setup.manager;
    var timers = [], removed = [];
    m.setTimeout = function (callback, delay) { timers.push({ callback: callback, delay: delay }); return timers.length; };
    m.clearTimeout = function (id) { removed.push(id); };
    m.move(0); m.move(1);
    m.receive({ type: "clock", matchId: "test", serverNow: 1000 });
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 2000);
    timers[0].callback();
    assert.equal(m.synchronizing, true);
    assert.equal(m.pending.length, 0);
    assert.equal(setup.sent[2].type, "resync");
    assert.ok(removed.includes(1));
  });
  await check("干扰快照触发重放，断线清掉预测且暂停输入", function () {
    var start = board([[1, 0, 2], [3, 0, 2]]), m = prediction(start).manager;
    m.move(3);
    var changed = GameLogic.applyInterference(start, { x: 0, y: 3 }, 4);
    m.receive({ type: "skill_result", matchId: "test", target: "p1", state: changed,
      stateVersion: 1, lastAcceptedSeq: 0 });
    assert.equal(GameLogic.hashState(m.state), GameLogic.hashState(GameLogic.applyMove(changed, 3).state));
    m.receive({ type: "connection_status", status: "disconnected" });
    assert.equal(m.pending.length, 0);
    assert.deepEqual(m.state, changed);
    assert.equal(m.move(2), false);
  });
  await check("能量不足和冷却中不发包，冷却结束后才允许请求技能", function () {
    var start = board([[1, 0, 2], [3, 0, 2]]), setup = prediction(start), m = setup.manager;
    m.energy = 0;
    assert.equal(m.useSkill(), false, "没有能量不得发包");
    assert.equal(setup.sent.length, 0);

    m.energy = 1;
    m.cooldownUntil = 5000;
    assert.equal(m.useSkill(), false, "冷却中不得发包");
    assert.equal(m.skillReadyIn(), 4000);
    assert.equal(setup.sent.length, 0);

    m.cooldownUntil = 900;
    assert.equal(m.useSkill(), true);
    assert.equal(setup.sent.length, 1);
    assert.equal(setup.sent[0].type, "use_skill");
    assert.equal(setup.sent[0].fields.skill, "interference");
    assert.equal(setup.sent[0].fields.matchId, "test");
    assert.equal("position" in setup.sent[0].fields, false, "客户端不得指定干扰位置");
    assert.equal("value" in setup.sent[0].fields, false, "客户端不得指定干扰数值");
  });
  await check("技能只在进行中可用，结束后拒绝", function () {
    var start = board([[1, 0, 2], [3, 0, 2]]), setup = prediction(start), m = setup.manager;
    m.energy = 1;
    m.phase = "waiting";
    assert.equal(m.useSkill(), false);
    m.phase = "playing";
    assert.equal(m.useSkill(), true);
    m.phase = "finished";
    assert.equal(m.useSkill(), false);
    assert.equal(setup.sent.length, 1);
  });
  await check("自己被干扰时采纳服务端随机状态并重放，对手被干扰只刷新对手面板", function () {
    var start = board([[1, 0, 2], [3, 0, 2]]), m = prediction(start).manager;
    m.move(3);
    var changed = GameLogic.applyInterference(start, { x: 0, y: 3 }, 4);
    changed.energy = 2;
    m.receive({ type: "skill_result", matchId: "test", target: "p1", state: changed,
      stateVersion: 1, lastAcceptedSeq: 0, cooldownUntil: 4000 });
    assert.equal(m.energy, 2, "能量取自权威 state");
    assert.equal(m.cooldownUntil, 4000);
    // 重放必须基于含干扰块的新棋盘，而不是被污染的旧随机流。
    assert.equal(GameLogic.hashState(m.state), GameLogic.hashState(GameLogic.applyMove(changed, 3).state));
    assert.equal(m.pending.length, 1);

    // 对手视角：干扰落在自己的棋盘上，但发起方只是刷新对手面板。
    var jammed = GameLogic.applyInterference(start, { x: 3, y: 3 }, 4);
    assert.ok(jammed, "构造的落点必须合法");
    jammed.energy = 1;
    m.receive({ type: "skill_result", matchId: "test", source: "p1", target: "p2",
      state: start, stateVersion: 1, lastAcceptedSeq: 0,
      opponent: { playerId: "p2", state: jammed, stateVersion: 4 } });
    assert.equal(GameLogic.hashState(m.opponent), GameLogic.hashState(jammed));
    assert.equal(m.opponentEnergy, 1, "对手能量取自对手权威 state");
  });
  await check("能量随合并增长：move_ack 后客户端立即可用于技能", function () {
    var start = board([[1, 0, 2], [3, 0, 2]]), setup = prediction(start), m = setup.manager;
    assert.equal(m.energy, 0);
    // 能量随权威快照下来，而不是只靠 resync。
    var merged = GameLogic.applyMove(start, 3).state;
    merged.moveSeq = 1;
    m.receive({ type: "move_ack", matchId: "test", seq: 1, stateVersion: 1,
      state: merged, stateHash: GameLogic.hashState(merged) });
    assert.equal(m.energy, merged.energy, "确认后能量必须同步");

    var gained = GameLogic.applyMove(merged, 3).state;
    gained.energy = 1;
    gained.moveSeq = 2;
    m.receive({ type: "move_ack", matchId: "test", seq: 2, stateVersion: 2,
      state: gained, stateHash: GameLogic.hashState(gained) });
    assert.equal(m.energy, 1);
  });
  await check("对手能量随 opponent_update 更新", function () {
    var start = board([[1, 0, 2], [3, 0, 2]]), m = prediction(start).manager;
    var theirs = GameLogic.applyMove(start, 3).state;
    theirs.energy = 2;
    m.receive({ type: "opponent_update", matchId: "test", playerId: "p2", stateVersion: 1,
      state: theirs, stateHash: GameLogic.hashState(theirs) });
    assert.equal(m.opponentEnergy, 2);
  });
  await check("乱序或重复的干扰快照不会回退本地状态", function () {
    var start = board([[1, 0, 2], [3, 0, 2]]), m = prediction(start).manager;
    var changed = GameLogic.applyInterference(start, { x: 0, y: 3 }, 4);
    m.receive({ type: "skill_result", matchId: "test", target: "p1", state: changed,
      stateVersion: 4, lastAcceptedSeq: 0 });
    var adopted = JSON.stringify(m.state);
    m.receive({ type: "skill_result", matchId: "test", target: "p1", state: start,
      stateVersion: 2, lastAcceptedSeq: 0 });
    assert.equal(JSON.stringify(m.state), adopted, "旧版本快照必须被忽略");
  });

  var now = 1000;
  var seedCounter = 0;
  var app = createServer({ rooms: { now: function () { return now; }, disconnectGraceMs: 30000 },
    // seed 必须每局不同，否则 rematch 重新发牌会拿到同一个棋盘。
    matches: { seedFactory: function () { return ++seedCounter; }, durationMs: 10000 } });
  var sockets = [];
  await app.listen(0, "127.0.0.1");
  var url = "ws://127.0.0.1:" + app.server.address().port + "/ws";
  async function connect() {
    var c = await client(url); sockets.push(c); c.send("hello"); await c.next("hello"); return c;
  }
  async function pair() {
    var a = await connect(), b = await connect();
    a.send("create_room"); var identity = await a.next("assigned");
    b.send("join_room", { roomCode: identity.roomCode }); var other = await b.next("assigned");
    return { a: a, b: b, identity: identity, other: other, room: app.rooms.get(identity.roomCode) };
  }
  async function begin(p) {
    p.a.send("ready", { ready: true }); p.b.send("ready", { ready: true });
    var a = await p.a.next("match_start"), b = await p.b.next("match_start");
    now = a.startsAt; app.matches.tick(); return { a: a, b: b };
  }
  function move(c, room, seq, direction, extra) {
    c.send("move", Object.assign({ matchId: room.match.matchId, seq: seq, direction: direction, baseVersion: 0 }, extra));
  }
  try {
    var p = await pair();
    await check("双方准备前拒绝移动，布尔校验和撤销准备生效", async function () {
      move(p.a, { match: { matchId: "early" } }, 1, 3);
      var error = await p.a.next("error"); assert.equal(error.code, "MATCH_NOT_READY"); assert.equal(error.seq, 1);
      p.a.send("ready", { ready: "true" }); assert.equal((await p.a.next("error")).code, "INVALID_MESSAGE");
      p.a.send("ready", { ready: true }); await p.a.next("room_state", function (s) { return s.players[0].ready; });
      p.a.send("ready", { ready: false }); await p.b.next("room_state", function (s) { return !s.players[0].ready && s.players.length === 2; });
    });
    var start;
    await check("双方同种子开始，三秒倒计时禁止提前移动", async function () {
      p.a.send("ready", { ready: true }); p.b.send("ready", { ready: true });
      var a = await p.a.next("match_start"), b = await p.b.next("match_start"); start = a;
      assert.deepEqual(a.state, b.state); assert.equal(a.startsAt, now + 3000);
      assert.equal(a.phase, "countdown"); assert.equal(a.stateHash, GameLogic.hashState(a.state));
      move(p.a, p.room, 1, 3); assert.equal((await p.a.next("error")).code, "MATCH_NOT_READY");
      now = a.startsAt; app.matches.tick();
      await p.a.next("room_state", function (s) { return s.phase === "playing"; });
    });
    var firstAck;
    await check("权威确认和对手快照一致，伪造棋盘分数被忽略", async function () {
      move(p.a, p.room, 2, 3, { score: 99999, state: board([[0, 0, 2048]], 99999) });
      firstAck = await p.a.next("move_ack"); var other = await p.b.next("opponent_update");
      var expected = GameLogic.applyMove(start.state, 3).state; expected.moveSeq = 2;
      assert.deepEqual(firstAck.state, expected); assert.deepEqual(firstAck.state, other.state);
      assert.equal(firstAck.stateHash, GameLogic.hashState(expected)); assert.equal(firstAck.stateVersion, 1);
      assert.equal(firstAck.seq, 2);
    });
    await check("重复序号、非法方向和50ms限流不改变状态，跳号可继续", async function () {
      var original = GameLogic.serializeState(p.room.match.players.p1.state);
      move(p.a, p.room, 2, 0); assert.equal((await p.a.next("error")).code, "SEQ_OUT_OF_ORDER");
      move(p.a, p.room, 3, 9); var bad = await p.a.next("error"); assert.equal(bad.code, "INVALID_DIRECTION"); assert.equal(bad.seq, 3);
      move(p.a, p.room, 4, 2); var rate = await p.a.next("error"); assert.equal(rate.code, "RATE_LIMITED"); assert.equal(rate.seq, 4);
      assert.deepEqual(p.room.match.players.p1.state, original);
      now += 50; move(p.a, p.room, 5, 2, { baseVersion: 999 }); var ack = await p.a.next("move_ack");
      assert.equal(ack.seq, 5); assert.equal(ack.stateVersion, 2);
    });
    await check("重连携带完整状态、随机状态、序号和对手棋盘", async function () {
      var expected = GameLogic.serializeState(p.room.match.players.p1.state);
      await p.a.close(); await p.b.next("player_update", function (m) { return m.status === "disconnected"; });
      var rejoined = await client(url); sockets.push(rejoined);
      rejoined.send("hello", { reconnectToken: p.identity.reconnectToken });
      assert.equal((await rejoined.next("assigned")).playerId, "p1");
      var sync = await rejoined.next("resync"); assert.deepEqual(sync.state, expected);
      assert.equal(sync.lastAcceptedSeq, 5); assert.equal(sync.stateVersion, 2);
      assert.deepEqual(sync.opponent.state, p.room.match.players.p2.state);
      p.a = rejoined;
    });
    await check("clock校准和截止时间按最高方块打破同分，无额外移动", async function () {
      p.room.match.players.p1.state = board([[0, 0, 8]], 100);
      p.room.match.players.p2.state = board([[0, 0, 16]], 100);
      now = p.room.match.startsAt + 5000; app.matches.tick();
      assert.equal((await p.a.next("clock")).serverNow, now);
      now = p.room.match.deadlineAt; move(p.a, p.room, 6, 2);
      var end = await p.a.next("match_end"); assert.equal(end.winner, "p2"); assert.equal(end.reason, "timeout");
      assert.equal((await p.a.next("error")).code, "MATCH_FINISHED");
      assert.equal(p.room.match.players.p1.lastAcceptedSeq, 5);
    });
    await check("先达到目标立即胜出，对手随后移动被拒绝", async function () {
      var target = await pair(); await begin(target);
      target.room.match.players.p1.state = board([[0, 0, 1024], [1, 0, 1024]]);
      move(target.a, target.room, 1, 3); await target.a.next("move_ack");
      var end = await target.b.next("match_end"); assert.equal(end.winner, "p1"); assert.equal(end.reason, "target_reached");
      move(target.b, target.room, 1, 3); assert.equal((await target.b.next("error")).code, "MATCH_FINISHED");
    });
    await check("双方stuck按分数比较，一方stuck拒绝移动，完全同分为平局", async function () {
      var stuck = await pair(); await begin(stuck);
      var full = [];
      for (var x = 0; x < 4; x++) for (var y = 0; y < 4; y++) full.push([x, y, (x + y) % 2 ? 4 : 2]);
      stuck.room.match.players.p2.state = board(full, 100);
      move(stuck.b, stuck.room, 1, 3); assert.equal((await stuck.b.next("error")).code, "PLAYER_STUCK");
      var almost = [];
      [[2, 4, 8, 16], [32, 64, 128, 256], [512, 2, 4, 8], [4, 8, 16, null]].forEach(function (row, y) {
        row.forEach(function (value, x) { if (value) almost.push([x, y, value]); });
      });
      var state = board(almost, 200);
      stuck.room.match.players.p1.state = state;
      // Find a deterministic final move which fills the sole vacancy without creating a merge.
      var result = GameLogic.applyMove(state, 1);
      assert.equal(result.stuck, true);
      move(stuck.a, stuck.room, 1, 1); await stuck.a.next("move_ack");
      var end = await stuck.a.next("match_end"); assert.equal(end.reason, "both_stuck"); assert.equal(end.winner, "p1");
      var tie = await pair(); await begin(tie);
      now = tie.room.match.deadlineAt; app.matches.tick();
      assert.equal((await tie.a.next("match_end")).winner, null);
    });
    await check("主动退出判负并解绑，可在同一连接重新建房", async function () {
      var leaving = await pair(); await begin(leaving);
      leaving.a.send("leave_room", { requestId: "leave" });
      var end = await leaving.b.next("match_end"); assert.equal(end.reason, "opponent_left"); assert.equal(end.winner, "p2");
      assert.equal((await leaving.a.next("left_room")).requestId, "leave");
      leaving.a.send("create_room"); assert.equal((await leaving.a.next("assigned")).playerId, "p1");
    });
    await check("对局断线超出宽限期判负，同刻断线双方为平局", async function () {
      var lost = await pair(); await begin(lost);
      await lost.a.close(); await lost.b.next("player_update", function (m) { return m.status === "disconnected"; });
      // Extend the test deadline so the reconnect grace expires first.
      lost.room.match.deadlineAt = now + 60000;
      now += 30000; app.matches.tick();
      var end = await lost.b.next("match_end"); assert.equal(end.reason, "opponent_disconnected"); assert.equal(end.winner, "p2");
      var both = await pair(); await begin(both);
      both.room.match.deadlineAt = now + 60000;
      await both.a.close(); await both.b.close();
      await until(function () { return both.room.players.p1.status === "disconnected" && both.room.players.p2.status === "disconnected"; });
      now += 30000; app.matches.tick();
      assert.equal(both.room.match.result.winner, null);
    });
    await check("能量不足拒绝干扰，不消耗能量也不进入冷却", async function () {
      var s = await pair(); await begin(s);
      s.room.match.players.p1.state.energy = 0;
      s.room.match.players.p2.state.energy = 2;
      s.a.send("use_skill", { matchId: s.room.match.matchId, skill: "interference", requestId: "no-energy" });
      var error = await s.a.next("error");
      assert.equal(error.code, "NOT_ENOUGH_ENERGY");
      assert.equal(error.requestId, "no-energy");
      assert.equal(s.room.match.players.p1.state.energy, 0, "被拒绝不得扣能量");
      assert.equal(s.room.match.players.p2.state.energy, 2, "被拒绝不得影响对手");
      assert.equal(s.room.match.players.p1.lastSkillAt, null, "被拒绝不得进入冷却");
      // 能量足够后同一局可以正常释放，说明前一次拒绝没有留下状态。
      s.room.match.players.p1.state.energy = 1;
      s.a.send("use_skill", { matchId: s.room.match.matchId, skill: "interference" });
      var ok = await s.a.next("skill_result");
      assert.equal(ok.source, "p1");
      assert.equal(ok.target, "p2");
      assert.equal(ok.value, 4);
      assert.equal(ok.state.energy, 0, "释放后能量扣 1 点");
      assert.equal(s.room.match.players.p2.state.energy, 2, "干扰不消耗对手能量");
    });
    await check("干扰由服务端落在对手空位，对手客户端硬同步", async function () {
      var s = await pair(); await begin(s);
      s.room.match.players.p1.state.energy = 1;
      var before = GameLogic.serializeState(s.room.match.players.p2.state);
      s.a.send("use_skill", { matchId: s.room.match.matchId, skill: "interference" });

      var source = await s.a.next("skill_result");
      var victim = await s.b.next("skill_result");
      assert.equal(source.target, "p2");
      assert.equal(victim.target, "p2");
      assert.deepEqual(source.position, victim.position, "两端看到同一落点");
      assert.ok(victim.position.x >= 0 && victim.position.x < 4 && victim.position.y >= 0 && victim.position.y < 4);

      var placed = s.room.match.players.p2.state.cells[victim.position.x][victim.position.y];
      assert.ok(placed, "干扰块必须落在选中的空位");
      assert.equal(placed.value, 4);
      assert.equal(placed.interference, true);
      // 对手端收到的是含干扰块的权威快照，且带上 rngState 以便重放。
      assert.deepEqual(victim.state, GameLogic.serializeState(s.room.match.players.p2.state));
      assert.equal(victim.state.rngState, before.rngState, "干扰不消耗随机数");
      assert.equal(victim.stateHash, GameLogic.hashState(s.room.match.players.p2.state));
      // 发起方额外拿到对手棋盘，用来播放对手视角。
      assert.deepEqual(source.opponent.state, victim.state);
      assert.equal(s.room.match.players.p2.stateVersion, 1);
    });
    await check("干扰 3 秒冷却，冷却内再次请求被拒绝", async function () {
      var s = await pair(); await begin(s);
      s.room.match.players.p1.state.energy = 2;
      s.a.send("use_skill", { matchId: s.room.match.matchId, skill: "interference" });
      var first = await s.a.next("skill_result");
      assert.equal(s.room.match.players.p1.lastSkillAt, now);
      assert.equal(first.cooldownUntil, now + 3000);

      s.a.send("use_skill", { matchId: s.room.match.matchId, skill: "interference" });
      assert.equal((await s.a.next("error")).code, "SKILL_ON_COOLDOWN");
      assert.equal(s.room.match.players.p1.state.energy, 1, "冷却被拒不得扣能量");

      // 对手消掉干扰块后，冷却一过即可再次释放。
      // 落点由服务端在剩余空位里挑选，本来就没有保证一定不同位置，
      // 所以这里只断言"确实又落下了一个"，位置重复是合法结果。
      var spot = first.position;
      s.room.match.players.p2.state.cells[spot.x][spot.y] = null;
      s.room.match.players.p2.state.stuck = false;
      now += 3000;
      s.a.send("use_skill", { matchId: s.room.match.matchId, skill: "interference" });
      var second = await s.a.next("skill_result");
      assert.equal(s.room.match.players.p1.state.energy, 0);
      assert.equal(second.value, 4);
      var placedAgain = s.room.match.players.p2.state.cells[second.position.x][second.position.y];
      assert.ok(placedAgain && placedAgain.interference === true, "干扰块消除后应能再次落下");
      assert.equal(
        s.room.match.players.p2.state.cells.filter(function (column) {
          return column.filter(function (tile) { return tile && tile.interference; }).length;
        }).length, 1, "任意时刻最多一个干扰块"
      );
    });
    await check("对手已有干扰块时返回 INTERFERENCE_ACTIVE", async function () {
      var s = await pair(); await begin(s);
      s.room.match.players.p1.state.energy = 1;
      var spot = { x: 3, y: 3 };
      s.room.match.players.p2.state = GameLogic.applyInterference(s.room.match.players.p2.state, spot, 4);
      s.a.send("use_skill", { matchId: s.room.match.matchId, skill: "interference" });
      assert.equal((await s.a.next("error")).code, "INTERFERENCE_ACTIVE");
      assert.equal(s.room.match.players.p1.state.energy, 1, "被拒绝不得扣能量");
    });
    await check("对手满棋盘无空位时返回 NO_TARGET_SPACE", async function () {
      var s = await pair(); await begin(s);
      s.room.match.players.p1.state.energy = 1;
      var fullTiles = [];
      for (var fx = 0; fx < 4; fx++) {
        for (var fy = 0; fy < 4; fy++) fullTiles.push([fx, fy, (fx + fy) % 2 ? 4 : 2]);
      }
      var full = board(fullTiles, 0);
      assert.equal(GameLogic.availableCells(full.cells, 4).length, 0);
      s.room.match.players.p2.state = full;
      s.a.send("use_skill", { matchId: s.room.match.matchId, skill: "interference" });
      assert.equal((await s.a.next("error")).code, "NO_TARGET_SPACE");
      assert.equal(s.room.match.players.p1.state.energy, 1, "被拒绝不得扣能量");
    });
    await check("stuck 玩家不能移动但仍可打出剩余能量", async function () {
      var s = await pair(); await begin(s);
      // 只剩一个空位且相邻不同值：再走一步就填满且无法合并。
      var almost = [];
      [[2, 4, 8, 16], [32, 64, 128, 256], [512, 2, 4, 8], [4, 8, 16, null]].forEach(function (row, y) {
        row.forEach(function (value, x) { if (value) almost.push([x, y, value]); });
      });
      // 构造一个再走一步就填满且无法合并的局面。
      var almost = [];
      [[2, 4, 8, 16], [32, 64, 128, 256], [512, 2, 4, 8], [4, 8, 16, null]].forEach(function (row, y) {
        row.forEach(function (value, x) { if (value) almost.push([x, y, value]); });
      });
      // stuck 的玩家不能移动，但手上剩余能量仍可打给还有空位的对手。
      var stepped = GameLogic.applyMove(board(almost, 0), 1);
      assert.equal(stepped.stuck, true, "构造出的局面必须一步填满且无法合并");
      s.room.match.players.p1.state = stepped.state;
      s.room.match.players.p1.state.energy = 1;
      s.room.match.deadlineAt = now + 60000;

      move(s.a, s.room, 1, 1);
      assert.equal((await s.a.next("error")).code, "PLAYER_STUCK", "stuck 玩家不能移动");

      s.a.send("use_skill", { matchId: s.room.match.matchId, skill: "interference" });
      var result = await s.a.next("skill_result");
      assert.equal(result.source, "p1");
      assert.equal(s.room.match.players.p1.state.energy, 0, "释放后自己扣能量");
      var placed = s.room.match.players.p2.state.cells[result.position.x][result.position.y];
      assert.ok(placed && placed.interference === true, "干扰仍能落到对手棋盘");
      // 单方 stuck 不判负，比赛继续到时间到或双方都无路可走。
      assert.equal(s.room.phase, "playing");
    });
    await check("未知技能名、对局未开始和结束后都拒绝", async function () {
      var s = await pair();
      s.a.send("use_skill", { matchId: "none", skill: "nuke" });
      assert.equal((await s.a.next("error")).code, "MATCH_NOT_READY");
      await begin(s);
      s.a.send("use_skill", { matchId: s.room.match.matchId, skill: "nuke" });
      assert.equal((await s.a.next("error")).code, "INVALID_MESSAGE");
      s.a.send("use_skill", { matchId: s.room.match.matchId, skill: "interference" });
      assert.equal((await s.a.next("error")).code, "NOT_ENOUGH_ENERGY");

      s.room.match.players.p1.state.energy = 1;
      now = s.room.match.deadlineAt; app.matches.tick();
      await s.a.next("match_end");
      s.a.send("use_skill", { matchId: s.room.match.matchId, skill: "interference" });
      assert.equal((await s.a.next("error")).code, "MATCH_FINISHED");
    });
    await check("客户端伪造的干扰位置和数值被忽略", async function () {
      var s = await pair(); await begin(s);
      s.room.match.players.p1.state.energy = 1;
      s.a.send("use_skill", {
        matchId: s.room.match.matchId, skill: "interference",
        position: { x: 0, y: 0 }, value: 1024, energy: 99
      });
      var result = await s.a.next("skill_result");
      assert.equal(result.value, 4, "数值由服务端固定为 4");
      var placed = s.room.match.players.p2.state.cells[result.position.x][result.position.y];
      assert.equal(placed.value, 4);
      assert.equal(s.room.match.players.p1.state.energy, 0, "能量只按服务端裁定扣除");
    });
    await check("重连快照带上能量、冷却和对手能量", async function () {
      var s = await pair(); await begin(s);
      s.room.match.players.p1.state.energy = 2;
      s.room.match.players.p2.state.energy = 1;
      s.room.match.players.p1.lastSkillAt = now - 1000;
      s.b.send("resync");
      var sync = await s.b.next("resync");
      assert.equal(sync.state.energy, 1);
      assert.equal(sync.opponent.state.energy, 2, "对手能量随对手 state 下发");
      assert.equal(sync.cooldownUntil, 0, "没有释放过就没有冷却");

      var other = await s.a.next("resync").catch(function () { return null; });
      assert.equal(other, null, "resync 只回给请求方");
      s.a.send("resync");
      var mine = await s.a.next("resync");
      assert.equal(mine.state.energy, 2);
      assert.equal(mine.cooldownUntil, now - 1000 + 3000);
    });
    await check("再来一局需双方同意，单方请求只记票并可撤销", async function () {
      var r = await pair(); await begin(r);
      now = r.room.match.deadlineAt; app.matches.tick();
      await r.a.next("match_end");
      var firstId = r.room.match.matchId;

      r.a.send("rematch");
      var state = await r.b.next("room_state", function (m) { return m.rematchVotes && m.rematchVotes.p1; });
      assert.deepEqual(state.rematchVotes, { p1: true, p2: false }, "广播双方投票状态");
      assert.equal(r.room.phase, "finished", "单方同意不得开新局");

      // 再次请求即撤销
      r.a.send("rematch");
      state = await r.b.next("room_state", function (m) { return m.rematchVotes && !m.rematchVotes.p1; });
      assert.deepEqual(state.rematchVotes, { p1: false, p2: false });

      r.a.send("rematch");
      await r.b.next("room_state", function (m) { return m.rematchVotes && m.rematchVotes.p1; });
      r.b.send("rematch");
      var start = await r.a.next("match_start");
      var other = await r.b.next("match_start");
      assert.equal(start.matchId, other.matchId);
      assert.notEqual(start.matchId, firstId, "新局必须换 matchId");
      assert.equal(r.room.phase, "countdown");
      assert.equal(start.state.score, 0);
      assert.equal(start.state.energy, 0, "新局能量清零");
      assert.equal(start.stateVersion, 0);
      assert.deepEqual(r.room.rematch, { p1: false, p2: false }, "开局后票数清空");
    });
    await check("再来一局重新发牌：同一房间码、不同棋盘、可继续对战", async function () {
      var r = await pair(); await begin(r);
      now = r.room.match.deadlineAt; app.matches.tick();
      await r.a.next("match_end");
      var before = GameLogic.serializeState(r.room.match.players.p1.state);

      r.a.send("rematch"); await r.a.next("room_state", function (m) { return m.rematchVotes && m.rematchVotes.p1; });
      r.b.send("rematch");
      await r.a.next("match_start");
      var fresh = await r.room.match.players.p1.state;
      assert.equal(r.room.players.p1.roomCode || r.room.roomCode, r.room.roomCode, "房间码不变");
      assert.notDeepEqual(GameLogic.serializeState(fresh).cells, before.cells, "新局重新发牌");
      now = r.room.match.startsAt; app.matches.tick();
      await r.a.next("room_state", function (m) { return m.phase === "playing"; });

      // 上一局的能量和冷却不得带进新局。
      move(r.a, r.room, 1, 0);
      await r.a.next("move_ack");
      move(r.b, r.room, 1, 2);
      await r.b.next("move_ack");
      assert.ok(GameLogic.applyMove(r.room.match.players.p1.state, 1).moved ||
                GameLogic.applyMove(r.room.match.players.p1.state, 3).moved,
                "新局可以正常走棋");
    });
    await check("对局未结束时拒绝再来一局，对手断线时也拒绝", async function () {
      var r = await pair(); await begin(r);
      r.a.send("rematch");
      assert.equal((await r.a.next("error")).code, "MATCH_FINISHED", "对局中不得再来一局");

      now = r.room.match.deadlineAt; app.matches.tick();
      await r.a.next("match_end");
      await r.b.close();
      await r.a.next("player_update", function (m) { return m.status === "disconnected"; });
      r.a.send("rematch");
      assert.equal((await r.a.next("error")).code, "OPPONENT_OFFLINE");
    });
    await check("连接总限流错误携带move序号供客户端回滚", async function () {
      var flood = await connect();
      for (var n = 1; n <= 30; n++) flood.send("move", { seq: n, matchId: "flood", direction: 0, baseVersion: 0 });
      var error = await flood.next("error", function (m) { return m.code === "RATE_LIMITED"; });
      assert.equal(error.seq, 30); assert.equal(error.matchId, "flood");
    });
    await check("真实客户端完成握手、房间、预测确认、限流回滚及自动重连", async function () {
      var transportA = new WebSocketClient({ url: url, WebSocket: WebSocket, storage: null });
      var transportB = new WebSocketClient({ url: url, WebSocket: WebSocket, storage: null });
      var errors = [];
      var a = new MultiplayerManager(transportA, { now: function () { return now; }, onError: function (error) { errors.push(error); } });
      var b = new MultiplayerManager(transportB, { now: function () { return now; } });
      try {
        transportA.connect(); transportB.connect();
        await until(function () { return transportA.ready && transportB.ready; });
        transportA.send("create_room"); await until(function () { return !!a.roomCode; });
        transportB.send("join_room", { roomCode: a.roomCode }); await until(function () { return !!b.roomCode; });
        transportA.send("ready", { ready: true }); transportB.send("ready", { ready: true });
        await until(function () { return a.phase === "countdown" && b.phase === "countdown"; });
        now = a.startsAt; app.matches.tick();
        await until(function () { return a.phase === "playing" && b.phase === "playing"; });
        assert.equal(a.move(3), true); assert.equal(a.move(2), true);
        await until(function () { return a.pending.length === 0 && errors.some(function (error) { return error.code === "RATE_LIMITED"; }); });
        var room = app.rooms.get(a.roomCode);
        assert.equal(GameLogic.hashState(a.state), GameLogic.hashState(room.match.players.p1.state));
        assert.equal(GameLogic.hashState(b.opponent), GameLogic.hashState(a.state));
        now += 50; assert.equal(a.move(2), true);
        await until(function () { return a.confirmedSeq === 3; });

        // 真实客户端跑完整干扰流程：发技能 -> 自己扣能量进冷却 ->
        // 对手硬同步出干扰块 -> 冷却中无法再次发包。
        // 能量由服务端裁定，客户端只是镜像：直接改服务端 state 不会让
        // 本地按钮解禁，必须等一次权威快照下来。
        room.match.deadlineAt = now + 600000;
        assert.equal(a.useSkill(), false, "能量为 0 时不得发包");
        room.match.players.p1.state.energy = 1;
        transportA.send("resync");
        await until(function () { return a.energy === 1; });
        assert.equal(a.useSkill(), true);
        await until(function () {
          return a.confirmed.energy === 0 && a.cooldownUntil > 0;
        });
        await until(function () {
          return b.state.cells.some(function (column) {
            return column.some(function (tile) { return tile && tile.interference === true; });
          });
        });
        assert.ok(a.opponent.cells.some(function (column) {
          return column.some(function (tile) { return tile && tile.interference === true; });
        }), "发起方也应看到对手棋盘上的干扰块");
        assert.equal(GameLogic.hashState(b.state),
          GameLogic.hashState(room.match.players.p2.state), "对手已硬同步到服务端权威棋盘");
        assert.equal(a.useSkill(), false, "冷却中不得再次发包");
        room.match.deadlineAt = now + 60000;

        var token = transportA.session.reconnectToken;
        transportA.socket.close();
        await until(function () { return a.connectionStatus === "reconnecting"; });
        await until(function () { return a.connectionStatus === "connected" && !a.synchronizing; });
        assert.equal(transportA.session.reconnectToken, token);
        assert.equal(a.confirmedSeq, 3);
        assert.deepEqual(a.state, room.match.players.p1.state);
        now = room.match.deadlineAt; app.matches.tick();
        await until(function () { return a.phase === "finished" && b.phase === "finished"; });
        assert.deepEqual(a.result.scores, b.result.scores);
      } finally {
        a.destroy(); b.destroy(); transportA.close(); transportB.close();
      }
    });
  } finally {
    await Promise.all(sockets.map(function (socket) { return socket.close(); }));
    await app.close();
  }
  console.log("对战与预测检查全部通过：" + passed);
}

run().catch(function (error) { console.error(error); process.exitCode = 1; });
