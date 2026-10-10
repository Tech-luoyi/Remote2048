function HTMLActuator() {
  this.tileContainer = document.querySelector(".tile-container");
  this.scoreContainer = document.querySelector(".score-container");
  this.scoreGainContainer = document.querySelector(".score-gain-container");
  this.bestContainer = document.querySelector(".best-container");
  this.messageContainer = document.querySelector(".game-message");
  this.maxTileContainer = document.querySelector(".max-tile");
  this.motionToggle = document.querySelector(".motion-toggle");
  this.autoplayButton = document.querySelector(".autoplay-button");
  this.autoplayStatus = document.querySelector(".autoplay-status");
  this.motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
  this.score = 0;
  this.maxTile = 0;
  this.frame = null;
  this.renderVersion = 0;
  this.animationJobs = [];
  this.scoreGainJobs = [];
  this.motionSpeed = 1;
  this.tileStep = null;
  this.motionToggle.checked = !this.motionPreference.matches;
  this.motionToggle.disabled = this.motionPreference.matches;
  var self = this;
  this.motionToggle.addEventListener("change", function () { self.updateMotion(); });
  this.motionPreference.addEventListener("change", function (event) {
    self.motionToggle.checked = !event.matches;
    self.motionToggle.disabled = event.matches;
    self.updateMotion();
  });
  window.addEventListener("resize", function () {
    self.resetMotion();
    self.tileStep = null;
  });
  this.updateMotion();
}

HTMLActuator.prototype.actuate = function (grid, metadata) {
  var self = this;
  // A superseded frame never displayed its intermediate board.
  var motion = this.motionEnabled() && this.frame === null;
  var speed = document.documentElement.classList.contains("autoplay-active") ? 2 : 1;
  if (this.frame !== null) window.cancelAnimationFrame(this.frame);
  this.resetTileMotion();
  ++this.renderVersion;
  this.frame = window.requestAnimationFrame(function () {
    self.frame = null;
    self.motionSpeed = speed;
    self.renderMotion = motion && self.motionEnabled();
    self.tileStep = null;
    self.clearContainer(self.tileContainer);
    var maxTile = 0;
    grid.cells.forEach(function (column) {
      column.forEach(function (cell) {
        if (!cell) return;
        maxTile = Math.max(maxTile, cell.value);
        self.addTile(cell);
      });
    });
    self.updateScore(metadata.score);
    self.updateBestScore(metadata.bestScore);
    self.maxTileContainer.textContent = maxTile;
    if (maxTile > self.maxTile && self.maxTile > 0) {
      self.flash(self.maxTileContainer.parentElement);
    }
    self.maxTile = maxTile;
    self.tileContainer.setAttribute("aria-label", "最大方块 " + maxTile);
    self.clearMessage();
    if (metadata.terminated) {
      if (metadata.over) self.message(false, metadata.score);
      else if (metadata.won) self.message(true, metadata.score);
    }
  });
};

HTMLActuator.prototype.continueGame = function () {
  if (this.frame !== null) window.cancelAnimationFrame(this.frame);
  this.frame = null;
  this.resetMotion();
  ++this.renderVersion;
  this.clearMessage();
};

HTMLActuator.prototype.updateAutoplay = function (active, remaining, terminated, completed) {
  document.documentElement.classList.toggle("autoplay-active", active);
  this.autoplayButton.disabled = terminated && !active;
  this.autoplayButton.setAttribute("aria-pressed", String(active));
  this.autoplayButton.setAttribute("aria-label", active ? "停止自动走，剩余 " + remaining + " 步" : "智能走 15 步");
  this.autoplayButton.title = active ? "停止自动走" : "智能走 15 步";
  this.autoplayButton.querySelector(".autoplay-label").textContent = active ? "停止 " + remaining + "/15" : "智能 15 步";
  this.autoplayButton.querySelector(".icon").src = active ? "style/icons/square.svg" : "style/icons/wand-sparkles.svg";
  this.autoplayStatus.textContent = active ? "自动走进行中" : (completed ? "已自动走 " + completed + " 步" : "");
};

HTMLActuator.prototype.motionEnabled = function () {
  return this.motionToggle.checked && !this.motionPreference.matches;
};

HTMLActuator.prototype.updateMotion = function () {
  document.documentElement.classList.toggle("motion-off", !this.motionEnabled());
  if (!this.motionEnabled()) this.resetMotion();
  this.motionToggle.parentElement.title = this.motionPreference.matches
    ? "系统已启用减少动态效果" : "动效";
};

HTMLActuator.prototype.clearContainer = function (container) {
  while (container.firstChild) container.removeChild(container.firstChild);
};

HTMLActuator.prototype.flash = function (element) {
  if (!this.motionEnabled() || this.renderMotion === false || !element) return;
  this.playAnimation(element, [
    { transform: "scale(1)" },
    { transform: "scale(1.04)", offset: 0.4 },
    { transform: "scale(1)" }
  ], 160 / (this.motionSpeed || 1));
};

HTMLActuator.prototype.addTile = function (tile, mergeSource) {
  var self = this;
  var motion = this.renderMotion !== false && this.motionEnabled();
  var wrapper = document.createElement("div");
  var inner = document.createElement("div");
  var classes = ["tile", "tile-" + tile.value, this.positionClass(tile)];
  if (tile.value > 2048) classes.push("tile-super");
  if (tile.interference) classes.push("tile-interference");
  if (mergeSource) classes.push("tile-merge-source");
  if (tile.mergedFrom) classes.push("tile-merged");
  if (tile.spawned) classes.push("tile-new");
  this.applyClasses(wrapper, classes);
  inner.classList.add("tile-inner");
  inner.textContent = tile.value;
  wrapper.appendChild(inner);
  this.tileContainer.appendChild(wrapper);
  if (!motion) return wrapper;

  var slideTime = 110 / (this.motionSpeed || 1);
  if (tile.mergedFrom) {
    inner.style.visibility = "hidden";
    var remaining = tile.mergedFrom.length;
    tile.mergedFrom.forEach(function (source) {
      var node = self.addTile(source, true);
      self.slideTile(node, source.previousPosition || source, tile, slideTime, function () {
        node.remove();
        if (--remaining) return;
        inner.style.visibility = "";
        if (self.motionEnabled() && !self.resettingMotion) self.mergePulse(inner, tile.value);
      });
    });
  } else if (!mergeSource && tile.previousPosition) {
    if (tile.previousPosition.x !== tile.x || tile.previousPosition.y !== tile.y) {
      this.slideTile(wrapper, tile.previousPosition, tile, slideTime);
    }
  } else if (tile.spawned) {
    this.playAnimation(inner, [
      { transform: "scale(0.82)", opacity: 0 },
      { transform: "scale(1)", opacity: 1 }
    ], 140 / (this.motionSpeed || 1));
  }
  return wrapper;
};

HTMLActuator.prototype.slideTile = function (node, from, to, duration, done) {
  if (!this.tileStep) {
    var gap = parseFloat(window.getComputedStyle(this.tileContainer).getPropertyValue("--gap"));
    var width = parseFloat(window.getComputedStyle(node).width) || node.offsetWidth;
    this.tileStep = width + gap;
  }
  var step = this.tileStep;
  if (!isFinite(step) || step <= 0) { if (done) done(); return; }
  this.playAnimation(node, [
    { transform: "translate(" + from.x * step + "px, " + from.y * step + "px)" },
    { transform: "translate(" + to.x * step + "px, " + to.y * step + "px)" }
  ], duration, done);
};

HTMLActuator.prototype.mergePulse = function (inner, value) {
  var large = value >= 128;
  this.playAnimation(inner, [
    { transform: large ? "scale(0.94)" : "scale(0.97)" },
    { transform: large ? "scale(1.07)" : "scale(1.035)", offset: 0.38 },
    { transform: "scale(1)" }
  ], (large ? 200 : 150) / (this.motionSpeed || 1));
};

// Final classes describe the committed board; cancellation reveals that state.
HTMLActuator.prototype.playAnimation = function (element, keyframes, duration, done, group) {
  var self = this, version = this.renderVersion;
  var job = { animation: null, timer: null, settled: false };
  var jobs = group || (this.animationJobs = this.animationJobs || []);
  jobs.push(job);
  job.finish = function () {
    if (job.settled) return;
    job.settled = true;
    window.clearTimeout(job.timer);
    if (job.animation) {
      job.animation.onfinish = null;
      job.animation.oncancel = null;
      job.animation.cancel();
    }
    element.style.animation = "";
    var index = jobs.indexOf(job);
    if (index >= 0) jobs.splice(index, 1);
    if ((group || version === self.renderVersion) && done) done();
  };
  if (typeof element.animate === "function") {
    try {
      job.animation = element.animate(keyframes, {
        duration: duration, easing: "cubic-bezier(0.2, 0.7, 0.25, 1)", fill: "both"
      });
    } catch (error) { /* CSS handles browsers without a usable WAAPI. */ }
  }
  if (job.animation) {
    job.animation.onfinish = job.finish;
    job.animation.oncancel = job.finish;
  } else {
    keyframes.forEach(function (frame, i) {
      element.style.setProperty("--motion-transform-" + i, frame.transform);
      element.style.setProperty("--motion-opacity-" + i, frame.opacity === undefined ? 1 : frame.opacity);
    });
    var name = keyframes.length === 4 ? "motion-gain" : (keyframes.length === 3 ? "motion-pulse" : "motion-slide");
    element.style.animation = name + " " + duration + "ms cubic-bezier(0.2, 0.7, 0.25, 1) both";
  }
  job.timer = window.setTimeout(job.finish, duration + (job.animation ? 32 : 0));
};

HTMLActuator.prototype.resetTileMotion = function () {
  this.resettingMotion = true;
  (this.animationJobs || []).slice().forEach(function (job) { job.finish(); });
  this.resettingMotion = false;
};

HTMLActuator.prototype.resetScoreGain = function () {
  (this.scoreGainJobs || []).slice().forEach(function (job) { job.finish(); });
  if (this.scoreGainContainer) this.clearContainer(this.scoreGainContainer);
};

HTMLActuator.prototype.resetMotion = function () {
  this.resetTileMotion();
  this.resetScoreGain();
};

HTMLActuator.prototype.showScoreGain = function (difference) {
  this.resetScoreGain();
  if (!this.motionEnabled() || !this.scoreGainContainer) return;
  var node = document.createElement("span");
  node.classList.add("score-gain");
  node.textContent = "+" + difference;
  node.setAttribute("data-long", String(difference >= 1000000));
  node.setAttribute("data-wide", String(difference >= 100000000));
  this.scoreGainContainer.appendChild(node);
  this.scoreGainJobs = this.scoreGainJobs || [];
  this.playAnimation(node, [
    { transform: "translateY(6px)", opacity: 0 },
    { transform: "translateY(0)", opacity: 1, offset: 0.12 },
    { transform: "translateY(-5px)", opacity: 1, offset: 0.62 },
    { transform: "translateY(-10px)", opacity: 0 }
  ], this.motionSpeed > 1 ? 480 : 620, function () { node.remove(); }, this.scoreGainJobs);
};

HTMLActuator.prototype.applyClasses = function (element, classes) {
  element.setAttribute("class", classes.join(" "));
};

HTMLActuator.prototype.normalizePosition = function (position) {
  return { x: position.x + 1, y: position.y + 1 };
};

HTMLActuator.prototype.positionClass = function (position) {
  position = this.normalizePosition(position);
  return "tile-position-" + position.x + "-" + position.y;
};

HTMLActuator.prototype.updateScore = function (score) {
  var difference = score - this.score;
  this.score = score;
  this.scoreContainer.textContent = score;
  this.scoreContainer.setAttribute("data-medium", String(score >= 10000));
  this.scoreContainer.setAttribute("data-long", String(score >= 1000000));
  this.scoreContainer.setAttribute("data-wide", String(score >= 100000000));
  if (difference > 0) {
    this.flash(this.scoreContainer);
    this.showScoreGain(difference);
  } else if (difference < 0) this.resetScoreGain();
};

HTMLActuator.prototype.updateBestScore = function (bestScore) {
  this.bestContainer.textContent = bestScore;
  this.bestContainer.setAttribute("data-medium", String(bestScore >= 10000));
  this.bestContainer.setAttribute("data-long", String(bestScore >= 1000000));
  this.bestContainer.setAttribute("data-wide", String(bestScore >= 100000000));
};

HTMLActuator.prototype.message = function (won, score) {
  this.messageContainer.classList.add(won ? "game-won" : "game-over");
  this.messageContainer.setAttribute("aria-hidden", "false");
  this.messageContainer.querySelector(".result-icon").src = won
    ? "style/icons/trophy.svg" : "style/icons/rotate-ccw.svg";
  this.messageContainer.querySelector(".result-score").textContent = "本局分数 " + score;
  this.messageContainer.getElementsByTagName("p")[0].textContent = won ? "你赢了！" : "游戏结束！";
};

HTMLActuator.prototype.clearMessage = function () {
  this.messageContainer.classList.remove("game-won");
  this.messageContainer.classList.remove("game-over");
  this.messageContainer.setAttribute("aria-hidden", "true");
};
