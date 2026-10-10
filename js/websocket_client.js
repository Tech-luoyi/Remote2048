(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(root);
  else root.WebSocketClient = factory(root);
}(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  function WebSocketClient(options) {
    options = options || {};
    this.url = options.url || (root.location && root.location.host
      ? (root.location.protocol === "https:" ? "wss://" : "ws://") + root.location.host + "/ws" : null);
    this.WebSocket = options.WebSocket || root.WebSocket;
    this.listeners = new Set();
    this.onStatus = options.onStatus || function () {};
    this.socket = null;
    this.ready = false;
    this.stopped = true;
    this.retry = 0;
    this.timer = null;
    this.requestId = 0;
    this.sessionKey = "2048-duel-session";
    this.storage = null;
    this.session = null;
    try {
      this.storage = options.storage === undefined ? root.sessionStorage : options.storage;
      this.session = this.storage && JSON.parse(this.storage.getItem(this.sessionKey));
      if (this.session && (typeof this.session.roomCode !== "string" ||
          !/^[A-HJ-NP-Z2-9]{6}$/.test(this.session.roomCode) ||
          typeof this.session.reconnectToken !== "string" ||
          this.session.reconnectToken.length < 16 || this.session.reconnectToken.length > 256)) this.session = null;
    } catch (error) { this.session = null; }
  }

  WebSocketClient.prototype.subscribe = function (listener) {
    this.listeners.add(listener);
    var self = this;
    return function () { self.listeners.delete(listener); };
  };

  WebSocketClient.prototype.emit = function (message) {
    this.listeners.forEach(function (listener) { listener(message); });
  };

  WebSocketClient.prototype.status = function (value) {
    this.onStatus(value);
    this.emit({ type: "connection_status", status: value });
  };

  WebSocketClient.prototype.clearSession = function () {
    this.session = null;
    try { if (this.storage) this.storage.removeItem(this.sessionKey); } catch (error) {}
  };

  WebSocketClient.prototype.connect = function () {
    if (!this.url || !this.WebSocket) { this.status("unavailable"); return; }
    if (this.socket && this.socket.readyState < 2) return;
    this.stopped = false;
    clearTimeout(this.timer);
    this.ready = false;
    this.status(this.retry ? "reconnecting" : "connecting");
    var self = this;
    var socket;
    try { socket = new this.WebSocket(this.url); }
    catch (error) { this.reconnect(); return; }
    this.socket = socket;
    socket.addEventListener("open", function () {
      if (socket !== self.socket || self.stopped) return;
      socket.send(JSON.stringify({ type: "hello", protocolVersion: 1,
        ...(self.session ? { reconnectToken: self.session.reconnectToken } : {}) }));
    });
    socket.addEventListener("message", function (event) {
      if (socket !== self.socket || self.stopped) return;
      var message;
      try { message = JSON.parse(event.data); } catch (error) { return; }
      if (!message || message.protocolVersion !== 1 || typeof message.type !== "string") return;
      if (message.type === "hello") {
        self.ready = true;
        self.retry = 0;
        self.status("connected");
      } else if (message.type === "assigned") {
        self.session = { roomCode: message.roomCode, reconnectToken: message.reconnectToken };
        try { if (self.storage) self.storage.setItem(self.sessionKey, JSON.stringify(self.session)); } catch (error) {}
      } else if (message.type === "left_room" ||
          (message.type === "error" && message.code === "RECONNECT_EXPIRED")) self.clearSession();
      self.emit(message);
      if (message.type === "error" && message.code === "PLAYER_CONNECTED" && self.session) socket.close();
    });
    socket.addEventListener("error", function () {});
    socket.addEventListener("close", function () {
      if (socket !== self.socket) return;
      self.ready = false;
      self.status("disconnected");
      if (!self.stopped) self.reconnect();
    });
  };

  WebSocketClient.prototype.reconnect = function () {
    if (this.stopped) return;
    var self = this;
    this.status("reconnecting");
    this.timer = setTimeout(function () { self.connect(); }, Math.min(5000, 250 * Math.pow(2, this.retry++)));
  };

  WebSocketClient.prototype.send = function (type, fields) {
    if (!this.ready || !this.socket || this.socket.readyState !== 1) return false;
    var message = Object.assign({}, fields, { type: type, protocolVersion: 1 });
    if (type !== "move" && message.requestId === undefined) message.requestId = "req-" + (++this.requestId);
    try { this.socket.send(JSON.stringify(message)); return true; }
    catch (error) { return false; }
  };

  WebSocketClient.prototype.close = function () {
    this.stopped = true;
    this.ready = false;
    clearTimeout(this.timer);
    if (this.socket) this.socket.close();
  };

  return WebSocketClient;
}));
