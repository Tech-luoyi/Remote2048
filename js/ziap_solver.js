(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./game_logic"));
  } else root.ZiapSolver = factory(root.GameLogic);
}(typeof globalThis !== "undefined" ? globalThis : this, function (GameLogic) {
  "use strict";

  function encodeBoard(state) {
    if (!GameLogic.isValidState(state) || state.size !== 4) return null;
    var board = 0n;
    for (var y = 0; y < 4; y++) {
      for (var x = 0; x < 4; x++) {
        var tile = state.cells[x][y];
        if (tile && tile.interference) return null;
        var rank = tile ? Math.log2(tile.value) : 0;
        // Match upstream's log2 lookup: unknown values use rank 15.
        if (tile && (rank < 1 || rank > 15 || !Number.isInteger(rank))) rank = 15;
        board = (board << 4n) | BigInt(rank);
      }
    }
    return board;
  }

  function result(direction, randomDir) {
    return { direction: direction === -1 ? randomDir : direction,
      rawDirection: direction, engine: "ziap-wasm" };
  }

  function create(instance) {
    var wasm = instance.exports;
    wasm.init();
    var randomDir = 0;
    return {
      chooseMove: function (state, restart) {
        if (!GameLogic.isValidState(state) || state.stuck) return null;
        var board = encodeBoard(state);
        if (board === null) return null;
        if (restart) wasm.reset_depth();
        var direction = wasm.search(board);
        randomDir = (randomDir + 1) % 4;
        return result(direction, randomDir);
      }
    };
  }

  async function load(url, options) {
    options = options || {};
    if (typeof WebAssembly === "undefined" || typeof SharedArrayBuffer === "undefined") {
      throw new Error("Shared WebAssembly memory is unavailable");
    }
    var controller = new AbortController();
    var threads = Math.min(32, Math.max((options.threads | 0) || 1, 1));
    var workers = [], dead = false, pending = null;
    var queue = Promise.resolve(), randomDir = 0;
    function dispose(error) {
      if (dead) return;
      dead = true;
      controller.abort();
      workers.forEach(function (worker) { worker.terminate(); });
      if (pending) { pending.reject(error || new Error("Solver disposed")); pending = null; }
    }
    function startWorker(name, config) {
      return new Promise(function (resolve, reject) {
        var worker = new Worker(new URL(name, options.workerBaseUrl), { type: "module" });
        workers.push(worker);
        worker.onerror = function (event) {
          event.preventDefault();
          var error = new Error(event.message || "ziap worker failed");
          dispose(error);
          reject(error);
        };
        worker.onmessage = function (event) {
          if (event.data !== "ready") { reject(new Error("Expected ready")); return; }
          worker.onmessage = null;
          resolve(worker);
        };
        worker.postMessage(config);
      });
    }
    var rejectTimeout;
    var timedOut = new Promise(function (_, reject) { rejectTimeout = reject; });
    var timeout = setTimeout(function () {
      var error = new Error("ziap initialization timed out");
      dispose(error);
      rejectTimeout(error);
    }, 8000);
    try {
      var initialized = (async function () {
        var response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error("WASM HTTP " + response.status);
        var module = await WebAssembly.compile(await response.arrayBuffer());
        if (dead) throw new Error("Solver disposed");
        var memory = new WebAssembly.Memory({ initial: 1024, maximum: 1024, shared: true });
        var config = { module: module, memory: memory };
        await Promise.all(Array.from({ length: threads - 1 }, function () {
          return startWorker("pool-worker.js", config);
        }));
        if (dead) throw new Error("Solver disposed");
        var worker = await startWorker("worker.js", config);
        worker.onmessage = function (event) {
          if (!pending) return;
          var waiting = pending;
          pending = null;
          randomDir = (randomDir + 1) % 4;
          waiting.resolve(result(event.data, randomDir));
        };
        return {
          threads: threads,
          dispose: dispose,
          chooseMove: function (state, restart) {
            var board = encodeBoard(state);
            if (board === null || state.stuck) return Promise.resolve(null);
            // A stopped batch can still be computing; serialize the next request.
            var task = queue.then(function () {
              if (dead) throw new Error("Solver disposed");
              return new Promise(function (resolve, reject) {
                pending = { resolve: resolve, reject: reject };
                worker.postMessage({ board: board, restart: !!restart });
              });
            });
            queue = task.catch(function () {});
            return task;
          }
        };
      }());
      return await Promise.race([initialized, timedOut]);
    } catch (error) {
      dispose(error);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  return { encodeBoard: encodeBoard, create: create, load: load };
}));
