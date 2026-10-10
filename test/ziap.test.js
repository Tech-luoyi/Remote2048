"use strict";

var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var crypto = require("node:crypto");
var NodeWorker = require("node:worker_threads").Worker;
var url = require("node:url");
var GameLogic = require("../js/game_logic");
var ZiapSolver = require("../js/ziap_solver");
var vendor = path.join(__dirname, "../js/vendor/ziap");
var bytes = fs.readFileSync(path.join(vendor, "main.wasm"));
var wasmModule = new WebAssembly.Module(bytes);

function instance() {
  var memory = new WebAssembly.Memory({ initial: 1024, maximum: 1024, shared: true });
  return new WebAssembly.Instance(wasmModule, { env: { memory: memory } });
}
function board(rows) {
  var state = GameLogic.createInitialState(123, { startTiles: 0 });
  rows.forEach(function (row, y) {
    row.forEach(function (value, x) {
      if (value) state.cells[x][y] = { position: { x: x, y: y }, value: value, interference: false };
    });
  });
  state.stuck = !GameLogic.hasMoves(state);
  return state;
}
var passed = 0;
async function check(name, fn) { await fn(); passed++; console.log("通过：" + name); }

// Run the unmodified browser worker scripts with Node's real worker threads.
var workers = [];
function WebWorker(workerUrl) {
  this.url = String(workerUrl);
  this.terminated = false;
  var boot = "const {parentPort,workerData}=require('node:worker_threads');" +
    "globalThis.postMessage=data=>parentPort.postMessage(data);" +
    "globalThis.addEventListener=(type,fn,options)=>{" +
    "if(type==='message')parentPort[options&&options.once?'once':'on']('message',data=>fn({data}));};" +
    "require(workerData);";
  this.worker = new NodeWorker(boot, { eval: true, workerData: url.fileURLToPath(workerUrl) });
  var self = this;
  this.worker.on("message", function (data) {
    if (self.onmessage) self.onmessage({ data: data });
  });
  this.worker.on("error", function (error) {
    if (self.onerror) self.onerror({ message: error.message, preventDefault: function () {} });
  });
  workers.push(this);
}
WebWorker.prototype.postMessage = function (data) { this.worker.postMessage(data); };
WebWorker.prototype.terminate = function () {
  this.terminated = true;
  if (!this.termination) this.termination = this.worker.terminate();
  return this.termination;
};

async function main() {
  await check("WASM 构建产物与固定上游版本的 SHA-256 一致", function () {
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"),
      "0fadf8c46e94c75212ea510d0ab2dd4d17ce85b3814c1e546841442208bd7651");
  });

  await check("棋盘与上游编码一致，包括高数值的 rank 15 饱和行为", function () {
    var state = board([[2, 4, 8, 16], [32, 64, 128, 256], [512, 1024, 2048, 4096], [8192, 16384, 32768, 65536]]);
    var before = JSON.stringify(state);
    assert.equal(ZiapSolver.encodeBoard(state), 0x123456789abcdeffn);
    assert.equal(JSON.stringify(state), before);
    state.rngState = 987654321;
    assert.equal(ZiapSolver.encodeBoard(state), 0x123456789abcdeffn);
    var irregular = board([[3, 3, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
    assert.equal(ZiapSolver.encodeBoard(irregular), 0xff00000000000000n);
    state.cells[0][0].interference = true;
    assert.equal(ZiapSolver.encodeBoard(state), null);
    assert.equal(ZiapSolver.encodeBoard(GameLogic.createInitialState(5, { size: 3 })), null);
    assert.equal(ZiapSolver.encodeBoard(null), null);
  });

  await check("保留原始方向，不用合成目标的方向覆盖搜索结果", function () {
    var resets = 0, searches = 0;
    var ai = ZiapSolver.create({ exports: {
      init: function () {}, reset_depth: function () { resets++; },
      search: function () { searches++; return 2; }
    } });
    var winning = board([[1024, 1024, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
    assert.equal(ai.chooseMove(winning, true).direction, 2);
    assert.equal(ai.chooseMove(winning, false).rawDirection, 2);
    assert.equal(resets, 1);
    assert.equal(searches, 2);
  });

  await check("原版 -1 返回值按每次回复的计数轮换方向", function () {
    var replies = [2, -1, -1, -1, -1];
    var ai = ZiapSolver.create({ exports: {
      init: function () {}, search: function () { return replies.shift(); }
    } });
    var state = GameLogic.createInitialState(123);
    assert.deepEqual(Array.from({ length: 5 }, function () { return ai.chooseMove(state).direction; }),
      [2, 2, 3, 0, 1]);
  });

  await check("原版搜索运行异常不会悄悄混入另一套算法", function () {
    var ai = ZiapSolver.create({ exports: {
      init: function () {}, search: function () { throw new Error("trap"); }
    } });
    assert.throws(function () { ai.chooseMove(GameLogic.createInitialState(123)); }, /trap/);
  });

  await check("真实 WASM 的四个方向与 GameLogic 完全对应", function () {
    var ai = ZiapSolver.create(instance());
    var cases = [
      [[0, 0, 0, 0], [2, 4, 8, 16], [32, 64, 128, 256], [512, 1024, 2, 4]],
      [[2, 4, 8, 0], [16, 32, 64, 0], [128, 256, 512, 0], [1024, 2, 4, 0]],
      [[2, 4, 8, 16], [32, 64, 128, 256], [512, 1024, 2, 4], [0, 0, 0, 0]],
      [[0, 2, 4, 8], [0, 16, 32, 64], [0, 128, 256, 512], [0, 1024, 2, 4]]
    ];
    cases.forEach(function (rows, direction) {
      var state = board(rows);
      assert.equal(ai.chooseMove(state, true).rawDirection, direction);
      assert.ok(GameLogic.applyMove(state, direction).moved);
    });
  });

  var originalWorker = global.Worker, originalFetch = global.fetch;
  global.Worker = WebWorker;
  global.fetch = async function () {
    return { ok: true, arrayBuffer: async function () { return bytes; } };
  };
  var workerBaseUrl = url.pathToFileURL(vendor + "/js/");
  try {
    await check("官方单线程 Worker 与原始 WASM 的45步方向逐次一致", async function () {
      var ai = await ZiapSolver.load("main.wasm", { threads: 1, workerBaseUrl: workerBaseUrl });
      try {
        var raw = instance().exports;
        raw.init();
        var state = GameLogic.createInitialState(606290980);
        for (var i = 0; i < 45; i++) {
          var restart = i % 15 === 0;
          if (restart) raw.reset_depth();
          var direction = raw.search(ZiapSolver.encodeBoard(state));
          var before = JSON.stringify(state);
          var choice = await ai.chooseMove(state, restart);
          assert.equal(choice.rawDirection, direction, "第 " + i + " 步与原版方向不一致");
          assert.equal(JSON.stringify(state), before);
          var result = GameLogic.applyMove(state, choice.direction);
          assert.ok(result.moved);
          state = result.state;
        }
        assert.equal(ai.threads, 1);
      } finally { ai.dispose(); }
    });

    await check("官方共享内存线程池完成60步，重叠请求串行执行并可释放", async function () {
      var first = workers.length;
      var ai = await ZiapSolver.load("main.wasm", { threads: 4, workerBaseUrl: workerBaseUrl });
      var batch = workers.slice(first);
      try {
        assert.equal(ai.threads, 4);
        assert.equal(batch.length, 4);
        assert.equal(batch.filter(function (worker) { return worker.url.endsWith("/pool-worker.js"); }).length, 3);
        var state = GameLogic.createInitialState(606290980);
        var pair = await Promise.all([ai.chooseMove(state, true), ai.chooseMove(state, false)]);
        pair.forEach(function (choice) { assert.equal(choice.engine, "ziap-wasm"); });
        for (var i = 0; i < 60; i++) {
          var choice = await ai.chooseMove(state, i % 15 === 0);
          assert.equal(choice.engine, "ziap-wasm");
          var result = GameLogic.applyMove(state, choice.direction);
          assert.ok(result.moved);
          state = result.state;
        }
        assert.ok(batch.every(function (worker) { return !worker.terminated; }));
      } finally { ai.dispose(); }
      assert.ok(batch.every(function (worker) { return worker.terminated; }));
      await assert.rejects(ai.chooseMove(state), /disposed/);
    });

    await check("WASM 下载失败明确拒绝，不遗留线程", async function () {
      var first = workers.length;
      global.fetch = async function () { return { ok: false, status: 404 }; };
      await assert.rejects(ZiapSolver.load("missing.wasm", { threads: 4, workerBaseUrl: workerBaseUrl }), /HTTP 404/);
      assert.equal(workers.length, first);
    });
  } finally {
    global.Worker = originalWorker;
    global.fetch = originalFetch;
    await Promise.all(workers.map(function (worker) { return worker.terminate(); }));
  }
  console.log("ziap 原版接入检查全部通过：" + passed);
}

main().catch(function (error) { console.error(error); process.exitCode = 1; });
