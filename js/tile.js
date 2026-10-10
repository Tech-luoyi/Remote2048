function Tile(position, value, interference) {
  this.x                = position.x;
  this.y                = position.y;
  this.value            = value === undefined || value === null ? 2 : value;
  this.interference     = !!interference;

  this.previousPosition = null;
  this.mergedFrom       = null; // Tracks tiles that merged together
}

Tile.prototype.savePosition = function () {
  this.previousPosition = { x: this.x, y: this.y };
};

Tile.prototype.savePositionFrom = function (position) {
  this.previousPosition = { x: position.x, y: position.y };
};

Tile.prototype.updatePosition = function (position) {
  this.x = position.x;
  this.y = position.y;
};

Tile.prototype.serialize = function () {
  return {
    position: {
      x: this.x,
      y: this.y
    },
    value: this.value,
    interference: this.interference
  };
};
