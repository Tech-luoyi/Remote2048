"use strict";

var http = require("http");
var fs = require("fs");
var path = require("path");
var WebSocket = require("ws");
var RoomManager = require("./room_manager");
var MatchManager = require("./match_manager");
var RateLimiter = require("./rate_limiter");
var protocol = require("./protocol");

var ROOT = path.resolve(__dirname, "..");
var MAX_RATE_LIMIT_STRIKES = 30;
var MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".ico": "image/x-icon",
  ".woff": "font/woff", ".eot": "application/vnd.ms-fontobject", ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8", ".wasm": "application/wasm"
};

function serveStatic(req, res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    res.writeHead(405).end();
    return;
  }
  var pathname;
  try {
    // Decode before resolving: encoded traversal cannot escape the public files.
    pathname = decodeURIComponent(req.url.split("?")[0]);
  } catch (error) {
    res.writeHead(400).end();
    return;
  }
  if (pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(req.method === "HEAD" ? undefined : '{"status":"ok","protocolVersion":1}');
    return;
  }
  if (pathname === "/") pathname = "/index.html";
  var publicPath = /^\/(index\.html|favicon\.ico|LICENSE\.txt)$/.test(pathname) ||
    /^\/(js|style|meta)\//.test(pathname);
  var file = path.resolve(ROOT, "." + pathname);
  var type = MIME[path.extname(file).toLowerCase()];
  if (!publicPath || !type || !file.startsWith(ROOT + path.sep) ||
      pathname.includes("\0") || pathname.includes("\\") || pathname.split("/").includes("..")) {
    res.writeHead(404).end();
    return;
  }
  fs.realpath(file, function (error, realFile) {
    if (error || realFile !== file) {
      res.writeHead(404).end();
      return;
    }
    fs.stat(realFile, function (statError, stat) {
      if (statError || !stat.isFile()) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": type, "Content-Length": stat.size });
      if (req.method === "HEAD") { res.end(); return; }
      var stream = fs.createReadStream(realFile);
      stream.on("error", function () { res.destroy(); });
      res.on("close", function () { stream.destroy(); });
      stream.pipe(res);
    });
  });
}

function createServer(options) {
  options = options || {};
  var rooms = new RoomManager(options.rooms);
  var matches = new MatchManager(rooms, {
    ...options.matches,
    emit: function (room, playerId, type, fields) {
      var message = protocol.makeMessage(type, fields);
      if (playerId === null) broadcast(room, message);
      else {
        var player = room.players[playerId];
        if (player && player.connection) protocol.send(player.connection.ws, message);
      }
    }
  });
  var server = http.createServer(serveStatic);
  var wss = new WebSocket.WebSocketServer({ noServer: true, maxPayload: protocol.MAX_MESSAGE_BYTES });
  var connections = new Set();
  var closing = false;
  var allowedOrigins = options.allowedOrigins || [];
  var heartbeatMs = options.heartbeatMs || 15000;

  function broadcast(room, message) {
    [room.players.p1, room.players.p2].forEach(function (player) {
      if (player && player.connection) protocol.send(player.connection.ws, message);
    });
  }
  function roomState(room) {
    broadcast(room, protocol.makeMessage("room_state", rooms.serialize(room)));
  }
  function playerUpdate(room, player, status) {
    broadcast(room, protocol.makeMessage("player_update", {
      playerId: player.playerId, status: status || player.status, roomCode: room.roomCode
    }));
  }
  function sweep() {
    matches.tick();
    rooms.cleanup().forEach(function (event) {
      if (event.type === "player_expired") {
        playerUpdate(event.room, event.player);
        roomState(event.room);
      } else {
        [event.room.players.p1, event.room.players.p2].forEach(function (player) {
          if (player && player.connection) player.connection.ws.close(1000, "Room expired");
        });
      }
    });
  }
  function assigned(connection, result, requestId) {
    if (result.error) {
      protocol.send(connection.ws, protocol.makeError(result.error, requestId));
      return;
    }
    protocol.send(connection.ws, protocol.makeMessage("assigned", {
      playerId: result.player.playerId, roomCode: result.room.roomCode,
      reconnectToken: result.player.reconnectToken,
      ...(requestId === undefined ? {} : { requestId: requestId })
    }));
    playerUpdate(result.room, result.player);
    roomState(result.room);
    if (result.rejoined && result.room.match) matches.resync(connection);
  }
  function handle(connection, raw, isBinary) {
    var ws = connection.ws;
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!connection.limiter.allow()) {
      connection.rateLimitStrikes++;
      if (connection.rateLimitStrikes >= MAX_RATE_LIMIT_STRIKES) {
        ws.terminate();
        return;
      }
      if (connection.rateLimitStrikes > 1) return;
      var limited = isBinary ? {} : protocol.parseMessage(raw);
      var limitedId = limited.message && protocol.isRequestId(limited.message.requestId)
        ? limited.message.requestId : undefined;
      protocol.send(ws, protocol.makeError("RATE_LIMITED", limitedId, protocol.moveCorrelation(limited.message)));
      return;
    }
    connection.rateLimitStrikes = 0;
    var parsed = isBinary ? { error: "INVALID_MESSAGE" } : protocol.parseMessage(raw);
    if (parsed.error) {
      protocol.send(ws, protocol.makeError(parsed.error,
        parsed.message && protocol.isRequestId(parsed.message.requestId) ? parsed.message.requestId : undefined,
        protocol.moveCorrelation(parsed.message)));
      return;
    }
    var message = parsed.message;
    if (!protocol.isRequestId(message.requestId)) {
      protocol.send(ws, protocol.makeError("INVALID_MESSAGE", undefined, protocol.moveCorrelation(message)));
      return;
    }
    function reject(code) {
      protocol.send(ws, protocol.makeError(code, message.requestId, protocol.moveCorrelation(message)));
    }
    if (!connection.hello && message.type !== "hello") { reject("HELLO_REQUIRED"); return; }
    if (message.type === "hello") {
      if (connection.hello) { reject("INVALID_MESSAGE"); return; }
      if (message.reconnectToken !== undefined &&
          (typeof message.reconnectToken !== "string" || message.reconnectToken.length < 16 || message.reconnectToken.length > 256)) {
        reject("INVALID_MESSAGE"); return;
      }
      connection.hello = true;
      clearTimeout(connection.helloTimer);
      protocol.send(ws, protocol.makeMessage("hello", { serverNow: rooms.now() }));
      if (message.reconnectToken !== undefined) {
        sweep();
        var found = null;
        rooms.rooms.forEach(function (room) {
          if (rooms.findByToken(room, message.reconnectToken)) found = room;
        });
        if (!found) { reject("RECONNECT_EXPIRED"); return; }
        assigned(connection, rooms.rejoin(found.roomCode, message.reconnectToken, connection), message.requestId);
      }
      return;
    }
    if (["ready", "move", "use_skill", "rematch", "resync", "leave_room"].includes(message.type)) {
      sweep();
      var result;
      if (message.type === "ready") result = matches.ready(connection, message.ready);
      else if (message.type === "move") result = matches.move(connection, message);
      else if (message.type === "use_skill") result = matches.useSkill(connection, message);
      else if (message.type === "rematch") result = matches.rematch(connection, message);
      else if (message.type === "resync") result = matches.resync(connection);
      else result = matches.leave(connection);
      if (result.error) reject(result.error);
      else if (message.type === "leave_room") {
        protocol.send(ws, protocol.makeMessage("left_room", {
          roomCode: result.roomCode, ...(message.requestId === undefined ? {} : { requestId: message.requestId })
        }));
      }
      return;
    }
    if (!["create_room", "join_room", "rejoin"].includes(message.type)) {
      reject("INVALID_MESSAGE"); return;
    }
    if (connection.room) { reject("ALREADY_ASSIGNED"); return; }
    sweep();
    if (message.type === "create_room") {
      assigned(connection, rooms.createRoom(connection), message.requestId);
    } else if (message.type === "join_room" || message.type === "rejoin") {
      var code = typeof message.roomCode === "string" ? message.roomCode.toUpperCase() : "";
      if (!protocol.isRoomCode(code)) { reject("INVALID_MESSAGE"); return; }
      if (message.type === "rejoin") {
        if (typeof message.reconnectToken !== "string" || message.reconnectToken.length < 16 || message.reconnectToken.length > 256) {
          reject("INVALID_MESSAGE"); return;
        }
        assigned(connection, rooms.rejoin(code, message.reconnectToken, connection), message.requestId);
      } else {
        assigned(connection, rooms.joinRoom(code, connection), message.requestId);
      }
    } else { reject("INVALID_MESSAGE"); }
  }

  server.on("upgrade", function (req, socket, head) {
    function refuse(status) {
      socket.end("HTTP/1.1 " + status + "\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    }
    if (closing || connections.size >= (options.maxConnections || 2048)) {
      refuse("503 Service Unavailable"); return;
    }
    if (req.url !== "/ws") { refuse("404 Not Found"); return; }
    var origin = req.headers.origin;
    if (origin) {
      var allowed = allowedOrigins.includes(origin);
      try {
        var parsedOrigin = new URL(origin);
        allowed = allowed || ((parsedOrigin.protocol === "http:" || parsedOrigin.protocol === "https:") &&
          parsedOrigin.host === req.headers.host && parsedOrigin.origin === origin);
      } catch (error) { allowed = false; }
      if (!allowed) { refuse("403 Forbidden"); return; }
    }
    wss.handleUpgrade(req, socket, head, function (ws) { wss.emit("connection", ws); });
  });
  wss.on("connection", function (ws) {
    var connection = { ws: ws, hello: false, room: null, player: null,
      limiter: new RateLimiter(), rateLimitStrikes: 0, awaitingPong: false, missedPongs: 0 };
    connections.add(connection);
    connection.helloTimer = setTimeout(function () { ws.close(1008, "Hello required"); }, options.helloTimeoutMs || 10000);
    ws.on("pong", function () { connection.awaitingPong = false; connection.missedPongs = 0; });
    ws.on("message", function (raw, binary) { handle(connection, raw, binary); });
    ws.on("error", function () { ws.terminate(); });
    ws.on("close", function () {
      clearTimeout(connection.helloTimer);
      connections.delete(connection);
      var result = rooms.disconnect(connection);
      if (result && !closing) { playerUpdate(result.room, result.player); roomState(result.room); }
    });
  });
  var heartbeat = setInterval(function () {
    connections.forEach(function (connection) {
      if (connection.awaitingPong) connection.missedPongs++;
      if (connection.missedPongs >= 2) { connection.ws.terminate(); return; }
      if (connection.ws.readyState === WebSocket.OPEN) {
        connection.awaitingPong = true;
        connection.ws.ping();
      }
    });
  }, heartbeatMs);
  var cleanup = setInterval(sweep, options.cleanupMs || 1000);
  var matchTick = setInterval(function () { matches.tick(); }, options.matchTickMs || 50);
  heartbeat.unref();
  cleanup.unref();
  matchTick.unref();

  return {
    server: server, wss: wss, rooms: rooms, matches: matches,
    listen: function (port, host) {
      return new Promise(function (resolve, reject) {
        server.once("error", reject);
        server.listen(port, host, function () {
          server.removeListener("error", reject);
          resolve(server.address());
        });
      });
    },
    close: function () {
      closing = true;
      clearInterval(heartbeat);
      clearInterval(cleanup);
      clearInterval(matchTick);
      connections.forEach(function (connection) {
        clearTimeout(connection.helloTimer);
        connection.ws.terminate();
      });
      return new Promise(function (resolve) {
        wss.close(function () {
          server.close(function () { resolve(); });
          server.closeIdleConnections();
        });
      });
    }
  };
}

if (require.main === module) {
  var port = Number(process.env.PORT || 3000);
  var host = process.env.HOST || "0.0.0.0";
  var app = createServer({
    allowedOrigins: (process.env.ALLOWED_ORIGINS || "").split(",").filter(Boolean),
    matches: {
      targetTile: Number(process.env.MATCH_TARGET_TILE || 2048),
      durationMs: Number(process.env.MATCH_DURATION_MS || 8 * 60 * 1000)
    }
  });
  app.listen(port, host).then(function () {
    console.log("2048 服务已启动：http://localhost:" + app.server.address().port);
  }).catch(function (error) {
    console.error("启动失败：" + error.message);
    app.close().then(function () { process.exitCode = 1; });
  });
  ["SIGINT", "SIGTERM"].forEach(function (signal) {
    process.once(signal, function () { app.close().then(function () { process.exit(0); }); });
  });
}

module.exports = { createServer: createServer };
