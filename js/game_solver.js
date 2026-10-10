(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./game_logic"));
  else root.GameSolver = factory(root.GameLogic);
}(typeof globalThis !== "undefined" ? globalThis : this, function (GameLogic) {
  "use strict";

  /*
   * 期望搜索（expectimax）：机会节点对所有空位的 2/4 加权取期望，
   * 选择节点取最大值。滑动与合并规则和真实对局共用 GameLogic 的定义，
   * 但搜索自己实现了一遍，原因有三：
   *
   *   1. rank 空间。棋盘存 log2(value)，0 表示空格，于是"两格相等"变成
   *      整数比较、"合并"变成 +1，评估函数不再逐格调用 Math.log2。
   *   2. 零分配。GameLogic.moveTiles 每次调用都会克隆棋盘、记录方块来源
   *      坐标并构造完整的 moves/merges 事件，搜索一个都不用；它还会先做
   *      一次 isValidState 深校验。这些在每个节点上都是纯开销。
   *   3. 节点预算只计真实展开。转置表的键里含绝对深度，实测命中率只有
   *      14%–27%（上一层的结果对下一层基本用不上），缓存命中不消耗
   *      maxNodes，否则预算会被查表吃光。
   *      别急着改成"board 做键 + 存剩余深度"来跨层复用：试过，命中率和
   *      深度都上去了，但条目变成对象后每步耗时 +42%，整局 2048 率反而
   *      从 14/16 掉到 10/16。
   *
   * 搜索只读取可见方块，不读取 rngState，也不修改传入的 state。
   */

  var CHAR_OFFSET = 48;         // rank + 48 作为缓存键里的字符码
  var LOST = -1000000;
  var WON = 1000000;

  var EVAL_EMPTY = 270;         // 评估权重，集中在这里便于校准
  var EVAL_PAIR = 70;
  var EVAL_SMOOTH = 12;
  var EVAL_MONOTONICITY = 55;
  var EVAL_MAX = 25;
  var EVAL_CORNER = 50;
  var GAIN_WEIGHT = 30;

  var DEFAULT_TARGET = 2048;
  var TWO_RATE = 1 - GameLogic.SPAWN_FOUR_RATE;
  var FOUR_RATE = GameLogic.SPAWN_FOUR_RATE;

  var EXHAUSTED = {};           // 用异常跳出时间/节点预算
  var RANKS = new Map();        // value -> rank，只在装载棋盘时用到
  var LINE_TABLES = new Map();  // size -> 各方向每行的写入顺序
  var now = typeof performance !== "undefined"
    ? function () { return performance.now(); }
    : function () { return Date.now(); };

  var POOL = [];                // 扁平棋盘缓冲区栈
  var POOL_TOP = 0;
  var POOL_CELLS = -1;
  var LINE = [];                // 单行滑动时的暂存
  var KEY_CODES = [];           // 构造缓存键时的字符码暂存

  var run = {
    size: 0,
    cells: 0,
    lines: null,
    target: 0,
    stopAtTarget: false,
    nodes: 0,
    probes: 0,
    maxNodes: 0,
    deadline: 0,
    cache: null
  };

  // 滑动后的结果通过这三个变量回传，避免每个节点都分配对象。
  var slidMoved = false;
  var slidGain = 0;
  var slidMergedRank = 0;

  function rankOf(value) {
    var rank = RANKS.get(value);
    if (rank === undefined) {
      rank = Math.log2(value);
      RANKS.set(value, rank);
    }
    return rank;
  }

  /*
   * 每个方向有 size 条行，行内按"从移动方向最远的一端开始写"的顺序
   * 排列下标。0 上（列内 y 递增）、1 右（行内 x 递减）、
   * 2 下（列内 y 递减）、3 左（行内 x 递增）。
   */
  function linesFor(size) {
    var cached = LINE_TABLES.get(size);
    if (cached) return cached;
    var directions = [];
    for (var direction = 0; direction < 4; direction++) {
      var lines = [];
      for (var line = 0; line < size; line++) {
        var indexes = [];
        for (var i = 0; i < size; i++) {
          var x, y;
          if (direction === 0) { x = line; y = i; }
          else if (direction === 1) { x = size - 1 - i; y = line; }
          else if (direction === 2) { x = line; y = size - 1 - i; }
          else { x = i; y = line; }
          indexes.push(x * size + y);
        }
        lines.push(indexes);
      }
      directions.push(lines);
    }
    LINE_TABLES.set(size, directions);
    return directions;
  }

  function alloc() {
    if (POOL_TOP === POOL.length) POOL.push(new Int32Array(run.cells));
    return POOL[POOL_TOP++];
  }

  function release() {
    POOL_TOP--;
  }

  // 把 GameLogic 的 cells[x][y] 装进 rank 空间的扁平棋盘。
  function load(cells) {
    var size = run.size;
    var board = alloc();
    for (var x = 0; x < size; x++) {
      for (var y = 0; y < size; y++) {
        var tile = cells[x][y];
        board[x * size + y] = tile ? rankOf(tile.value) : 0;
      }
    }
    return board;
  }

  /*
   * 就地滑动：每行先把非空格按顺序收进 LINE，再相邻同值合并写出。
   * 写出的方块不会再和本行后面的方块合并，因此"一次移动只合并一次"
   * 的规则天然成立，与 GameLogic.moveTiles 的结果逐格一致。
   */
  function slideFlat(source, target, direction) {
    var lines = run.lines[direction];
    slidMoved = false;
    slidGain = 0;
    slidMergedRank = 0;
    for (var l = 0; l < lines.length; l++) {
      var indexes = lines[l];
      var count = 0, i, rank;
      for (i = 0; i < indexes.length; i++) {
        rank = source[indexes[i]];
        if (rank !== 0) LINE[count++] = rank;
      }
      var read = 0, write = 0, first, merged;
      while (read < count) {
        first = LINE[read];
        if (read + 1 < count && LINE[read + 1] === first) {
          merged = first + 1;
          target[indexes[write++]] = merged;
          slidGain += Math.pow(2, merged);
          if (merged > slidMergedRank) slidMergedRank = merged;
          read += 2;
        } else {
          target[indexes[write++]] = first;
          read += 1;
        }
      }
      while (write < indexes.length) target[indexes[write++]] = 0;
      for (i = 0; i < indexes.length; i++) {
        if (target[indexes[i]] !== source[indexes[i]]) {
          slidMoved = true;
          break;
        }
      }
    }
  }

  // 棋盘还有空位，或者存在相邻同值，就还能走一步。
  function hasMovesFlat(board) {
    var size = run.size, cells = run.cells;
    var i;
    for (i = 0; i < cells; i++) if (board[i] === 0) return true;
    for (var x = 0; x < size; x++) {
      for (var y = 0; y < size; y++) {
        var rank = board[x * size + y];
        if (rank === 0) continue;
        if (x + 1 < size && board[(x + 1) * size + y] === rank) return true;
        if (y + 1 < size && board[x * size + y + 1] === rank) return true;
      }
    }
    return false;
  }

  function evaluateFlat(board) {
    var size = run.size, cells = run.cells;
    var empty = 0, smoothness = 0, pairs = 0, max = 0, monotonicity = 0;
    var i, rank, previous, difference, increasing, decreasing;
    for (i = 0; i < cells; i++) {
      rank = board[i];
      if (rank === 0) { empty++; continue; }
      if (rank > max) max = rank;
    }
    for (var axis = 0; axis < 2; axis++) {
      for (var line = 0; line < size; line++) {
        previous = 0;
        increasing = 0;
        decreasing = 0;
        for (i = 0; i < size; i++) {
          rank = axis ? board[i * size + line] : board[line * size + i];
          if (rank === 0) continue;
          if (previous) {
            difference = rank - previous;
            smoothness += difference < 0 ? -difference : difference;
            if (difference === 0) pairs++;
            if (difference > 0) increasing += difference;
            else decreasing -= difference;
          }
          previous = rank;
        }
        monotonicity -= increasing < decreasing ? increasing : decreasing;
      }
    }
    var last = size - 1;
    var corner = board[0];
    if (board[last] > corner) corner = board[last];
    if (board[last * size] > corner) corner = board[last * size];
    if (board[cells - 1] > corner) corner = board[cells - 1];
    var cornerBonus = corner === max ? max * EVAL_CORNER : -max * EVAL_CORNER;
    return empty * EVAL_EMPTY + pairs * EVAL_PAIR -
      smoothness * EVAL_SMOOTH + monotonicity * EVAL_MONOTONICITY +
      max * EVAL_MAX + cornerBonus;
  }

  function gainOf(delta) {
    return Math.log2(1 + delta) * GAIN_WEIGHT;
  }

  function visit() {
    run.nodes++;
    if (run.nodes > run.maxNodes) throw EXHAUSTED;
  }

  // 时钟必须按"每次进节点"检查：缓存命中不走 visit()，只按展开数查时钟的话，
  // 命中多、展开少的区段就能绕过 timeBudgetMs。
  function guard() {
    if ((++run.probes & 63) === 0 && now() >= run.deadline) throw EXHAUSTED;
  }

  function cacheKey(board, depth, chance) {
    var cells = run.cells, i;
    if (KEY_CODES.length !== cells) {
      KEY_CODES = [];
      for (i = 0; i < cells; i++) KEY_CODES[i] = 0;
    }
    for (i = 0; i < cells; i++) KEY_CODES[i] = board[i] + CHAR_OFFSET;
    return depth + ":" + chance + ":" + String.fromCharCode.apply(null, KEY_CODES);
  }

  function search(board, depth, chance, won) {
    guard();
    // won 是路径相关状态，不能进缓存，必须先判；剩余深度越大说明越早达成目标。
    if (run.stopAtTarget && won) return WON;
    var cache = run.cache;
    var key = cacheKey(board, depth, chance);
    if (cache.has(key)) return cache.get(key);
    visit();

    var value, i, child;
    if (!hasMovesFlat(board)) {
      // 败着之间偏好后死者：depth 越小代表活得越久，扣分越少。
      value = LOST;
    } else if (chance) {
      var cells = run.cells, emptyCount = 0;
      for (i = 0; i < cells; i++) if (board[i] === 0) emptyCount++;
      if (!emptyCount) {
        value = search(board, depth, false, won);
      } else {
        value = 0;
        for (i = 0; i < cells; i++) {
          if (board[i] !== 0) continue;
          child = alloc();
          child.set(board);
          child[i] = 1;
          value += TWO_RATE * search(child, depth, false, won) / emptyCount;
          release();
          child = alloc();
          child.set(board);
          child[i] = 2;
          value += FOUR_RATE * search(child, depth, false, won) / emptyCount;
          release();
        }
      }
    } else if (depth === 0) {
      value = evaluateFlat(board);
    } else {
      value = LOST;
      var next = alloc(), scored, childWon;
      for (var direction = 0; direction < 4; direction++) {
        slideFlat(board, next, direction);
        if (!slidMoved) continue;
        childWon = won || slidMergedRank >= run.target;
        scored = gainOf(slidGain) + search(next, depth - 1, true, childWon);
        if (scored > value) value = scored;
      }
      release();
    }
    cache.set(key, value);
    return value;
  }

  function chooseMove(state, options) {
    options = options || {};
    if (!GameLogic.isValidState(state) || state.stuck) return null;

    var size = state.size;
    run.size = size;
    run.cells = size * size;
    run.lines = linesFor(size);
    var target = state.targetTile;
    run.target = Math.log2(target === undefined || target === null
      ? DEFAULT_TARGET
      : target);
    run.stopAtTarget = !state.won && options.stopAtTarget !== false;
    run.nodes = 0;
    run.probes = 0;
    run.maxNodes = options.maxNodes === undefined
      ? 16000
      : Math.max(0, options.maxNodes);
    var maxDepth = options.maxDepth === undefined
      ? 4
      : Math.max(1, Math.min(6, options.maxDepth));
    run.deadline = now() + (options.timeBudgetMs === undefined
      ? 60
      : Math.max(0, options.timeBudgetMs));
    run.cache = new Map();

    if (POOL_CELLS !== run.cells) {
      POOL.length = 0;
      POOL_CELLS = run.cells;
    }
    // 上一轮搜索可能抛 EXHAUSTED 提前退出，缓冲区栈必须重置。
    POOL_TOP = 0;
    if (LINE.length !== size) LINE = new Int32Array(size);

    var root = load(state.cells);
    var candidates = [];
    var direction, board, won, candidate, best, value, i;
    for (direction = 0; direction < 4; direction++) {
      board = alloc();
      slideFlat(root, board, direction);
      if (!slidMoved) { release(); continue; }
      won = !!state.won || slidMergedRank >= run.target;
      candidates.push({
        direction: direction,
        board: board,
        gain: slidGain,
        won: won
      });
    }
    if (!candidates.length) return null;

    // 先完整评估一步，作为预算耗尽或异常时的兜底方向。
    var choice = {
      direction: candidates[0].direction,
      value: -Infinity,
      depth: 0,
      nodes: 0
    };
    var anyWin = false;
    for (i = 0; i < candidates.length; i++) {
      candidate = candidates[i];
      value = run.stopAtTarget && candidate.won
        ? WON
        : evaluateFlat(candidate.board);
      value += gainOf(candidate.gain);
      if (candidate.won) anyWin = true;
      if (value > choice.value) {
        choice.direction = candidate.direction;
        choice.value = value;
      }
    }
    if (run.stopAtTarget && anyWin) {
      choice.nodes = run.nodes;
      return choice;
    }

    // 逐层加深：只有完整跑完一层才采用它的结果，避免预算耗尽时偏向
    // 恰好先算完的方向。
    for (var depth = 1;
         depth <= maxDepth && run.nodes < run.maxNodes && now() < run.deadline;
         depth++) {
      var best = { value: -Infinity, direction: choice.direction };
      try {
        for (i = 0; i < candidates.length; i++) {
          candidate = candidates[i];
          value = gainOf(candidate.gain) +
            search(candidate.board, depth - 1, true, candidate.won);
          if (value > best.value) {
            best.value = value;
            best.direction = candidate.direction;
          }
        }
      } catch (error) {
        if (error !== EXHAUSTED) throw error;
        break;
      }
      choice.direction = best.direction;
      choice.value = best.value;
      choice.depth = depth;
    }
    choice.nodes = run.nodes;
    return choice;
  }

  return { chooseMove: chooseMove };
}));