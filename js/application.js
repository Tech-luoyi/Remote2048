// Wait till the browser is ready to render the game (avoids glitches)
window.requestAnimationFrame(function () {
  var actuator = new HTMLActuator();
  var input = new KeyboardInputManager();

  /*
   * 单机与联机共用同一个 actuator 和输入管理器。
   * 两个实例会各自维护 renderVersion 和分数基数、却写同一份 DOM，
   * 结果就是动画互相打断、"+N" 飘字错乱。
   */
  function SharedActuator() { return actuator; }
  function SharedInput() { return input; }

  var solo = new GameManager(4, SharedInput, SharedActuator, LocalStorageManager);
  var duel = new DuelController(actuator, {
    onEnter: function () { solo.setActive(false); },
    onExit: function () { solo.setActive(true); solo.actuate(); }
  });

  // GameManager 先注册，联机模式下它已在 move() 里直接返回。
  input.on("move", function (direction) {
    if (duel.active) duel.move(direction);
  });
});
