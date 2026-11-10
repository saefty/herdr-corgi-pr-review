// Run: node test_explore.mjs  (explore.js: the left column's width, ask answers and threads, the drill-down's
// breadcrumb and cache, explorations without a diff, the analysis' scope line)
import assert from "node:assert/strict";
import * as X from "./explore.js";
import { archLayout } from "./arch.js";

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
assert.deepEqual(rc({ x: 840, sel }), { sel, ask: true }, "the Ask chip left of it asks about the selection");
assert.deepEqual(rc({ composing: true, sel }), { sel, focus: true }, "the open composer keeps its line");

// ---- keys: shortcuts only while the review itself has the keyboard
assert.equal(X.keyRoute({ typing: "draft", rootFocused: false, key: "n" }), "typing");
assert.equal(X.keyRoute({ typing: false, rootFocused: false, key: "n" }), "pass", "an input keeps its letters");
assert.equal(X.keyRoute({ typing: false, rootFocused: false, key: "escape" }), "blur");
assert.equal(X.keyRoute({ typing: false, rootFocused: true, key: "j" }), "shortcut");

// ---- Ask: the scope, the hunks it sends, the answer kept to what exists
const arch = { groups: [{ id: "w", label: "Workers", kind: "Lambda" }],
  nodes: [{ id: "api", group: "w", label: "API", description: "", type: "api", status: "changed", at: "src/api.py:10" },
    { id: "stages", group: "w", label: "Stages handler", description: "", type: "service", status: "new", evidence: "src/stages.py:4" },
    { id: "db", group: "w", label: "DB", description: "", type: "data", status: "unchanged" }],
  edges: [{ from: "api", to: "stages", label: "starts", evidence: "src/api.py:22" }, { from: "stages", to: "db", label: "writes" }] };
const ai = { arch, steps: [{ title: "Layer A", why: "w", text: "t", hunks: ["h1"], evidence: ["src/mail.py:3"], visuals: [{ kind: "flow", nodes: [{ id: "a", label: "A", at: "src/flow.py:9" }], edges: [] }] }] };
const sc = X.scopeOf(ai, { node: "stages" });
assert.equal(sc.kind, "node");
assert.deepEqual(sc.edges.map((e) => e.id), ["e0", "e1"]);
assert.deepEqual(X.scopeFiles(sc), ["src/stages.py", "src/api.py"]);
assert.deepEqual(X.scopeFiles(X.scopeOf(ai, { layer: 0 })), ["src/mail.py", "src/flow.py"]);
assert.equal(X.scopeOf(ai, null).kind, "picture");
assert.equal(X.scopeOf(ai, { node: "x1", label: "inner()", at: "a.py:1" }).node.label, "inner()", "a sub-diagram's node");
const hunks = [{ id: "h1", path: "src/other.py", lines: ["@@ -1 +1 @@", "+x"] }, { id: "h2", path: "repo/src/stages.py", lines: ["@@ -1 +1 @@", "+y"] }, { id: "h3", path: "src/zzz.py", lines: ["+z"] }];
assert.deepEqual(X.hunksFor(["src/stages.py"], hunks, ["h1"]).map((h) => h.path), ["src/other.py", "repo/src/stages.py"], "the layer's hunks first, then by file");
assert.equal(X.hunksFor(["src/stages.py"], hunks, [], 12, 5).length, 0, "bounded by size");

const a = X.mapAnswer({ text: " Weil … ", highlights: { nodes: ["stages", "ghost", "stages"], edges: ["e1", "e9"] }, evidence: [{ at: "src/stages.py:12", why: "hier" }, { at: "nope" }] }, arch);
assert.deepEqual(a, { text: "Weil …", highlights: { nodes: ["stages"], edges: ["e1"] }, evidence: [{ at: "src/stages.py:12", why: "hier" }] });
assert.deepEqual(X.mapAnswer(null, null), { text: "", highlights: { nodes: [], edges: [] }, evidence: [] });
const L = archLayout(arch);
const hi = X.highlightOf(L, a);
assert.equal(hi.focus, "stages");
assert.ok(L.paths.find((p) => p.num === hi.hl).edges.includes(1), "the highlighted edge's path");
assert.deepEqual(X.highlightOf(L, { highlights: { nodes: [], edges: [] } }), { focus: null, hl: null });

// Threads: per PR, the last 6 turns, the newest 40 PRs; history sends the last 4.
let doc = {};
for (let i = 0; i < 9; i++) doc = X.threadAdd(doc, "pr1", { q: `q${i}`, a: { text: `a${i}` } }, 1000 + i);
assert.deepEqual(X.threadOf(doc, "pr1").map((t) => t.q), ["q3", "q4", "q5", "q6", "q7", "q8"]);
assert.deepEqual(X.history(X.threadOf(doc, "pr1")), [{ q: "q5", a: "a5" }, { q: "q6", a: "a6" }, { q: "q7", a: "a7" }, { q: "q8", a: "a8" }]);
for (let i = 0; i < 45; i++) doc = X.threadAdd(doc, `p${i}`, { q: "x", a: { text: "" } }, 5000 + i);
assert.equal(Object.keys(doc).length, 40);
assert.ok(!doc.pr1 && doc.p44 && !doc.p4 && doc.p5, "the oldest threads go");
assert.deepEqual(X.threadOf(doc, "nope"), []);

console.log("explore ok");
