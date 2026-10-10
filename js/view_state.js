/*
 * 纯状态 → 视图对象的唯一转换点。
 *
 * GameLogic 的状态是纯数据（cells[x][y] + 事件），HTMLActuator 需要的是
 * 带 previousPosition / mergedFrom 的 Grid/Tile。单机与联机共用这一份实现，
 * 否则两条渲染链路会各自演化，动画迟早不一致。
 */
var ViewState = {
  /*
   * state  : GameLogic 权威状态
   * events : applyMove 返回的动画事件；不传表示静态渲染（例如载入存档）
   */
  buildGrid: function (state, events) {
    var size = state.size;
    var grid = new Grid(size);
    var x, y;

    for (x = 0; x < size; x++) {
      for (y = 0; y < size; y++) {
        var cell = state.cells[x][y];
        if (cell) {
          grid.insertTile(new Tile({ x: x, y: y }, cell.value, cell.interference));
        }
      }
    }

    var hasAnimation = !!events;
    events = events || { moved: [], merges: [] };
    if (events.spawn) {
      var spawned = grid.cellContent(events.spawn.position);
      if (spawned) spawned.spawned = true;
    }

    // 旧 actuator 通过 previousPosition 区分既有方块和新生成方块。
    // 让未移动的方块从原位开始渲染，只有 spawn 保留 tile-new 动画。
    if (hasAnimation) {
      var spawn = events.spawn && events.spawn.position;
      for (x = 0; x < size; x++) {
        for (y = 0; y < size; y++) {
          var stableTile = grid.cells[x][y];
          if (!stableTile) continue;
          if (spawn && spawn.x === x && spawn.y === y) continue;
          stableTile.savePosition();
        }
      }
    }

    (events.moved || []).forEach(function (move) {
      var tile = grid.cellContent(move.to);
      if (tile) tile.savePositionFrom(move.from);
    });

    (events.merges || []).forEach(function (merge) {
      var merged = grid.cellContent(merge.to);
      if (!merged) return;

      merged.previousPosition = null;
      merged.mergedFrom = merge.from.map(function (source) {
        var tile = new Tile(merge.to, source.value, source.interference);
        // 方块可能先滑过空格再参与合并，保留原坐标让渲染器完成滑入动画。
        tile.savePositionFrom(source.position);
        return tile;
      });
    });

    return grid;
  }
};
