/* ==========================================================================
 * 2048 远程双人对战 —— 纯逻辑单测
 * --------------------------------------------------------------------------
 * 零依赖，只用 Node 内置 assert。
 * 运行：node test/logic.test.js
 *
 * 覆盖 docs/remote-duel-plan-zh.md §14「纯逻辑测试」与 §4/§5/§8/§9 的契约。
 * ========================================================================== */
"use strict";

var assert = require("assert");
var path = require("path");
var L = require(path.join(__dirname, "..", "js", "game_logic.js"));

var UP = L.DIRECTIONS.UP;
var RIGHT = L.DIRECTIONS.RIGHT;
var DOWN = L.DIRECTIONS.DOWN;
var LEFT = L.DIRECTIONS.LEFT;

var passed = 0;
var failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  \u2713 " + name);
  } catch (err) {
    failed++;
    process.exitCode = 1;
    console.error("  \u2717 " + name);
    console.error("      " + (err && err.message ? err.message : err));
  }
}

function section(title) {
  console.log("\n" + title);
}

/* ---------------- 测试辅助 ---------------- */

// matrix[x][y] = 数值，0 表示空；坐标系与生产代码一致：先 x 后 y
function stateFrom(matrix, overrides) {
  var size = matrix.length;
  var cells = [];
  for (var x = 0; x < size; x++) {
    cells[x] = [];
    for (var y = 0; y < size; y++) {
      var value = matrix[x][y];
      cells[x][y] = value
        ? { position: { x: x, y: y }, value: value, interference: false }
        : null;
    }
  }
  var state = {
    version: L.VERSION,
    size: size,
    targetTile: 2048,
    cells: cells,
    score: 0,
    won: false,
    stuck: false,
    energy: 0,
    combo: 0,
    moveSeq: 0,
    rngState: 0x12345678
  };
  if (overrides) {
    for (var key in overrides) {
      if (Object.prototype.hasOwnProperty.call(overrides, key)) state[key] = overrides[key];
    }
  }
  return state;
}

function emptyMatrix(size) {
  size = size || 4;
  var m = [];
  for (var x = 0; x < size; x++) {
    m[x] = [];
    for (var y = 0; y < size; y++) m[x][y] = 0;
  }
  return m;
}

function put(matrix, x, y, value) {
  matrix[x][y] = value;
  return matrix;
}

function board() {
  var m = emptyMatrix();
  for (var i = 0; i < arguments.length; i++) {
    var t = arguments[i];
    put(m, t[0], t[1], t[2]);
  }
  return m;
}

function valueAt(state, x, y) {
  return state.cells[x][y] ? state.cells[x][y].value : 0;
}

function countTiles(state) {
  var n = 0;
  for (var x = 0; x < state.size; x++) {
    for (var y = 0; y < state.size; y++) if (state.cells[x][y]) n++;
  }
  return n;
}

function snap(value) {
  return JSON.stringify(value);
}

// 横排（固定 y，x = 0..size-1）
function rowOf(state, y) {
  var out = [];
  for (var x = 0; x < state.size; x++) out.push(valueAt(state, x, y));
  return out;
}

/* ======================================================================
 * 1. 初始状态与确定性随机
 * ==================================================================== */

section("1. 初始状态与确定性随机");

test("createInitialState：固定 seed 生成 2 个方块且完全可复现", function () {
  var a = L.createInitialState(20240601);
  var b = L.createInitialState(20240601);
  assert.strictEqual(countTiles(a), 2, "开局应有 2 个方块");
  assert.strictEqual(a.score, 0);
  assert.strictEqual(a.won, false);
  assert.strictEqual(a.stuck, false);
  assert.strictEqual(a.energy, 0);
  assert.strictEqual(a.combo, 0);
  assert.strictEqual(snap(a), snap(b), "同 seed 必须生成完全一致的初始状态");
});

test("createInitialState：不同 seed 生成不同布局", function () {
  var a = L.createInitialState(1);
  var b = L.createInitialState(999);
  assert.notStrictEqual(L.hashState(a), L.hashState(b));
});

test("createInitialState：seed 为 0 时不会退化成空随机流", function () {
  var a = L.createInitialState(0);
  var b = L.createInitialState(0x9e3779b9);
  assert.strictEqual(a.rngState, b.rngState, "seed 0 应被规范化为 xorshift32 的有效种子");
});

test("createInitialState：targetTile 可配置（招新演示用 512）", function () {
  var s = L.createInitialState(5, { targetTile: 512 });
  assert.strictEqual(s.targetTile, 512);
});

/* ======================================================================
 * 2. 移动与合并
 * ==================================================================== */

section("2. 移动与合并");

test("applyMove：四个方向都能把方块推到边界", function () {
  var cases = [
    { dir: LEFT, x: 0, y: 1 },
    { dir: RIGHT, x: 3, y: 1 },
    { dir: UP, x: 1, y: 0 },
    { dir: DOWN, x: 1, y: 3 }
  ];
  cases.forEach(function (c) {
    var r = L.applyMove(stateFrom(board([1, 1, 2])), c.dir);
    assert.strictEqual(r.moved, true, "方向 " + c.dir + " 应为有效移动");
    assert.strictEqual(valueAt(r.state, c.x, c.y), 2,
      "方向 " + c.dir + " 应把方块推到 (" + c.x + "," + c.y + ")");
  });
});

test("applyMove：单次合并的数值、分数与 merges 事件", function () {
  var r = L.applyMove(stateFrom(board([0, 0, 2], [1, 0, 2])), LEFT);
  assert.strictEqual(valueAt(r.state, 0, 0), 4);
  assert.strictEqual(r.state.score, 4);
  assert.strictEqual(r.events.merges.length, 1);
  assert.strictEqual(r.events.merges[0].value, 4);
  assert.deepStrictEqual(r.events.merges[0].to, { x: 0, y: 0 });

  var fromPairs = r.events.merges[0].from.map(function (f) {
    return f.position.x + "," + f.position.y + "=" + f.value;
  }).sort();
  assert.deepStrictEqual(fromPairs, ["0,0=2", "1,0=2"], "merges.from 应记录两个源方块的位置");
  assert.strictEqual(r.events.merges[0].from[0].interference, false,
    "合并事件应携带源方块的干扰标记");
});

test("applyMove：滑过空格后合并时，事件保留源坐标和干扰标记", function () {
  var s = stateFrom(board([0, 0, 4], [2, 0, 4]));
  s.cells[2][0].interference = true;

  var r = L.applyMove(s, LEFT);
  assert.deepStrictEqual(r.events.merges[0].from, [
    { position: { x: 2, y: 0 }, value: 4, interference: true },
    { position: { x: 0, y: 0 }, value: 4, interference: false }
  ]);
  assert.deepStrictEqual(r.events.merges[0].to, { x: 0, y: 0 });
});

test("applyMove：先滑动再合并时，merges.from 保留两个方块的真实起点", function () {
  var r = L.applyMove(stateFrom(board([1, 0, 2], [3, 0, 2])), LEFT);

  assert.deepStrictEqual(r.events.moved, [{
    from: { x: 1, y: 0 },
    to: { x: 0, y: 0 },
    value: 2,
    interference: false
  }]);
  assert.deepStrictEqual(r.events.merges[0].from.map(function (source) {
    return source.position;
  }), [{ x: 3, y: 0 }, { x: 1, y: 0 }]);
});

test("applyMove：同一排 [2,2,2,2] 向左只合并成 [4,4]，不是 [8]", function () {
  var r = L.applyMove(stateFrom(board([0, 0, 2], [1, 0, 2], [2, 0, 2], [3, 0, 2])), LEFT);
  assert.deepStrictEqual(rowOf(r.state, 0).slice(0, 2), [4, 4]);
  assert.strictEqual(r.state.score, 8);
  assert.strictEqual(r.events.merges.length, 2, "4 个 2 只能产生 2 次合并");
});

test("applyMove：[2,2,4] 向左时，新合成的 4 不再与滑过来的 4 合并", function () {
  var r = L.applyMove(stateFrom(board([0, 0, 2], [1, 0, 2], [2, 0, 4])), LEFT);
  assert.deepStrictEqual(rowOf(r.state, 0).slice(0, 2), [4, 4]);
  assert.strictEqual(r.state.score, 4, "只应记一次 2+2 的分数");
  assert.strictEqual(r.events.merges.length, 1);
});

test("applyMove：不改变方块数量以外的空位（无效移动）", function () {
  // 第 0 列已靠左且纵向上无可合并，向左移动必然无效
  var s = stateFrom(board([0, 0, 2], [0, 1, 4], [0, 2, 2], [0, 3, 4]));
  var before = snap(s);
  var r = L.applyMove(s, LEFT);

  assert.strictEqual(r.moved, false);
  assert.strictEqual(r.state, s, "无效移动应原样返回入参");
  assert.strictEqual(r.state.rngState, s.rngState, "无效移动不得消耗随机数");
  assert.strictEqual(r.state.score, 0, "无效移动不得加分");
  assert.strictEqual(countTiles(r.state), 4, "无效移动不得生成新方块");
  assert.deepStrictEqual(r.events, { moved: [], merges: [], spawn: null });
  assert.strictEqual(snap(s), before, "applyMove 不得修改入参");
});

test("applyMove：非法方向返回 moved=false 且不改变状态", function () {
  var s = L.createInitialState(3);
  var r = L.applyMove(s, 99);
  assert.strictEqual(r.moved, false);
  assert.strictEqual(r.state, s);
  assert.strictEqual(r.error, "INVALID_DIRECTION");
  assert.strictEqual(L.isValidDirection(99), false);
  assert.strictEqual(L.isValidDirection(LEFT), true);
  assert.strictEqual(L.isValidDirection("left"), false, "方向必须是数字枚举，不是字符串");
});

test("applyMove：spawn 事件形状与 §5 一致，且落在空位上", function () {
  var r = L.applyMove(stateFrom(board([0, 0, 2], [1, 0, 2])), LEFT);
  assert.ok(r.events.spawn, "有效移动必须生成新方块");
  assert.strictEqual(typeof r.events.spawn.position.x, "number");
  assert.strictEqual(typeof r.events.spawn.position.y, "number");
  assert.ok(r.events.spawn.value === 2 || r.events.spawn.value === 4);
  assert.strictEqual(r.events.spawn.interference, false);
  assert.ok(!(r.events.spawn.position.x === 0 && r.events.spawn.position.y === 0),
    "新方块不得落在已被占用的合并位置");
});

/* ======================================================================
 * 3. won 与 stuck
 * ==================================================================== */

section("3. won 与 stuck");

test("applyMove：合成目标方块时设置 won", function () {
  var r = L.applyMove(stateFrom(board([0, 0, 1024], [1, 0, 1024])), LEFT);
  assert.strictEqual(r.won, true);
  assert.strictEqual(r.state.won, true);
  assert.strictEqual(valueAt(r.state, 0, 0), 2048);
  assert.strictEqual(r.state.score, 2048);
});

test("applyMove：targetTile 生效（512 目标）", function () {
  var r = L.applyMove(stateFrom(board([0, 0, 256], [1, 0, 256]), { targetTile: 512 }), LEFT);
  assert.strictEqual(r.state.won, true);
});

test("applyMove：won 一旦为真保持为真", function () {
  var r = L.applyMove(stateFrom(board([0, 0, 2], [1, 0, 2]), { won: true }), LEFT);
  assert.strictEqual(r.state.won, true);
});

test("hasMoves：满盘且无相邻同值时为 false", function () {
  var m = emptyMatrix();
  for (var x = 0; x < 4; x++) {
    for (var y = 0; y < 4; y++) m[x][y] = ((x + y) % 2 === 0) ? 2 : 4;
  }
  var s = stateFrom(m);
  assert.strictEqual(L.hasMoves(s), false);
  assert.strictEqual(L.availableCells(s.cells, 4).length, 0);
  assert.strictEqual(L.applyMove(s, LEFT).moved, false);
  assert.strictEqual(L.applyMove(s, UP).moved, false);
});

test("hasMoves：满盘但存在相邻同值时为 true", function () {
  var m = emptyMatrix();
  for (var x = 0; x < 4; x++) {
    for (var y = 0; y < 4; y++) m[x][y] = ((x + y) % 2 === 0) ? 2 : 4;
  }
  m[3][3] = 2;                                    // 与 (2,3) 的 4 不冲突，与 (3,2) 的 4 不冲突
  m[2][3] = 2;                                    // 制造 (2,3) 与 (3,3) 同值
  assert.strictEqual(L.hasMoves(stateFrom(m)), true);
});

/* ======================================================================
 * 4. 干扰块（§9）
 * ==================================================================== */

section("4. 干扰块");

test("applyInterference：插入带标记的方块，且不消耗随机数", function () {
  var s = stateFrom(board([0, 0, 2]), { rngState: 777 });
  var next = L.applyInterference(s, { x: 3, y: 3 });

  assert.ok(next, "空位应可插入");
  assert.strictEqual(next.cells[3][3].value, 4, "§9：干扰块数值为 4");
  assert.strictEqual(next.cells[3][3].interference, true);
  assert.strictEqual(next.rngState, 777, "位置由服务端选定，不得消耗随机数");
  assert.strictEqual(s.cells[3][3], null, "applyInterference 不得修改入参");
});

test("applyInterference：拒绝非 4 的数值和重复干扰块", function () {
  var s = stateFrom(board([0, 0, 2]));
  assert.strictEqual(L.applyInterference(s, { x: 3, y: 3 }, 8), null,
    "干扰块数值必须固定为 4");

  var next = L.applyInterference(s, { x: 3, y: 3 }, L.INTERFERENCE_VALUE);
  assert.ok(next);
  assert.strictEqual(L.applyInterference(next, { x: 2, y: 2 }), null,
    "棋盘上已有干扰块时不得再次插入");
});

test("applyInterference：越界或已占用时返回 null（对应 NO_TARGET_SPACE）", function () {
  var s = stateFrom(board([0, 0, 2]));
  assert.strictEqual(L.applyInterference(s, { x: 0, y: 0 }, 4), null, "已占用应拒绝");
  assert.strictEqual(L.applyInterference(s, { x: 4, y: 0 }, 4), null, "x 越界应拒绝");
  assert.strictEqual(L.applyInterference(s, { x: 0, y: -1 }, 4), null, "y 越界应拒绝");
  assert.strictEqual(L.applyInterference(s, null, 4), null, "缺少位置应拒绝");
  assert.ok(L.applyInterference(s, { x: 3, y: 3 }, 4), "空位应成功");
});

test("applyInterference：填掉最后一个空位且无法合并时进入 stuck（§9）", function () {
  var m = emptyMatrix();
  for (var x = 0; x < 4; x++) {
    for (var y = 0; y < 4; y++) {
      m[x][y] = (x === 3 && y === 3) ? 0 : (2 << (x + y));
    }
  }
  var s = stateFrom(m);
  assert.strictEqual(L.hasMoves(s), true, "还剩一个空位时不应 stuck");

  var next = L.applyInterference(s, { x: 3, y: 3 }, L.INTERFERENCE_VALUE);
  assert.ok(next);
  assert.strictEqual(next.stuck, true, "干扰块填满棋盘后目标应进入 stuck");
  assert.strictEqual(s.stuck, false, "不得修改入参");
});

test("applyMove：干扰块参与合并后标记清除（§9）", function () {
  var s = stateFrom(board([0, 0, 4], [1, 0, 4]));
  s.cells[0][0].interference = true;

  var r = L.applyMove(s, LEFT);
  assert.strictEqual(valueAt(r.state, 0, 0), 8);
  assert.strictEqual(r.state.cells[0][0].interference, false, "合并后干扰标记必须消失");
  assert.strictEqual(s.cells[0][0].interference, true, "入参不得被修改");
});

test("applyMove：干扰块未参与合并时标记保留，并出现在 moved 事件里", function () {
  var s = stateFrom(board([2, 0, 4]));
  s.cells[2][0].interference = true;

  var r = L.applyMove(s, LEFT);
  assert.strictEqual(valueAt(r.state, 0, 0), 4);
  assert.strictEqual(r.state.cells[0][0].interference, true, "滑动不改变干扰标记");
  assert.strictEqual(r.events.moved.length, 1);
  assert.strictEqual(r.events.moved[0].interference, true);
});

/* ======================================================================
 * 5. 连击与能量（§9）
 * ==================================================================== */

section("5. 连击与能量");

test("每连续 3 次合并获得 1 点能量，上限 2", function () {
  function mergeable() { return board([0, 0, 2], [1, 0, 2]); }

  var r1 = L.applyMove(stateFrom(mergeable(), { combo: 0, energy: 0 }), LEFT);
  assert.strictEqual(r1.state.combo, 1);
  assert.strictEqual(r1.state.energy, 0);

  var r2 = L.applyMove(stateFrom(mergeable(), { combo: 1, energy: 0 }), LEFT);
  assert.strictEqual(r2.state.combo, 2);
  assert.strictEqual(r2.state.energy, 0);

  var r3 = L.applyMove(stateFrom(mergeable(), { combo: 2, energy: 0 }), LEFT);
  assert.strictEqual(r3.state.combo, 3);
  assert.strictEqual(r3.state.energy, 1, "第 3 次连续合并应给 1 点能量");

  var r4 = L.applyMove(stateFrom(mergeable(), { combo: 5, energy: 1 }), LEFT);
  assert.strictEqual(r4.state.combo, 6);
  assert.strictEqual(r4.state.energy, 2, "第 6 次连续合并再给 1 点能量");

  var r5 = L.applyMove(stateFrom(mergeable(), { combo: 8, energy: 2 }), LEFT);
  assert.strictEqual(r5.state.energy, 2, "能量不得超过上限 2");
});

test("有效但不产生合并的移动把连击清零，已有能量保留", function () {
  var r = L.applyMove(stateFrom(board([2, 0, 2]), { combo: 5, energy: 1 }), LEFT);
  assert.strictEqual(r.moved, true);
  assert.strictEqual(r.events.merges.length, 0);
  assert.strictEqual(r.state.combo, 0, "无合并的有效移动应清零连击");
  assert.strictEqual(r.state.energy, 1, "清零连击不影响已有能量");
});

test("能量与连击参与状态哈希（§5）", function () {
  var base = stateFrom(board([0, 0, 2]));
  var withEnergy = stateFrom(board([0, 0, 2]), { energy: 1 });
  var withCombo = stateFrom(board([0, 0, 2]), { combo: 1 });
  assert.notStrictEqual(L.hashState(withEnergy), L.hashState(base));
  assert.notStrictEqual(L.hashState(withCombo), L.hashState(base));
});

/* ======================================================================
 * 6. 确定性契约（关键）
 * ==================================================================== */

section("6. 确定性契约（客户端预测的基础）");

var SEQUENCE = [LEFT, DOWN, LEFT, DOWN, LEFT, RIGHT, UP, LEFT, DOWN, RIGHT,
                LEFT, UP, LEFT, DOWN, DOWN, LEFT, RIGHT, RIGHT, DOWN, LEFT,
                LEFT, UP, LEFT, DOWN];

test("同 seed + 同输入序列 ⇒ 每一步的 stateHash 与 rngState 都一致", function () {
  var a = L.createInitialState(20240601);
  var b = L.createInitialState(20240601);
  assert.strictEqual(L.hashState(a), L.hashState(b));

  for (var i = 0; i < SEQUENCE.length; i++) {
    var ra = L.applyMove(a, SEQUENCE[i]);
    var rb = L.applyMove(b, SEQUENCE[i]);
    a = ra.state;
    b = rb.state;

    assert.strictEqual(a.rngState, b.rngState, "第 " + (i + 1) + " 步后 rngState 必须一致");
    assert.strictEqual(L.hashState(a), L.hashState(b), "第 " + (i + 1) + " 步后 stateHash 必须一致");
    assert.strictEqual(snap(ra.events), snap(rb.events), "第 " + (i + 1) + " 步的动画事件必须一致");
  }

  assert.ok(a.score > 0, "24 步后应当已经产生分数，否则这组用例没有实际覆盖移动");
});

test("不同 seed 在同一输入序列下产生不同结果", function () {
  function run(seed) {
    var s = L.createInitialState(seed);
    for (var i = 0; i < SEQUENCE.length; i++) s = L.applyMove(s, SEQUENCE[i]).state;
    return L.hashState(s);
  }
  assert.notStrictEqual(run(1), run(2));
});

test("无效移动不消耗随机数：跳过与否不影响后续结果", function () {
  // 两格都贴在第 0 列：向左必然无效，向下必然有效
  var leftLocked = board([0, 0, 2], [0, 1, 4]);

  var withInvalid = L.applyMove(stateFrom(leftLocked), LEFT);
  assert.strictEqual(withInvalid.moved, false, "本用例需要一个无效的向左移动");
  var afterA = L.applyMove(withInvalid.state, DOWN).state;

  var directResult = L.applyMove(stateFrom(leftLocked), DOWN);
  var direct = directResult.state;
  assert.strictEqual(directResult.moved, true, "applyMove 顶层结果必须返回 moved 字段");

  assert.strictEqual(afterA.rngState, direct.rngState,
    "无效移动必须完全不消耗随机流");
  assert.strictEqual(L.hashState(afterA), L.hashState(direct),
    "无效移动被跳过与否，后续结果必须相同");
});

test("§8 反向用例：重放前采纳服务端 rngState 才可能一致", function () {
  var seq = [LEFT, DOWN, LEFT, DOWN, LEFT, RIGHT, UP, LEFT];

  // 服务端：先插入干扰块（跨棋盘写入），再依次处理移动
  var server = L.createInitialState(2024);
  var slot = L.availableCells(server.cells, server.size)[0];
  server = L.applyInterference(server, slot, L.INTERFERENCE_VALUE);
  var snapshot = L.serializeState(server);          // 客户端会收到这份快照

  for (var i = 0; i < seq.length; i++) server = L.applyMove(server, seq[i]).state;

  // 正确做法：采纳快照（含 rngState）后重放
  var ok = snapshot;
  for (var j = 0; j < seq.length; j++) ok = L.applyMove(ok, seq[j]).state;
  assert.strictEqual(L.hashState(ok), L.hashState(server),
    "采纳服务端 rngState 后重放必须与服务端一致");

  // 错误做法：沿用客户端自己那份已经分叉的随机流
  var stale = L.serializeState(snapshot);
  stale.rngState = 0xdeadbeef;
  var bad = stale;
  for (var k = 0; k < seq.length; k++) bad = L.applyMove(bad, seq[k]).state;
  assert.notStrictEqual(bad.rngState, server.rngState,
    "沿用分叉的随机流必然走到不同的随机状态");
});

/* ======================================================================
 * 7. 序列化与哈希覆盖范围（§5）
 * ==================================================================== */

section("7. 序列化与哈希覆盖范围");

test("serializeState：深拷贝且保留 position 字段", function () {
  var s = stateFrom(board([2, 1, 8], [1, 1, 8]));
  var out = L.serializeState(s);

  assert.deepStrictEqual(out.cells[2][1], { position: { x: 2, y: 1 }, value: 8, interference: false });
  assert.strictEqual(out.version, L.VERSION);
  assert.strictEqual(out.size, 4);
  assert.strictEqual(out.rngState, s.rngState);

  var h = L.hashState(s);
  out.cells[2][1] = null;                              // 修改副本
  assert.strictEqual(L.hashState(s), h, "修改序列化副本不得影响原状态");
  assert.strictEqual(s.cells[2][1].value, 8);
});

test("hashState：rngState 与 moveSeq 不参与哈希（§5）", function () {
  function build(over) { return stateFrom(board([0, 0, 2], [1, 1, 4]), over); }
  var h1 = L.hashState(build({ rngState: 1, moveSeq: 1 }));
  var h2 = L.hashState(build({ rngState: 999999, moveSeq: 42 }));
  assert.strictEqual(h1, h2, "传输层字段变化不得改变状态哈希");
});

test("hashState：玩法状态变化必须改变哈希（§5）", function () {
  function build(over) { return stateFrom(board([0, 0, 2], [1, 1, 4]), over); }
  var base = L.hashState(build());

  var cellChanged = build();
  cellChanged.cells[0][0].value = 4;
  assert.notStrictEqual(L.hashState(cellChanged), base, "方块数值");

  var flagChanged = build();
  flagChanged.cells[0][0].interference = true;
  assert.notStrictEqual(L.hashState(flagChanged), base, "干扰标记");

  assert.notStrictEqual(L.hashState(build({ score: 8 })), base, "分数");
  assert.notStrictEqual(L.hashState(build({ won: true })), base, "won");
  assert.notStrictEqual(L.hashState(build({ stuck: true })), base, "stuck");
  assert.notStrictEqual(L.hashState(build({ targetTile: 512 })), base, "targetTile");
});

test("hashState：结果稳定为 8 位十六进制，可直接用于协议", function () {
  var h = L.hashState(L.createInitialState(42));
  assert.ok(/^[0-9a-f]{8}$/.test(h), "哈希应为 8 位十六进制，实际：" + h);
});

test("canonicalString：不依赖对象键顺序", function () {
  var s = stateFrom(board([0, 0, 2]));
  var reordered = stateFrom(board([0, 0, 2]));
  reordered.cells[0][0] = {
    interference: false,
    value: 2,
    position: { y: 0, x: 0 }
  };
  assert.strictEqual(L.canonicalString(reordered), L.canonicalString(s));
  assert.strictEqual(L.hashState(reordered), L.hashState(s));
});

/* ======================================================================
 * 8. 纯函数性与枚举顺序
 * ==================================================================== */

section("8. 纯函数性与枚举顺序");

test("applyMove / applyInterference 均不修改入参", function () {
  var s = stateFrom(board([0, 0, 2], [1, 0, 2], [2, 2, 8]));
  var before = snap(s);

  L.applyMove(s, LEFT);
  L.applyMove(s, RIGHT);
  L.applyMove(s, UP);
  L.applyInterference(s, { x: 3, y: 3 }, 4);

  assert.strictEqual(snap(s), before, "所有导出函数必须是纯函数");
});

test("availableCells：固定按 x 升序、再 y 升序枚举（§4）", function () {
  var s = stateFrom(board([1, 1, 2], [3, 0, 4]));
  var got = L.availableCells(s.cells, 4).map(function (slot) {
    return slot.x + "," + slot.y;
  });
  assert.deepStrictEqual(got, [
    "0,0", "0,1", "0,2", "0,3",
    "1,0", "1,2", "1,3",
    "2,0", "2,1", "2,2", "2,3",
    "3,1", "3,2", "3,3"
  ], "顺序一旦改变，客户端预测会与服务端分叉");
});

section("9. 非法输入与终局边界");

test("isValidState：拒绝损坏的棋盘、随机状态和干扰块", function () {
  var malformed = stateFrom(board([0, 0, 2]));
  malformed.cells[0] = null;
  assert.strictEqual(L.isValidState(malformed), false);
  assert.strictEqual(L.applyMove(malformed, LEFT).error, "INVALID_STATE");

  var badRng = stateFrom(board([0, 0, 2]), { rngState: 0x100000000 });
  assert.strictEqual(L.isValidState(badRng), false);

  var badInterference = stateFrom(board([0, 0, 2]));
  badInterference.cells[0][0].value = 2;
  badInterference.cells[0][0].interference = true;
  assert.strictEqual(L.isValidState(badInterference), false);

  var duplicate = stateFrom(board([0, 0, 4], [1, 0, 4]));
  duplicate.cells[0][0].interference = true;
  duplicate.cells[1][0].interference = true;
  assert.strictEqual(L.isValidState(duplicate), false);
});

test("serializeState / hashState：非法状态安全返回 null", function () {
  var bad = stateFrom(board([0, 0, 2]));
  bad.cells[2] = "broken";
  assert.strictEqual(L.serializeState(bad), null);
  assert.strictEqual(L.hashState(bad), null);
});

test("applyMove：stuck 状态拒绝移动且不修改入参", function () {
  var s = stateFrom(board([0, 0, 2]), { stuck: true });
  var before = snap(s);
  var r = L.applyMove(s, LEFT);
  assert.strictEqual(r.error, "PLAYER_STUCK");
  assert.strictEqual(r.state, s);
  assert.strictEqual(snap(s), before);
});

test("applyInterference：拒绝小数坐标和错误类型坐标", function () {
  var s = stateFrom(board([0, 0, 2]));
  assert.strictEqual(L.applyInterference(s, { x: 1.5, y: 1 }, 4), null);
  assert.strictEqual(L.applyInterference(s, { x: "1", y: 1 }, 4), null);
});

/* ---------------- 汇总 ---------------- */

console.log("\n" + (failed === 0 ? "全部通过" : "存在失败") +
            "：" + passed + " 通过" + (failed ? "，" + failed + " 失败" : ""));
