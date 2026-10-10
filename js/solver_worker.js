"use strict";

importScripts("game_logic.js", "game_solver.js", "ziap_solver.js");

var requested = new URLSearchParams(self.location.search).get("threads");
var threads = requested === null ? navigator.hardwareConcurrency : Number(requested);
var solverReady = ZiapSolver.load("vendor/ziap/main.wasm", {
  threads: threads,
  workerBaseUrl: new URL("vendor/ziap/js/", self.location.href)
}).catch(function () { return null; });

solverReady.then(function (solver) {
  self.postMessage({ ready: true, engine: solver ? "ziap-wasm" : "javascript",
    threads: solver ? solver.threads : 0 });
});

self.onmessage = async function (event) {
  var request = event.data;
  var solver = await solverReady;
  try {
    var supported = solver && ZiapSolver.encodeBoard(request.state) !== null;
    var choice = supported ? await solver.chooseMove(request.state, request.restart)
      : GameSolver.chooseMove(request.state);
    self.postMessage({ id: request.id, direction: choice ? choice.direction : null,
      engine: supported ? "ziap-wasm" : "javascript" });
  } catch (error) {
    self.postMessage({ id: request.id, error: true });
  }
};
