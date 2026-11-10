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

// ---- a click on a diff row (gutter 122 px, list 1000 px wide: the chip spans 876..988)
const rc = (o) => X.rowClick({ x: 500, w: 1000, shift: false, gutterW: 122, composing: false, editing: false, sel: null, path: "a.py", k: "+10", rangeOk: false, ...o });
assert.deepEqual(rc({ x: 60 }), { sel: { path: "a.py", a: "+10", b: "+10" }, open: true }, "anywhere on the line numbers: the composer");
assert.deepEqual(rc({ x: 110 }).open, true, "the sign column counts as gutter");
assert.deepEqual(rc({}), { sel: { path: "a.py", a: "+10", b: "+10" }, open: false }, "a click on code selects");
assert.deepEqual(rc({ sel: { path: "a.py", a: "+10", b: "+10" } }).sel, null, "again: unselects");
const sel = { path: "a.py", a: "+10", b: "+10" };
assert.deepEqual(rc({ k: "+17", shift: true, sel, rangeOk: true }), { sel: { path: "a.py", a: "+10", b: "+17" }, open: true }, "shift-click completing a range opens the composer");
assert.deepEqual(rc({ k: "+17", shift: true, sel, rangeOk: true, composing: true }).open, true, "also with a composer open");
assert.equal(rc({ k: "+17", shift: true, sel, rangeOk: true, composing: true, editing: true }).open, false, "an edited comment keeps its composer");
assert.equal(rc({ k: "+17", shift: true, sel: { ...sel, path: "b.py" }, rangeOk: false }).open, false, "another file: a new selection");
assert.deepEqual(rc({ x: 900, sel: { path: "a.py", a: "+3", b: "+10" } }), { sel: { path: "a.py", a: "+3", b: "+10" }, open: true }, "the chip on the selection's last row");
assert.equal(rc({ x: 900, k: "+11", sel }).open, false, "no chip on other rows");
assert.deepEqual(rc({ composing: true, sel }), { sel, focus: true }, "the open composer keeps its line");

// ---- keys: shortcuts only while the review itself has the keyboard
assert.equal(X.keyRoute({ typing: "draft", rootFocused: false, key: "n" }), "typing");
assert.equal(X.keyRoute({ typing: false, rootFocused: false, key: "n" }), "pass", "an input keeps its letters");
assert.equal(X.keyRoute({ typing: false, rootFocused: false, key: "escape" }), "blur");
assert.equal(X.keyRoute({ typing: false, rootFocused: true, key: "j" }), "shortcut");

console.log("explore ok");
