"use strict";

var crypto = require("node:crypto");
var GameLogic = require("../js/game_logic");

function integerOption(options, name, fallback, minimum) {
  var value = options[name] === undefined ? fallback : options[name];
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error("Invalid " + name);
  return value;
}

function MatchManager(rooms, options) {
  options = options || {};
  this.rooms = rooms;
  this.now = options.now || rooms.now;
  this.emit = options.emit || function () {};
  this.targetTile = integerOption(options, "targetTile", 2048, 4);
  if (Math.pow(2, Math.round(Math.log2(this.targetTile))) !== this.targetTile) throw new Error("Invalid targetTile");
  this.durationMs = integerOption(options, "durationMs", 8 * 60 * 1000, 1);
  this.countdownMs = integerOption(options, "countdownMs", 3000, 0);
  this.moveIntervalMs = integerOption(options, "moveIntervalMs", 50, 0);
  this.clockMs = integerOption(options, "clockMs", 5000, 1);
  this.skillCooldownMs = integerOption(options, "skillCooldownMs", 3000, 0);
  this.seedFactory = options.seedFactory || function () { return crypto.randomBytes(4).readUInt32LE(0); };
  // 干扰位置必须由服务端决定；用独立随机源，避免与对局 rngState 相互影响。
  this.pickFactory = options.pickFactory || function (limit) { return crypto.randomInt(limit); };
}

MatchManager.prototype.roomState = function (room) {
  this.emit(room, null, "room_state", this.rooms.serialize(room));
};

/*
 * rematch：再来一局。
 *
 * 只有结算页可以请求，且双方都在线。任一方请求后即可撤销（再次发送即取消），
 * 两人同时在场且都同意时才开新局。新局复用同一个房间码和 matchId 之外的一切
 * 身份，seed 重新抽取，因此两盘棋盘互不相同。
 */
MatchManager.prototype.rematch = function (connection, message, now) {
  now = now === undefined ? this.now() : now;
  var room = connection.room;
  if (!room || !connection.player) return { error: "NOT_ASSIGNED" };
  this.advance(room, now);
  if (room.phase !== "finished" || !room.match) return { error: "MATCH_FINISHED" };
  var players = [room.players.p1, room.players.p2];
  if (!players.every(function (player) {
    return player && player.status === "connected";
  })) {
    return { error: "OPPONENT_OFFLINE" };
  }

  var id = connection.player.playerId;
  var votes = room.rematch || (room.rematch = { p1: false, p2: false });
  // 再次请求即撤销自己的同意，避免误点后无法反悔。
  votes[id] = !votes[id];
  if (!votes.p1 || !votes.p2) {
    this.roomState(room);
    return {};
  }
  this.start(room, now);
  return {};
};

// 抽 seed、建 match、进入倒计时。首次开局与 rematch 共用这一段。
MatchManager.prototype.start = function (room, now) {
  var seed = this.seedFactory();
  room.match = {
    matchId: crypto.randomBytes(12).toString("hex"),
    startsAt: now + this.countdownMs,
    deadlineAt: now + this.countdownMs + this.durationMs,
    lastClockAt: now,
    players: {}, result: null
  };
  room.rematch = { p1: false, p2: false };
  room.finishedAt = null;
  room.finishReason = null;
  var players = [room.players.p1, room.players.p2];
  players.forEach(function (player) {
    room.match.players[player.playerId] = {
      state: GameLogic.createInitialState(seed, { targetTile: this.targetTile }),
      stateVersion: 0, lastAcceptedSeq: 0, lastMoveAt: null, lastSkillAt: null
    };
  }, this);
  room.phase = "countdown";
  players.forEach(function (player) {
    this.emit(room, player.playerId, "match_start", this.snapshot(room, player.playerId, now));
  }, this);
  this.roomState(room);
};

MatchManager.prototype.snapshot = function (room, playerId, now) {
  var match = room.match;
  var player = match.players[playerId];
  var otherId = playerId === "p1" ? "p2" : "p1";
  var other = match.players[otherId];
  return {
    matchId: match.matchId, playerId: playerId, phase: room.phase,
    serverNow: now, startsAt: match.startsAt, deadlineAt: match.deadlineAt,
    state: GameLogic.serializeState(player.state), stateVersion: player.stateVersion,
    stateHash: GameLogic.hashState(player.state), lastAcceptedSeq: player.lastAcceptedSeq,
    // energy 已在 state 内，这里额外给出冷却截止时间（它不在 state 里）。
    cooldownUntil: player.lastSkillAt === null ? 0 : player.lastSkillAt + this.skillCooldownMs,
    opponent: {
      playerId: otherId, state: GameLogic.serializeState(other.state),
      stateVersion: other.stateVersion
    },
    result: match.result
  };
};

MatchManager.prototype.ready = function (connection, value, now) {
  now = now === undefined ? this.now() : now;
  var room = connection.room;
  if (!room || !connection.player) return { error: "NOT_ASSIGNED" };
  this.advance(room, now);
  if (room.phase === "finished") return { error: "MATCH_FINISHED" };
  if (room.phase !== "waiting") return { error: "MATCH_NOT_READY" };
  if (typeof value !== "boolean") return { error: "INVALID_MESSAGE" };
  connection.player.ready = value;
  var players = [room.players.p1, room.players.p2];
  if (players.every(function (player) { return player && player.status === "connected" && player.ready; })) {
    this.start(room, now);
  }
  this.roomState(room);
  this.advance(room, now);
  return {};
};

MatchManager.prototype.compare = function (room) {
  var p1 = room.match.players.p1.state;
  var p2 = room.match.players.p2.state;
  var difference = p1.score - p2.score || this.maxTile(p1) - this.maxTile(p2);
  return difference > 0 ? "p1" : (difference < 0 ? "p2" : null);
};

MatchManager.prototype.maxTile = function (state) {
  var max = 0;
  state.cells.forEach(function (column) {
    column.forEach(function (tile) { if (tile) max = Math.max(max, tile.value); });
  });
  return max;
};

MatchManager.prototype.finish = function (room, winner, reason, now) {
  if (!room.match || room.phase === "finished") return;
  this.rooms.markFinished(room, reason, now);
  // 新局的同意票在结算时清空，避免上局的残留直接触发开局。
  room.rematch = { p1: false, p2: false };
  var states = {};
  ["p1", "p2"].forEach(function (id) {
    var player = room.match.players[id];
    states[id] = {
      state: GameLogic.serializeState(player.state), stateVersion: player.stateVersion,
      lastAcceptedSeq: player.lastAcceptedSeq
    };
  });
  room.match.result = {
    matchId: room.match.matchId, winner: winner, reason: reason, serverNow: now,
    scores: { p1: states.p1.state.score, p2: states.p2.state.score }, states: states
  };
  this.emit(room, null, "match_end", room.match.result);
  this.roomState(room);
};

MatchManager.prototype.advance = function (room, now) {
  if (!room.match || room.phase === "finished") return;
  var match = room.match;
  // Resolve the earliest expired grace period before the match deadline.
  var expired = [room.players.p1, room.players.p2].filter(function (player) {
    return player && player.status === "disconnected" &&
      player.reconnectDeadline <= now && player.reconnectDeadline <= match.deadlineAt;
  }).sort(function (a, b) { return a.reconnectDeadline - b.reconnectDeadline; });
  if (expired.length) {
    var winner = expired.length === 2 && expired[0].reconnectDeadline === expired[1].reconnectDeadline
      ? null : (expired[0].playerId === "p1" ? "p2" : "p1");
    this.finish(room, winner, "opponent_disconnected", expired[0].reconnectDeadline);
    return;
  }
  if (now >= match.deadlineAt) {
    this.finish(room, this.compare(room), "timeout", match.deadlineAt);
    return;
  }
  if (room.phase === "countdown" && now >= match.startsAt) {
    room.phase = "playing";
    this.roomState(room);
  }
  if (now - match.lastClockAt >= this.clockMs) {
    match.lastClockAt = now;
    this.emit(room, null, "clock", { matchId: match.matchId, serverNow: now });
  }
};

MatchManager.prototype.tick = function (now) {
  now = now === undefined ? this.now() : now;
  this.rooms.rooms.forEach(function (room) { this.advance(room, now); }, this);
};

MatchManager.prototype.move = function (connection, message, now) {
  now = now === undefined ? this.now() : now;
  var room = connection.room;
  if (!room || !connection.player) return { error: "NOT_ASSIGNED" };
  this.advance(room, now);
  if (room.phase === "finished") return { error: "MATCH_FINISHED" };
  if (room.phase !== "playing") return { error: "MATCH_NOT_READY" };
  var match = room.match;
  if (message.matchId !== match.matchId) return { error: "MATCH_NOT_READY" };
  if (![0, 1, 2, 3].includes(message.direction)) return { error: "INVALID_DIRECTION" };
  if (!Number.isSafeInteger(message.seq) || message.seq < 1 ||
      !Number.isSafeInteger(message.baseVersion) || message.baseVersion < 0) {
    return { error: "INVALID_MESSAGE" };
  }
  var id = connection.player.playerId;
  var player = match.players[id];
  if (message.seq <= player.lastAcceptedSeq) return { error: "SEQ_OUT_OF_ORDER" };
  if (player.state.stuck) return { error: "PLAYER_STUCK" };
  if (player.lastMoveAt !== null && now - player.lastMoveAt < this.moveIntervalMs) {
    return { error: "RATE_LIMITED" };
  }
  // baseVersion describes the prediction; authority always uses its own state.
  var result = GameLogic.applyMove(player.state, message.direction);
  player.state = GameLogic.serializeState(result.state);
  player.state.moveSeq = message.seq;
  player.lastAcceptedSeq = message.seq;
  player.lastMoveAt = now;
  player.stateVersion++;
  var fields = {
    matchId: match.matchId, playerId: id, seq: message.seq, stateVersion: player.stateVersion,
    stateHash: GameLogic.hashState(player.state), state: GameLogic.serializeState(player.state),
    events: result.events, serverNow: now
  };
  this.emit(room, id, "move_ack", fields);
  this.emit(room, id === "p1" ? "p2" : "p1", "opponent_update", fields);
  if (result.won) this.finish(room, id, "target_reached", now);
  else if (match.players.p1.state.stuck && match.players.p2.state.stuck) {
    this.finish(room, this.compare(room), "both_stuck", now);
  }
  return {};
};

MatchManager.prototype.opponentOf = function (playerId) {
  return playerId === "p1" ? "p2" : "p1";
};

/*
 * use_skill：§9 干扰玩法。
 *
 * 全部判定都在服务端，客户端只能请求"用掉 1 点能量"，不能指定位置或数值：
 *   - 能量不足      -> NOT_ENOUGH_ENERGY（不消耗能量）
 *   - 冷却中        -> SKILL_ON_COOLDOWN
 *   - 对手无空位    -> NO_TARGET_SPACE
 *   - 对手已有干扰块-> INTERFERENCE_ACTIVE
 *
 * 干扰是跨棋盘写入：对手客户端收到 skill_result 且 target 是自己时必须硬同步。
 * stuck 玩家不能移动，但手上仍有的能量允许打出去（§9 边界规则）。
 */
MatchManager.prototype.useSkill = function (connection, message, now) {
  now = now === undefined ? this.now() : now;
  var room = connection.room;
  if (!room || !connection.player) return { error: "NOT_ASSIGNED" };
  this.advance(room, now);
  if (room.phase === "finished") return { error: "MATCH_FINISHED" };
  if (room.phase !== "playing") return { error: "MATCH_NOT_READY" };
  var match = room.match;
  if (message.matchId !== undefined && message.matchId !== match.matchId) {
    return { error: "MATCH_NOT_READY" };
  }
  if (message.skill !== "interference") return { error: "INVALID_MESSAGE" };

  var id = connection.player.playerId;
  var otherId = this.opponentOf(id);
  var player = match.players[id];
  var target = match.players[otherId];
  if (player.state.energy < 1) return { error: "NOT_ENOUGH_ENERGY" };
  if (player.lastSkillAt !== null && now - player.lastSkillAt < this.skillCooldownMs) {
    return { error: "SKILL_ON_COOLDOWN" };
  }

  // 位置由服务端在空位中挑选；客户端无从得知，也不参与预测。
  var spaces = GameLogic.availableCells(target.state.cells, target.state.size);
  if (!spaces.length) return { error: "NO_TARGET_SPACE" };
  var position = spaces[this.pickFactory(spaces.length) % spaces.length];
  var next = GameLogic.applyInterference(target.state, position);
  if (!next) return { error: "INTERFERENCE_ACTIVE" };

  // 消耗能量只写发起方自己的棋盘，因此不会影响对手的预测重放。
  player.state = GameLogic.serializeState(player.state);
  player.state.energy -= 1;
  player.lastSkillAt = now;
  player.stateVersion++;
  target.state = next;
  target.stateVersion++;

  var fields = {
    matchId: match.matchId, skill: "interference",
    source: id, target: otherId, requestId: message.requestId,
    position: position, value: GameLogic.INTERFERENCE_VALUE,
    cooldownUntil: now + this.skillCooldownMs, serverNow: now
  };
  this.emit(room, otherId, "skill_result", Object.assign({}, fields, {
    stateVersion: target.stateVersion,
    stateHash: GameLogic.hashState(target.state),
    state: GameLogic.serializeState(target.state),
    lastAcceptedSeq: target.lastAcceptedSeq
  }));
  this.emit(room, id, "skill_result", Object.assign({}, fields, {
    stateVersion: player.stateVersion,
    stateHash: GameLogic.hashState(player.state),
    state: GameLogic.serializeState(player.state),
    lastAcceptedSeq: player.lastAcceptedSeq,
    opponent: {
      playerId: otherId, state: GameLogic.serializeState(target.state),
      stateVersion: target.stateVersion
    }
  }));

  // 干扰可能让对手无路可走；只有双方都 stuck 才结束比赛。
  if (match.players.p1.state.stuck && match.players.p2.state.stuck) {
    this.finish(room, this.compare(room), "both_stuck", now);
  }
  return {};
};

MatchManager.prototype.resync = function (connection, now) {
  now = now === undefined ? this.now() : now;
  if (!connection.room || !connection.player) return { error: "NOT_ASSIGNED" };
  this.advance(connection.room, now);
  if (!connection.room.match) return { error: "MATCH_NOT_READY" };
  this.emit(connection.room, connection.player.playerId, "resync",
    this.snapshot(connection.room, connection.player.playerId, now));
  return {};
};

MatchManager.prototype.leave = function (connection, now) {
  now = now === undefined ? this.now() : now;
  var room = connection.room;
  if (!room || !connection.player) return { error: "NOT_ASSIGNED" };
  this.advance(room, now);
  var player = connection.player;
  if (room.match && room.phase !== "finished") {
    this.finish(room, player.playerId === "p1" ? "p2" : "p1", "opponent_left", now);
  }
  this.rooms.disconnect(connection, now);
  player.status = "expired";
  player.reconnectDeadline = null;
  if (room.phase === "waiting") room.players[player.playerId] = null;
  this.emit(room, null, "player_update", { roomCode: room.roomCode, playerId: player.playerId, status: "expired" });
  this.roomState(room);
  return { roomCode: room.roomCode };
};

module.exports = MatchManager;
