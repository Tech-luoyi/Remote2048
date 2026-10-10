"use strict";

function RateLimiter(limit, windowMs, clock) {
  this.limit = limit || 30;
  this.windowMs = windowMs || 1000;
  this.clock = clock || Date.now;
  this.timestamps = [];
}

RateLimiter.prototype.allow = function (now) {
  now = now === undefined ? this.clock() : now;
  var cutoff = now - this.windowMs;
  while (this.timestamps.length && this.timestamps[0] <= cutoff) {
    this.timestamps.shift();
  }
  if (this.timestamps.length >= this.limit) return false;
  this.timestamps.push(now);
  return true;
};

RateLimiter.prototype.reset = function () {
  this.timestamps.length = 0;
};

module.exports = RateLimiter;
