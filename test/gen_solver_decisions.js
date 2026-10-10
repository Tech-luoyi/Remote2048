"use strict";

/* 生成 test/fixtures/solver-decisions.json：沿用文件里已有的局面，用当前求解器在固定深度下重算期望决策。
   局面本身来自真实自对弈采样，不换局面只换期望值，保证跨版本可比。 */

var fs = require("node:fs");
var path = require("node:path");
var GameLogic = require("../js/game_logic");
var GameSolver = require("../js/game_solver");

var FILE = path.join(__dirname, "fixtures/solver-decisions.json");
var COVERAGE = { d2: Infinity, d3: Infinity, d4: 12 };     // d4 全量太慢，只跑前 12 个局面
var UNLIMITED = { timeBudgetMs: 600000, maxNodes: 1e9 };   // 深度封顶，与预算计数方式无关

var fixture = JSON.parse(fs.readFileSync(FILE, "utf8"));

function stateOf(cells) {
  var state = GameLogic.createInitialState(7, { startTiles: 0 });
  cells.forEach(function (column, x) {
    column.forEach(function (value, y) {
      state.cells[x][y] = value
        ? { position: { x: x, y: y }, value: value, interference: false }
        : null;
    });
  });
  state.stuck = !GameLogic.hasMoves(state);
  return GameLogic.serializeState(state);
}

["d2", "d3", "d4"].forEach(function (key) {
  var depth = Number(key.slice(1));
  var list = [];
  var states = fixture.cells.map(stateOf);
  states.slice(0, COVERAGE[key] === Infinity ? states.length : COVERAGE[key]).forEach(function (state, index) {
    var choice = GameSolver.chooseMove(state, Object.assign({ maxDepth: depth }, UNLIMITED));
    if (choice) list.push({ index: index, direction: choice.direction, depth: choice.depth });
  });
  fixture.depths[key] = list;
  console.log(key + " 记录 " + list.length + " 条");
});

fixture.note = "由当前 js/game_solver.js 在固定搜索深度下重算生成；局面沿用真实自对弈采样不换。" +
  "改动搜索或评估导致这里的 direction/depth 变化时，必须用 npm run bench:solver 说明棋力变化。";

fs.writeFileSync(FILE, JSON.stringify(fixture) + "\n");
console.log("已写入 " + FILE);
