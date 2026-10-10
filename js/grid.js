function Grid(size, previousState) {
  this.size = size;
  this.cells = previousState ? this.fromState(previousState) : this.empty();
}

// Build a grid of the specified size
Grid.prototype.empty = function () {
  var cells = [];

  for (var x = 0; x < this.size; x++) {
    var row = cells[x] = [];

    for (var y = 0; y < this.size; y++) {
      row.push(null);
    }
  }

  return cells;
};

Grid.prototype.fromState = function (state) {
  var cells = [];
  state = Array.isArray(state) ? state : [];

  for (var x = 0; x < this.size; x++) {
    var row = cells[x] = [];
    var sourceRow = Array.isArray(state[x]) ? state[x] : [];

    for (var y = 0; y < this.size; y++) {
      var tile = sourceRow[y];
      if (!tile) {
        row.push(null);
        continue;
      }

      // 兼容旧存档的对象格式，也接受早期方案中的裸数字格子。
      var value = typeof tile === "number" ? tile : tile.value;
      if (typeof value !== "number" || !isFinite(value) ||
          value <= 0 || Math.floor(value) !== value) {
        row.push(null);
        continue;
      }

      // 网格下标是权威坐标；忽略损坏或过期的 position，避免构造 Tile 时抛错。
      var position = { x: x, y: y };
      var interference = typeof tile === "object" && tile.interference === true;
      row.push(new Tile(position, value, interference));
    }
  }

  return cells;
};

// Deprecated compatibility helper. Random placement belongs to GameLogic.
Grid.prototype.randomAvailableCell = function () {
  var cells = this.availableCells();

  if (cells.length) {
    return cells[0];
  }
};

Grid.prototype.availableCells = function () {
  var cells = [];

  this.eachCell(function (x, y, tile) {
    if (!tile) {
      cells.push({ x: x, y: y });
    }
  });

  return cells;
};

// Call callback for every cell
Grid.prototype.eachCell = function (callback) {
  for (var x = 0; x < this.size; x++) {
    for (var y = 0; y < this.size; y++) {
      callback(x, y, this.cells[x][y]);
    }
  }
};

// Check if there are any cells available
Grid.prototype.cellsAvailable = function () {
  return !!this.availableCells().length;
};

// Check if the specified cell is taken
Grid.prototype.cellAvailable = function (cell) {
  return !this.cellOccupied(cell);
};

Grid.prototype.cellOccupied = function (cell) {
  return !!this.cellContent(cell);
};

Grid.prototype.cellContent = function (cell) {
  if (this.withinBounds(cell)) {
    return this.cells[cell.x][cell.y];
  } else {
    return null;
  }
};

// Inserts a tile at its position
Grid.prototype.insertTile = function (tile) {
  this.cells[tile.x][tile.y] = tile;
};

Grid.prototype.removeTile = function (tile) {
  this.cells[tile.x][tile.y] = null;
};

Grid.prototype.withinBounds = function (position) {
  return position.x >= 0 && position.x < this.size &&
         position.y >= 0 && position.y < this.size;
};

Grid.prototype.serialize = function () {
  var cellState = [];

  for (var x = 0; x < this.size; x++) {
    var row = cellState[x] = [];

    for (var y = 0; y < this.size; y++) {
      row.push(this.cells[x][y] ? this.cells[x][y].serialize() : null);
    }
  }

  return {
    size: this.size,
    cells: cellState
  };
};
