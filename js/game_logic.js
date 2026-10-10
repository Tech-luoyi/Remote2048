/* ==========================================================================
 * 2048 远程双人对战 —— 共享领域逻辑
 * --------------------------------------------------------------------------
 * 本文件同时被浏览器（<script>）和 Node.js（require）加载，因此：
 *   - 不依赖 window / document / DOM / Grid / Tile / localStorage；
 *   - 不使用 Math.random()，随机性全部来自 state.rngState（xorshift32）；
 *   - 不依赖 Node 的 crypto，hashState 是纯 JavaScript 实现（FNV-1a）；
 *   - 所有导出函数都是纯函数，不修改传入的 state。
 *
 * 契约详见 docs/remote-duel-plan-zh.md §4 / §5 / §9。
 * 坐标系为 cells[x][y]，先 x 后 y，与旧版 Grid 一致。
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.GameLogic = factory();
  }
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ---------------- 常量 ---------------- */

  var VERSION = 1;
  var DEFAULT_SIZE = 4;
  var DEFAULT_TARGET_TILE = 2048;
  var DEFAULT_START_TILES = 2;
  var NEW_TILE_VALUE = 2;
  var SPAWN_FOUR_RATE = 0.1;      // 与原版一致：90% 生成 2，10% 生成 4
  var COMBO_PER_ENERGY = 3;       // §9：每连续 3 次产生合并的移动获得 1 点能量
  var ENERGY_MAX = 2;             // §9：能量上限
  var INTERFERENCE_VALUE = 4;     // §9：干扰块数值
  var HASH_PREFIX = "2048-v1";    // 规范字符串前缀，字段顺序一旦发布不得更改
  var MAX_BOARD_SIZE = 32;        // 防止错误输入一次性分配失控的大棋盘

  var DIRECTIONS = { UP: 0, RIGHT: 1, DOWN: 2, LEFT: 3 };
  var VECTORS = {
    0: { x: 0, y: -1 },
    1: { x: 1, y: 0 },
    2: { x: 0, y: 1 },
    3: { x: -1, y: 0 }
  };

  function isValidDirection(direction) {
    return direction === 0 || direction === 1 || direction === 2 || direction === 3;
  }

  function normalizeTargetTile(value) {
    var target = Number(value);
    return isFinite(target) && target > 0 && Math.floor(target) === target
      ? target
      : DEFAULT_TARGET_TILE;
  }

  function isPositiveInteger(value) {
    return typeof value === "number" && isFinite(value) &&
      value > 0 && Math.floor(value) === value;
  }

  function isNonNegativeInteger(value) {
    return typeof value === "number" && isFinite(value) &&
      value >= 0 && Math.floor(value) === value;
  }

  function normalizeSize(value) {
    var size = Number(value);
    return isFinite(size) && size > 0 && Math.floor(size) === size &&
      size <= MAX_BOARD_SIZE ? size : DEFAULT_SIZE;
  }

  function normalizeCount(value, fallback, maximum) {
    var count = Number(value);
    if (!isFinite(count) || count < 0) count = fallback;
    count = Math.floor(count);
    return maximum === undefined ? count : Math.min(count, maximum);
  }

  function normalizeNumber(value, fallback) {
    var number = Number(value);
    return isFinite(number) ? number : fallback;
  }

  function isGridCoordinate(position, size) {
    return position && typeof position === "object" &&
      typeof position.x === "number" && typeof position.y === "number" &&
      isFinite(position.x) && isFinite(position.y) &&
      Math.floor(position.x) === position.x &&
      Math.floor(position.y) === position.y &&
      withinBounds(size, position.x, position.y);
  }

  /* ======================================================================
   * 1. 确定性随机（xorshift32）
   * ==================================================================== */

  function normalizeSeed(seed) {
    var s = (seed === undefined || seed === null) ? 0 : seed;
    s = s >>> 0;
    return s === 0 ? 0x9e3779b9 : s;   // 0 是 xorshift32 的不动点，必须替换
  }

  function nextRandomValue(rngState) {
    var x = rngState >>> 0;
    x ^= (x << 13); x = x >>> 0;
    x ^= (x >>> 17); x = x >>> 0;
    x ^= (x << 5);  x = x >>> 0;
    return x === 0 ? 0x9e3779b9 : x;
  }

  // 推进一次随机流，返回 { rngState, value }，value ∈ [0, 1)
  function draw(rngState) {
    var next = nextRandomValue(rngState);
    return { rngState: next, value: next / 4294967296 };
  }

  /* ======================================================================
   * 2. 棋盘基础操作
   * ==================================================================== */

  function makeTile(x, y, value, interference) {
    return {
      position: { x: x, y: y },
      value: value,
      interference: !!interference
    };
  }

  function createEmptyCells(size) {
    var cells = [];
    for (var x = 0; x < size; x++) {
      cells[x] = [];
      for (var y = 0; y < size; y++) {
        cells[x][y] = null;
      }
    }
    return cells;
  }

  // 深拷贝，并把 position 归一化到真实下标（缓存 position 不得漂移，否则哈希不稳）
  function cloneCells(cells, size) {
    var out = [];
    for (var x = 0; x < size; x++) {
      out[x] = [];
      for (var y = 0; y < size; y++) {
        var tile = cells[x] && cells[x][y];
        out[x][y] = tile ? makeTile(x, y, tile.value, tile.interference) : null;
      }
    }
    return out;
  }

  // §4 固定顺序：x 升序，再 y 升序。不得依赖对象键顺序。
  function availableCells(cells, size) {
    var list = [];
    if (!Array.isArray(cells) || !isPositiveInteger(size)) return list;
    for (var x = 0; x < size; x++) {
      if (!Array.isArray(cells[x]) || cells[x].length !== size) return [];
      for (var y = 0; y < size; y++) {
        if (cells[x][y] === null) list.push({ x: x, y: y });
      }
    }
    return list;
  }

  function withinBounds(size, x, y) {
    return x >= 0 && x < size && y >= 0 && y < size;
  }

  function tileMatchesAvailable(cells, size) {
    if (!Array.isArray(cells) || !isPositiveInteger(size)) return false;
    for (var x = 0; x < size; x++) {
      for (var y = 0; y < size; y++) {
        var tile = cells[x] && cells[x][y];
        if (!tile) continue;
        for (var d = 0; d < 4; d++) {
          var vector = VECTORS[d];
          var nx = x + vector.x, ny = y + vector.y;
          if (!withinBounds(size, nx, ny)) continue;
          var other = cells[nx] && cells[nx][ny];
          if (other && other.value === tile.value) return true;
        }
      }
    }
    return false;
  }

  function hasMoves(state) {
    return isValidState(state) &&
      (availableCells(state.cells, state.size).length > 0 ||
       tileMatchesAvailable(state.cells, state.size));
  }

  function isValidState(state) {
    if (!state || typeof state !== "object" || Array.isArray(state) ||
        !isPositiveInteger(state.size) || state.size > MAX_BOARD_SIZE ||
        !Array.isArray(state.cells) || state.cells.length !== state.size) {
      return false;
    }

    if (state.version !== undefined &&
        (typeof state.version !== "number" || state.version !== VERSION)) {
      return false;
    }
    if (state.targetTile !== undefined && !isPositiveInteger(state.targetTile)) {
      return false;
    }
    if (state.score !== undefined &&
        (typeof state.score !== "number" || !isFinite(state.score) ||
         !isNonNegativeInteger(state.score))) {
      return false;
    }
    if (state.energy !== undefined &&
        (typeof state.energy !== "number" || !isFinite(state.energy) ||
         !isNonNegativeInteger(state.energy))) {
      return false;
    }
    if (state.combo !== undefined &&
        (typeof state.combo !== "number" || !isFinite(state.combo) ||
         !isNonNegativeInteger(state.combo))) {
      return false;
    }
    if (state.moveSeq !== undefined &&
        (typeof state.moveSeq !== "number" || !isFinite(state.moveSeq) ||
         !isNonNegativeInteger(state.moveSeq))) {
      return false;
    }
    if (state.rngState !== undefined &&
        (typeof state.rngState !== "number" || !isFinite(state.rngState) ||
         !isNonNegativeInteger(state.rngState) || state.rngState > 0xffffffff)) {
      return false;
    }
    if (state.won !== undefined && typeof state.won !== "boolean") return false;
    if (state.stuck !== undefined && typeof state.stuck !== "boolean") return false;

    var interferenceCount = 0;
    for (var x = 0; x < state.size; x++) {
      if (!Array.isArray(state.cells[x]) || state.cells[x].length !== state.size) {
        return false;
      }
      for (var y = 0; y < state.size; y++) {
        var tile = state.cells[x][y];
        // 协议只用 null 表示空格；其他假值都是损坏状态。
        if (tile === null) continue;
        if (typeof tile !== "object" || Array.isArray(tile) ||
            typeof tile.value !== "number" || !isFinite(tile.value) ||
            !isPositiveInteger(tile.value)) {
          return false;
        }
        if (tile.position !== undefined &&
            !isGridCoordinate(tile.position, state.size)) {
          return false;
        }
        if (tile.interference !== undefined &&
            typeof tile.interference !== "boolean") {
          return false;
        }
        if (tile.interference === true) {
          if (tile.value !== INTERFERENCE_VALUE || ++interferenceCount > 1) {
            return false;
          }
        }
      }
    }
    return true;
  }

  /* ======================================================================
   * 3. 状态构造
   * ==================================================================== */

  // 一次有效移动固定消耗两次随机数：先取空位，再取 2/4。顺序不可更改。
  function spawnRandomTile(cells, size, rngState) {
    var slots = availableCells(cells, size);
    if (!slots.length) return { rngState: rngState, tile: null };

    var pick = draw(rngState);
    rngState = pick.rngState;
    var slot = slots[Math.floor(pick.value * slots.length)];

    var roll = draw(rngState);
    rngState = roll.rngState;
    var value = roll.value < SPAWN_FOUR_RATE ? 4 : NEW_TILE_VALUE;

    var tile = makeTile(slot.x, slot.y, value, false);
    cells[slot.x][slot.y] = tile;
    return { rngState: rngState, tile: tile };
  }

  function createInitialState(seed, options) {
    options = options || {};
    var size = normalizeSize(options.size);
    var startTiles = options.startTiles === undefined
      ? DEFAULT_START_TILES
      : normalizeCount(options.startTiles, DEFAULT_START_TILES, size * size);

    var state = {
      version: VERSION,
      size: size,
      targetTile: normalizeTargetTile(options.targetTile),
      cells: createEmptyCells(size),
      score: 0,
      won: false,
      stuck: false,
      energy: 0,
      combo: 0,
      moveSeq: 0,
      rngState: normalizeSeed(seed)
    };

    for (var i = 0; i < startTiles; i++) {
      var spawned = spawnRandomTile(state.cells, size, state.rngState);
      state.rngState = spawned.rngState;
      if (!spawned.tile) break;          // 棋盘已满，提前结束
    }

    state.stuck = !hasMoves(state);
    return state;
  }

  /* ======================================================================
   * 4. 移动与合并
   * ==================================================================== */

  function buildTraversals(size, vector) {
    var xs = [], ys = [];
    for (var i = 0; i < size; i++) {
      xs.push(i);
      ys.push(i);
    }
    // 始终从所选方向最远处的格子开始遍历
    if (vector.x === 1) xs.reverse();
    if (vector.y === 1) ys.reverse();
    return { x: xs, y: ys };
  }

  function findFarthestPosition(cells, size, cell, vector) {
    var previous, current = cell;
    do {
      previous = current;
      current = { x: previous.x + vector.x, y: previous.y + vector.y };
    } while (withinBounds(size, current.x, current.y) && !cells[current.x][current.y]);

    return { farthest: previous, next: current };
  }

  function positionSnapshot(x, y, value, interference) {
    return {
      position: { x: x, y: y },
      value: value,
      interference: !!interference
    };
  }

  function emptyEvents() {
    return { moved: [], merges: [], spawn: null };
  }

  function noMoveResult(state, error) {
    var result = {
      state: state,
      events: emptyEvents(),
      moved: false,
      won: state ? !!state.won : false,
      stuck: state ? !!state.stuck : false
    };
    if (error) result.error = error;
    return result;
  }

  /**
   * applyMove(state, direction) -> { state, events, moved, won, stuck }
   *
   * 纯函数：不修改入参 state。
   * moved === false 时返回入参本身，events 为空事件集，
   * 不生成方块、不增加分数、不消耗随机数。
   */
  function moveTiles(state, direction, spawnEnabled) {
    if (!isValidState(state)) return noMoveResult(state, "INVALID_STATE");
    if (!isValidDirection(direction)) return noMoveResult(state, "INVALID_DIRECTION");
    if (state.stuck) return noMoveResult(state, "PLAYER_STUCK");

    var size = state.size;
    var targetTile = normalizeTargetTile(state.targetTile);
    var cells = cloneCells(state.cells, size);
    var score = normalizeNumber(state.score, 0);
    var won = !!state.won;
    var moves = [];
    var merges = [];
    var moved = false;
    // 本次移动中已经产生过合并的位置；用独立网格记录，避免瞬态字段污染 state
    var mergedFlags = createEmptyCells(size);
    // 方块在本次移动开始时的来源坐标。目标方块可能已经先滑过空格，
    // 合并事件仍必须记录它的真实起点，渲染器才能完整播放滑入动画。
    var origins = createEmptyCells(size);
    for (var originX = 0; originX < size; originX++) {
      for (var originY = 0; originY < size; originY++) {
        if (cells[originX][originY]) {
          origins[originX][originY] = { x: originX, y: originY };
        }
      }
    }

    var vector = VECTORS[direction];
    var traversals = buildTraversals(size, vector);

    for (var xi = 0; xi < traversals.x.length; xi++) {
      for (var yi = 0; yi < traversals.y.length; yi++) {
        var x = traversals.x[xi], y = traversals.y[yi];
        var tile = cells[x][y];
        if (!tile) continue;

        var positions = findFarthestPosition(cells, size, { x: x, y: y }, vector);
        var next = positions.next;
        var nextTile = withinBounds(size, next.x, next.y) ? cells[next.x][next.y] : null;

        // 每次移动中，同一个方块只能参与一次合并
        if (nextTile && nextTile.value === tile.value && !mergedFlags[next.x][next.y]) {
          var mergedValue = tile.value * 2;
          var mergedTile = makeTile(next.x, next.y, mergedValue, false);
          var tileOrigin = origins[x][y] || { x: x, y: y };
          var nextOrigin = origins[next.x][next.y] || { x: next.x, y: next.y };
          mergedFlags[next.x][next.y] = true;

          cells[x][y] = null;
          cells[next.x][next.y] = mergedTile;
          origins[x][y] = null;
          origins[next.x][next.y] = nextOrigin;
          score += mergedValue;

          merges.push({
            from: [
              positionSnapshot(tileOrigin.x, tileOrigin.y, tile.value, tile.interference),
              positionSnapshot(nextOrigin.x, nextOrigin.y, nextTile.value, nextTile.interference)
            ],
            to: { x: next.x, y: next.y },
            value: mergedValue
          });

          if (mergedValue >= targetTile) won = true;
          moved = true;
        } else if (positions.farthest.x !== x || positions.farthest.y !== y) {
          var fx = positions.farthest.x, fy = positions.farthest.y;
          var origin = origins[x][y] || { x: x, y: y };
          cells[x][y] = null;
          cells[fx][fy] = makeTile(fx, fy, tile.value, tile.interference);
          origins[x][y] = null;
          origins[fx][fy] = origin;
          moves.push({
            from: { x: origin.x, y: origin.y },
            to: { x: fx, y: fy },
            value: tile.value,
            interference: !!tile.interference
          });
          moved = true;
        }
      }
    }

    if (!moved) {
      return noMoveResult(state);
    }

    var spawn = spawnEnabled ? spawnRandomTile(cells, size, state.rngState)
      : { rngState: state.rngState, tile: null };
    var rngState = spawn.rngState;

    // §9：合并累加连击，无合并的有效移动清零；每连续 3 次合并得 1 点能量
    var combo = Math.max(0, Math.floor(normalizeNumber(state.combo, 0)));
    var energy = Math.max(0, Math.min(ENERGY_MAX,
      Math.floor(normalizeNumber(state.energy, 0))));
    if (merges.length > 0) {
      combo += 1;
      if (combo % COMBO_PER_ENERGY === 0) {
        energy = Math.min(energy + 1, ENERGY_MAX);
      }
    } else {
      combo = 0;
    }

    var nextState = {
      version: VERSION,
      size: size,
      targetTile: targetTile,
      cells: cells,
      score: score,
      won: won,
      stuck: false,
      energy: energy,
      combo: combo,
      // 传输层元数据，领域逻辑只透传不修改
      moveSeq: normalizeNumber(state.moveSeq, 0),
      rngState: normalizeSeed(rngState)
    };
    nextState.stuck = !hasMoves(nextState);

    return {
      state: nextState,
      events: {
        moved: moves,
        merges: merges,
        spawn: spawn.tile
          ? { position: { x: spawn.tile.position.x, y: spawn.tile.position.y },
              value: spawn.tile.value,
              interference: !!spawn.tile.interference }
          : null
      },
      moved: true,
      won: nextState.won,
      stuck: nextState.stuck
    };
  }

  function applyMove(state, direction) {
    return moveTiles(state, direction, true);
  }

  // The solver models random spawns separately; sliding uses the same rules.
  function slideMove(state, direction) {
    return moveTiles(state, direction, false);
  }

  /* ======================================================================
   * 5. 干扰块（§9）
   * ==================================================================== */

  /**
   * applyInterference(state, position, value) -> 新状态 | null
   *
   * null 表示请求不合法（位置越界、已占用、数值不为 4 或已有干扰块），
   * 调用方据此返回对应协议错误。
   * 位置由服务端选定，因此本函数不消耗随机数。
   * 干扰块插入后可能让目标玩家进入 stuck（§9 边界规则）。
   */
  function applyInterference(state, position, value) {
    if (!isValidState(state) || !position) return null;

    var size = state.size;
    if (!isGridCoordinate(position, size)) return null;
    var x = position.x, y = position.y;
    if (state.cells[x][y]) return null;

    // 每个棋盘最多保留一个干扰块，且干扰块数值固定为 4。
    if (value !== undefined && value !== INTERFERENCE_VALUE) return null;
    for (var ix = 0; ix < size; ix++) {
      for (var iy = 0; iy < size; iy++) {
        if (state.cells[ix][iy] && state.cells[ix][iy].interference) return null;
      }
    }

    var cells = cloneCells(state.cells, size);
    cells[x][y] = makeTile(x, y, INTERFERENCE_VALUE, true);

    var nextState = {
      version: state.version === undefined ? VERSION : state.version,
      size: size,
      targetTile: normalizeTargetTile(state.targetTile),
      cells: cells,
      score: normalizeNumber(state.score, 0),
      won: !!state.won,
      stuck: false,
      energy: Math.max(0, Math.min(ENERGY_MAX,
        Math.floor(normalizeNumber(state.energy, 0)))),
      combo: Math.max(0, Math.floor(normalizeNumber(state.combo, 0))),
      moveSeq: normalizeNumber(state.moveSeq, 0),
      rngState: normalizeSeed(state.rngState)
    };
    nextState.stuck = !hasMoves(nextState);
    return nextState;
  }

  /* ======================================================================
   * 6. 序列化与状态哈希（§5）
   * ==================================================================== */

  function serializeState(state) {
    if (!isValidState(state)) return null;
    var size = state.size;
    var cells = [];
    for (var x = 0; x < size; x++) {
      cells[x] = [];
      for (var y = 0; y < size; y++) {
        var tile = state.cells[x][y];
        cells[x][y] = tile
          ? { position: { x: x, y: y }, value: tile.value, interference: !!tile.interference }
          : null;
      }
    }
    return {
      version: state.version === undefined ? VERSION : state.version,
      size: size,
      targetTile: normalizeTargetTile(state.targetTile),
      cells: cells,
      score: normalizeNumber(state.score, 0),
      won: !!state.won,
      stuck: !!state.stuck,
      energy: Math.max(0, Math.min(ENERGY_MAX,
        Math.floor(normalizeNumber(state.energy, 0)))),
      combo: Math.max(0, Math.floor(normalizeNumber(state.combo, 0))),
      moveSeq: normalizeNumber(state.moveSeq, 0),
      rngState: normalizeSeed(state.rngState)
    };
  }

  /**
   * 规范字符串：字段顺序固定，只覆盖参与哈希的玩法状态。
   * 不含 rngState / moveSeq（§5 状态哈希的覆盖范围）。
   */
  function canonicalString(state) {
    if (!isValidState(state)) return null;

    var size = state.size;
    var parts = [HASH_PREFIX, String(size), String(normalizeTargetTile(state.targetTile))];

    for (var x = 0; x < size; x++) {
      for (var y = 0; y < size; y++) {
        var tile = state.cells[x][y];
        parts.push(tile
          ? (x + ":" + y + ":" + tile.value + ":" + (tile.interference ? 1 : 0))
          : "-");
      }
    }

    parts.push(String(normalizeNumber(state.score, 0)));
    parts.push(state.won === true ? "1" : "0");
    parts.push(state.stuck === true ? "1" : "0");
    parts.push(String(Math.max(0, Math.min(ENERGY_MAX,
      Math.floor(normalizeNumber(state.energy, 0))))));
    parts.push(String(Math.max(0, Math.floor(normalizeNumber(state.combo, 0)))));

    return parts.join("|");
  }

  // FNV-1a 32 位，纯 JavaScript，两端结果一致
  function fnv1a(str) {
    if (typeof str !== "string") return null;

    var hash = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = hash >>> 0;
      // hash *= 16777619 (0x01000193)，用移位加法避免精度问题
      hash = (hash +
              ((hash << 1) >>> 0) +
              ((hash << 4) >>> 0) +
              ((hash << 7) >>> 0) +
              ((hash << 8) >>> 0) +
              ((hash << 24) >>> 0)) >>> 0;
    }
    return ("0000000" + hash.toString(16)).slice(-8);
  }

  function hashState(state) {
    var canonical = canonicalString(state);
    return canonical === null ? null : fnv1a(canonical);
  }

  /* ---------------- 导出 ---------------- */

  return {
    VERSION: VERSION,
    DIRECTIONS: DIRECTIONS,
    INTERFERENCE_VALUE: INTERFERENCE_VALUE,
    ENERGY_MAX: ENERGY_MAX,
    COMBO_PER_ENERGY: COMBO_PER_ENERGY,
    SPAWN_FOUR_RATE: SPAWN_FOUR_RATE,

    isValidDirection: isValidDirection,
    createInitialState: createInitialState,
    applyMove: applyMove,
    slideMove: slideMove,
    applyInterference: applyInterference,
    hasMoves: hasMoves,
    isValidState: isValidState,
    availableCells: availableCells,
    serializeState: serializeState,
    hashState: hashState,
    canonicalString: canonicalString
  };
}));
