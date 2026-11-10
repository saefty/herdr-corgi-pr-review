// Run: node test_comments.mjs  (inline composer rows, GitHub review payloads, the agent review prompt)
import assert from "node:assert/strict";
import { diffRows, selection, buildReview, diffLines, inDiff, ghReview, lineThreads, suggestionBlock, itemKeys, lineKey } from "./pr.js";

const rows = diffRows(["@@ -1,4 +1,4 @@", " a", "-b", "+B", "+C", " d"]);
const hunks = [{ path: "x.js", rows }];
const lines = diffLines(hunks);
assert.deepEqual([...lines.get("x.js")].sort(), ["L1", "L2", "L3", "R1", "R2", "R3", "R4"]);

// Composer and threads under the right row: under the selection's last row, after the comments there.
const one = { id: "c1", file: "x.js", ...selection(rows, 3), text: "Why?" };
assert.deepEqual(lineThreads(rows[3], [one], { composeKey: "+2" }).map((i) => i.t), ["comment", "cact", "compose", "composeact"]);
assert.deepEqual(lineThreads(rows[4], [one], { composeKey: "+2" }), []);
assert.deepEqual(lineThreads(rows[2], [one], { composeKey: "+2" }), []); // removed line 2 is another row than new line 2
// Editing: the composer takes the comment's place, and no second composer opens at the selection.
assert.deepEqual(lineThreads(rows[3], [one], { composeKey: "+2", editId: "c1" }).map((i) => i.t), ["compose", "composeact"]);
// GitHub's comments: by side.
const gh = [{ id: 9, line: 2, side: "LEFT" }, { id: 8, line: 2, side: "RIGHT" }];
assert.deepEqual(lineThreads(rows[2], [], { gh }).map((i) => i.g.id), [9]);
assert.deepEqual(lineThreads(rows[3], [], { gh }).map((i) => i.g.id), [8]);
// Stable, unique keys for the new rows.
const keys = itemKeys([{ t: "compose" }, { t: "composeact" }, { t: "gh", g: { id: 9 } }]);
assert.deepEqual(keys, ["x|compose", "x|composeact", "gh|9"]);

// Suggestion block: the selected new-side lines.
assert.equal(suggestionBlock(rows.slice(3, 6)), "```suggestion\nB\nC\nd\n```");

// GitHub payload: single line, range, LEFT side, a suggestion, and a comment outside the diff moved into the body.
const single = { id: "a", file: "x.js", ...selection(rows, 4), text: " Name? " };
const range = { id: "b", file: "x.js", ...selection(rows, 3, 4), text: "```suggestion\nB2\nC2\n```" };
const left = { id: "c", file: "x.js", ...selection(rows, 2), text: "Keep this" };
const outside = { id: "d", file: "x.js", start: 40, end: 41, old: false, text: "Context far below" };
const other = { id: "e", file: "y.js", start: 3, end: 3, old: false, text: "Not changed here" };
assert.equal(inDiff(lines, single), true);
assert.equal(inDiff(lines, outside), false);
const { payload, outside: moved } = ghReview({ comments: [single, range, left, outside, other], event: "request_changes", summary: " Needs work ", commit: "abc", lines });
assert.equal(payload.commit_id, "abc");
assert.equal(payload.event, "REQUEST_CHANGES");
assert.deepEqual(payload.comments, [
  { path: "x.js", line: 3, side: "RIGHT", body: "Name?" },
  { path: "x.js", line: 3, side: "RIGHT", start_line: 2, start_side: "RIGHT", body: "```suggestion\nB2\nC2\n```" },
  { path: "x.js", line: 2, side: "LEFT", body: "Keep this" },
]);
assert.deepEqual(moved.map((c) => c.id), ["d", "e"]);
assert.equal(payload.body, "Needs work\n\n**`x.js` lines 40–41**\n\nContext far below\n\n**`y.js` line 3**\n\nNot changed here");
assert.equal(ghReview({ comments: [], event: "approve", commit: "abc", lines }).payload.event, "APPROVE");
assert.equal(ghReview({ comments: [single], commit: "abc", lines }).payload.event, "COMMENT");

// The agent prompt: unchanged without a verdict; with one, the verdict and the summary.
const base = buildReview({ pr: { number: 7, title: "Fix" }, comments: [{ file: "b.js", text: "Name?" }] });
assert.ok(base.startsWith('PR #7 "Fix": code review with 1 point. '));
const verdict = buildReview({ pr: { number: 7, title: "Fix" }, comments: [{ file: "b.js", text: "Name?" }], event: "request_changes", summary: "Close." });
assert.ok(verdict.startsWith('PR #7 "Fix": code review (changes requested) with 1 point. '));
assert.ok(verdict.includes("\n\nOverall: Close.\n\n1. `b.js`\nName?"));
assert.equal(lineKey(rows[3]), "+2");
console.log("ok comments");

// The review layout: installed when missing, kept when it is ours, installed as "pr-review" beside someone else's "review".
import { layoutPlan, isReviewLayout } from "./pr.js";
import { readFileSync } from "node:fs";
const ours = readFileSync(new URL("./review-layout.json", import.meta.url), "utf8");
assert.equal(isReviewLayout(ours), true);
assert.deepEqual(layoutPlan(null, null), { name: "review", write: true });
assert.deepEqual(layoutPlan(ours, null), { name: "review", write: false });
const foreign = JSON.stringify({ id: "root", type: "row", children: [{ id: "a", type: "block", content: { mod: "notes" } }] });
assert.deepEqual(layoutPlan(foreign, null), { name: "pr-review", write: true });
assert.deepEqual(layoutPlan(foreign, ours), { name: "pr-review", write: false });
assert.equal(isReviewLayout("not json"), false);
console.log("ok layout");
