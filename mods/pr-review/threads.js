// Pure helpers (node-testable) for review comments after they leave the pending review: sent and posted comments stay
// as threads under their lines (pr-data/threads.json, per PR, bounded), the agent answers each by id in
// pr-data/replies/<pr hash>.jsonl, GitHub replies come from its review comments. Plus what a GitHub submit posts
// (exactly the ticked items) and the preview before anything is typed into an agent's session.
import { hash, ghReview, lineLabel, answerIn } from "./pr.js";

export const MAX_PRS = 50, MAX_THREADS = 100;
export const STATUSES = ["fixed", "answered", "wontfix", "question"];

// A comment's id: the one it was made with (Date.now base 36), else (older pending comments) one from its content.
export const commentId = (c) => c.id ?? `c${hash(`${c.file}\0${c.start}\0${c.end}\0${c.old ? 1 : 0}\0${c.text}`)}`;
export const withIds = (list) => (list ?? []).map((c) => (c.id ? c : { ...c, id: commentId(c) }));

// ---- threads.json: {<pr key>: {at, threads: [{id, file, start, end, old, hunk, text, from, route, sentAt, agent, ghId,
// url, dry, followups: [{text, at, after}]}]}}

export const threadsOf = (doc, key) => doc?.[key]?.threads ?? [];
function bound(doc, key, threads, now, extra = {}) {
  const next = { ...(doc ?? {}), [key]: { ...doc?.[key], ...extra, at: now, threads: threads.slice(-MAX_THREADS) } };
  for (const k of Object.keys(next).sort((a, b) => next[b].at - next[a].at).slice(MAX_PRS)) delete next[k];
  return next;
}
// Comments that went out (how: {route: "agent" | "github", agent, dry, gh: {<comment id>: {ghId, url}}}) become threads;
// one sent again replaces its thread.
export function addThreads(doc, key, comments, how, now = Date.now()) {
  const made = withIds(comments).map((c) => ({ id: c.id, file: c.file, start: c.start, end: c.end, old: Boolean(c.old), hunk: c.hunk ?? null, text: c.text, from: c.from ?? null,
    route: how.route, sentAt: now, agent: how.agent ?? null, dry: Boolean(how.dry), ghId: how.gh?.[c.id]?.ghId ?? null, url: how.gh?.[c.id]?.url ?? null, followups: [] }));
  const ids = new Set(made.map((t) => t.id));
  return bound(doc, key, [...threadsOf(doc, key).filter((t) => !ids.has(t.id)), ...made], now);
}
// The reviewer's follow-up in a thread; after: how many agent replies it came after (that's where it shows).
export function addFollowup(doc, key, id, text, after, now = Date.now()) {
  return bound(doc, key, threadsOf(doc, key).map((t) => (t.id === id ? { ...t, followups: [...(t.followups ?? []), { text, at: now, after }] } : t)), now);
}

// The agent's answers: one JSON line each {id, reply, status, commit?}; all kept per id in file order, broken lines
// (half-written) skipped, an unknown status read as "answered".
export function parseReplies(text) {
  const out = {};
  for (const line of String(text ?? "").split("\n")) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r?.id || !String(r.reply ?? "").trim()) continue;
    (out[r.id] ??= []).push({ reply: String(r.reply).trim(), status: STATUSES.includes(r.status) ? r.status : "answered", commit: r.commit ? String(r.commit) : null });
  }
  return out;
}

// GitHub's replies to a posted comment (gh: the PR's review comments with in_reply_to_id), oldest first.
export const ghRepliesTo = (gh, ghId) => (ghId ? (gh ?? []).filter((g) => g.in_reply_to_id === ghId).sort((a, b) => String(a.at).localeCompare(String(b.at))) : []);

// What a thread shows: the agent's replies with the reviewer's follow-ups between them, GitHub replies after; its
// status (the last agent reply's, else sent/posted); a fixed thread folds to one line ("Fixed in <sha>") unless open.
export function threadView(th, replies = [], gh = [], open = false) {
  const entries = [];
  const ups = th.followups ?? [];
  for (const u of ups.filter((x) => (x.after ?? 0) <= 0)) entries.push({ who: "you", text: u.text });
  replies.forEach((r, k) => {
    entries.push({ who: "agent", text: r.reply, status: r.status, commit: r.commit });
    for (const u of ups.filter((x) => x.after === k + 1)) entries.push({ who: "you", text: u.text });
  });
  for (const u of ups.filter((x) => x.after > replies.length)) entries.push({ who: "you", text: u.text });
  for (const g of gh) entries.push({ who: g.user ?? "GitHub", text: g.body ?? "", url: g.url ?? null });
  const last = replies[replies.length - 1], status = last?.status ?? (th.route === "github" ? "posted" : "sent");
  const fixedIn = status === "fixed" ? [...replies].reverse().find((r) => r.commit)?.commit ?? null : null;
  return { status, fixedIn, collapsed: (status === "fixed" || status === "wontfix") && !open, entries };
}

// For the open-reviews registry: threads, replies and fixed ones of a PR.
export function threadCounts(threads, replies, gh = []) {
  let n = 0, fixed = 0;
  for (const t of threads) { const r = replies[t.id] ?? []; n += r.length + ghRepliesTo(gh, t.ghId).length; if (r[r.length - 1]?.status === "fixed") fixed++; }
  return { threads: threads.length, replies: n, fixed };
}

// ---- the agent: replies contract, follow-ups, and the preview before anything is typed into its session

// The contract appended to a review sent to the agent (mirrors the findings' report contract of fixPrompt).
export function repliesContract(file, id) {
  return `Answer each point once it is handled: append one JSON line per point to ${file}, for example\n` +
    `echo '{"id": "${id ?? "<id>"}", "reply": "briefly, what you did or your answer", "status": "fixed", "commit": "<sha>"}' >> ${file}\n` +
    `(status: fixed with the commit, answered for a question, wontfix with the reason, question when you need an answer from the reviewer).`;
}

// A follow-up in one thread: the comment, what was said so far, the new words, the same contract.
export function followupPrompt({ pr, thread, replies = [], text, file, lang }) {
  const said = threadView(thread, replies).entries.map((e) => `${e.who === "you" ? "Reviewer" : "You"}: ${e.text}`);
  return [`${pr ? `PR #${pr.number} "${pr.title}"` : "This branch"}: a follow-up on review point [${thread.id}] \`${thread.file}\`${thread.start === undefined ? "" : ` ${lineLabel(thread)}`}.`,
    thread.hunk ? "```diff\n" + thread.hunk + "\n```" : null, `Reviewer: ${thread.text}`, ...said, `Reviewer: ${text.trim()}`, repliesContract(file, thread.id)]
    .filter(Boolean).join("\n\n") + answerIn(lang);
}

// The preview of a send: own (the reviewer's words, shown apart) and the whole text, which the user may edit; confirm
// gives back exactly what goes out. send() is only called with confirm's result.
export const preview = ({ what, agent, own, prompt }) => ({ what, agent, own: own ?? "", prompt, text: prompt });
export const confirm = (p, edited) => ({ what: p.what, text: edited ?? p.text });
// Who it goes to, in words: the agent's tab, its main conversation (never a sub-agent's), or what opens instead.
export function agentLabel(agent, fallback) {
  if (!agent) return fallback;
  return `${agent.tab_name || agent.title || "Agent"} · ${agent.parent ? "a sub-agent (not the main conversation)" : "main conversation"}`;
}

// ---- GitHub: exactly what is ticked goes out

// off: the ids unticked; summaryOn: the summary ticked. ready: something to post (a verdict alone counts).
export function ghPlan({ comments, off = new Set(), summary = "", summaryOn = true, event = "comment", commit, lines, repo, login = null }) {
  const picked = withIds(comments).filter((c) => !off.has(c.id));
  const { payload, outside } = ghReview({ comments: picked, event, summary: summaryOn ? summary : "", commit, lines });
  const n = payload.comments.length, word = { comment: "Comment", approve: "Approve", request_changes: "Request changes" }[event] ?? "Comment";
  const ready = n > 0 || Boolean(payload.body) || payload.event !== "COMMENT";
  const what = [n ? `${n} ${n === 1 ? "comment" : "comments"}` : null, payload.body ? "a review body" : null].filter(Boolean).join(" and ") || "a review";
  // label: the button (short); target: the line above it, which says who posts where (it wraps, never clipped).
  return { payload, outside, picked, ready, label: `Post ${what}`, target: `as ${login ?? "your gh login"} · ${repo ?? "GitHub"} · ${word}` };
}

// One line comment posted at once (POST repos/{o}/{r}/pulls/{n}/comments); null when GitHub can't take it on a line.
export function singlePayload(c, commit, inDiffNow) {
  if (!inDiffNow) return null;
  const side = c.old ? "LEFT" : "RIGHT";
  return { commit_id: commit, path: c.file, line: c.end, side, ...(c.start !== c.end ? { start_line: c.start, start_side: side } : {}), body: c.text.trim() };
}

// What a GitHub post carried, for the popover afterwards: the body and each line comment.
export const postedItems = (payload) => [...(payload.body ? [`Review body: ${payload.body.slice(0, 120)}`] : []),
  ...payload.comments.map((c) => `${c.path}:${c.start_line ? `${c.start_line}–` : ""}${c.line}: ${c.body.slice(0, 120)}`)];

// ---- Fix: comments (and findings) to a sub-agent in its own worktree, or to the main agent; the selection

export const MAX_FIXES = 30;
export const selectedOf = (doc, key) => doc?.[key]?.selected ?? [];
// The selection for "Fix selected": comment ids, kept per PR.
export const toggleSelected = (doc, key, id, now = Date.now()) => {
  const sel = selectedOf(doc, key);
  return bound(doc, key, threadsOf(doc, key), now, { selected: sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id] });
};
export const clearSelected = (doc, key, now = Date.now()) => bound(doc, key, threadsOf(doc, key), now, { selected: [] });

// Fix jobs: {id, branch, path (its worktree), base (the PR's checkout), head (where the branch starts), items: [{kind:
// "comment" | "finding", id}], terminal, target: "sub" | "main", handoff (the PR agent the sub-agent reports to, else
// null), at, state: "running" | "applied" | "discarded"}. A running job with a commit and a handoff reads "handed".
export const fixesOf = (doc, key) => doc?.[key]?.fixes ?? [];
export const addFix = (doc, key, job, now = Date.now()) => bound(doc, key, threadsOf(doc, key), now, { fixes: [...fixesOf(doc, key).filter((f) => f.id !== job.id), job].slice(-MAX_FIXES) });
export const setFix = (doc, key, id, change, now = Date.now()) => bound(doc, key, threadsOf(doc, key), now, { fixes: fixesOf(doc, key).map((f) => (f.id === id ? { ...f, ...change } : f)) });
// The live job (not applied or discarded) an item belongs to.
export const fixFor = (doc, key, id) => [...fixesOf(doc, key)].reverse().find((f) => f.state === "running" && f.items.some((x) => x.id === id)) ?? null;

// A fix branch per job: fix/<pr number>-<first item>.
export const fixBranch = (number, ids) => `fix/${number ?? "pr"}-${String(ids[0] ?? "x").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 12)}${ids.length > 1 ? `-and-${ids.length - 1}` : ""}`;
// Where its worktree goes (Herdr's convention for worktrees): ~/.herdr/worktrees/<repo>/<branch with - for />.
export const fixPath = (home, repo, branch) => `${home}/.herdr/worktrees/${String(repo ?? "repo").split("/").pop()}/${branch.replace(/\//g, "-")}`;

// The commit a job's items report (a comment's reply or a finding's report with status fixed); null while none.
export function fixCommit(job, replies = {}, reports = {}) {
  for (const it of job.items) {
    const r = it.kind === "finding" ? reports[it.id] : (replies[it.id] ?? []).at(-1);
    if (r?.status === "fixed" && r.commit) return r.commit;
  }
  return null;
}

// What the sub-agent is told on top of the comments or findings: its worktree, its branch, commit there, never push
// (main: the PR's agent takes the fix over, see handoffNote; without one the reviewer applies it).
export const worktreeNote = (branch, path, main = null) => `You work in your own git worktree ${path} on branch ${branch}, started from the PR head. ` +
  `Make the change there, commit it on ${branch} (one commit per point is fine), and never push: ${main ? "the PR's agent takes it over (last step below)" : "the reviewer applies it to the PR"}.`;

// What the PR's agent does with a ready fix: cherry-pick, tests, push, then the fix worktree and branch go.
const takeOver = ({ branch, head, path }) => `Please take it over: on your PR branch run git cherry-pick ${head}..${branch}, resolve conflicts if any, run the tests, ` +
  `and push to the PR branch. Then remove the fix worktree and branch: git worktree remove ${path} && git branch -D ${branch}`;
// The sub-agent's last step: one hc send to the PR's agent (main: its terminal address) with the result and takeOver.
// Without a live PR agent (or the head) there is no such step and Apply to PR stays the way in.
export function handoffNote({ main, branch, path, head }) {
  if (!main || !head) return null;
  return `Last step, after the commit and the report line: hand the fix to the PR's agent with exactly one message (no double quotes inside the text):\n` +
    `hc send ${main} "Fix ready: branch ${branch}, commit <sha>, worktree ${path}. <one line: what you changed>. Tests: <passed | failed: what | not run>. ${takeOver({ branch, head, path })}"\n` +
    `Never push yourself. If hc send fails, check with hc read ${main} --lines 30 whether it arrived before you try once more; if it still fails, stop: the reviewer can apply the fix from the review.`;
}
// The mod's notice to the PR's agent when a fix sub-agent starts (labels: the items, short).
export const startNotice = ({ pr, branch, path, terminal, labels }) => `${pr ? `PR #${pr.number}` : "This PR"}: the reviewer started a fix sub-agent (${terminal}) ` +
  `on branch ${branch}, worktree ${path}, for: ${labels.map((l) => String(l).replace(/\s+/g, " ").slice(0, 80)).join("; ")}. ` +
  `It reports back here when done; nothing to do yet.`;

// The comments as one fix task, with ids and the replies contract (each point answered with status fixed and the commit).
export function fixCommentsPrompt({ pr, comments, file, lang, branch = null, path = null, head = null, main = null }) {
  const items = withIds(comments).map((c, i) => [`${i + 1}. [${c.id}] \`${c.file}\`${c.start === undefined ? "" : ` ${lineLabel(c)}`}`, c.hunk ? "```diff\n" + c.hunk + "\n```" : null, c.text.trim()].filter(Boolean).join("\n"));
  return [`${pr ? `PR #${pr.number} "${pr.title}"${pr.url ? ` (${pr.url})` : ""}` : "This branch"}: please fix ${comments.length === 1 ? "this review comment" : `these ${comments.length} review comments`}.`,
    branch ? worktreeNote(branch, path, head && main) : null, ...items, repliesContract(file, withIds(comments)[0]?.id),
    branch ? handoffNote({ main, branch, path, head }) : null].filter(Boolean).join("\n\n") + answerIn(lang);
}

// hc run for the sub-agent: under the PR's agent (parent) so it shows there, in its worktree, on the PR's context
// (env: the context's command prefix), no notes typed into the parent.
export function subAgentArgs({ parent, cwd, name, env = [], task, job }) {
  return ["run", "--bg", "--json", "--no-notify", "--name", name, "--cwd", cwd, ...(parent ? ["--parent", parent] : ["--no-parent"]),
    "--label", `pr-review.fix=${job}`, "--", ...env, "claude", task];
}

// Apply to PR: a cherry-pick of the branch's commits onto the PR's checkout, only when that checkout is clean.
export function applyPlan({ status, head, branch }) {
  const dirty = String(status ?? "").split("\n").filter((l) => l.trim());
  if (dirty.length) return { ok: false, reason: `The PR's checkout has ${dirty.length} uncommitted ${dirty.length === 1 ? "change" : "changes"}: Apply needs a clean checkout.` };
  return { ok: true, args: ["cherry-pick", `${head}..${branch}`] };
}
// The hand-over when the checkout isn't clean: the main agent takes it over (as after a sub-agent's handoff).
export const applyPrompt = (job) => `The reviewer's fix is ready on branch ${job.branch} (worktree ${job.path}). ${takeOver(job)}.`;

// ---- the Comments tab and the Show switch

export const SHOW_KINDS = [["mine", "Yours"], ["ai", "AI"], ["agents", "Agents"], ["github", "GitHub"], ["notes", "Notes"]];
export const showOf = (s) => Object.fromEntries(SHOW_KINDS.map(([k]) => [k, s?.[k] !== false])); // all on by default
// Every comment of the PR as a row for the Comments tab: pending ones, sent threads (with their state and replies),
// other people's GitHub comments, notes. state: pending | waiting | replied | fixed | declined | github | note.
export function commentRows({ pending = [], threads = [], replies = {}, gh = [], ghOwn = () => false, notes = [] }) {
  const rows = withIds(pending).map((c) => ({ id: c.id, kind: "pending", src: c.from === "ki" ? "ai" : "mine", file: c.file, line: c.end, old: Boolean(c.old), text: c.text, state: "pending", replies: 0 }));
  for (const t of threads) {
    const r = replies[t.id] ?? [], last = r.at(-1)?.status, g = ghRepliesTo(gh, t.ghId).length;
    const state = last === "fixed" ? "fixed" : last === "wontfix" ? "declined" : last || g ? "replied" : "waiting";
    rows.push({ id: t.id, kind: "thread", src: "mine", file: t.file, line: t.end, old: Boolean(t.old), text: t.text, state, replies: r.length + g, route: t.route });
  }
  for (const g of gh) if (!ghOwn(g) && !g.in_reply_to_id) rows.push({ id: `gh${g.id}`, kind: "gh", src: "github", file: g.path, line: g.line, old: g.side === "LEFT", text: g.body ?? "", state: "github", replies: gh.filter((x) => x.in_reply_to_id === g.id).length, author: g.user });
  for (const p of notes) if (p.anchor?.file) rows.push({ id: p.id, kind: "note", src: "notes", file: p.anchor.file, line: p.anchor.end, old: Boolean(p.anchor.old), text: p.summary, state: "note", replies: 0 });
  return rows.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
// "5 comments · 2 pending · 1 waiting on agent · 2 fixed"
export function commentSummary(rows) {
  const mine = rows.filter((r) => r.kind === "pending" || r.kind === "thread"), n = (s) => mine.filter((r) => r.state === s).length;
  return [`${mine.length} ${mine.length === 1 ? "comment" : "comments"}`, n("pending") && `${n("pending")} pending`, n("waiting") && `${n("waiting")} waiting on agent`,
    n("replied") && `${n("replied")} replied`, n("fixed") && `${n("fixed")} fixed`, n("declined") && `${n("declined")} declined`].filter(Boolean).join(" · ");
}
// The tab's filters: state (all | pending | waiting | replied | fixed) and the Show switch's kinds.
export const filterRows = (rows, state, show) => rows.filter((r) => show[r.src] !== false && (state === "all" || r.state === state));
// The Show switch's counts: comments per kind in the diff (AI: suggestions and findings).
export const showCounts = ({ rows, ai = 0, agents = 0 }) => ({ mine: rows.filter((r) => r.src === "mine").length, ai: ai + rows.filter((r) => r.src === "ai").length, agents,
  github: rows.filter((r) => r.src === "github").length, notes: rows.filter((r) => r.src === "notes").length });
