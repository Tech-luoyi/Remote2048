"use strict";

var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var vm = require("node:vm");
var GameLogic = require("../js/game_logic");
var passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log("Passed: " + name);
}

function stateWith(tiles) {
  var state = GameLogic.createInitialState(123, { startTiles: 0 });
  tiles.forEach(function (tile) {
    state.cells[tile[0]][tile[1]] = {
      position: { x: tile[0], y: tile[1] }, value: tile[2], interference: false
    };
  });
  return state;
}

// Run the real actuator against a deterministic DOM, clock, and animation lifecycle.
function harness(options) {
  options = options || {};
  var now = 0;
  var nextId = 0;
  var frames = new Map();
  var timers = new Map();
  var animations = [];
  var windowListeners = {};
  var cell = options.cell || 95;
  var gap = options.gap || 12;
  var roots = {};
  var preference = { matches: false, listeners: {}, addEventListener: function (name, fn) { this.listeners[name] = fn; } };

  function matches(node, selector) {
    return selector.charAt(0) === "." && selector.slice(1).split(".").every(function (name) {
      return node.classList.contains(name);
    });
  }
  function element(className) {
    var node = {
      tagName: "DIV", className: className || "", attributes: {}, children: [], parentNode: null,
      style: { setProperty: function (key, value) { this[key] = value; }, removeProperty: function (key) { delete this[key]; } },
      listeners: {}, offsetWidth: Math.round(cell), offsetHeight: Math.round(cell),
      appendChild: function (child) {
        if (child.parentNode) child.parentNode.removeChild(child);
        this.children.push(child);
        child.parentNode = this;
        return child;
      },
      removeChild: function (child) {
        var index = this.children.indexOf(child);
        if (index < 0) throw new Error("Removing a child from the wrong parent");
        this.children.splice(index, 1);
        child.parentNode = null;
        return child;
      },
      remove: function () { if (this.parentNode) this.parentNode.removeChild(this); },
      setAttribute: function (key, value) {
        this.attributes[key] = String(value);
        if (key === "class") this.className = String(value);
      },
      getAttribute: function (key) { return key === "class" ? this.className : this.attributes[key]; },
      addEventListener: function (key, fn) { this.listeners[key] = fn; },
      removeEventListener: function (key, fn) { if (this.listeners[key] === fn) delete this.listeners[key]; },
      querySelectorAll: function (selector) {
        var found = [];
        this.children.forEach(function visit(child) {
          if (selector.split(",").some(function (part) { return matches(child, part.trim()); })) found.push(child);
          child.children.forEach(visit);
        });
        return found;
      },
      querySelector: function (selector) { return this.querySelectorAll(selector)[0] || null; },
      getElementsByTagName: function () { return this.children; },
      getBoundingClientRect: function () {
        var position = this.className.match(/tile-position-(\d)-(\d)/);
        return {
          left: 430 + gap + (position ? Number(position[1]) - 1 : 0) * (cell + gap),
          top: 160 + gap + (position ? Number(position[2]) - 1 : 0) * (cell + gap),
          width: cell, height: cell
        };
      }
    };
    Object.defineProperty(node, "firstChild", { get: function () { return this.children[0] || null; } });
    Object.defineProperty(node, "parentElement", { get: function () { return this.parentNode; } });
    Object.defineProperty(node, "isConnected", { get: function () { return !!this.parentNode; } });
    var text = "";
    Object.defineProperty(node, "textContent", {
      get: function () { return text; },
      set: function (value) {
        this.children.forEach(function (child) { child.parentNode = null; });
        this.children.length = 0;
        text = String(value);
      }
    });
    node.classList = {
      contains: function (name) { return node.className.split(/\s+/).includes(name); },
      add: function (name) { if (!this.contains(name)) node.className = (node.className + " " + name).trim(); },
      remove: function (name) { node.className = node.className.split(/\s+/).filter(function (part) { return part !== name; }).join(" "); },
      toggle: function (name, force) {
        var add = typeof force === "boolean" ? force : !this.contains(name);
        if (add) this.add(name); else this.remove(name);
        return add;
      }
    };
    if (!options.noAnimate) {
      node.animate = function (keyframes, settings) {
        var resolveFinished;
        var rejectFinished;
        var finished;
        var animation = {
          node: node, frames: keyframes, settings: settings, playState: "running", canceled: false,
          finish: function () {
            if (this.playState !== "running") return;
            timers.delete(this.timer);
            this.playState = "finished";
            if (resolveFinished) resolveFinished(this);
            if (this.onfinish) this.onfinish();
          },
          cancel: function () {
            timers.delete(this.timer);
            this.playState = "idle";
            this.canceled = true;
            if (rejectFinished) rejectFinished(new Error("Animation canceled"));
            if (this.oncancel) this.oncancel();
          }
        };
        Object.defineProperty(animation, "finished", { get: function () {
          if (!finished) finished = new Promise(function (resolve, reject) { resolveFinished = resolve; rejectFinished = reject; });
          return finished;
        } });
        animation.timer = ++nextId;
        if (!options.silentAnimations) {
          timers.set(animation.timer, { at: now + settings.duration, fn: function () { animation.finish(); } });
        }
        animations.push(animation);
        return animation;
      };
    }
    return node;
  }

  ["tile-container", "score-container", "score-gain-container", "best-container", "game-message", "max-tile", "motion-toggle", "autoplay-button", "autoplay-status", "game-container"].forEach(function (name) {
    roots["." + name] = element(name);
  });
  element("milestone").appendChild(roots[".max-tile"]);
  element().appendChild(roots[".motion-toggle"]);
  roots[".autoplay-button"].appendChild(element("autoplay-label"));
  roots[".autoplay-button"].appendChild(element("icon"));
  ["result-icon", "result-score", "message-text"].forEach(function (name) { roots[".game-message"].appendChild(element(name)); });
  var html = element();
  var document = {
    documentElement: html, createElement: function (tag) { var node = element(); node.tagName = tag.toUpperCase(); return node; },
    querySelector: function (selector) { return roots[selector] || null; }
  };
  var window = {
    requestAnimationFrame: function (fn) { frames.set(++nextId, fn); return nextId; },
    cancelAnimationFrame: function (id) { frames.delete(id); },
    setTimeout: function (fn, duration) { timers.set(++nextId, { at: now + (Number(duration) || 0), fn: fn }); return nextId; },
    clearTimeout: function (id) { timers.delete(id); },
    getComputedStyle: function () {
      return { width: cell + "px", getPropertyValue: function (name) { return name === "--gap" ? gap + "px" : ""; } };
    },
    matchMedia: function () { return preference; },
    addEventListener: function (name, fn) { windowListeners[name] = fn; }
  };
  var context = vm.createContext({ GameLogic: GameLogic, document: document, window: window });
  ["grid", "tile", "view_state", "html_actuator"].forEach(function (file) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/" + file + ".js"), "utf8"), context);
  });
  var actuator = new context.HTMLActuator();

  async function tick(duration) {
    var until = now + duration;
    for (var count = 0; count < 1000; count++) {
      var entries = Array.from(timers.entries()).filter(function (entry) { return entry[1].at <= until; });
      entries.sort(function (a, b) { return a[1].at - b[1].at; });
      if (!entries.length) { now = until; await Promise.resolve(); return; }
      now = entries[0][1].at;
      timers.delete(entries[0][0]);
      entries[0][1].fn();
      await Promise.resolve();
    }
    throw new Error("Animation timers did not settle");
  }
  return {
    context: context, actuator: actuator, roots: roots, html: html, preference: preference,
    frames: frames, timers: timers, animations: animations, tick: tick,
    resize: function () { windowListeners.resize(); },
    flushFrames: function () {
      var callbacks = Array.from(frames.values());
      frames.clear();
      callbacks.forEach(function (fn) { fn.call(window, now); });
    },
    tiles: function () { return roots[".tile-container"].children; },
    sources: function () { return roots[".tile-container"].querySelectorAll(".tile-merge-source"); }
  };
}

function metadata(score) {
  return { score: score || 0, bestScore: score || 0, won: false, over: false, terminated: false };
}

function mergeGrid(h, value, target, sources) {
  target = target || { x: 1, y: 2 };
  sources = sources || [{ x: 0, y: 2 }, { x: 3, y: 2 }];
  var grid = new h.context.Grid(4);
  var result = new h.context.Tile(target, value || 64);
  result.mergedFrom = sources.map(function (from) {
    var source = new h.context.Tile(target, result.value / 2);
    source.savePositionFrom(from);
    return source;
  });
  grid.insertTile(result);
  return grid;
}

function translate(frame) {
  var match = frame.transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
  assert.ok(match, "Movement must use a pixel translation: " + frame.transform);
  return [Number(match[1]), Number(match[2])];
}

async function main() {
  await check("view state retains merge origins and marks only the spawned tile", function () {
    var h = harness();
    var result = GameLogic.applyMove(stateWith([[1, 0, 2], [3, 0, 2], [0, 2, 8]]), 3);
    var grid = h.context.ViewState.buildGrid(result.state, result.events);
    var merged = grid.cells[0][0];
    assert.equal(merged.mergedFrom.length, 2);
    assert.deepEqual(Array.from(merged.mergedFrom, function (tile) { return tile.previousPosition.x; }).sort(), [1, 3]);
    var spawn = result.events.spawn.position;
    assert.equal(grid.cells[spawn.x][spawn.y].spawned, true);
    assert.equal(grid.cells[0][2].spawned, undefined);
    assert.equal(merged.spawned, undefined);
  });

  await check("static boards render visible tiles without replaying spawn animations", function () {
    var h = harness();
    h.actuator.actuate(h.context.ViewState.buildGrid(stateWith([[0, 0, 2], [2, 1, 64]])), metadata());
    h.flushFrames();
    assert.equal(h.tiles().length, 2);
    h.tiles().forEach(function (tile) { assert.notEqual(tile.firstChild.style.visibility, "hidden"); });
    assert.equal(h.animations.filter(function (animation) { return animation.node.classList.contains("tile-inner"); }).length, 0);
    assert.equal(h.sources().length, 0);
  });

  await check("only the genuine spawned tile receives an appearance animation", async function () {
    var h = harness();
    var result = GameLogic.applyMove(stateWith([[1, 0, 2], [2, 2, 8]]), 3);
    h.actuator.actuate(h.context.ViewState.buildGrid(result.state, result.events), metadata());
    h.flushFrames();
    var appearances = h.animations.filter(function (animation) {
      return animation.node.classList.contains("tile-inner") && animation.frames[0].opacity === 0;
    });
    assert.equal(appearances.length, 1);
    assert.match(appearances[0].node.parentNode.className, /tile-new/);
    await h.tick(1000);
    assert.equal(h.actuator.animationJobs.length, 0);
  });

  await check("motion-enabled actuation completes when rAF supplies window as this", async function () {
    var h = harness();
    h.actuator.actuate(mergeGrid(h), metadata(64));
    assert.doesNotThrow(h.flushFrames);
    assert.equal(h.roots[".max-tile"].textContent, "64");
    assert.equal(h.roots[".score-container"].textContent, "64");
    await h.tick(1000);
    assert.equal(h.sources().length, 0);
    assert.equal(h.tiles().length, 1);
    assert.notEqual(h.tiles()[0].firstChild.style.visibility, "hidden");
  });

  for (var geometry of [{ cell: 95, gap: 12 }, { cell: 60.75, gap: 9 }]) {
    await check("merge movement uses layout pixels at cell width " + geometry.cell, async function () {
      var h = harness(geometry);
      h.actuator.actuate(mergeGrid(h), metadata(64));
      h.flushFrames();
      var sourceAnimations = h.animations.filter(function (animation) { return animation.node.classList.contains("tile-merge-source"); });
      assert.equal(sourceAnimations.length, 2);
      var step = geometry.cell + geometry.gap;
      assert.deepEqual(sourceAnimations.map(function (animation) { return translate(animation.frames[0]); }), [[0, 2 * step], [3 * step, 2 * step]]);
      assert.deepEqual(sourceAnimations.map(function (animation) { return translate(animation.frames[animation.frames.length - 1]); }), [[step, 2 * step], [step, 2 * step]]);
      var result = h.tiles().find(function (tile) { return !tile.classList.contains("tile-merge-source"); });
      assert.equal(result.firstChild.style.visibility, "hidden");
      sourceAnimations[0].finish();
      await Promise.resolve();
      assert.equal(result.firstChild.style.visibility, "hidden", "One arriving source cannot reveal the result");
      sourceAnimations[1].finish();
      await Promise.resolve();
      assert.notEqual(result.firstChild.style.visibility, "hidden");
      await h.tick(1000);
      assert.equal(h.sources().length, 0);
      assert.equal(h.timers.size, 0);
      assert.equal(h.actuator.animationJobs.length, 0);
    });
  }

  await check("same-frame updates render the final board without invented intermediate movement", async function () {
    var h = harness();
    h.actuator.actuate(mergeGrid(h, 64), metadata(64));
    h.actuator.actuate(mergeGrid(h, 128), metadata(192));
    assert.equal(h.frames.size, 1);
    h.flushFrames();
    assert.equal(h.sources().length, 0);
    assert.equal(h.tiles().length, 1);
    assert.equal(h.tiles()[0].firstChild.textContent, "128");
    assert.notEqual(h.tiles()[0].firstChild.style.visibility, "hidden");
    assert.equal(h.animations.filter(function (animation) { return animation.node.classList.contains("tile"); }).length, 0);
    await h.tick(1000);
  });

  await check("simultaneous merges reveal and settle each result independently", async function () {
    var h = harness();
    var result = GameLogic.applyMove(stateWith([[1, 0, 32], [3, 0, 32], [0, 2, 64], [2, 2, 64]]), 3);
    h.actuator.actuate(h.context.ViewState.buildGrid(result.state, result.events), metadata(result.state.score));
    h.flushFrames();
    var sources = h.animations.filter(function (animation) { return animation.node.classList.contains("tile-merge-source"); });
    assert.equal(sources.length, 4);
    var results = h.tiles().filter(function (tile) { return tile.classList.contains("tile-merged"); });
    assert.equal(results.length, 2);
    results.forEach(function (tile) { assert.equal(tile.firstChild.style.visibility, "hidden"); });
    sources[0].finish();
    sources[1].finish();
    await Promise.resolve();
    assert.notEqual(results[0].firstChild.style.visibility, "hidden");
    assert.equal(results[1].firstChild.style.visibility, "hidden");
    sources[2].finish();
    sources[3].finish();
    await Promise.resolve();
    assert.notEqual(results[1].firstChild.style.visibility, "hidden");
    var pulses = h.animations.filter(function (animation) {
      return animation.node.classList.contains("tile-inner") && animation.frames.length === 3;
    });
    assert.equal(pulses.length, 2, "Each result receives exactly one contact pulse");
    await h.tick(1000);
    assert.equal(h.sources().length, 0);
    assert.equal(h.tiles().length, 3, "Two results plus the genuinely spawned tile remain");
    assert.equal(h.actuator.animationJobs.length, 0);
    assert.equal(h.timers.size, 0);
  });

  await check("resizing during a merge settles results and invalidates cached pixel geometry", async function () {
    var h = harness({ cell: 75.75, gap: 8 });
    h.actuator.actuate(mergeGrid(h), metadata(64));
    h.flushFrames();
    assert.equal(h.sources().length, 2);
    assert.equal(h.actuator.tileStep, 83.75);
    var lateCallbacks = h.animations.map(function (animation) { return animation.onfinish; }).filter(Boolean);
    h.resize();
    assert.equal(h.actuator.tileStep, null);
    assert.equal(h.sources().length, 0);
    assert.equal(h.tiles().length, 1);
    assert.notEqual(h.tiles()[0].firstChild.style.visibility, "hidden");
    assert.equal(h.actuator.animationJobs.length, 0);
    assert.equal(h.timers.size, 0);
    var animationCount = h.animations.length;
    lateCallbacks.forEach(function (fn) { fn(); });
    await h.tick(1000);
    assert.equal(h.animations.length, animationCount);
    assert.equal(h.actuator.animationJobs.length, 0);
  });

  await check("restart cancels pending victory and ignores late animation callbacks", async function () {
    var h = harness();
    h.actuator.actuate(mergeGrid(h), metadata(64));
    h.flushFrames();
    var lateCallbacks = h.animations.map(function (animation) { return animation.onfinish; }).filter(Boolean);
    h.actuator.actuate(mergeGrid(h, 2048), Object.assign(metadata(2048), { won: true, terminated: true }));
    h.actuator.continueGame();
    h.actuator.actuate(h.context.ViewState.buildGrid(stateWith([[0, 0, 2]])), metadata());
    h.flushFrames();
    var animationCount = h.animations.length;
    lateCallbacks.forEach(function (fn) { fn(); });
    await h.tick(1000);
    assert.equal(h.animations.length, animationCount, "Old merges cannot animate the restarted board");
    assert.equal(h.tiles().length, 1);
    assert.equal(h.tiles()[0].firstChild.textContent, "2");
    assert.equal(h.roots[".score-container"].textContent, "0");
    assert.equal(h.roots[".game-message"].getAttribute("aria-hidden"), "true");
    assert.equal(h.timers.size, 0);
  });

  await check("a superseding render settles the displayed board before the replacement frame", async function () {
    var h = harness();
    h.actuator.actuate(mergeGrid(h), metadata(64));
    h.flushFrames();
    var displayed = h.tiles().find(function (tile) { return !tile.classList.contains("tile-merge-source"); });
    assert.equal(displayed.firstChild.style.visibility, "hidden");
    var lateCallbacks = h.animations.map(function (animation) { return animation.onfinish; }).filter(Boolean);
    h.actuator.actuate(mergeGrid(h, 128), metadata(192));
    assert.equal(h.sources().length, 0);
    assert.notEqual(displayed.firstChild.style.visibility, "hidden", "Canceled merge must not leave a blank cell before the next rAF");
    assert.equal(h.actuator.animationJobs.length, 0);
    lateCallbacks.forEach(function (fn) { fn(); });
    assert.equal(h.actuator.animationJobs.length, 0);
    h.flushFrames();
    await h.tick(1000);
    assert.equal(h.tiles().length, 1);
    assert.equal(h.tiles()[0].firstChild.textContent, "128");
    assert.equal(h.actuator.animationJobs.length, 0);
  });

  await check("disabling motion settles an in-flight merge and clears scheduled work", async function () {
    var h = harness();
    h.actuator.actuate(mergeGrid(h), metadata(64));
    h.flushFrames();
    var lateCallbacks = h.animations.map(function (animation) { return animation.onfinish; }).filter(Boolean);
    h.actuator.motionToggle.checked = false;
    h.actuator.updateMotion();
    assert.equal(h.html.classList.contains("motion-off"), true);
    assert.equal(h.sources().length, 0);
    assert.notEqual(h.tiles()[0].firstChild.style.visibility, "hidden");
    var animationCount = h.animations.length;
    lateCallbacks.forEach(function (fn) { fn(); });
    await h.tick(1000);
    assert.equal(h.animations.length, animationCount);
    assert.equal(h.animations.filter(function (animation) { return animation.playState === "running"; }).length, 0);
    assert.equal(h.timers.size, 0);
    assert.equal(h.frames.size, 0);
    assert.equal(h.actuator.animationJobs.length, 0);
  });

  await check("system reduced-motion preference overrides the user switch", function () {
    var h = harness();
    h.actuator.motionToggle.checked = true;
    h.preference.matches = true;
    h.preference.listeners.change({ matches: true });
    assert.equal(h.html.classList.contains("motion-off"), true);
    assert.equal(h.actuator.motionToggle.disabled, true);
    assert.equal(h.actuator.motionToggle.parentElement.title, "系统已启用减少动态效果");
    h.actuator.actuate(mergeGrid(h), metadata(64));
    h.flushFrames();
    assert.equal(h.sources().length, 0);
    assert.equal(h.animations.length, 0);
    assert.notEqual(h.tiles()[0].firstChild.style.visibility, "hidden");
  });

  await check("fifteen accelerated moves leave no sources and retain speed on the final move", async function () {
    var normal = harness();
    normal.actuator.actuate(mergeGrid(normal), metadata(64));
    normal.flushFrames();
    var normalDuration = normal.animations.find(function (animation) { return animation.node.classList.contains("tile-merge-source"); }).settings.duration;
    await normal.tick(1000);
    var h = harness();
    h.html.classList.add("autoplay-active");
    var durations = [];
    for (var i = 0; i < 15; i++) {
      var before = h.animations.length;
      h.actuator.actuate(mergeGrid(h), metadata((i + 1) * 64));
      if (i === 14) h.html.classList.remove("autoplay-active");
      h.flushFrames();
      var sourceAnimations = h.animations.slice(before).filter(function (animation) { return animation.node.classList.contains("tile-merge-source"); });
      assert.equal(sourceAnimations.length, 2);
      durations.push(sourceAnimations[0].settings.duration);
      await h.tick(350 / 2);
      assert.equal(h.sources().length, 0, "Sources must finish within the automatic cadence");
      assert.equal(h.tiles().length, 1);
      assert.notEqual(h.tiles()[0].firstChild.style.visibility, "hidden");
    }
    assert.ok(durations[0] < normalDuration);
    assert.equal(durations[0], normalDuration / 2);
    durations.forEach(function (duration) { assert.equal(duration, durations[0]); });
    await h.tick(1000);
    assert.equal(h.timers.size, 0);
    assert.equal(h.animations.filter(function (animation) { return animation.playState === "running"; }).length, 0);
    assert.equal(h.actuator.animationJobs.length, 0);
  });

  await check("missing animation finish events still reveal results and release every job", async function () {
    var h = harness({ silentAnimations: true });
    h.actuator.actuate(mergeGrid(h, 128), metadata(128));
    h.flushFrames();
    assert.equal(h.sources().length, 2);
    await h.tick(1000);
    assert.equal(h.sources().length, 0);
    assert.notEqual(h.tiles()[0].firstChild.style.visibility, "hidden");
    assert.equal(h.actuator.animationJobs.length, 0);
    assert.equal(h.timers.size, 0);
    assert.equal(h.animations.filter(function (animation) { return animation.playState === "running"; }).length, 0);
  });

  await check("CSS fallback finishes merges and disabling it cancels pending frames", async function () {
    var h = harness({ noAnimate: true });
    h.actuator.actuate(mergeGrid(h), metadata(64));
    h.flushFrames();
    h.flushFrames();
    await h.tick(1000);
    assert.equal(h.sources().length, 0);
    assert.equal(h.tiles().length, 1);
    assert.notEqual(h.tiles()[0].firstChild.style.visibility, "hidden");
    h.actuator.actuate(mergeGrid(h, 128), metadata(192));
    h.flushFrames();
    h.actuator.motionToggle.checked = false;
    h.actuator.updateMotion();
    h.flushFrames();
    await h.tick(1000);
    assert.equal(h.sources().length, 0);
    assert.notEqual(h.tiles()[0].firstChild.style.visibility, "hidden");
    assert.equal(h.frames.size, 0);
    assert.equal(h.timers.size, 0);
  });

  await check("every positive score delta gets a readable gain outside the score value", async function () {
    var h = harness();
    var layer = h.roots[".score-gain-container"];
    h.actuator.updateScore(4);
    assert.equal(layer.children.length, 1);
    var gain = layer.firstChild;
    assert.equal(gain.tagName, "SPAN");
    assert.equal(gain.className, "score-gain");
    assert.equal(gain.textContent, "+4");
    assert.equal(h.roots[".score-container"].textContent, "4");
    assert.equal(h.roots[".score-container"].children.length, 0);
    var animation = h.animations.find(function (entry) { return entry.node === gain; });
    assert.ok(animation, "Low score deltas must animate too");
    assert.equal(animation.frames[animation.frames.length - 1].opacity, 0);
    assert.match(animation.frames[animation.frames.length - 1].transform, /translateY\(-10px\)/);
    assert.equal(h.actuator.scoreGainJobs.length, 1);
    h.actuator.updateScore(4);
    assert.equal(layer.firstChild, gain, "An unchanged score must keep the current gain");
    assert.equal(h.animations.filter(function (entry) { return entry.node.classList.contains("score-gain"); }).length, 1);
    await h.tick(1200);
    assert.equal(layer.children.length, 0);
    assert.equal(h.actuator.scoreGainJobs.length, 0);
    assert.equal(h.timers.size, 0);
  });

  await check("consecutive scoring replaces the gain without piling up labels or stale cleanup", async function () {
    var h = harness();
    var layer = h.roots[".score-gain-container"];
    h.actuator.updateScore(4);
    var previous = layer.firstChild;
    var previousAnimation = h.animations.find(function (entry) { return entry.node === previous; });
    var lateFinish = previousAnimation.onfinish;
    await h.tick(40);
    h.actuator.updateScore(12);
    var latest = layer.firstChild;
    assert.notEqual(latest, previous);
    assert.equal(previous.parentNode, null);
    assert.equal(previousAnimation.canceled, true);
    assert.equal(layer.children.length, 1);
    assert.equal(latest.textContent, "+8");
    assert.equal(h.actuator.scoreGainJobs.length, 1);
    lateFinish();
    assert.equal(layer.firstChild, latest, "A replaced gain cannot remove the new one");
    await h.tick(1200);
    assert.equal(layer.children.length, 0);
    assert.equal(h.actuator.scoreGainJobs.length, 0);
  });

  await check("a render without scoring preserves the gain through a new render generation", async function () {
    var h = harness();
    h.actuator.updateScore(4);
    var layer = h.roots[".score-gain-container"];
    var gain = layer.firstChild;
    var animation = h.animations.find(function (entry) { return entry.node === gain; });
    await h.tick(40);
    h.actuator.actuate(h.context.ViewState.buildGrid(stateWith([[0, 0, 2]])), metadata(4));
    assert.equal(layer.firstChild, gain);
    h.flushFrames();
    assert.equal(layer.firstChild, gain);
    assert.equal(animation.canceled, false);
    assert.equal(h.actuator.scoreGainJobs.length, 1);
    await h.tick(1200);
    assert.equal(layer.children.length, 0, "Finish must still remove gains from a previous generation");
    assert.equal(h.actuator.scoreGainJobs.length, 0);
    assert.equal(h.timers.size, 0);
  });

  await check("coalesced scoring renders still show the complete visible score increase", async function () {
    var h = harness();
    var grid = h.context.ViewState.buildGrid(stateWith([[0, 0, 2]]));
    h.actuator.actuate(grid, metadata(4));
    h.actuator.actuate(grid, metadata(12));
    h.flushFrames();
    assert.equal(h.roots[".score-gain-container"].firstChild.textContent, "+12");
    assert.equal(h.actuator.scoreGainJobs.length, 1);
    await h.tick(1200);
    assert.equal(h.actuator.scoreGainJobs.length, 0);
  });

  for (var cleanup of ["restart", "decrease", "motion-off", "system-reduced-motion"]) {
    await check(cleanup + " clears score gains and their pending work", async function () {
      var h = harness();
      h.actuator.updateScore(4);
      var layer = h.roots[".score-gain-container"];
      var old = layer.firstChild;
      var lateFinish = h.animations.find(function (entry) { return entry.node === old; }).onfinish;
      if (cleanup === "restart") h.actuator.continueGame();
      if (cleanup === "decrease") h.actuator.updateScore(0);
      if (cleanup === "motion-off") {
        h.actuator.motionToggle.checked = false;
        h.actuator.updateMotion();
      }
      if (cleanup === "system-reduced-motion") {
        h.preference.matches = true;
        h.preference.listeners.change({ matches: true });
      }
      assert.equal(layer.children.length, 0);
      assert.equal(h.actuator.scoreGainJobs.length, 0);
      lateFinish();
      await h.tick(1200);
      assert.equal(layer.children.length, 0);
      assert.equal(h.actuator.scoreGainJobs.length, 0);
      if (cleanup === "motion-off" || cleanup === "system-reduced-motion") {
        h.actuator.updateScore(8);
        assert.equal(layer.children.length, 0, "Disabled motion cannot create score effects");
      }
    });
  }

  await check("score gain CSS fallback animates and removes labels without WAAPI", async function () {
    var h = harness({ noAnimate: true });
    h.actuator.updateScore(4);
    var layer = h.roots[".score-gain-container"];
    var gain = layer.firstChild;
    assert.equal(gain.textContent, "+4");
    assert.ok(gain.style.animation, "Fallback must play an actual CSS animation");
    assert.equal(h.actuator.scoreGainJobs.length, 1);
    h.actuator.actuate(h.context.ViewState.buildGrid(stateWith([[0, 0, 2]])), metadata(4));
    h.flushFrames();
    assert.equal(layer.firstChild, gain);
    await h.tick(1200);
    assert.equal(layer.children.length, 0);
    assert.equal(h.actuator.scoreGainJobs.length, 0);
    assert.equal(h.timers.size, 0);
    h.actuator.updateScore(12);
    h.actuator.continueGame();
    assert.equal(layer.children.length, 0);
    assert.equal(h.actuator.scoreGainJobs.length, 0);
    await h.tick(1200);
    assert.equal(h.timers.size, 0);
  });

  console.log("UI adapter checks passed: " + passed);
}

main().catch(function (error) { console.error(error); process.exitCode = 1; });
