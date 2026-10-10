"use strict";

/* 棋力基准：固定种子自对弈，报 400 步均分与整局达 2048 率，用于对比搜索改动前后的棋力变化。 */

var GameLogic = require("../js/game_logic");
var GameSolver = require("../js/game_solver");

var BUDGET = { maxNodes: 16000, timeBudgetMs: 60, maxDepth: 4 };  // 与 solver_worker.js 默认档一致
var SHORT_CAP = 400, SHORT_GAMES = 8, FULL_GAMES = 12;

function maxValue(state) {
  var max = 0;
  for (var x = 0; x < state.size; x++) {
    for (var y = 0; y < state.size; y++) {
      var tile = state.cells[x][y];
      if (tile && tile.value > max) max = tile.value;
    }
  }
  return max;
}

function play(seed, cap) {
  var state = GameLogic.createInitialState(seed, {});
  var moves = 0, ms = 0, depths = {}, illegal = 0;
  while (!state.stuck && (!cap || moves < cap)) {
    var started = process.hrtime.bigint();
    var choice = GameSolver.chooseMove(state, BUDGET);
    ms += Number(process.hrtime.bigint() - started) / 1e6;
    if (!choice) { illegal++; break; }
    depths[choice.depth] = (depths[choice.depth] || 0) + 1;
    var result = GameLogic.applyMove(state, choice.direction);
    if (result.error || !result.moved) { illegal++; break; }
    state = result.state;
    moves++;
  }
  return { state: state, moves: moves, ms: ms, depths: depths, illegal: illegal };
}

function run(label, games, cap, seedAt) {
  var rows = [], depths = {}, ms = 0, moves = 0, illegal = 0, won = 0, score = 0, max = 0;
  for (var i = 0; i < games; i++) {
    var row = play(seedAt(i), cap);
    rows.push(row);
    ms += row.ms; moves += row.moves; illegal += row.illegal;
    if (row.state.won) won++;
    score += row.state.score;
    max += maxValue(row.state);
    Object.keys(row.depths).forEach(function (depth) {
      depths[depth] = (depths[depth] || 0) + row.depths[depth];
    });
  }
  return { label: label, winRate: won + "/" + games, avgScore: Math.round(score / games),
    avgMaxTile: Math.round(max / games), avgMoves: Math.round(moves / games),
    msPerMove: +(ms / (moves || 1)).toFixed(1), worstMoveMs: +Math.max.apply(null,
      rows.map(function (row) { return row.ms / (row.moves || 1); })).toFixed(1),
    illegal: illegal, depthHist: depths };
}

console.log("求解器棋力基准 预算=" + JSON.stringify(BUDGET) + " Node " + process.version);
[run("短盘 " + SHORT_CAP + " 步", SHORT_GAMES, SHORT_CAP, function (i) { return 5000 + i * 31; }),
 run("整局到终局", FULL_GAMES, 0, function (i) { return 1000 + i * 7; })].forEach(function (row) {
  console.log(row.label + ": " + JSON.stringify(row));
});
