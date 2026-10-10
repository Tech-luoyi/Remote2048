"use strict";

var assert = require("node:assert/strict");
var http = require("node:http");
var WebSocket = require("ws");
var createServer = require("../server/server").createServer;
var RoomManager = require("../server/room_manager");
var RateLimiter = require("../server/rate_limiter");
var protocol = require("../server/protocol");
var client = require("./ws_client");

function waitForClose(socket) {
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () { reject(new Error("等待关闭超时")); }, 2000);
    socket.once("close", function (code) { clearTimeout(timer); resolve(code); });
  });
}

function get(base, pathname, method) {
  return new Promise(function (resolve, reject) {
    var req = http.request(base + pathname, { method: method || "GET" }, function (res) {
      var chunks = [];
      res.on("data", function (chunk) { chunks.push(chunk); });
      res.on("end", function () { resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }); });
    });
    req.on("error", reject);
    req.end();
  });
}

async function run() {
  var passed = 0;
  async function check(name, fn) {
    await fn();
    passed++;
    console.log("通过：" + name);
  }

  await check("滑动窗口限流边界及恢复", function () {
    var limiter = new RateLimiter(2, 1000);
    assert.equal(limiter.allow(0), true);
    assert.equal(limiter.allow(100), true);
    assert.equal(limiter.allow(999), false);
    assert.equal(limiter.allow(1000), true);
    assert.equal(limiter.allow(1099), false);
    assert.equal(limiter.allow(1100), true);
  });
  await check("共享发送出口按 UTF-8 字节计算本条消息，超出缓冲上限立即释放连接", function () {
    var message = protocol.makeMessage("test", { text: "\u4f60\u597d" });
    var payload = JSON.stringify(message);
    var payloadBytes = Buffer.byteLength(payload);
    var sent = [];
    var terminated = false;
    var socket = {
      readyState: WebSocket.OPEN,
      bufferedAmount: protocol.MAX_BUFFERED_BYTES - payloadBytes - 10,
      send: function (value) { sent.push(value); this.bufferedAmount += Buffer.byteLength(value); },
      terminate: function () { terminated = true; this.readyState = WebSocket.CLOSING; }
    };
    assert.equal(protocol.send(socket, message), true);
    assert.deepEqual(sent, [payload]);
    assert.equal(socket.bufferedAmount, protocol.MAX_BUFFERED_BYTES - 10);
    assert.equal(protocol.send(socket, message), false);
    assert.equal(terminated, true);
    assert.equal(sent.length, 1);
    assert.equal(protocol.send(socket, message), false);
    var oversizedSocket = Object.assign({}, socket, { readyState: WebSocket.OPEN, bufferedAmount: 0 });
    assert.equal(protocol.send(oversizedSocket, { text: "x".repeat(protocol.MAX_BUFFERED_BYTES) }), false);
    assert.equal(sent.length, 1);
  });
  await check("房间码碰撞重试、容量上限与公开状态不泄露 token", function () {
    var codes = ["ABCDEF", "ABCDEF", "BCDEFG"];
    var rooms = new RoomManager({ maxRooms: 2, codeFactory: function () { return codes.shift() || "ABCDEF"; } });
    var first = rooms.createRoom({});
    var second = rooms.createRoom({});
    assert.equal(second.room.roomCode, "BCDEFG");
    assert.equal(rooms.createRoom({}).error, "ROOM_LIMIT_REACHED");
    assert.equal(JSON.stringify(rooms.serialize(first.room)).includes(first.player.reconnectToken), false);
    var collision = new RoomManager({ codeFactory: function () { return "ABCDEF"; } });
    collision.createRoom({});
    assert.equal(collision.createRoom({}).error, "ROOM_LIMIT_REACHED");
  });
  await check("等待在线房间不受空房 TTL 影响，过期座位可替换", function () {
    var rooms = new RoomManager({ waitingTtlMs: 1000, disconnectGraceMs: 30 });
    var owner = {};
    var first = rooms.createRoom(owner, 0);
    rooms.cleanup(2000);
    assert.equal(rooms.rooms.size, 1);
    rooms.disconnect(owner, 2000);
    assert.equal(rooms.rejoin(first.room.roomCode, first.player.reconnectToken, {}, 2030).error, "RECONNECT_EXPIRED");
    rooms.cleanup(2030);
    var replacement = rooms.joinRoom(first.room.roomCode, {}, 2031);
    assert.equal(replacement.player.playerId, "p1");
    assert.notEqual(replacement.player.reconnectToken, first.player.reconnectToken);
    assert.equal(rooms.rejoin(first.room.roomCode, first.player.reconnectToken, {}, 2032).error, "RECONNECT_EXPIRED");
  });
  await check("空房和已结束房间按各自 TTL 清理，重连不延长结束 TTL", function () {
    var rooms = new RoomManager({ waitingTtlMs: 1000, finishedTtlMs: 100, disconnectGraceMs: 30 });
    var owner = {};
    var first = rooms.createRoom(owner, 0);
    rooms.disconnect(owner, 1);
    rooms.cleanup(31);
    assert.equal(rooms.rooms.size, 1);
    rooms.cleanup(1001);
    assert.equal(rooms.rooms.size, 0);
    var next = rooms.createRoom(owner, 2000);
    rooms.markFinished(next.room, "timeout", 2001);
    rooms.disconnect(owner, 2080);
    assert.equal(rooms.rejoin(next.room.roomCode, next.player.reconnectToken, {}, 2081).rejoined, true);
    assert.equal(rooms.cleanup(2101).some(function (event) { return event.type === "room_expired"; }), true);
  });

  var app = createServer({ cleanupMs: 10, rooms: { disconnectGraceMs: 80 } });
  var sockets = [];
  await app.listen(0, "127.0.0.1");
  var base = "http://127.0.0.1:" + app.server.address().port;
  var url = base.replace("http", "ws") + "/ws";
  async function connect(options) { var c = await client(url, options); sockets.push(c); return c; }
  async function hello(c) { c.send("hello"); return c.next("hello"); }
  try {
    await check("HTTP 静态文件、HEAD、健康检查及私有文件隔离", async function () {
      var page = await get(base, "/");
      assert.match(page.body, /2048/);
      assert.equal(page.headers["cross-origin-opener-policy"], "same-origin");
      assert.equal(page.headers["cross-origin-embedder-policy"], "require-corp");
      var wasm = await get(base, "/js/vendor/ziap/main.wasm", "HEAD");
      assert.equal(wasm.status, 200);
      assert.equal(wasm.headers["content-type"], "application/wasm");
      assert.equal(Number(wasm.headers["content-length"]), 15147);
      assert.match((await get(base, "/js/game_logic.js")).headers["content-type"], /javascript/);
      assert.equal((await get(base, "/style/main.css", "HEAD")).body, "");
      assert.equal((await get(base, "/health")).status, 200);
      for (var pathname of ["/.git/config", "/package.json", "/server/server.js", "/test/protocol.test.js", "/js/%2e%2e/server/server.js", "/js/%00.js", "/missing"]) {
        assert.equal((await get(base, pathname)).status, 404, pathname);
      }
      assert.equal((await get(base, "/", "POST")).status, 405);
    });
    await check("Origin 拒绝跨站连接且允许同源", async function () {
      await assert.rejects(client(url, { origin: "https://example.com" }), /403/);
      await assert.rejects(client(url, { origin: "null" }), /403/);
      var same = await connect({ origin: base });
      await hello(same);
    });
    var a = await connect();
    var b = await connect();
    var c = await connect();
    await check("握手前禁止创建，协议版本和非法报文可恢复", async function () {
      a.send("create_room", { requestId: "before" });
      assert.equal((await a.next("error")).code, "HELLO_REQUIRED");
      a.send("hello", { protocolVersion: 2, requestId: "v2" });
      var error = await a.next("error");
      assert.equal(error.code, "PROTOCOL_MISMATCH");
      assert.equal(error.requestId, "v2");
      a.socket.send("{");
      assert.equal((await a.next("error")).code, "INVALID_MESSAGE");
      a.socket.send(Buffer.from("{}"));
      assert.equal((await a.next("error")).code, "INVALID_MESSAGE");
      assert.equal((await hello(a)).protocolVersion, 1);
      await hello(b);
      await hello(c);
    });
    var identity;
    await check("创建、大小写加入、身份绑定和满员广播", async function () {
      a.send("create_room", { requestId: "create" });
      identity = await a.next("assigned");
      assert.equal(identity.playerId, "p1");
      assert.equal(identity.requestId, "create");
      assert.match(identity.roomCode, /^[A-HJ-NP-Z2-9]{6}$/);
      b.send("join_room", { roomCode: identity.roomCode.toLowerCase(), requestId: "join" });
      var other = await b.next("assigned");
      assert.equal(other.playerId, "p2");
      assert.notEqual(other.reconnectToken, identity.reconnectToken);
      var state = await a.next("room_state", function (message) { return message.players.length === 2; });
      assert.equal(state.phase, "waiting");
      assert.equal(JSON.stringify(state).includes(identity.reconnectToken), false);
      c.send("join_room", { roomCode: identity.roomCode, requestId: "full" });
      assert.equal((await c.next("error")).code, "ROOM_FULL");
      a.send("create_room", { requestId: "repeat" });
      assert.equal((await a.next("error")).code, "ALREADY_ASSIGNED");
      assert.equal(app.rooms.rooms.size, 1);
      c.send("join_room", { roomCode: "ZZZZZZ" });
      assert.equal((await c.next("error")).code, "ROOM_NOT_FOUND");
    });
    await check("在线身份拒绝劫持，断线 rejoin 恢复同一 token", async function () {
      c.send("rejoin", { roomCode: identity.roomCode, reconnectToken: identity.reconnectToken });
      assert.equal((await c.next("error")).code, "PLAYER_CONNECTED");
      await a.close();
      await b.next("player_update", function (message) { return message.playerId === "p1" && message.status === "disconnected"; });
      c.send("rejoin", { roomCode: identity.roomCode, reconnectToken: identity.reconnectToken });
      var restored = await c.next("assigned");
      assert.equal(restored.playerId, "p1");
      assert.equal(restored.reconnectToken, identity.reconnectToken);
      await b.next("player_update", function (message) { return message.playerId === "p1" && message.status === "connected"; });
    });
    await check("hello token 恢复与宽限期过期广播", async function () {
      await c.close();
      await b.next("player_update", function (message) { return message.playerId === "p1" && message.status === "disconnected"; });
      var restored = await connect();
      restored.send("hello", { reconnectToken: identity.reconnectToken });
      assert.equal((await restored.next("assigned")).playerId, "p1");
      await restored.close();
      await b.next("player_update", function (message) { return message.playerId === "p1" && message.status === "expired"; });
      var late = await connect();
      await hello(late);
      late.send("rejoin", { roomCode: identity.roomCode, reconnectToken: identity.reconnectToken });
      assert.equal((await late.next("error")).code, "RECONNECT_EXPIRED");
    });
    await check("消息限流返回关联请求，拒绝时不创建房间", async function () {
      var flood = await connect();
      await hello(flood);
      for (var i = 0; i < 29; i++) flood.send("invalid");
      flood.send("create_room", { requestId: "limited" });
      var error = await flood.next("error", function (message) { return message.code === "RATE_LIMITED"; });
      assert.equal(error.requestId, "limited");
      assert.equal(app.rooms.rooms.size, 1);
      await new Promise(function (resolve) { setTimeout(resolve, 1050); });
      flood.send("invalid", { requestId: "recovered" });
      assert.equal((await flood.next("error", function (message) { return message.requestId === "recovered"; })).code, "INVALID_MESSAGE");
      assert.equal(flood.socket.readyState, WebSocket.OPEN);
    });
    await check("持续超限只回包一次并释放连接，不处理断开后的报文", async function () {
      var accepted = new Promise(function (resolve) { app.wss.once("connection", resolve); });
      var flood = await connect();
      var serverSocket = await accepted;
      await hello(flood);
      var sendCount = 0;
      var rateLimitedCount = 0;
      var send = serverSocket.send;
      serverSocket.send = function (payload) {
        sendCount++;
        if (JSON.parse(payload).code === "RATE_LIMITED") rateLimitedCount++;
        return send.apply(this, arguments);
      };
      var closed = waitForClose(serverSocket);
      for (var i = 0; i < 500; i++) flood.send("create_room", { requestId: "flood-" + i });
      await closed;
      assert.equal(rateLimitedCount, 1);
      // The first accepted request emits assigned + two broadcasts; the remaining 28 emit errors.
      assert.equal(sendCount, 32);
      assert.equal(serverSocket.bufferedAmount <= protocol.MAX_BUFFERED_BYTES, true);
    });
    await check("停止接收的真实连接发送队列保持在 64 KB 内并被释放", async function () {
      var accepted = new Promise(function (resolve) { app.wss.once("connection", resolve); });
      var slow = await connect();
      var serverSocket = await accepted;
      await hello(slow);
      slow.socket.pause();
      var closed = waitForClose(serverSocket);
      var sent = true;
      var message = protocol.makeMessage("test", { text: "x".repeat(8192) });
      for (var i = 0; i < 10000 && sent; i++) {
        sent = protocol.send(serverSocket, message);
        assert.equal(serverSocket.bufferedAmount <= protocol.MAX_BUFFERED_BYTES, true);
      }
      slow.socket.resume();
      assert.equal(sent, false);
      await closed;
    });
    await check("超过 8 KB 的消息以 1009 关闭", async function () {
      var oversized = await connect();
      var closed = new Promise(function (resolve) { oversized.socket.once("close", resolve); });
      oversized.socket.send("x".repeat(8193));
      assert.equal(await closed, 1009);
    });
  } finally {
    await app.close();
  }
  var heartbeatApp = createServer({ heartbeatMs: 20, helloTimeoutMs: 100 });
  await heartbeatApp.listen(0, "127.0.0.1");
  try {
    var heartbeatUrl = "ws://127.0.0.1:" + heartbeatApp.server.address().port + "/ws";
    await check("自动 pong 保持连接，连续两次失联关闭连接", async function () {
      var healthy = await client(heartbeatUrl);
      healthy.send("hello");
      await healthy.next("hello");
      var silent = await client(heartbeatUrl, { autoPong: false });
      silent.send("hello");
      await silent.next("hello");
      await new Promise(function (resolve) { silent.socket.once("close", resolve); });
      assert.equal(healthy.socket.readyState, WebSocket.OPEN);
      await healthy.close();
    });
    await check("未握手连接按超时关闭", async function () {
      var uninitialized = await client(heartbeatUrl);
      assert.equal(await new Promise(function (resolve) { uninitialized.socket.once("close", resolve); }), 1008);
    });
  } finally {
    await heartbeatApp.close();
  }
  console.log("协议与房间检查全部通过：" + passed);
}

run().catch(function (error) { console.error(error); process.exitCode = 1; });
