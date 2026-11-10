// Run: node test_explore.mjs  (explore.js: the left column's width, ask answers and threads, the drill-down's
// breadcrumb and cache, explorations without a diff, the analysis' scope line)
import assert from "node:assert/strict";
import * as X from "./explore.js";

// ---- the left column: default 560, clamped to 340 .. 65% of the window, null (double-click) is the default again
assert.equal(X.leftWidth(null, 1600), 560);
assert.equal(X.leftWidth(undefined, 0), 560, "window not measured yet: the default");
assert.equal(X.leftWidth(100, 1600), 340);
assert.equal(X.leftWidth(5000, 1600), 1040, "at most 65% of 1600");
assert.equal(X.leftWidth(700.4, 1600), 700);
assert.equal(X.leftWidth(560, 400), 340, "a tiny window still leaves the minimum");

console.log("explore ok");
