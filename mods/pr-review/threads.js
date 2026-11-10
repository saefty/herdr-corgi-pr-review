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
function bound(doc, key, threads, now) {
  const next = { ...(doc ?? {}), [key]: { at: now, threads: threads.slice(-MAX_THREADS) } };
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
  return { status, fixedIn, collapsed: status === "fixed" && !open, entries };
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
export function ghPlan({ comments, off = new Set(), summary = "", summaryOn = true, event = "comment", commit, lines, repo }) {
  const picked = withIds(comments).filter((c) => !off.has(c.id));
  const { payload, outside } = ghReview({ comments: picked, event, summary: summaryOn ? summary : "", commit, lines });
  const n = payload.comments.length, word = { comment: "Comment", approve: "Approve", request_changes: "Request changes" }[event] ?? "Comment";
  const ready = n > 0 || Boolean(payload.body) || payload.event !== "COMMENT";
  const what = [n ? `${n} ${n === 1 ? "comment" : "comments"}` : null, payload.body ? "a review body" : null].filter(Boolean).join(" and ") || "a review";
  return { payload, outside, picked, ready, label: `Post ${what} to ${repo ?? "GitHub"} as ${word}` };
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
