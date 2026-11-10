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

// ---- Show details: breadcrumb and cache
let st = X.drillPush([], { id: "stages", label: "Stages handler", group: "Workers" });
st = X.drillPush(st, { id: "stages/run", label: "run()" });
assert.deepEqual(X.crumbs(st, "Architecture").map((c) => c.label), ["Architecture", "Workers", "Stages handler", "run()"]);
assert.deepEqual(X.crumbs(st, "Architecture").map((c) => c.depth), [0, null, 1, 2]);
assert.deepEqual(X.drillPush(st, { id: "stages", label: "Stages handler" }).map((x) => x.id), ["stages"], "pushing a level on the stack goes back to it");
assert.deepEqual(X.drillTo(st, 1).map((x) => x.id), ["stages"]);
assert.deepEqual(X.drillTo(st, 0), []);
assert.equal(X.drillKey("pr", "abc", st), "pr|abc|stages/stages/run");
assert.notEqual(X.drillKey("pr", "abc", st), X.drillKey("pr", "def", st), "per diff head");
let cache = {};
for (let i = 0; i < 65; i++) cache = X.cachePut(cache, `k${i}`, { v: i }, X.DRILLS, i);
assert.equal(Object.keys(cache).length, 60);
assert.ok(!cache.k4 && cache.k5 && cache.k64.v === 64);
const d = X.mapDrill({ summary: "s", visual: { kind: "pie", title: "T", nodes: [{ id: "a", label: "load()", values: "id = 7", note: "liest", at: "x.py:3" }, { id: "b", label: "save()" }],
  edges: [{ from: "a", to: "b", label: "{id: 7}" }, { from: "a", to: "ghost" }] } });
assert.equal(d.visual.kind, "flow");
assert.equal(d.visual.nodes[0].note, "liest\n= id = 7");
assert.deepEqual(d.visual.edges.map((e) => e.label), ["{id: 7}"]);
const sm = X.mapDrill({ visual: { kind: "state_machine", nodes: [{ id: "a" }, { id: "b" }], transitions: [{ from: "a", to: "b", event: "go" }] } });
assert.equal(sm.visual.transitions.length, 1);
assert.deepEqual(sm.visual.edges, []);

// ---- Explore: the list, the shape without a diff, the cited files
const e1 = { id: X.exploreId("/r", "How?"), root: "/r", topic: "How?" };
assert.equal(e1.id, X.exploreId("/r", "  how? "), "same repo and topic: one entry");
let ix = { list: [] };
for (let i = 0; i < 22; i++) ix = X.exploreIndex(ix.list, { id: `x${i}`, topic: `t${i}` });
assert.equal(ix.list.length, 20);
assert.deepEqual(ix.dropped, ["x1"]);
assert.deepEqual(X.exploreIndex(ix.list, { id: "x15", topic: "again" }).list.slice(0, 2).map((x) => x.id), ["x15", "x21"], "reopened: on top, once");
const saved = { topic: "Reminder?", root: "/r", model: "sonnet", cost: 0.4, generated: "2026-11-10T10:00:00+01:00", answer: {
  title: "Reminders", summary: "Ein Job …", question: [{ text: "Wie wird erinnert?", source: "existing" }],
  how_it_works: [{ text: "Cron startet", source: "existing", evidence: "infra/cron.tf:4" }], architecture: arch, visuals: [],
  steps: [{ title: "Scheduling", why_it_matters: "w", explanation: "e", reading_order: 2, evidence: ["jobs/schedule.py:10", "bad"], flows: [{ function: "run", at: "jobs/run.py:5", trace: [{ path: "jobs/run.py", line: 6, values: "x = 1" }] }] },
    { title: "Sending", why_it_matters: "w2", explanation: "e2", reading_order: 1, evidence: ["mail/send.py:3"] }] } };
const ex = X.exploreAi(saved);
assert.equal(ex.explore, true);
assert.deepEqual(ex.steps.map((s) => s.title), ["Sending", "Scheduling"], "reading order");
assert.deepEqual(ex.steps.map((s) => s.hunks), [[], []], "no diff");
assert.deepEqual(ex.steps[1].evidence, ["jobs/schedule.py:10"]);
assert.equal(ex.intent[0].text, "Wie wird erinnert?");
assert.equal(ex.behaviorPoints[0].evidence, "infra/cron.tf:4");
assert.deepEqual(ex.files.map((f) => f.path), ["infra/cron.tf", "jobs/run.py", "jobs/schedule.py", "mail/send.py", "src/api.py", "src/stages.py"]);
assert.deepEqual(ex.files.find((f) => f.path === "jobs/run.py").lines, [5, 6]);

// ---- the scope line
assert.equal(X.scopeLine({ files: 41, detailed: 38, skimmed: 3, why: "lockfiles" }), "Read 38 of 41 files in detail, 3 skimmed (lockfiles)");
assert.equal(X.scopeLine({ files: 1, detailed: 1, skimmed: 0, passes: 1 }), "Read 1 of 1 file in detail");
assert.equal(X.scopeLine({ files: 90, detailed: 80, skimmed: 10, passes: 4 }), "Read 80 of 90 files in detail, 10 skimmed · 4 passes");
assert.equal(X.scopeLine(null), "");
console.log("explore ok");
// ---- Explore's trust: no remote, a foreign host, your github.com repo
assert.equal(X.repoOfRemote("https://github.com/Saefty/x.git"), "Saefty/x");
assert.equal(X.repoOfRemote("git@github.com:Saefty/x.git"), "Saefty/x");
assert.equal(X.repoOfRemote("https://evil.example/saefty/x"), null, "only github.com names a repo");
assert.equal(X.repoOfRemote("https://github.com.evil.example/saefty/x"), null);
assert.equal(X.repoOfRemote(""), null);
assert.equal(X.exploreTrust({ repo: null, root: "/tmp/archive", login: "saefty" }), false, "a folder without a remote: untrusted");
assert.equal(X.exploreTrust({ repo: null, root: "/tmp/archive", trustedRoots: ["/tmp/archive"] }), true, "unless you trusted the folder");
assert.equal(X.exploreTrust({ repo: X.repoOfRemote("https://evil.example/saefty/x"), root: "/r", login: "saefty" }), false, "a foreign host with your name: untrusted");
assert.equal(X.exploreTrust({ repo: X.repoOfRemote("git@github.com:SaeFty/x"), root: "/r", login: "saefty" }), true, "your github.com repo, any case");
assert.equal(X.exploreTrust({ repo: "acme/x", root: "/r", login: "saefty" }), false);
assert.equal(X.exploreTrust({ repo: "acme/x", root: "/r", login: "saefty", trustedRepos: ["acme/x"] }), true);
console.log("explore trust ok");
