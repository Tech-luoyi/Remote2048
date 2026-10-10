/*
 * In-memory player identity and connection lifecycle. MatchManager attaches
 * authoritative match state to the same room. Reconnect tokens are never part
 * of room_state broadcasts.
 */
"use strict";

var crypto = require("crypto");

var ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
var ROOM_CODE_LENGTH = 6;
var MAX_CODE_ATTEMPTS = 5;
var DEFAULT_MAX_ROOMS = 1000;
var DEFAULT_WAITING_TTL_MS = 30 * 60 * 1000;
var DEFAULT_FINISHED_TTL_MS = 5 * 60 * 1000;
var DEFAULT_DISCONNECT_GRACE_MS = 30 * 1000;

function defaultCodeFactory(length) {
  var code = "";
  for (var i = 0; i < length; i++) {
    code += ROOM_CODE_ALPHABET[crypto.randomInt(ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

function defaultTokenFactory() {
  return crypto.randomBytes(24).toString("base64url");
}

function RoomManager(options) {
  options = options || {};
  this.rooms = new Map();
  this.maxRooms = options.maxRooms || DEFAULT_MAX_ROOMS;
  this.waitingTtlMs = options.waitingTtlMs || DEFAULT_WAITING_TTL_MS;
  this.finishedTtlMs = options.finishedTtlMs || DEFAULT_FINISHED_TTL_MS;
  this.disconnectGraceMs = options.disconnectGraceMs || DEFAULT_DISCONNECT_GRACE_MS;
  this.codeLength = options.codeLength || ROOM_CODE_LENGTH;
  this.maxCodeAttempts = options.maxCodeAttempts || MAX_CODE_ATTEMPTS;
  this.now = options.now || Date.now;
  this.codeFactory = options.codeFactory || defaultCodeFactory;
  this.tokenFactory = options.tokenFactory || defaultTokenFactory;
}

RoomManager.prototype.createPlayer = function (playerId, now) {
  return {
    playerId: playerId,
    reconnectToken: this.tokenFactory(),
    status: "connected",
    ready: false,
    connection: null,
    connectedAt: now,
    disconnectedAt: null,
    reconnectDeadline: null
  };
};

RoomManager.prototype.createRoom = function (connection, now) {
  now = now === undefined ? this.now() : now;
  if (connection && connection.room) return { error: "ALREADY_ASSIGNED" };
  if (this.rooms.size >= this.maxRooms) {
    return { error: "ROOM_LIMIT_REACHED" };
  }

  var code = null;
  for (var attempt = 0; attempt < this.maxCodeAttempts; attempt++) {
    var candidate = String(this.codeFactory(this.codeLength)).toUpperCase();
    if (!this.rooms.has(candidate)) {
      code = candidate;
      break;
    }
  }
  if (!code) return { error: "ROOM_LIMIT_REACHED" };

  var room = {
    roomCode: code,
    phase: "waiting",
    createdAt: now,
    lastActivityAt: now,
    finishedAt: null,
    finishReason: null,
    players: {
      p1: this.createPlayer("p1", now),
      p2: null
    }
  };
  this.rooms.set(code, room);
  this.bind(room, room.players.p1, connection, now);
  return { room: room, player: room.players.p1 };
};

RoomManager.prototype.joinRoom = function (roomCode, connection, now) {
  now = now === undefined ? this.now() : now;
  if (connection && connection.room) return { error: "ALREADY_ASSIGNED" };
  var room = this.get(roomCode);
  if (!room) return { error: "ROOM_NOT_FOUND" };
  if (room.phase !== "waiting") return { error: "ROOM_FULL" };
  var playerId = !room.players.p1 ? "p1" : (!room.players.p2 ? "p2" : null);
  if (!playerId) return { error: "ROOM_FULL" };

  var player = this.createPlayer(playerId, now);
  room.players[playerId] = player;
  room.lastActivityAt = now;
  this.bind(room, player, connection, now);
  return { room: room, player: player };
};

RoomManager.prototype.rejoin = function (roomCode, reconnectToken, connection, now) {
  now = now === undefined ? this.now() : now;
  if (connection && connection.room) return { error: "ALREADY_ASSIGNED" };
  var room = this.get(roomCode);
  if (!room) return { error: "ROOM_NOT_FOUND" };

  var player = this.findByToken(room, reconnectToken);
  if (!player) return { error: "RECONNECT_EXPIRED" };
  if (player.status === "expired" ||
      (player.reconnectDeadline !== null && now >= player.reconnectDeadline)) {
    return { error: "RECONNECT_EXPIRED", room: room, player: player };
  }
  if (player.connection && player.connection !== connection) {
    return { error: "PLAYER_CONNECTED" };
  }

  this.bind(room, player, connection, now);
  return { room: room, player: player, rejoined: true };
};

RoomManager.prototype.bind = function (room, player, connection, now) {
  if (connection) {
    connection.room = room;
    connection.player = player;
  }
  player.connection = connection || null;
  player.status = "connected";
  player.connectedAt = now;
  player.disconnectedAt = null;
  player.reconnectDeadline = null;
  room.lastActivityAt = now;
};

RoomManager.prototype.disconnect = function (connection, now) {
  now = now === undefined ? this.now() : now;
  if (!connection || !connection.room || !connection.player) return null;
  var room = connection.room;
  var player = connection.player;
  if (player.connection !== connection) return null;

  player.connection = null;
  player.status = "disconnected";
  player.disconnectedAt = now;
  player.reconnectDeadline = now + this.disconnectGraceMs;
  if (room.phase === "waiting") player.ready = false;
  room.lastActivityAt = now;
  connection.room = null;
  connection.player = null;
  return { room: room, player: player };
};

RoomManager.prototype.markFinished = function (room, reason, now) {
  now = now === undefined ? this.now() : now;
  if (!room || room.phase === "finished") return;
  room.phase = "finished";
  room.finishedAt = now;
  room.finishReason = reason || null;
  room.lastActivityAt = now;
};

RoomManager.prototype.findByToken = function (room, token) {
  if (typeof token !== "string" || token.length < 16 || token.length > 256) {
    return null;
  }
  var players = [room.players.p1, room.players.p2];
  for (var i = 0; i < players.length; i++) {
    if (players[i] && players[i].reconnectToken === token) return players[i];
  }
  return null;
};

RoomManager.prototype.get = function (roomCode) {
  if (typeof roomCode !== "string") return null;
  return this.rooms.get(roomCode.toUpperCase()) || null;
};

RoomManager.prototype.remove = function (roomCode) {
  return this.rooms.delete(String(roomCode).toUpperCase());
};

RoomManager.prototype.serialize = function (room) {
  if (!room) return null;
  var players = [room.players.p1, room.players.p2].filter(Boolean).map(function (player) {
    return {
      playerId: player.playerId,
      status: player.status,
      ready: !!player.ready
    };
  });
  // rematch 投票只暴露布尔值，不含任何可用于推断对手意图的额外信息。
  var votes = room.rematch || { p1: false, p2: false };
  return {
    roomCode: room.roomCode,
    phase: room.phase,
    players: players,
    finishReason: room.finishReason,
    ...(room.match ? {
      matchId: room.match.matchId, startsAt: room.match.startsAt, deadlineAt: room.match.deadlineAt
    } : {}),
    ...(room.phase === "finished" && room.players.p1 && room.players.p2 ? {
      rematchVotes: { p1: !!votes.p1, p2: !!votes.p2 }
    } : {})
  };
};

RoomManager.prototype.cleanup = function (now) {
  now = now === undefined ? this.now() : now;
  var expired = [];
  var self = this;
  this.rooms.forEach(function (room) {
    [room.players.p1, room.players.p2].forEach(function (player) {
      if (!player || player.status !== "disconnected" ||
          player.reconnectDeadline === null || now < player.reconnectDeadline) {
        return;
      }
      player.status = "expired";
      player.reconnectDeadline = null;
      expired.push({ type: "player_expired", room: room, player: player });
      if (room.phase === "waiting") room.players[player.playerId] = null;
    });

    var empty = [room.players.p1, room.players.p2].every(function (player) {
      return !player;
    });
    var expiredRoom = room.phase === "finished"
      ? now - room.finishedAt >= self.finishedTtlMs
      : room.phase === "waiting" && empty && now - room.lastActivityAt >= self.waitingTtlMs;
    if (expiredRoom) {
      self.rooms.delete(room.roomCode);
      expired.push({ type: "room_expired", room: room });
    }
  });
  return expired;
};

RoomManager.ROOM_CODE_ALPHABET = ROOM_CODE_ALPHABET;
RoomManager.DEFAULTS = {
  maxRooms: DEFAULT_MAX_ROOMS,
  waitingTtlMs: DEFAULT_WAITING_TTL_MS,
  finishedTtlMs: DEFAULT_FINISHED_TTL_MS,
  disconnectGraceMs: DEFAULT_DISCONNECT_GRACE_MS
};

module.exports = RoomManager;
