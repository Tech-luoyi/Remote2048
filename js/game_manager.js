/*
 * 单机页面适配器。
 *
 * GameLogic 持有唯一的玩法状态；这里仅把纯数据转换成旧版
 * Grid/Tile 视图对象，供 HTMLActuator 播放已有的滑动和合并动画。
 */
function GameManager(size, InputManager, Actuator, StorageManager) {
  this.size           = size;
  this.inputManager   = new InputManager;
  this.storageManager = new StorageManager;
  this.actuator       = new Actuator;
  // 联机模式下由 application.js 置为 false：输入交给 DuelController，
  // 单机棋盘既不推进也不再写 localStorage。
  this.active         = true;
  this.autoplay       = { active: false, remaining: 0, completed: 0, requestId: 0, worker: null, timer: null, timeout: null, stepStartedAt: 0 };

  this.inputManager.on("move", this.move.bind(this));
  this.inputManager.on("restart", this.restart.bind(this));
  this.inputManager.on("keepPlaying", this.keepPlaying.bind(this));
  this.inputManager.on("autoplay", this.toggleAutoplay.bind(this));

  this.setup();
}

GameManager.prototype.setActive = function (active) {
  this.active = active !== false;
  if (!this.active) this.stopAutoplay(true);
};

GameManager.prototype.restart = function () {
  if (this.active === false) return;
  this.stopAutoplay(true);
  this.autoplay.completed = 0;
  this.autoplay.remaining = 0;
  this.storageManager.clearGameState();
  this.keepPlayingMode = false;
  this.actuator.continueGame();
  this.setup();
};

GameManager.prototype.keepPlaying = function () {
  this.keepPlayingMode = true;
  this.actuator.continueGame();
  this.actuate();
};

GameManager.prototype.isGameTerminated = function () {
  return this.state.stuck || (this.state.won && !this.keepPlayingMode);
};

GameManager.prototype.setup = function () {
  var previousState = this.storageManager.getGameState();

  if (previousState) {
    this.state = this.restoreState(previousState);
    this.keepPlayingMode = !this.restoreUsedFallback &&
      !!(previousState && previousState.keepPlaying);
  } else {
    this.restoreUsedFallback = false;
    this.state = GameLogic.createInitialState(Date.now(), {
      size: this.size,
      startTiles: 2
    });
    this.keepPlayingMode = false;
  }

  this.syncGrid();
  this.actuate();
};

/*
 * 兼容旧版 localStorage。新状态放在 logicState；旧版本只有 grid/score
 * 时，将其一次性转换成 GameLogic 的数据结构。
 */
GameManager.prototype.restoreState = function (saved) {
  this.restoreUsedFallback = false;
  var createFreshState = function () {
    this.restoreUsedFallback = true;
    return GameLogic.createInitialState(Date.now(), {
      size: this.size,
      startTiles: 2
    });
  }.bind(this);

  if (!saved || typeof saved !== "object" || Array.isArray(saved)) {
    return createFreshState();
  }

  var source = (saved.logicState && typeof saved.logicState === "object")
    ? saved.logicState
    : ((saved.state && typeof saved.state === "object") ? saved.state : saved);
  var legacyGrid = source.grid || saved.grid;
  var size = this.size;
  var cellsSource = source.cells || (legacyGrid && legacyGrid.cells) || [];
  if (!Array.isArray(cellsSource) || cellsSource.length < size) {
    return createFreshState();
  }

  var seed = source.rngState !== undefined
    ? source.rngState
    : (saved.rngState === undefined ? Date.now() : saved.rngState);
  var state = GameLogic.createInitialState(seed, {
    size: size,
    startTiles: 0,
    targetTile: source.targetTile
  });

  for (var x = 0; x < state.size; x++) {
    if (!Array.isArray(cellsSource[x]) || cellsSource[x].length < size) {
      return createFreshState();
    }
    for (var y = 0; y < state.size; y++) {
      var tile = cellsSource[x] && cellsSource[x][y];
      // 旧版裸数字存档可能用 0 表示空格；新协议只接受 null。
      if (tile === null || tile === 0) {
        state.cells[x][y] = null;
        continue;
      }
      if (tile === undefined || tile === false || tile === "") {
        return createFreshState();
      }

      var value = typeof tile === "number" ? tile : Number(tile.value);
      if (!isFinite(value) || value <= 0 || Math.floor(value) !== value) {
        return createFreshState();
      }
      if (typeof tile === "object" && tile.interference !== undefined &&
          typeof tile.interference !== "boolean") {
        return createFreshState();
      }

      state.cells[x][y] = {
        position: { x: x, y: y },
        value: value,
        interference: typeof tile === "object" && tile.interference === true
      };
    }
  }

  state.version = GameLogic.VERSION;
  state.score = Number(source.score !== undefined ? source.score : saved.score);
  state.score = isFinite(state.score) && state.score >= 0
    ? Math.floor(state.score)
    : 0;
  state.won = source.won === true || saved.won === true;
  state.energy = Number(source.energy);
  state.energy = isFinite(state.energy)
    ? Math.max(0, Math.min(GameLogic.ENERGY_MAX, Math.floor(state.energy)))
    : 0;
  state.combo = Number(source.combo);
  state.combo = isFinite(state.combo) ? Math.max(0, Math.floor(state.combo)) : 0;
  state.moveSeq = Number(source.moveSeq);
  state.moveSeq = isFinite(state.moveSeq) ? Math.max(0, Math.floor(state.moveSeq)) : 0;
  var restoredRng = source.rngState === undefined
    ? (saved.rngState === undefined ? state.rngState : saved.rngState)
    : source.rngState;
  restoredRng = Number(restoredRng) >>> 0;
  // xorshift32 的 0 是死点；旧存档中的 0 必须恢复成有效种子。
  state.rngState = restoredRng || 0x9e3779b9;
  // `stuck` 根据棋盘重新计算。浏览器崩溃或旧版本存档中的标记可能过期，
  // 不能让本来还能玩的棋盘被错误锁死。
  if (!GameLogic.isValidState(state)) {
    return createFreshState();
  }
  state.stuck = !GameLogic.hasMoves(state);

  return state;
};

/* Convert the pure state into the view objects expected by HTMLActuator. */
GameManager.prototype.syncGrid = function (events) {
  this.grid = ViewState.buildGrid(this.state, events);
};

GameManager.prototype.move = function (direction, automatic) {
  if (this.active === false) return false;
  if (this.isGameTerminated() || (this.autoplay && this.autoplay.active && !automatic)) return false;

  var result = GameLogic.applyMove(this.state, direction);
  if (result.error || !result.moved) return false;

  this.state = result.state;
  if (automatic && this.state.won) this.keepPlayingMode = true;
  this.syncGrid(result.events);
  this.actuate();
  return true;
};

GameManager.prototype.updateAutoplay = function () {
  this.actuator.updateAutoplay(this.autoplay.active, this.autoplay.remaining,
    this.isGameTerminated(), this.autoplay.completed);
};

GameManager.prototype.stopAutoplay = function (release) {
  var auto = this.autoplay;
  auto.active = false;
  ++auto.requestId;
  window.clearTimeout(auto.timer);
  window.clearTimeout(auto.timeout);
  if (release) {
    if (auto.worker) auto.worker.terminate();
    auto.worker = null;
    auto.engine = null;
  }
  this.updateAutoplay();
};

GameManager.prototype.toggleAutoplay = function () {
  if (this.active === false) return;
  if (this.autoplay.active) { this.stopAutoplay(); return; }
  if (this.isGameTerminated()) return;
  var self = this;
  var auto = this.autoplay;
  auto.active = true;
  auto.remaining = 15;
  auto.completed = 0;
  auto.restartSearch = true;
  this.updateAutoplay();
  try {
    if (auto.worker) {
      auto.timer = window.setTimeout(function () { self.requestAutoplayMove(); }, 0);
      return;
    }
    var query = window.location ? window.location.search : "";
    var worker = new window.Worker("js/solver_worker.js" + query);
    auto.worker = worker;
    auto.engine = null;
    worker.onmessage = function (event) {
      if (auto.worker !== worker) return;
      if (event.data.ready) {
        auto.engine = event.data.engine;
        window.clearTimeout(auto.timeout);
        if (auto.active && auto.engine !== "ziap-wasm") {
          auto.timeout = window.setTimeout(function () { self.stopAutoplay(true); }, 2000);
        }
        return;
      }
      if (!auto.active || event.data.id !== auto.requestId) return;
      window.clearTimeout(auto.timeout);
      if (event.data.error) { self.stopAutoplay(true); return; }
      self.applyAutoplayMove(event.data.direction);
    };
    worker.onerror = function (event) {
      event.preventDefault();
      if (auto.worker !== worker) return;
      window.clearTimeout(auto.timeout);
      worker.terminate();
      auto.worker = null;
      auto.engine = null;
      if (auto.active) self.requestAutoplayMove();
    };
  } catch (error) {
    // Local file pages may block workers; the same solver has a short fallback budget.
    auto.worker = null;
  }
  auto.timer = window.setTimeout(function () { self.requestAutoplayMove(); }, 0);
};

GameManager.prototype.requestAutoplayMove = function () {
  var self = this;
  var auto = this.autoplay;
  if (!auto.active) return;
  if (this.isGameTerminated()) { this.stopAutoplay(); return; }
  auto.stepStartedAt = Date.now();
  if (auto.worker) {
    auto.worker.postMessage({ id: ++auto.requestId, state: GameLogic.serializeState(this.state),
      restart: auto.restartSearch });
    auto.restartSearch = false;
    if (auto.engine !== "ziap-wasm") {
      auto.timeout = window.setTimeout(function () { self.stopAutoplay(true); }, auto.engine ? 2000 : 10000);
    }
  } else {
    var choice = GameSolver.chooseMove(this.state, { timeBudgetMs: 20, maxNodes: 4000 });
    this.applyAutoplayMove(choice ? choice.direction : null);
  }
};

GameManager.prototype.applyAutoplayMove = function (direction) {
  var auto = this.autoplay;
  if (!auto.active) return;
  if (!GameLogic.isValidDirection(direction)) { this.stopAutoplay(true); return; }
  if (this.move(direction, true)) {
    auto.remaining--;
    auto.completed++;
  }
  if (!auto.remaining || this.isGameTerminated()) { this.stopAutoplay(); return; }
  this.updateAutoplay();
  var self = this;
  // Include search time in the cadence without reducing the solver's budget.
  var delay = Math.max(0, 350 / 2 - (Date.now() - auto.stepStartedAt));
  auto.timer = window.setTimeout(function () { self.requestAutoplayMove(); }, delay);
};

GameManager.prototype.actuate = function () {
  var score = this.state.score;
  var bestScore = Number(this.storageManager.getBestScore()) || 0;
  if (!isFinite(bestScore) || bestScore < 0) bestScore = 0;
  bestScore = Math.floor(bestScore);

  if (bestScore < score) {
    this.storageManager.setBestScore(score);
    bestScore = score;
  }

  if (this.state.stuck) {
    this.storageManager.clearGameState();
  } else {
    this.storageManager.setGameState(this.serialize());
  }

  this.actuator.actuate(this.grid, {
    score: score,
    over: this.state.stuck && (!this.state.won || this.keepPlayingMode),
    won: this.state.won,
    bestScore: bestScore,
    terminated: this.isGameTerminated(),
    // 连击数：特效层据此决定要不要点火（§9 每 3 次合并得 1 点能量）。
    // 只在有合并的那一步才传 undefined 之外的值——combo=0 意味着没连击，
    // 让特效层自己判断门限，别在这里做策略。
    combo: this.state.combo
  });
  this.updateAutoplay();
};

GameManager.prototype.serialize = function () {
  return {
    logicState: GameLogic.serializeState(this.state),
    // 保留旧字段，便于旧工具和已有 localStorage 读取。
    grid: this.grid.serialize(),
    score: this.state.score,
    over: this.state.stuck,
    won: this.state.won,
    keepPlaying: this.keepPlayingMode
  };
};
