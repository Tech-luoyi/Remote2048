/*
 * WebSocket protocol helpers shared by the server and protocol tests.
 * Connection, room and authoritative match messages share this envelope.
 */
"use strict";

var PROTOCOL_VERSION = 1;
var MAX_MESSAGE_BYTES = 8 * 1024;
var MAX_BUFFERED_BYTES = 64 * 1024;

var MESSAGE_KEYS = {
  PROTOCOL_MISMATCH: "error.protocolMismatch",
  INVALID_MESSAGE: "error.invalidMessage",
  ROOM_FULL: "error.roomFull",
  ROOM_NOT_FOUND: "error.roomNotFound",
  ROOM_LIMIT_REACHED: "error.roomLimitReached",
  RECONNECT_EXPIRED: "error.reconnectExpired",
  RATE_LIMITED: "error.rateLimited",
  HELLO_REQUIRED: "error.helloRequired",
  ALREADY_ASSIGNED: "error.alreadyAssigned",
  PLAYER_CONNECTED: "error.playerConnected",
  NOT_ASSIGNED: "error.notAssigned",
  MATCH_NOT_READY: "error.matchNotReady",
  MATCH_FINISHED: "error.matchFinished",
  INVALID_DIRECTION: "error.invalidDirection",
  SEQ_OUT_OF_ORDER: "error.seqOutOfOrder",
  PLAYER_STUCK: "error.playerStuck",
  NOT_ENOUGH_ENERGY: "error.notEnoughEnergy",
  NO_TARGET_SPACE: "error.noTargetSpace",
  INTERFERENCE_ACTIVE: "error.interferenceActive",
  SKILL_ON_COOLDOWN: "error.skillOnCooldown",
  OPPONENT_OFFLINE: "error.opponentOffline"
};

function byteLength(value) {
  if (Buffer.isBuffer(value)) return value.length;
  return Buffer.byteLength(String(value), "utf8");
}

function parseMessage(raw) {
  if (byteLength(raw) > MAX_MESSAGE_BYTES) {
    return { error: "INVALID_MESSAGE", reason: "MESSAGE_TOO_LARGE" };
  }

  var text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  var message;
  try {
    message = JSON.parse(text);
  } catch (error) {
    return { error: "INVALID_MESSAGE", reason: "INVALID_JSON" };
  }

  if (!message || typeof message !== "object" || Array.isArray(message) ||
      typeof message.type !== "string" || message.type.length > 32) {
    return { error: "INVALID_MESSAGE", reason: "INVALID_ENVELOPE" };
  }

  if (message.protocolVersion !== PROTOCOL_VERSION) {
    return { error: "PROTOCOL_MISMATCH", message: message };
  }

  return { message: message };
}

function isRequestId(value) {
  return value === undefined ||
    (typeof value === "string" && value.length > 0 && value.length <= 128);
}

function isRoomCode(value) {
  return typeof value === "string" && /^[A-HJ-NP-Z2-9]{6}$/.test(value);
}

function moveCorrelation(message) {
  var fields = {};
  if (message && message.type === "move") {
    if (Number.isSafeInteger(message.seq)) fields.seq = message.seq;
    if (typeof message.matchId === "string" && message.matchId.length <= 128) fields.matchId = message.matchId;
  }
  return fields;
}

function makeError(code, requestId, extra) {
  var message = {
    type: "error",
    protocolVersion: PROTOCOL_VERSION,
    code: code,
    messageKey: MESSAGE_KEYS[code] || MESSAGE_KEYS.INVALID_MESSAGE,
    retryable: code === "RATE_LIMITED"
  };
  if (requestId !== undefined) message.requestId = requestId;
  if (extra) {
    Object.keys(extra).forEach(function (key) {
      message[key] = extra[key];
    });
  }
  return message;
}

function makeMessage(type, fields) {
  var message = {
    type: type,
    protocolVersion: PROTOCOL_VERSION
  };
  if (fields) {
    Object.keys(fields).forEach(function (key) {
      message[key] = fields[key];
    });
  }
  return message;
}

function send(ws, message) {
  if (!ws || ws.readyState !== 1) return false;
  var payload = JSON.stringify(message);
  // Reserve the largest unmasked frame header as well as the UTF-8 payload.
  if (ws.bufferedAmount + byteLength(payload) + 10 > MAX_BUFFERED_BYTES) {
    // A close frame would also queue behind the stalled data.
    ws.terminate();
    return false;
  }
  ws.send(payload);
  return true;
}

module.exports = {
  PROTOCOL_VERSION: PROTOCOL_VERSION,
  MAX_MESSAGE_BYTES: MAX_MESSAGE_BYTES,
  MAX_BUFFERED_BYTES: MAX_BUFFERED_BYTES,
  MESSAGE_KEYS: MESSAGE_KEYS,
  byteLength: byteLength,
  parseMessage: parseMessage,
  isRequestId: isRequestId,
  isRoomCode: isRoomCode,
  moveCorrelation: moveCorrelation,
  makeError: makeError,
  makeMessage: makeMessage,
  send: send
};
