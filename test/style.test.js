"use strict";

var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var execFileSync = require("node:child_process").execFileSync;
var root = path.resolve(__dirname, "..");
var sassCli = path.join(path.dirname(require.resolve("sass")), "sass.js");
var compiled = execFileSync(process.execPath, [sassCli, "--no-source-map", "--style=expanded", "style/main.scss"], {
  cwd: root, encoding: "utf8"
});
assert.equal(fs.readFileSync(path.join(root, "style/main.css"), "utf8"), compiled,
  "main.css is stale. Run npm run build:css and commit both style files.");
console.log("Style source and generated CSS match.");
