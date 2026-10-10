"use strict";

var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var vm = require("node:vm");
var GameLogic = require("../js/game_logic");
var GameSolver = require("../js/game_solver");

var passed = 0;
function check(name, fn) { fn(); passed++; console.log("通过：" + name); }
function board(rows, target) {
  var state = GameLogic.createInitialState(123, { startTiles: 0, targetTile: target || 2048 });
  rows.forEach(function (row, y) {
    row.forEach(function (value, x) {
      if (value) state.cells[x][y] = { position: { x: x, y: y }, value: value, interference: false };
    });
  });
  state.stuck = !GameLogic.hasMoves(state);
  return state;
}

check("搜索用滑动与真实移动遵循同一套合并规则，但不生成方块或消耗随机数", function () {
  var state = board([[2, 2, 4, 4], [8, 0, 8, 0], [0, 2, 0, 4], [0, 0, 0, 0]]);
  state.combo = 2;
  for (var direction = 0; direction < 4; direction++) {
    var slide = GameLogic.slideMove(state, direction), actual = GameLogic.applyMove(state, direction);
    assert.equal(slide.moved, actual.moved);
    assert.equal(slide.state.rngState, state.rngState);
    assert.equal(slide.events.spawn, null);
    var realCells = JSON.parse(JSON.stringify(actual.state.cells));
    if (actual.events.spawn) realCells[actual.events.spawn.position.x][actual.events.spawn.position.y] = null;
    assert.deepEqual(slide.state.cells, realCells);
    assert.equal(slide.state.score, actual.state.score);
    assert.equal(slide.state.combo, actual.state.combo);
    assert.equal(slide.state.energy, actual.state.energy);
    assert.deepEqual(slide.events.merges, actual.events.merges);
  }
});

check("求解器不修改棋盘，且只依据可见局面、不窥探随机种子", function () {
  var state = board([[8, 4, 2, 0], [4, 4, 2, 0], [2, 2, 0, 0], [0, 0, 0, 0]]);
  var before = JSON.stringify(state);
  var options = { timeBudgetMs: 1000, maxNodes: 10000, maxDepth: 2 };
  var a = GameSolver.chooseMove(state, options);
  assert.equal(JSON.stringify(state), before);
  var sameBoard = GameLogic.serializeState(state);
  sameBoard.rngState = 987654321;
  var b = GameSolver.chooseMove(sameBoard, options);
  assert.deepEqual(a, b);
  assert.ok(GameLogic.applyMove(state, a.direction).moved);
  assert.ok(a.depth > 0);
});

check("优先选择可直接达到目标的方向，继续挑战时仍能搜索", function () {
  var state = board([[1024, 1024, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
  var choice = GameSolver.chooseMove(state);
  var result = GameLogic.applyMove(state, choice.direction);
  assert.equal(result.won, true);
  assert.ok(GameLogic.applyMove(result.state, GameSolver.chooseMove(result.state).direction).moved);
});

check("无路可走和非法状态不返回方向，预算耗尽也只返回合法移动", function () {
  var full = board([[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]]);
  assert.equal(GameSolver.chooseMove(full), null);
  assert.equal(GameSolver.chooseMove(null), null);
  var state = board([[2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
  var choice = GameSolver.chooseMove(state, { timeBudgetMs: 0, maxNodes: 0 });
  assert.equal(choice.depth, 0);
  assert.ok(GameLogic.applyMove(state, choice.direction).moved);
});

/*
 * 下面两条是搜索实现的回归护栏。搜索为了提速改成了 rank 空间的扁平棋盘，
 * 并且不再把转置表命中计入节点预算，这两件事都可能悄悄改变棋力，所以要钉住。
 */

/* 决策冻结：固定搜索深度（而不是固定节点预算）下方向必须与优化前一致。 */
var fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, "fixtures/solver-decisions.json"), "utf8"));

function fromFixture(cells) {
  var state = GameLogic.createInitialState(7, { startTiles: 0 });
  cells.forEach(function (column, x) {
    column.forEach(function (value, y) {
      state.cells[x][y] = value
        ? { position: { x: x, y: y }, value: value, interference: false }
        : null;
    });
  });
  state.stuck = !GameLogic.hasMoves(state);
  return state;
}

check("固定搜索深度下，决策与优化前的实现逐条一致", function () {
  var plans = { d2: 2, d3: 3, d4: 4 };
  var checked = 0;
  Object.keys(plans).forEach(function (key) {
    var options = { timeBudgetMs: 600000, maxNodes: 1e9, maxDepth: plans[key] };
    fixture.depths[key].forEach(function (entry) {
      var state = fromFixture(fixture.cells[entry.index]);
      var choice = GameSolver.chooseMove(GameLogic.serializeState(state), options);
      assert.equal(choice.direction, entry.direction,
        key + " 第 " + entry.index + " 个局面方向变了");
      assert.equal(choice.depth, entry.depth,
        key + " 第 " + entry.index + " 个局面搜索深度变了");
      checked++;
    });
  });
  assert.ok(checked >= 300, "冻结的决策样本太少");
});

check("转置表命中不消耗节点预算，深度 4 能在预算内跑完", function () {
  var state = board([[2, 4, 8, 0], [16, 32, 64, 0], [128, 256, 0, 2], [0, 4, 0, 0]]);
  var choice = GameSolver.chooseMove(GameLogic.serializeState(state),
    { timeBudgetMs: 600000, maxNodes: 500000, maxDepth: 4 });
  assert.equal(choice.depth, 4);
  // 若把缓存命中也计入 maxNodes，同样的搜索要消耗约 550 万次计数。
  assert.ok(choice.nodes < 500000, "展开数 " + choice.nodes + " 仍然过多");
  assert.ok(GameLogic.applyMove(state, choice.direction).moved);
});

check("任意合法棋盘尺寸都能搜索，且不修改入参", function () {
  [2, 3, 4, 5].forEach(function (size) {
    var state = GameLogic.createInitialState(size + 1, { size: size, startTiles: 0 });
    var value = 2;
    for (var x = 0; x < size; x++) {
      for (var y = 0; y < size; y++) {
        if ((x + y) % 2 === 0) continue;
        state.cells[x][y] = { position: { x: x, y: y }, value: value, interference: false };
        value *= 2;
      }
    }
    state.stuck = !GameLogic.hasMoves(state);
    if (state.stuck) return;
    var before = JSON.stringify(state);
    var choice = GameSolver.chooseMove(GameLogic.serializeState(state),
      { timeBudgetMs: 200, maxNodes: 200000, maxDepth: 3 });
    assert.ok(choice.direction !== null, "尺寸 " + size + " 必须给出方向");
    assert.ok(GameLogic.applyMove(state, choice.direction).moved,
      "尺寸 " + size + " 给出了非法移动");
    assert.equal(JSON.stringify(state), before, "尺寸 " + size + " 入参被修改");
  });
});

function controller(state, options) {
  options = options || {};
  var now = 0, nextTimer = 0, timers = new Map(), workers = [], renders = [];
  function schedule(fn, delay) { timers.set(++nextTimer, { fn: fn, at: now + delay }); return nextTimer; }
  function next() {
    if (!timers.size) return false;
    var entry = Array.from(timers).sort(function (a, b) { return a[1].at - b[1].at; })[0];
    timers.delete(entry[0]); now = entry[1].at; entry[1].fn(); return true;
  }
  function drain() {
    for (var count = 0; count < 200 && next(); count++) {}
    assert.equal(timers.size, 0, "自动走必须停止，不得留下无限循环");
  }
  function Input() {}
  Input.prototype.on = function () {};
  function Actuator() {}
  Actuator.prototype.actuate = function (grid, metadata) { renders.push(metadata.score); };
  Actuator.prototype.continueGame = function () {};
  Actuator.prototype.updateAutoplay = function (active, remaining, terminated, completed) {
    this.auto = { active: active, remaining: remaining, terminated: terminated, completed: completed };
  };
  function Storage() { this.saved = { logicState: state, keepPlaying: !!options.keepPlaying }; this.best = 0; }
  Storage.prototype.getGameState = function () { return this.saved; };
  Storage.prototype.setGameState = function (saved) { this.saved = saved; };
  Storage.prototype.clearGameState = function () { this.saved = null; };
  Storage.prototype.getBestScore = function () { return this.best; };
  Storage.prototype.setBestScore = function (score) { this.best = score; };
  function Worker() { this.requests = []; this.terminated = false; workers.push(this); }
  Worker.prototype.terminate = function () { this.terminated = true; };
  Worker.prototype.postMessage = function (request) {
    this.requests.push(request);
    var worker = this;
    if (options.hang) return;
    schedule(function () {
      if (options.workerError) { worker.onerror({ preventDefault: function () {} }); return; }
      var choice = GameSolver.chooseMove(request.state, { timeBudgetMs: 0, maxNodes: 0 });
      // Deliberately deliver after termination to test the stale-result guard.
      worker.onmessage({ data: { id: request.id, direction: choice ? choice.direction : null } });
    }, 10);
  };
  var context = vm.createContext({ GameLogic: GameLogic, GameSolver: GameSolver,
    Date: { now: function () { return now; } },
    window: { setTimeout: schedule, clearTimeout: function (id) { timers.delete(id); }, Worker: options.fallback ? undefined : Worker }
  });
  ["grid", "tile", "view_state", "game_manager"].forEach(function (file) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/" + file + ".js"), "utf8"), context);
  });
  return { game: new context.GameManager(4, Input, Actuator, Storage), workers: workers, renders: renders, next: next, drain: drain,
    elapsed: function () { return now; } };
}

check("道具每次读取新棋盘，恰好执行15次有效移动后恢复手动输入", function () {
  var c = controller(GameLogic.createInitialState(123)), game = c.game;
  game.toggleAutoplay();
  assert.equal(game.move(3), false);
  c.drain();
  assert.equal(game.autoplay.active, false);
  assert.equal(game.autoplay.completed, 15);
  assert.equal(c.renders.length, 16);
  assert.equal(c.workers[0].requests.length, 15);
  assert.equal(c.workers[0].terminated, false);
  assert.ok(Math.abs(c.elapsed() - (14 * 350 / 2 + 10)) < 1,
    "15次移动遵循两倍速节奏，搜索耗时计入每步间隔");
  assert.notDeepEqual(c.workers[0].requests[0].state, c.workers[0].requests[1].state);
  var direction = GameSolver.chooseMove(game.state).direction;
  assert.equal(game.move(direction), true);
});

check("中途停止取消待执行步骤，迟到结果不能改写棋盘", function () {
  var c = controller(GameLogic.createInitialState(123)), game = c.game;
  game.toggleAutoplay(); c.next();
  var before = JSON.stringify(game.state);
  game.toggleAutoplay(); c.drain();
  assert.equal(JSON.stringify(game.state), before);
  assert.equal(game.autoplay.active, false);
  assert.equal(game.autoplay.completed, 0);
  assert.equal(c.workers[0].terminated, false);
});

check("重启清掉旧道具请求与进度，新棋盘不会被旧回复影响", function () {
  var c = controller(GameLogic.createInitialState(123)), game = c.game;
  game.toggleAutoplay(); c.next(); game.restart();
  var fresh = JSON.stringify(game.state);
  c.drain();
  assert.equal(JSON.stringify(game.state), fresh);
  assert.equal(game.state.score, 0);
  assert.equal(game.autoplay.completed, 0);
  assert.equal(c.workers[0].terminated, true);
});

check("自动走合成目标后继续完成15步，无路可走不能启动", function () {
  var c = controller(board([[1024, 1024, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]));
  c.game.toggleAutoplay(); c.drain();
  assert.equal(c.game.state.won, true);
  assert.equal(c.game.autoplay.completed, 15);
  assert.equal(c.game.keepPlayingMode, true);
  assert.equal(c.game.actuator.auto.terminated, false);
  var stuck = controller(board([[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]]));
  stuck.game.toggleAutoplay();
  assert.equal(stuck.game.autoplay.active, false);
  assert.equal(stuck.workers.length, 0);
});

check("连续使用道具复用Worker，每批只重置一次搜索深度", function () {
  var c = controller(GameLogic.createInitialState(123));
  c.game.toggleAutoplay(); c.drain();
  c.game.toggleAutoplay(); c.drain();
  assert.equal(c.workers.length, 1);
  assert.equal(c.workers[0].requests.length, 30);
  c.workers[0].requests.forEach(function (request, i) {
    assert.equal(request.restart, i === 0 || i === 15);
  });
  c.game.setActive(false);
  assert.equal(c.workers[0].terminated, true);
});

check("停止后立即再次启动，旧回复不能算入新批次", function () {
  var c = controller(GameLogic.createInitialState(123));
  c.game.toggleAutoplay(); c.next();
  c.game.toggleAutoplay(); c.game.toggleAutoplay(); c.drain();
  assert.equal(c.workers.length, 1);
  assert.equal(c.workers[0].requests.length, 16);
  assert.equal(c.game.autoplay.completed, 15);
  assert.equal(c.renders.length, 16);
});

check("已就绪的原版WASM搜索不受两秒超时限制，仍能停止与重启", function () {
  var c = controller(GameLogic.createInitialState(123), { hang: true });
  c.game.toggleAutoplay(); c.next();
  c.workers[0].onmessage({ data: { ready: true, engine: "ziap-wasm", threads: 4 } });
  c.drain();
  assert.equal(c.game.autoplay.active, true);
  c.game.toggleAutoplay();
  assert.equal(c.game.autoplay.active, false);
  assert.equal(c.workers[0].terminated, false);
  c.game.restart();
  assert.equal(c.workers[0].terminated, true);
});

check("离线Worker不可用或加载失败时，受限搜索仍能完成15步", function () {
  [{ fallback: true }, { workerError: true }].forEach(function (options) {
    var c = controller(GameLogic.createInitialState(123), options);
    c.game.toggleAutoplay(); c.drain();
    assert.equal(c.game.autoplay.completed, 15);
    assert.equal(c.game.autoplay.active, false);
  });
});

check("Worker迟迟不返回时取消道具，不影响原棋盘或下一次启动", function () {
  var c = controller(GameLogic.createInitialState(123), { hang: true });
  var before = JSON.stringify(c.game.state);
  c.game.toggleAutoplay(); c.drain();
  assert.equal(c.game.autoplay.active, false);
  assert.equal(JSON.stringify(c.game.state), before);
  c.game.toggleAutoplay(); assert.equal(c.game.autoplay.active, true); c.drain();
});

console.log("求解器与自动走检查全部通过：" + passed);
