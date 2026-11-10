// Run: node test_threads.mjs  (threads.js: sent comments as threads, agent replies, GitHub's exact payload, the
// agent preview)
import assert from "node:assert/strict";
import * as TH from "./threads.js";
import { buildReview } from "./pr.js";

// ---- ids: the creation id stays; older comments without one get one from their content, the same every load
const old = { file: "a.py", start: 3, end: 4, old: false, text: "why?" };
assert.equal(TH.commentId(old), TH.commentId({ ...old }));
assert.notEqual(TH.commentId(old), TH.commentId({ ...old, end: 5 }));
assert.equal(TH.commentId({ ...old, id: "lx1" }), "lx1");
assert.deepEqual(TH.withIds([old, { ...old, id: "k" }]).map((c) => c.id), [TH.commentId(old), "k"], "old pending comments still load");

// ---- threads: added once per id, bounded per PR and in PRs
let doc = TH.addThreads({}, "pr1", [{ id: "c1", file: "a.py", start: 3, end: 4, text: "Warum?", hunk: "+x" }], { route: "agent", agent: "PR #7 · main conversation" }, 100);
doc = TH.addThreads(doc, "pr1", [{ id: "c1", file: "a.py", start: 3, end: 4, text: "Warum nochmal?" }], { route: "agent" }, 200);
assert.equal(TH.threadsOf(doc, "pr1").length, 1);
assert.equal(TH.threadsOf(doc, "pr1")[0].text, "Warum nochmal?");
for (let i = 0; i < 55; i++) doc = TH.addThreads(doc, `p${i}`, [{ id: "x", file: "f", end: 1, text: "t" }], { route: "github" }, 1000 + i);
assert.equal(Object.keys(doc).length, 50);
assert.ok(!doc.pr1 && doc.p54);

// ---- replies: parsed per id in file order, merged into the thread; follow-ups between them; fixed folds
const text = ['{"id": "c1", "reply": "Weil X.", "status": "answered"}', "{half", '{"id": "c1", "reply": "Behoben.", "status": "fixed", "commit": "abc1234def"}',
  '{"id": "c2", "reply": "", "status": "fixed"}', '{"id": "c3", "reply": "ok", "status": "weird"}'].join("\n");
const rep = TH.parseReplies(text);
assert.deepEqual(Object.keys(rep), ["c1", "c3"]);
assert.equal(rep.c3[0].status, "answered");
let d = TH.addThreads({}, "pr", [{ id: "c1", file: "a.py", start: 3, end: 4, text: "Warum?" }], { route: "agent" }, 1);
d = TH.addFollowup(d, "pr", "c1", "Und Y?", 1, 2);
const th = TH.threadsOf(d, "pr")[0];
const v = TH.threadView(th, rep.c1);
assert.deepEqual(v.entries.map((e) => [e.who, e.text]), [["agent", "Weil X."], ["you", "Und Y?"], ["agent", "Behoben."]]);
assert.equal(v.status, "fixed");
assert.equal(v.fixedIn, "abc1234def");
assert.equal(v.collapsed, true, "a fixed thread folds to one line");
assert.equal(TH.threadView(th, rep.c1, [], true).collapsed, false, "and opens");
assert.equal(TH.threadView(th, []).status, "sent");
assert.equal(TH.threadView({ ...th, route: "github" }, []).status, "posted");
const gh = [{ id: 9, in_reply_to_id: 5, user: "anna", body: "Seh ich auch so", at: "2026-11-10T10:00:00Z" }, { id: 5, user: "me", body: "root" }];
assert.deepEqual(TH.threadView({ ...th, followups: [], ghId: 5 }, [], TH.ghRepliesTo(gh, 5)).entries.map((e) => e.who), ["anna"], "GitHub replies in the thread");
assert.deepEqual(TH.threadCounts([th, { id: "zz" }], rep, gh), { threads: 2, replies: 2, fixed: 1 });

// ---- the agent: ids and the replies contract in the prompt; the preview sends exactly what it shows
const prompt = buildReview({ pr: { number: 7, title: "T" }, comments: [{ id: "c1", file: "a.py", start: 3, end: 4, text: "Warum?" }], lang: "German", replies: "/x/replies/p.jsonl", contract: TH.repliesContract });
assert.ok(prompt.includes("[c1] `a.py` lines 3–4"));
assert.ok(prompt.includes(`echo '{"id": "c1", "reply": "briefly, what you did or your answer", "status": "fixed", "commit": "<sha>"}' >> /x/replies/p.jsonl`));
assert.ok(!buildReview({ pr: null, base: "main", comments: [{ file: "a", text: "t" }] }).includes(">>"), "the panel's prompt stays without a contract");
const up = TH.followupPrompt({ pr: { number: 7, title: "T" }, thread: th, replies: rep.c1, text: "Und Z?", file: "/x/r.jsonl", lang: "English" });
assert.ok(up.includes("[c1]") && up.includes("You: Weil X.") && up.includes("Reviewer: Und Z?") && up.includes(">> /x/r.jsonl"));
const pv = TH.preview({ what: "Comment", agent: "PR #7 · main conversation", own: "Warum?", prompt });
assert.equal(TH.confirm(pv).text, prompt, "unedited: exactly the preview's text");
assert.equal(TH.confirm(pv, "edited").text, "edited", "edited: exactly the edit");
assert.equal(TH.agentLabel({ tab_name: "PR #7" }, "x"), "PR #7 · main conversation");
assert.ok(TH.agentLabel({ tab_name: "Sub", parent: "t1" }, "x").includes("sub-agent"));
assert.equal(TH.agentLabel(null, "a new Claude tab"), "a new Claude tab");

// ---- GitHub: exactly the ticked items with their edited text; nothing else
const lines = new Map([["a.py", new Set(["R3", "R4", "R10"])]]);
const comments = [{ id: "c1", file: "a.py", start: 3, end: 4, text: "Warum? (edited)" }, { id: "c2", file: "a.py", start: 10, end: 10, text: "Typo" },
  { id: "c3", file: "b.py", start: 1, end: 1, text: "outside" }];
let plan = TH.ghPlan({ comments, off: new Set(["c2"]), summary: "Overall", summaryOn: true, event: "comment", commit: "h", lines, repo: "acme/x#7" });
assert.deepEqual(plan.payload.comments.map((c) => c.body), ["Warum? (edited)"]);
assert.ok(plan.payload.body.includes("Overall") && plan.payload.body.includes("outside"), "out-of-diff notes go into the body when ticked");
assert.equal(plan.label, "Post 1 comment and a review body to acme/x#7 as Comment");
plan = TH.ghPlan({ comments, off: new Set(["c1", "c2", "c3"]), summary: "Overall", summaryOn: false, event: "comment", commit: "h", lines });
assert.equal(plan.ready, false, "nothing ticked and no body: Submit is off");
assert.equal(TH.ghPlan({ comments, off: new Set(["c1", "c2", "c3"]), summaryOn: false, event: "approve", commit: "h", lines }).ready, true, "a verdict alone posts");
const finding = { id: "f1", file: "a.py", line: 3, title: "SQL injection", detail: "…" }, suggestion = { key: "s1", path: "a.py", line: 4, reason: "AI says" };
plan = TH.ghPlan({ comments, summary: "", event: "comment", commit: "h", lines });
assert.ok(!JSON.stringify(plan.payload).includes(finding.title) && !JSON.stringify(plan.payload).includes(suggestion.reason), "findings and AI suggestions never ride along");
plan = TH.ghPlan({ comments: [...comments, { id: "f1c", file: "a.py", start: 3, end: 3, text: `${finding.title}: ${finding.detail}`, from: "security" }], summary: "", event: "comment", commit: "h", lines });
assert.ok(plan.payload.comments.some((c) => c.body.startsWith("SQL injection")), "unless added as a comment");
assert.deepEqual(TH.singlePayload(comments[0], "h", true), { commit_id: "h", path: "a.py", line: 4, side: "RIGHT", start_line: 3, start_side: "RIGHT", body: "Warum? (edited)" });
assert.equal(TH.singlePayload(comments[2], "h", false), null);
assert.equal(TH.postedItems(plan.payload)[1], "a.py:3–4: Warum? (edited)");

// ---- Fix: selection, jobs, the sub-agent's launch, Apply only on a clean checkout
let fx = TH.addThreads({}, "pr", [{ id: "c1", file: "a.py", end: 3, text: "t" }], { route: "agent" }, 1);
fx = TH.toggleSelected(fx, "pr", "c1", 2);
fx = TH.toggleSelected(fx, "pr", "p9", 3);
assert.deepEqual(TH.selectedOf(fx, "pr"), ["c1", "p9"]);
assert.equal(TH.threadsOf(fx, "pr").length, 1, "the selection keeps the threads");
assert.deepEqual(TH.selectedOf(TH.toggleSelected(fx, "pr", "c1", 4), "pr"), ["p9"]);
assert.deepEqual(TH.selectedOf(JSON.parse(JSON.stringify(fx)), "pr"), ["c1", "p9"], "it persists with the threads");
fx = TH.addThreads(fx, "pr", [{ id: "c2", file: "b.py", end: 1, text: "u" }], { route: "agent" }, 5);
assert.deepEqual(TH.selectedOf(fx, "pr"), ["c1", "p9"], "adding threads keeps the selection");
assert.equal(TH.fixBranch(7, ["mwb8736v"]), "fix/7-mwb8736v");
assert.equal(TH.fixBranch(7, ["a", "b", "c"]), "fix/7-a-and-2");
assert.equal(TH.fixPath("/h", "acme/bookshelf", "fix/7-a"), "/h/.herdr/worktrees/bookshelf/fix-7-a");
const job = { id: "j1", branch: "fix/7-c1", path: "/w", base: "/repo", head: "abc", items: [{ kind: "comment", id: "c1" }, { kind: "finding", id: "f1" }], target: "sub", state: "running" };
fx = TH.addFix(fx, "pr", job, 6);
assert.equal(TH.fixFor(fx, "pr", "f1").id, "j1");
assert.equal(TH.fixFor(TH.setFix(fx, "pr", "j1", { state: "applied" }, 7), "pr", "f1"), null, "an applied job is no longer live");
assert.equal(TH.fixCommit(job, {}, {}), null);
assert.equal(TH.fixCommit(job, { c1: [{ status: "answered" }, { status: "fixed", commit: "beef" }] }, {}), "beef", "a comment reply with the commit");
assert.equal(TH.fixCommit(job, {}, { f1: { status: "fixed", commit: "cafe" } }), "cafe", "a finding report with the commit");
const args = TH.subAgentArgs({ parent: "t3", cwd: "/w", name: "fix-j1", env: ["env", "CLAUDE_CONFIG_DIR=/c"], task: "Fix it", job: "j1" });
assert.deepEqual(args.slice(0, 2), ["run", "--bg"]);
assert.ok(args.includes("--no-notify"), "nothing typed into the parent");
assert.equal(args[args.indexOf("--parent") + 1], "t3", "a sub-agent of the PR's agent");
assert.equal(args[args.indexOf("--cwd") + 1], "/w", "in its own worktree");
assert.deepEqual(args.slice(args.indexOf("--") + 1), ["env", "CLAUDE_CONFIG_DIR=/c", "claude", "Fix it"], "on the PR's context");
assert.ok(TH.subAgentArgs({ parent: null, cwd: "/w", name: "n", task: "x", job: "j" }).includes("--no-parent"));
assert.equal(TH.applyPlan({ status: " M src/a.ts\n?? x", head: "abc", branch: "fix/7-c1" }).ok, false, "a dirty checkout: refused");
assert.match(TH.applyPlan({ status: " M a\n", head: "abc", branch: "b" }).reason, /1 uncommitted change/);
assert.deepEqual(TH.applyPlan({ status: "", head: "abc", branch: "fix/7-c1" }), { ok: true, args: ["cherry-pick", "abc..fix/7-c1"] });
assert.ok(TH.applyPrompt(job).includes("git cherry-pick abc..fix/7-c1"));
// The target choice: the sub-agent's text names its worktree, the main agent's doesn't; the preview sends that text.
const sub = TH.fixCommentsPrompt({ pr: { number: 7, title: "T" }, comments: [{ id: "c1", file: "a.py", start: 3, end: 3, text: "Warum?" }], file: "/r.jsonl", branch: "fix/7-c1", path: "/w" });
const main = TH.fixCommentsPrompt({ pr: { number: 7, title: "T" }, comments: [{ id: "c1", file: "a.py", start: 3, end: 3, text: "Warum?" }], file: "/r.jsonl" });
assert.ok(sub.includes("own git worktree /w on branch fix/7-c1") && sub.includes("[c1]") && sub.includes(">> /r.jsonl"));
assert.ok(!main.includes("worktree") && main.includes("[c1]"));
assert.equal(TH.confirm(TH.preview({ what: "Fix", agent: "x", prompt: sub })).text, sub);
console.log("threads ok");
