(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./game_logic"));
  else root.MultiplayerManager = factory(root.GameLogic);
}(typeof globalThis !== "undefined" ? globalThis : this, function (GameLogic) {
  "use strict";

  var MAX_PENDING = 8;

  function MultiplayerManager(client, options) {
    options = options || {};
    this.client = client;
    this.now = options.now || Date.now;
    this.onChange = options.onChange || function () {};
    this.onError = options.onError || function () {};
    this.playerId = null;
    this.roomCode = null;
    this.matchId = null;
    this.phase = "waiting";
    this.connectionStatus = "disconnected";
    this.state = null;
    this.confirmed = null;
    this.opponent = null;
    this.opponentVersion = 0;
    this.stateVersion = 0;
    this.confirmedSeq = 0;
    this.seq = 0;
    this.pending = [];
    this.offset = 0;
    this.startsAt = 0;
    this.deadlineAt = 0;
    this.synchronizing = false;
    this.result = null;
    this.ackTimer = null;
    this.ackTimerSeq = null;
    // 最近一次干扰：from = "me" | "opponent"，at 为服务器时钟毫秒。
    // 面板用它做一次性提示，不参与状态判定。
    this.lastSkill = null;
    // §9 能量与冷却由服务端裁定，这里只做乐观显示的镜像。
    this.energy = 0;
    this.opponentEnergy = 0;
    this.cooldownUntil = 0;
    this.setTimeout = options.setTimeout || function (callback, delay) { return setTimeout(callback, delay); };
    this.clearTimeout = options.clearTimeout || function (id) { clearTimeout(id); };
    var self = this;
    this.unsubscribe = client.subscribe(function (message) { self.receive(message); });
  }

  MultiplayerManager.prototype.notify = function (events, opponentEvents) {
    this.watchPending();
    this.onChange({
      phase: this.phase, connectionStatus: this.connectionStatus,
      playerId: this.playerId, roomCode: this.roomCode, matchId: this.matchId,
      state: GameLogic.serializeState(this.state), opponent: GameLogic.serializeState(this.opponent),
      events: events || null, opponentEvents: opponentEvents || null,
      startsAt: this.startsAt, deadlineAt: this.deadlineAt, serverOffset: this.offset,
      synchronizing: this.synchronizing, pending: this.pending.length, result: this.result
    });
  };

  MultiplayerManager.prototype.watchPending = function () {
    var seq = this.pending.length && !this.synchronizing ? this.pending[0].seq : null;
    if (seq === this.ackTimerSeq) return;
    this.clearTimeout(this.ackTimer);
    this.ackTimerSeq = seq;
    this.ackTimer = null;
    if (seq === null) return;
    var self = this;
    // A flood may suppress error replies; don't leave such predictions pending.
    this.ackTimer = this.setTimeout(function () { self.requestSync(); }, 2000);
    if (this.ackTimer && this.ackTimer.unref) this.ackTimer.unref();
  };

  MultiplayerManager.prototype.replay = function () {
    this.state = GameLogic.serializeState(this.confirmed);
    this.pending.forEach(function (input, index) {
      this.state = GameLogic.serializeState(GameLogic.applyMove(this.state, input.direction).state);
      this.state.moveSeq = input.seq;
      input.hash = GameLogic.hashState(this.state);
      input.rngState = this.state.rngState;
      input.version = this.stateVersion + index + 1;
    }, this);
  };

  MultiplayerManager.prototype.requestSync = function () {
    this.pending = [];
    this.state = GameLogic.serializeState(this.confirmed);
    this.synchronizing = true;
    this.client.send("resync");
    this.notify();
  };

  MultiplayerManager.prototype.move = function (direction) {
    var serverNow = this.now() + this.offset;
    if (!this.state || this.synchronizing || this.state.stuck || this.state.won ||
        ![0, 1, 2, 3].includes(direction) ||
        (this.phase !== "playing" && this.phase !== "countdown") ||
        serverNow < this.startsAt || serverNow >= this.deadlineAt) return false;
    if (this.pending.length >= MAX_PENDING) { this.requestSync(); return false; }
    var seq = ++this.seq;
    var result = GameLogic.applyMove(this.state, direction);
    if (!this.client.send("move", {
      matchId: this.matchId, seq: seq, direction: direction,
      baseVersion: this.stateVersion + this.pending.length
    })) return false;
    this.state = GameLogic.serializeState(result.state);
    this.state.moveSeq = seq;
    this.pending.push({ seq: seq, direction: direction, hash: GameLogic.hashState(this.state), rngState: this.state.rngState,
      version: this.stateVersion + this.pending.length + 1 });
    this.notify(result.events);
    return true;
  };

  MultiplayerManager.prototype.adopt = function (message) {
    var state = GameLogic.serializeState(message.state);
    if (!state || !Number.isSafeInteger(message.stateVersion) || message.stateVersion < 0) {
      this.requestSync(); return;
    }
    if (message.matchId !== this.matchId) this.seq = 0;
    this.matchId = message.matchId;
    this.confirmed = state;
    this.state = GameLogic.serializeState(state);
    this.stateVersion = message.stateVersion;
    this.confirmedSeq = message.lastAcceptedSeq;
    this.seq = Math.max(this.seq, message.lastAcceptedSeq);
    this.pending = [];
    this.syncEnergy(state);
    if (Number.isFinite(message.cooldownUntil)) this.cooldownUntil = message.cooldownUntil;
    this.phase = message.phase;
    this.startsAt = message.startsAt;
    this.deadlineAt = message.deadlineAt;
    this.result = message.result || null;
    this.synchronizing = false;
    if (message.opponent) {
      this.opponent = GameLogic.serializeState(message.opponent.state);
      this.opponentVersion = message.opponent.stateVersion;
      if (Number.isSafeInteger(this.opponent.energy)) {
        this.opponentEnergy = this.opponent.energy;
      }
    }
    this.notify();
  };

  /*
   * §9 干扰是跨棋盘写入，会破坏预测的前提，所以两条路径都必须硬同步：
   *
   *   target 是自己  -> 自己的棋盘被服务端改动，作废全部推测状态后重放；
   *   target 是对手  -> 对手棋盘本来就不预测，采纳快照并刷新能量与冷却。
   *
   * 两种情况都只信任服务端的 state 和 rngState。
   */
  MultiplayerManager.prototype.applySkillResult = function (message) {
    var state = GameLogic.serializeState(message.state);
    if (!state) { this.requestSync(); return; }
    if (Number.isFinite(message.cooldownUntil)) this.cooldownUntil = message.cooldownUntil;
    // energy 住在 state 里，是唯一来源；报文不再重复携带，避免两处不一致。
    this.syncEnergy(state);

    // 两端都必须采纳权威 state：被干扰方的棋盘变了，释放方的能量变了，
    // 而 energy 参与 hashState，不刷新就会与下一次 move_ack 对不上。
    var mine = message.target === this.playerId;
    if (message.stateVersion > this.stateVersion) {
      this.confirmed = state;
      this.state = GameLogic.serializeState(state);
      this.stateVersion = message.stateVersion;
      this.confirmedSeq = message.lastAcceptedSeq;
      this.seq = Math.max(this.seq, message.lastAcceptedSeq);
      // 干扰块占掉了原本属于随机生成的空位，未确认输入必须基于新棋盘重放。
      this.pending = this.pending.filter(function (item) {
        return item.seq > message.lastAcceptedSeq;
      });
      this.replay();
    }
    if (mine) this.lastSkill = { from: "opponent", at: this.now() + this.offset };
    else this.lastSkill = { from: "me", at: this.now() + this.offset };

    if (message.opponent) {
      this.opponent = GameLogic.serializeState(message.opponent.state);
      this.opponentVersion = message.opponent.stateVersion;
      if (Number.isSafeInteger(this.opponent.energy)) {
        this.opponentEnergy = this.opponent.energy;
      }
    }
    this.notify();
  };

  /*
   * 只有能量足够、冷却结束且对局进行中才允许请求。真正的判定在服务端，
   * 这里只是提前给出反馈，避免明知会被拒绝还发包。
   */
  MultiplayerManager.prototype.useSkill = function () {
    var serverNow = this.now() + this.offset;
    if (!this.state || this.synchronizing || this.phase !== "playing") return false;
    if (serverNow < this.startsAt || serverNow >= this.deadlineAt) return false;
    if (this.energy < 1) return false;
    if (this.cooldownUntil && serverNow < this.cooldownUntil) return false;
    return this.client.send("use_skill", {
      matchId: this.matchId, skill: "interference"
    });
  };

  MultiplayerManager.prototype.skillReadyIn = function () {
    var serverNow = this.now() + this.offset;
    if (!this.cooldownUntil) return 0;
    return Math.max(0, this.cooldownUntil - serverNow);
  };

  // 能量住在权威 state 里，任何采纳快照的路径都要同步它。
  MultiplayerManager.prototype.syncEnergy = function (state) {
    if (state && Number.isSafeInteger(state.energy)) this.energy = state.energy;
  };

  MultiplayerManager.prototype.receive = function (message) {
    if (message.type === "connection_status") {
      this.connectionStatus = message.status;
      if (message.status !== "connected" && this.matchId) {
        this.pending = [];
        this.state = GameLogic.serializeState(this.confirmed);
        this.synchronizing = true;
      }
      this.notify(); return;
    }
    if (message.type === "assigned") {
      this.playerId = message.playerId;
      this.roomCode = message.roomCode;
      this.notify(); return;
    }
    if (message.type === "left_room" || (message.type === "error" && message.code === "RECONNECT_EXPIRED")) {
      this.roomCode = this.playerId = this.matchId = this.state = this.confirmed = this.opponent = null;
      this.pending = [];
      this.phase = "waiting";
      this.synchronizing = false;
      this.result = null;
      if (message.type === "error") this.onError(message);
      this.notify(); return;
    }
    if (message.matchId && this.matchId && message.matchId !== this.matchId && message.type !== "match_start") return;
    if (Number.isFinite(message.serverNow)) this.offset = message.serverNow - this.now();
    if (message.type === "match_start" || message.type === "resync") {
      this.adopt(message);
    } else if (message.type === "room_state") {
      this.phase = message.phase;
      this.notify();
    } else if (message.type === "clock") {
      if (this.synchronizing && this.phase !== "finished") this.client.send("resync");
      this.notify();
    } else if (message.type === "move_ack") {
      if (this.synchronizing || message.seq <= this.confirmedSeq || message.stateVersion <= this.stateVersion) return;
      var state = GameLogic.serializeState(message.state);
      if (!state || GameLogic.hashState(state) !== message.stateHash) { this.requestSync(); return; }
      var input = this.pending.find(function (item) { return item.seq === message.seq; });
      var matches = input && input.hash === message.stateHash && input.version === message.stateVersion &&
        input.rngState === state.rngState;
      this.confirmed = state;
      this.confirmedSeq = message.seq;
      this.seq = Math.max(this.seq, message.seq);
      this.stateVersion = message.stateVersion;
      // 能量随合并增长，只能从权威快照读；漏掉这一步技能按钮会一直禁用。
      this.syncEnergy(state);
      this.pending = this.pending.filter(function (item) { return item.seq > message.seq; });
      if (!matches) this.replay();
      this.notify();
    } else if (message.type === "opponent_update") {
      if (message.playerId === this.playerId || message.stateVersion <= this.opponentVersion) return;
      this.opponent = GameLogic.serializeState(message.state);
      this.opponentVersion = message.stateVersion;
      if (Number.isSafeInteger(this.opponent.energy)) this.opponentEnergy = this.opponent.energy;
      this.notify(null, message.events);
    } else if (message.type === "skill_result") {
      this.applySkillResult(message);
    } else if (message.type === "error") {
      if (Number.isSafeInteger(message.seq) && this.pending.some(function (item) { return item.seq === message.seq; })) {
        this.pending = this.pending.filter(function (item) { return item.seq !== message.seq; });
        this.replay();
        this.notify();
      }
      this.onError(message);
    } else if (message.type === "match_end") {
      var own = message.states[this.playerId];
      var other = message.states[this.playerId === "p1" ? "p2" : "p1"];
      this.confirmed = GameLogic.serializeState(own.state);
      this.state = GameLogic.serializeState(own.state);
      this.opponent = GameLogic.serializeState(other.state);
      this.stateVersion = own.stateVersion;
      this.confirmedSeq = own.lastAcceptedSeq;
      this.pending = [];
      this.phase = "finished";
      this.synchronizing = false;
      this.result = message;
      this.notify();
    }
  };

  MultiplayerManager.prototype.destroy = function () {
    this.clearTimeout(this.ackTimer);
    this.unsubscribe();
  };
  MultiplayerManager.MAX_PENDING = MAX_PENDING;
  return MultiplayerManager;
}));
