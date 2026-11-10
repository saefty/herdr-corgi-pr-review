// Run: node test_pr.mjs
import assert from "node:assert/strict";
import { diffRows, buildPrompt, nextChange, splitPatch, selection, lineLabel, anchorRow, buildReview, hunksOf, budget,
  mapReview, suspectComment, fileRows, fileTree, reviewRequest, stepKey, lowValue, lineKey, rangeOf } from "./pr.js";

const rows = diffRows(["@@ -1,3 +1,3 @@", " a", "-b", "+B", " c", "@@ -10,2 +10,2 @@", " x", "+y"]);
assert.deepEqual(rows[3], { kind: "+", number: 2, n: 2, text: "B" });
assert.deepEqual(rows[2], { kind: "-", number: 2, o: 2, text: "b" });
assert.deepEqual([rows[1].o, rows[1].n, rows[4].o, rows[4].n], [1, 1, 3, 3]);
assert.equal(rows[7].number, 11);

const p = buildPrompt({ pr: { number: 7, title: "Fix" }, file: "a.js", anchor: { ...selection(rows, 2), hunk: "-b" }, question: " Why? " });
assert.equal(p, "PR #7 \"Fix\": question about `a.js` line 2 (old, removed).\n\n```diff\n-b\n```\n\nWhy?");
assert.equal(buildPrompt({ base: "origin/main", question: "Fine?" }), "Branch diff against origin/main: question.\n\nFine?");
assert.equal(buildPrompt({ base: "origin/main", question: "Fine?", lang: "German" }), "Branch diff against origin/main: question.\n\nFine?\n\nAnswer in German.");
assert.equal(buildPrompt({ base: "b", question: "?", lang: "English" }).includes("Answer in"), false);
assert.equal(buildPrompt({ pr: { number: 7, title: "Fix", url: "https://github.com/o/r/pull/7" }, question: "?" }), "PR #7 \"Fix\" (https://github.com/o/r/pull/7): question.\n\n?");

// gh pr diff: one entry per file, new name (old one when deleted), counts only from hunks.
const patch = splitPatch(["diff --git a/a b.js b/a b.js", "index 1..2 100644", "--- a/a b.js", "+++ b/a b.js", "@@ -1,2 +1,2 @@", "-x", "+y", "+--- not a header",
  "diff --git a/gone.txt b/gone.txt", "deleted file mode 100644", "--- a/gone.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye",
  "diff --git a/img.png b/img.png", "Binary files a/img.png and b/img.png differ", ""].join("\n"));
assert.deepEqual(patch.map((f) => [f.path, f.add, f.del, f.binary]), [["a b.js", 2, 1, false], ["gone.txt", 0, 1, false], ["img.png", 0, 0, true]]);
assert.equal(patch[0].lines[3], "@@ -1,2 +1,2 @@");
// A range: new-side numbers, context stops at the hunk header, removed-only ranges use old numbers.
const r2 = diffRows(["@@ -1,5 +1,5 @@", " a", " b", "-c", "+C", "+D", " e", " f", " g", " h", "@@ -20 +20 @@", " z"]);
const sel = selection(r2, 5, 3);
assert.deepEqual([sel.start, sel.end, sel.old], [3, 4, false]);
assert.equal(sel.hunk, "@@ -1,5 +1,5 @@\n a\n b\n-c\n+C\n+D\n e\n f\n g");
assert.equal(lineLabel(sel), "lines 3–4");
const gone = selection(r2, 3);
assert.equal(lineLabel(gone), "line 3 (old, removed)");
assert.equal(anchorRow(r2, gone), 3);
assert.equal(anchorRow(r2, sel), 5);
assert.equal(anchorRow(r2, { end: 99, old: false }), -1);

const review = buildReview({ pr: { number: 7, title: "Fix" }, comments: [{ file: "a.js", ...gone, hunk: "-c", text: "Why removed?" }, { file: "b.js", text: " Name? " }] });
assert.equal(review, "PR #7 \"Fix\": code review with 2 points. Work through the points one by one: answer questions, make the requested changes. At the end, say briefly per point what you did." +
  "\n\n1. `a.js` line 3 (old, removed)\n```diff\n-c\n```\nWhy removed?\n\n2. `b.js`\nName?");

// Hunk ids ignore the @@ numbers (a moved hunk keeps its id), duplicates get a suffix; aliases map back.
const hk = hunksOf(splitPatch(["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1 +1 @@", "-a", "+b", "@@ -9 +9 @@", "-a", "+b", "@@ -20 +20 @@", "+new"].join("\n")));
const moved = hunksOf(splitPatch(["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -5 +5 @@", "-a", "+b"].join("\n")));
assert.deepEqual(hk.map((h) => h.alias), ["h1", "h2", "h3"]);
assert.equal(moved[0].id, hk[0].id);
assert.equal(hk[1].id, hk[0].id + "#2");
// j/k: starts of change blocks, from no selection too.
assert.equal(nextChange(r2, null, 1), 3);
assert.equal(nextChange(r2, 3, 1), -1);
assert.equal(nextChange(rows, 3, 1), 7);
assert.equal(nextChange(rows, 7, -1), 2);
assert.equal(nextChange(rows, null, -1), 7);

// Over budget: later hunks are cut, a smaller one after a big one still fits.
const big = { path: "x", alias: "h1", lines: ["+" + "a".repeat(50)] }, small = { path: "y", alias: "h2", lines: ["+b"] };
assert.deepEqual(budget([small, big, small], 30), { sent: [small, small], cut: ["h1"] });

// ---- review layout
// File status from the patch header.
const st = splitPatch(["diff --git a/n.js b/n.js", "new file mode 100644", "--- /dev/null", "+++ b/n.js", "@@ -0,0 +1 @@", "+x",
  "diff --git a/o.js b/p.js", "similarity index 90%", "rename from o.js", "rename to p.js", "--- a/o.js", "+++ b/p.js", "@@ -1 +1 @@", "-a", "+b"].join("\n"));
assert.deepEqual(st.map((f) => [f.path, f.status, f.from]), [["n.js", "added", undefined], ["p.js", "renamed", "o.js"]]);

// Risk order: high, medium, low, skim, then reading order; aliases map to ids, unknown ones are dropped; questions
// and flows capped at 3; suggestions from the steps (and an older analysis's suspects) land on rows,
// a line the hunk lacks snaps to its first change (approx).
const rh = hunksOf(splitPatch(["diff --git a/a.js b/a.js", "--- a/a.js", "+++ b/a.js", "@@ -10,3 +10,3 @@", " ctx", "-old", "+new", " end",
  "diff --git a/b.test.js b/b.test.js", "--- a/b.test.js", "+++ b/b.test.js", "@@ -1 +1,2 @@", " t", "+t2"].join("\n")));
const fl0 = { function: "f", at: "a.js:11", inputs: [], output: null, trace: Array.from({ length: 20 }, (_, i) => ({ path: "a.js", line: i, values: "x = 1" })) };
const rv = mapReview({ title: "T", steps: [
  { title: "tests", risk: "skim", reading_order: 5, check_questions: ["q"], hunks: ["h2"] },
  { title: "logic", risk: "low", reading_order: 1, why_it_matters: "w", explanation: "e", check_questions: ["1", "2", "3", "4"], hunks: ["h1", "h9"],
    flows: [fl0, fl0, fl0, fl0], suggestions: [{ hunk: "h1", side: "new", line: 11, severity: "high", text: "boom" }, { hunk: "h1", side: "new", line: 99, severity: "medium", text: "far" }] },
  { title: "sec", risk: "high", reading_order: 3, hunks: [] },
  { title: "logic2", risk: "high", reading_order: 2, hunks: [] },
  { title: "old", category: "tests", risk: "high", hunks: [] },
  { title: "odd", risk: "??", hunks: [] }],
  suspects: [{ hunk: "h1", side: "old", line: 11, severity: "low", reason: "gone" }, { hunk: "h7", side: "new", line: 1, severity: "high", reason: "x" }],
  asks: [{ text: "a", coverage: "extra", hunks: ["h2"] }, { text: "b", coverage: "?", hunks: [] }] }, rh);
assert.deepEqual(rv.steps.map((s) => s.title), ["logic2", "sec", "odd", "logic", "tests", "old"]);
assert.deepEqual(rv.steps.map((s) => s.risk), ["high", "high", "medium", "low", "skim", "skim"]);
const lg = rv.steps[3];
assert.deepEqual([lg.hunks, lg.questions.length, lg.why, lg.text, lg.order, lg.flows.length, lg.flows[0].trace.length], [[rh[0].id], 3, "w", "e", 1, 3, 12]);
assert.deepEqual(rv.suspects.map((s) => [s.line, s.old, s.approx, s.severity, s.reason]), [[11, true, false, "low", "gone"], [11, false, false, "high", "boom"], [11, true, true, "medium", "far"]]);
assert.deepEqual(rv.asks.map((a) => [a.coverage, a.hunks]), [["extra", [rh[1].id]], ["absent", []]]);
assert.equal(stepKey(lg), stepKey({ hunks: [rh[0].id], title: "renamed later" }));
// Stale hunk (no lines today): its suspects go, its step keeps the id so the UI can say "veraltet".
assert.deepEqual(mapReview({ steps: [{ title: "s", hunks: ["h1"] }], suspects: [{ hunk: "h1", line: 1, reason: "r" }] }, [{ alias: "h1", id: "gone" }]).suspects, []);

// Suggestion -> pending comment: the same anchor a click on that line gives.
const rows1 = diffRows(rh[0].lines), sc = suspectComment(rv.suspects[1], rows1, "id1");
assert.deepEqual({ ...sc, hunk: undefined }, { id: "id1", file: "a.js", start: 11, end: 11, old: false, hunk: undefined, text: "boom", from: "ki" });
assert.equal(sc.hunk, selection(rows1, rows1.findIndex((r) => r.kind === "+")).hunk);
assert.equal(suspectComment({ ...rv.suspects[1], line: 500 }, rows1, "x"), null);

// Files view: gaps between hunks, opened from either side, whole file; tail unknown until the file is loaded.
const fh = [diffRows(["@@ -3,2 +3,2 @@", "-c", "+C", " d"]), diffRows(["@@ -10 +10 @@", "-j", "+J"])];
const kinds = (rs) => rs.map((r) => (r.kind === "gap" ? `gap${r.gap}:${r.hidden}` : r.kind === "@" ? "@" : `${r.kind.trim()}${r.number}`)).join(" ");
assert.equal(kinds(fileRows(fh, null)), "gap0:2 @ -3 +3 4 gap1:5 @ -10 +10 gap2:null");
const file = Array.from({ length: 12 }, (_, i) => `l${i + 1}`);
assert.equal(kinds(fileRows(fh, file, { 1: { down: 2, up: 1 } })), "gap0:2 @ -3 +3 4 5 6 gap1:2 9 @ -10 +10 gap2:2");
assert.equal(kinds(fileRows(fh, file, { 1: { down: 30 } })), "gap0:2 @ -3 +3 4 5 6 7 8 9 @ -10 +10 gap2:2");
assert.equal(kinds(fileRows(fh, file, {}, true)), "1 2 @ -3 +3 4 5 6 7 8 9 @ -10 +10 11 12");
assert.equal(fileRows(fh, file, {}, true)[0].text, "l1");
// Old numbers of opened context: shifted by the lines added/removed before (here none), after a deletion one less.
assert.deepEqual(fileRows([diffRows(["@@ -2,2 +2 @@", "-x", " y"])], ["a", "y", "z"], {}, true).map((r) => [r.o, r.n]), [[1, 1], [undefined, undefined], [2, undefined], [3, 2], [4, 3]]);
assert.equal(kinds(fileRows([diffRows(["@@ -0,0 +1,2 @@", "+a", "+b"])], null, {}, false, false)), "@ +1 +2");
assert.equal(kinds(fileRows([diffRows(["@@ -5,2 +4,0 @@", "-x", "-y"])], file.slice(0, 6), {}, true)), "1 2 3 4 @ -5 -6 5 6");
assert.equal(fileRows(fh, null)[2].h, 0);

// File tree: folders once, before their files; a closed folder hides everything below it.
const tree = (c) => fileTree(["a.js", "src/x.js", "src/y/z.js", "src/z.js"], new Set(c)).map((n) => `${"  ".repeat(n.depth)}${n.name}${n.dir ? "/" : ""}`).join("|");
assert.equal(tree([]), "a.js|src/|  x.js|  y/|    z.js|  z.js");
assert.equal(tree(["src/y"]), "a.js|src/|  x.js|  y/|  z.js");
assert.equal(tree(["src"]), "a.js|src/");

// Request: low-value hunks are cut first, what's sent stays in diff order, cache names carry the model.
const rq = splitPatch(["diff --git a/package-lock.json b/package-lock.json", "--- a/package-lock.json", "+++ b/package-lock.json", "@@ -1 +1 @@", "-" + "x".repeat(200), "+" + "y".repeat(200),
  "diff --git a/b.js b/b.js", "--- a/b.js", "+++ b/b.js", "@@ -1 +1 @@", "-a", "+b", "diff --git a/c.js b/c.js", "--- a/c.js", "+++ b/c.js", "@@ -1 +1 @@", "-a", "+b"].join("\n"));
assert.ok(lowValue("web/package-lock.json") && lowValue("dist/app.js") && !lowValue("src/lock.js"));
const full = reviewRequest({ url: "u", files: rq, model: "haiku", context: { id: "default", env: null }, dir: "/d" });
assert.deepEqual([full.req.hunks.map((h) => h.alias), full.req.cut], [["h1", "h2", "h3"], []]);
assert.ok(full.out.endsWith("-haiku.json") && full.latest.endsWith("-haiku.json") && full.out !== full.latest);
const MODELS0 = (await import("./pr.js")).MODELS;
const was = MODELS0.haiku.chars; MODELS0.haiku.chars = 100;
const capped = reviewRequest({ url: "u", files: rq, model: "haiku", context: { id: "default", env: null }, dir: "/d" });
MODELS0.haiku.chars = was;
assert.deepEqual([capped.req.hunks.map((h) => h.alias), capped.req.cut], [["h2", "h3"], ["h1"]]);

// Range selection by line keys: survives new row arrays, works either way round and across hunks of a file;
// expanded context in between is part of it, a hidden gap is left out of the quoted code.
const fr = fileRows(fh, file, { 1: { down: 1 } });
const k3 = lineKey(fr.find((r) => r.kind === "+")), k10 = lineKey(fr.filter((r) => r.kind === "+")[1]);
assert.deepEqual([k3, lineKey(fr.find((r) => r.kind === "-")), lineKey(fr.find((r) => r.kind === "@")), lineKey(fr.find((r) => r.kind === "gap"))], ["+3", "-3", null, null]);
const again = fileRows(fh, file, { 1: { down: 1 } }); // a re-render: new objects, same keys
const [lo, hi] = rangeOf(again, k10, k3);
const across = selection(again, lo, hi);
assert.deepEqual([across.start, across.end, across.old], [3, 10, false]);
assert.ok(!across.hunk.includes("undefined") && across.hunk.includes("+C") && across.hunk.includes("+J"));
assert.equal(rangeOf(again, "+3", "+99"), null);
assert.deepEqual(rangeOf(again, "+3", "+3"), [lo, lo]);

console.log("ok");

// Findings: reports (last line wins, half lines skipped) beat the panel's status; moved code asks for a recheck.
const { parseReports, findingStatus, fixPrompt } = await import("./pr.js");
const reps = parseReports('{"id":"a","status":"wontfix"}\n{"id":"a","status":"fixed","commit":"abc"}\n{"id":"b","sta');
assert.deepEqual(Object.keys(reps), ["a"]);
const fa = { id: "a", head: "h1", code: "x()" }, fb = { id: "b", head: "h1", code: "y()" };
assert.equal(findingStatus(fa, {}, reps, "h2", "z()"), "fixed");
assert.equal(findingStatus(fb, { b: { s: "progress" } }, reps, "h1", "y()"), "progress");
assert.equal(findingStatus(fb, {}, reps, "h2", "  y()"), "open");
assert.equal(findingStatus(fb, {}, reps, "h2", "y(1)"), "recheck");
assert.equal(findingStatus(fb, { b: { s: "dismissed" } }, reps, "h2", "y(1)"), "dismissed");
const fp = fixPrompt([{ id: "a1", severity: "high", reviewer: "codex", file: "a.js", line: 3, end: 4, title: "T", detail: "D", suggestion: "S" }], { number: 7, title: "Fix", url: "u" }, "/r.jsonl");
assert.ok(fp.includes("[a1] high · codex · `a.js`:3–4: T") && fp.includes(">> /r.jsonl") && fp.includes('"id": "a1"'));
console.log("ok");

// Open reviews: created once (startedAt kept), merged by url, merged/closed PRs turn done after a day, done ones
// go after 14 days, in-progress ones stay.
const { touchReview, expireReviews, progressLine } = await import("./pr.js");
const D = 86400000;
let reg = touchReview([], { url: "a", progress: { steps: 9, stepsChecked: 1 } }, 1000);
reg = touchReview(reg, { url: "b" }, 2000);
reg = touchReview(reg, { url: "a", progress: { stepsChecked: 3, comments: 2 } }, 3000);
assert.deepEqual(reg.map((r) => [r.url, r.startedAt, r.lastTouched, r.status]), [["a", 1000, 3000, "in-progress"], ["b", 2000, 2000, "in-progress"]]);
assert.equal(progressLine(reg[0].progress), "3/9 steps · 2 comments");
reg = touchReview(reg, { url: "b", status: "sent" }, 4000);
const prsNow = [{ url: "a", state: "merged", updatedAt: new Date(0).toISOString() }];
let ex = expireReviews(reg, prsNow, 2 * D);
assert.deepEqual(ex.map((r) => [r.url, r.status]), [["b", "sent"], ["a", "done"]]);
ex = expireReviews(ex, prsNow, 2 * D + 15 * D);
assert.deepEqual(ex, []);
assert.deepEqual(expireReviews([{ url: "c", status: "in-progress", lastTouched: 0 }], [], 100 * D).map((r) => r.url), ["c"]);
console.log("ok");

// Resume roundtrip: what review.js saves (uiState, as JSON in review-progress.json) comes back as the same fields.
const { resumeFields } = await import("./pr.js");
const ui = { tab: "steps", fileFocus: "a.js", focusHunk: "a.js:abc", cur: 3, order: "reading", fsel: { path: "a.js", a: "+3", b: "+10" }, page: null, model: "opus", values: false };
const back = resumeFields(JSON.parse(JSON.stringify(ui)));
assert.deepEqual(back.fields, { tab: "steps", fileFocus: "a.js", focusHunk: "a.js:abc", cur: 3, order: "reading", fsel: { path: "a.js", a: "+3", b: "+10" }, page: null });
assert.deepEqual([back.scroll, back.model, back.values], ["a.js:abc", "opus", false]);
assert.equal(resumeFields(undefined), null);
console.log("ok");

// List keys: unique, and the same for every other item when a definition card is inserted under a row.
const { itemKeys, expandTabs, offsetAt, tokenAt } = await import("./pr.js");
const krows = diffRows(["@@ -1,2 +1,2 @@", " a", "-b", "+b"]);
const base = krows.map((r, ri) => ({ t: "row", path: "x.py", src: krows, ri }));
base.splice(1, 0, { t: "file", f: { path: "x.py" } });
const k1 = itemKeys(base), withDef = [...base.slice(0, 3), { t: "def", d: { key: "x.py:+1" } }, ...base.slice(3)], k2 = itemKeys(withDef);
assert.equal(new Set(k1).size, k1.length);
assert.deepEqual(k2.filter((k) => !k.startsWith("d|")), k1);
assert.deepEqual(itemKeys([base[2], base[2]]), [k1[2], `${k1[2]}#1`]); // a hunk in two steps
// Click → token → position: tabs expand to the next stop of 4, the character is the UTF-16 offset in the original
// line, the line is the row's new line (old line on a removed row).
assert.equal(expandTabs("\tx\ty"), "    x   y");
assert.deepEqual([offsetAt("\tfoo", 0), offsetAt("\tfoo", 3), offsetAt("\tfoo", 4), offsetAt("\tfoo", 6)], [0, 0, 1, 3]);
const prow = diffRows(["@@ -10,2 +20,2 @@", "-\told_call()", "+\tnew_call(x)"]);
const sp = [{ start: 4, end: 12, kind: "function", ref: true }];
assert.deepEqual(tokenAt(prow[2], sp, 122 + 5 * 8 + 1, 122, 8), { name: "new_call", side: "+", line: 20, character: 1 });
assert.deepEqual(tokenAt(prow[1], [{ start: 4, end: 12, ref: true }], 122 + 4 * 8, 122, 8), { name: "old_call", side: "-", line: 10, character: 1 });
assert.equal(tokenAt(prow[2], sp, 122 + 1 * 8, 122, 8), null); // on the indentation
assert.equal(tokenAt(prow[2], sp, 100, 122, 8), null); // in the gutter
console.log("ok");

// since your last review, verification, pictures, pre-merge checks, triage
{
  const { markReviewed, sinceBase, verifyCandidates, applyVerification, levels, blastArch, preMergeChecks, mergeBlockers, triageOf, findingStatus, mapReview } = await import("./pr.js");
  // A visit marks the head as seen; it never downgrades a sent mark of the same head; send always moves it.
  const sent = markReviewed(null, "a1", "sent", 1);
  assert.deepEqual(sent, { sha: "a1", how: "sent", at: 1 });
  assert.equal(markReviewed(sent, "a1", "seen", 2), sent);
  assert.deepEqual(markReviewed(sent, "b2", "seen", 3), { sha: "b2", how: "seen", at: 3 });
  assert.equal(markReviewed(sent, null, "seen", 3), sent); // head unknown: keep
  assert.equal(sinceBase({ reviewed: sent }, "a1"), null); // nothing moved
  assert.equal(sinceBase({ reviewed: sent }, "b2").sha, "a1");
  assert.equal(sinceBase({}, "b2"), null);

  // Verification: only Fix-sent findings on an older head, not verified on this one; verdicts merge into the status.
  const fs = [{ id: "f1" }, { id: "f2" }, { id: "f3" }, { id: "f4" }];
  const st = { f1: { s: "progress", fixHead: "a1" }, f2: { s: "progress", fixHead: "b2" }, f3: { s: "open" }, f4: { s: "progress", fixHead: "a1", verify: { head: "b2" } } };
  assert.deepEqual(verifyCandidates(fs, st, "b2", () => "progress").map((f) => f.id), ["f1"]);
  const out = applyVerification(st, [{ id: "f1", verdict: "fixed", reason: "guarded" }, { id: "f2", verdict: "not_fixed", reason: "still null" }, { id: "f3", verdict: "unclear", reason: "?" }], "b2", 0);
  assert.equal(out.f1.s, "fixed"); assert.equal(out.f1.fixHead, "a1"); assert.equal(out.f1.verify.reason, "guarded");
  assert.equal(out.f2.s, "open"); assert.equal(out.f2.verify.result, "not_fixed");
  assert.equal(out.f3.s, "open"); assert.equal(out.f3.verify.result, "unclear");
  // A verification beats the agent's "fixed" report.
  assert.equal(findingStatus({ id: "f2" }, out, { f2: { id: "f2", status: "fixed" } }, null, undefined), "open");
  assert.equal(findingStatus({ id: "f2" }, st, { f2: { id: "f2", status: "fixed" } }, null, undefined), "fixed");

  // Columns: longest path from the sources; a cycle does not hang.
  const lv = levels([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }], [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "a", to: "c" }, { from: "x", to: "d" }]);
  assert.deepEqual(["a", "b", "c", "d"].map((k) => lv.get(k)), [0, 1, 2, 0]);
  const cyc = levels([{ id: "p" }, { id: "q" }], [{ from: "p", to: "q" }, { from: "q", to: "p" }]);
  assert.deepEqual([cyc.get("p"), cyc.get("q")], [0, 0]);

  // Architecture: columns by calls, nodes stacked, an edge between columns as segments with its badge on the lane.
  const arch = { groups: [{ id: "web", label: "Web" }, { id: "api", label: "API" }], nodes: [{ id: "ui", group: "web", status: "changed" }, { id: "inv", group: "api", status: "new" }, { id: "db", group: "api", status: "removed" }, { id: "x", group: "nope" }],
    edges: [{ from: "ui", to: "inv", label: "Creates" }, { from: "inv", to: "db", label: "Persists" }] };
  const { archLayout } = await import("./arch.js");
  const L = archLayout(arch);
  assert.deepEqual(L.groups.map((g) => g.label), ["Web", "API", "System"]);
  const [ui, inv, db] = ["ui", "inv", "db"].map((id) => L.nodes.find((n) => n.id === id));
  assert.deepEqual([ui.col, inv.col, db.col], [0, 1, 2]); // inv calls db: db one column right, inside the API group
  const e = L.paths[0];
  assert.ok(e.segments.length >= 2); // the lane leg drops out when both ports are level
  assert.equal(e.segments[0].x1, ui.x + ui.w); // leaves the right edge of the source
  assert.equal(e.segments.at(-1).x2, inv.x); // ends at the left edge of the target
  assert.ok(e.badge.x > ui.x + ui.w && e.badge.x < inv.x && e.label === "Creates" && e.mark === "①");
  assert.ok(L.paths[1].segments.at(-1).x2 === db.x && L.groups[1].x + L.groups[1].w > db.x + db.w); // the API frame spans both columns
  assert.deepEqual(archLayout(arch, "before").nodes.map((n) => n.id).sort(), ["db", "ui", "x"]);
  assert.deepEqual(archLayout(arch, "after").paths.length, 1);
  const b = blastArch({ units: [{ id: "u1", label: "API", status: "added", files: ["api.ts"], spots: 5 }], context: [{ id: "c1", file: "src/perm.ts", direction: "upstream", relation: "Checks admin", links_to: "u1" }, { id: "c2", file: "mail.ts", direction: "downstream", relation: "Sends", links_to: "u1" }] }, [{ file: "api.ts", severity: "high" }]);
  assert.deepEqual(archLayout(b).nodes.map((n) => n.col), [0, 1, 2]);
  assert.deepEqual(b.counts, { added: 1, changed: 0, up: 1, down: 1 });
  assert.equal(b.nodes[1].findings.length, 1);

  // Pre-merge checks and blockers.
  const checks = preMergeChecks({ title: "Fix it", rules: [{ rule: "No secrets", status: "fail", why: "token in config" }, { rule: "Docs", status: "n/a" }],
    ctx: { checks: [{ name: "build", bucket: "pass" }, { name: "lint", bucket: "fail" }, { name: "e2e", bucket: "pending" }, { name: "x", bucket: "skipping" }], mergeable: "CONFLICTING" } });
  assert.deepEqual(checks.map((c) => c.ok), [false, false, true, false, null, false]);
  assert.equal(preMergeChecks({ title: "feat(api): SHELF-1 add x" })[0].ok, true);
  const bl = mergeBlockers({ checks, findings: [{ id: "f", title: "SQL injection", severity: "high", file: "a", line: 1 }, { id: "g", severity: "low" }], unverified: 2,
    related: { open: [{ number: 9, overlap: 2, files: ["a", "b"] }, { number: 10, overlap: 0 }] } });
  assert.deepEqual(bl.map((x) => x.title), ["Code conflicts need to be resolved", "1 CI check is failing", "Rule not met: Conventional Commit title", "Rule not met: No secrets", "SQL injection", "2 fixes are not verified", "Overlaps with open PR #9"]);

  // Triage: type from the prefix, effort from the analysis else the size, P1 for overlap or high risk.
  const tr = triageOf({ pr: { title: "feat(x): y" }, analysis: { effort: { score: 3 }, mergeRisk: { level: "high", why: "auth" } } });
  assert.deepEqual([tr.priority, tr.chips], [1, ["High security risk", "Feature", "Deep review", "Medium effort"]]);
  assert.match(tr.why, /merge risk is high \(auth\)/);
  const small = triageOf({ pr: { title: "docs: z" }, size: { files: 1, lines: 10 } });
  assert.deepEqual([small.priority, small.chips, small.why], [3, ["Docs", "Quick look", "Low effort"], "A quick look should do: small and low risk."]);
  assert.equal(triageOf({ pr: { title: "x" }, related: { open: [{ overlap: 1 }] }, llm: { priority: 2, why: "w" } }).why, "w");

  // Old analyses (no merge risk, rules, pictures) still map.
  const old = mapReview({ steps: [{ title: "t", risk: "high", hunks: [] }] }, []);
  assert.deepEqual([old.mergeRisk, old.effort, old.rules, old.arch, old.blast, old.steps[0].visuals, old.steps[0].isNew], [null, null, [], null, null, [], false]);
  // Several pictures per layer (and for the whole PR); the older single `visual` reads as a list of one.
  const pic = (kind) => ({ kind, title: kind, nodes: [{ id: "a", label: "A" }], edges: [] });
  const vis = mapReview({ visuals: [pic("state_machine")], steps: [{ title: "t", hunks: [], visuals: [pic("architecture"), pic("state_machine"), { kind: "flow", nodes: [] }] }, { title: "u", hunks: [], visual: pic("flow") }] }, []);
  assert.deepEqual(vis.steps.map((s) => s.visuals.map((v) => v.kind)), [["architecture", "state_machine"], ["flow"]]);
  assert.deepEqual(vis.visuals.map((v) => v.kind), ["state_machine"]);
  const neu = mapReview({ merge_risk: { level: "high", why: "w" }, effort: { score: 7 }, rule_checks: [{ rule: "a", status: "pass" }, { rule: "b", status: "fail" }], steps: [{ title: "t", new: true, hunks: [] }] }, []);
  assert.deepEqual([neu.mergeRisk.level, neu.effort.score, neu.rules.map((r) => r.rule), neu.steps[0].isNew], ["high", 5, ["b", "a"], true]);
  console.log("ok since/verify/pictures/checks/triage");
}

// PRs you didn't open
{
  const { parsePrRef, ghTarget, pruneSources } = await import("./pr.js");
  assert.deepEqual(parsePrRef("acme/bookshelf#12"), { repo: "acme/bookshelf", number: 12, url: "https://github.com/acme/bookshelf/pull/12" });
  assert.equal(parsePrRef(" https://github.com/o/r.js/pull/7/files ")?.url, "https://github.com/o/r.js/pull/7"); // a tab of the PR page
  assert.equal(parsePrRef("https://github.com/o/r.js/pull/7").repo, "o/r.js");
  assert.equal(parsePrRef("o/r/pull/7#issuecomment-1").number, 7);
  assert.equal(parsePrRef("nope"), null);
  const t = ghTarget({ number: 5, title: "x", url: "https://github.com/o/r/pull/5", author: { login: "kim" }, isDraft: true, headRefOid: "abc", reviewDecision: "" }, { context: "blue", source: "repo" });
  assert.deepEqual([t.repo, t.author, t.state, t.headSha, t.review, t.session], ["o/r", "kim", "draft", "abc", null, null]);
  assert.equal(ghTarget({ number: 6, url: "u", repository: { nameWithOwner: "a/b" } }, { context: "blue" }).repo, "a/b");
  assert.deepEqual(Object.keys(pruneSources({ a: { at: 1 }, b: { at: 3 }, c: { at: 2 } }, 2)), ["b", "c"]);
  console.log("ok sources");
}
