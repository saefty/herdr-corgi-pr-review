// Pure helpers for the PR review panel (tested by test_pr.mjs).

// Numbers each diff line once (as the shipped changes panel does): number is the line on its side (new, removed:
// old); o and n are the old and new line numbers where the line has one.
export function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0], text = line.slice(1) || " ";
    if (kind === "-") return { kind, number: old, o: old++, text };
    if (kind === "+") return { kind, number: next, n: next++, text };
    if (kind === " ") return { kind, number: next, o: old++, n: next++, text };
    return { kind: "", text: line };
  });
}

// What goes to the agent: where, the code, the question.
const headOf = (pr, base) => pr ? `PR #${pr.number} "${pr.title}"${pr.url ? ` (${pr.url})` : ""}` : `Branch diff against ${base}`;
// The answer language line for prompts to an agent: none for English (the default).
export const answerIn = (lang) => (lang && !/^english$/i.test(lang) ? `\n\nAnswer in ${lang}.` : "");

export function buildPrompt({ pr, base, file, anchor, question, lang }) {
  const label = anchor?.start !== undefined ? " " + lineLabel(anchor) : "";
  return [`${headOf(pr, base)}: question${file ? ` about \`${file}\`${label}` : ""}.`, anchor?.hunk ? "```diff\n" + anchor.hunk + "\n```" : null, question.trim()].filter(Boolean).join("\n\n") + answerIn(lang);
}

// A whole `gh pr diff` split per file: path (the new one; the old one if deleted), +/− counts, its lines.
export function splitPatch(text) {
  const files = [];
  for (const line of text.replace(/\n$/, "").split("\n")) {
    const header = /^diff --git a\/.* b\/(.*)$/.exec(line);
    if (header) { files.push({ path: header[1], add: 0, del: 0, binary: false, status: "modified", lines: [], body: false }); continue; }
    const f = files[files.length - 1];
    if (!f) continue;
    if (line.startsWith("@@")) f.body = true;
    if (!f.body) {
      const name = /^(?:\+\+\+ b|--- a)\/(.*)$/.exec(line);
      if (name) f.path = name[1]; // "+++ b/" comes after "--- a/"; a deleted file only has the old name
      if (line.startsWith("Binary files")) f.binary = true;
      if (line.startsWith("new file mode")) f.status = "added";
      else if (line.startsWith("deleted file mode")) f.status = "deleted";
      else if (line.startsWith("rename from ")) { f.status = "renamed"; f.from = line.slice(12); }
    } else if (line[0] === "+") f.add++;
    else if (line[0] === "-") f.del++;
    f.lines.push(line);
  }
  return files.map(({ body, ...f }) => f);
}

// Rows a..b (either order) as a review anchor: line range (old numbers only when every line is removed)
// and the diff with up to ctx lines of context inside the hunk, at most max lines.
export function selection(rows, a, b = a, ctx = 3, max = 60) {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const lines = rows.slice(lo, hi + 1).filter((r) => r.number !== undefined);
  const old = lines.length > 0 && lines.every((r) => r.kind === "-");
  const nums = lines.filter((r) => old || r.kind !== "-").map((r) => r.number);
  let start = lo, end = hi;
  const edge = (r) => r.kind === "@" || r.kind === "gap"; // context stops at a hunk header or hidden lines
  while (start > 0 && !edge(rows[start]) && lo - start < ctx) start--;
  while (end + 1 < rows.length && !edge(rows[end + 1]) && end - hi < ctx) end++;
  end = Math.min(end, start + max - 1);
  const prefix = { "+": "+", "-": "-", " ": " ", "@": "" };
  return { start: nums[0], end: nums[nums.length - 1], old, hunk: rows.slice(start, end + 1).filter((r) => r.kind !== "gap").map((r) => (prefix[r.kind] ?? "") + r.text).join("\n") };
}

// The first row of the next (dir 1) or previous (-1) block of changed lines from row i; -1 when none.
export function nextChange(rows, i, dir) {
  const starts = rows.map((r, j) => (r.kind === "+" || r.kind === "-") && !(rows[j - 1]?.kind === "+" || rows[j - 1]?.kind === "-") ? j : -1).filter((j) => j >= 0);
  return (dir > 0 ? starts.find((j) => j > (i ?? -1)) : starts.reverse().find((j) => j < (i ?? rows.length))) ?? -1;
}

export const lineLabel = ({ start, end, old }) => start === undefined ? "" :
  (start === end ? `line ${start}` : `lines ${start}–${end}`) + (old ? " (old, removed)" : "");

// The row a comment hangs under: its last line, on its side. -1 when that line is no longer in the diff.
export const anchorRow = (rows, c) => rows.findIndex((r) => r.number === c.end && (c.old ? r.kind === "-" : r.kind === "+" || r.kind === " "));

// All pending comments as one prompt. event (comment | approve | request_changes) and summary: the Finish-your-review choice.
const VERDICT = { comment: "", approve: " (approved)", request_changes: " (changes requested)" };
// replies: the file the agent answers each point in, by its id (threads.js repliesContract); null: no contract.
export function buildReview({ pr, base, comments, lang, event = "comment", summary = "", replies = null, contract = null }) {
  const points = comments.map((c, i) => [`${i + 1}. ${c.id ? `[${c.id}] ` : ""}\`${c.file}\`${c.start === undefined ? "" : " " + lineLabel(c)}`,
    c.hunk ? "```diff\n" + c.hunk + "\n```" : null, c.text.trim()].filter(Boolean).join("\n"));
  return [`${headOf(pr, base)}: code review${VERDICT[event] ?? ""} with ${comments.length} ${comments.length === 1 ? "point" : "points"}. ` +
    "Work through the points one by one: answer questions, make the requested changes. At the end, say briefly per point what you did.",
    summary.trim() ? `Overall: ${summary.trim()}` : null, ...points, replies && contract ? contract(replies, comments[0]?.id) : null].filter(Boolean).join("\n\n") + answerIn(lang);
}

// ---- GitHub reviews (review.js "Finish your review", route GitHub)

export const GH_EVENT = { comment: "COMMENT", approve: "APPROVE", request_changes: "REQUEST_CHANGES" };

// The lines GitHub accepts review comments on: per path a Set of "R<new line>" and "L<old line>" (every hunk row).
export function diffLines(hunks) {
  const m = new Map();
  for (const h of hunks) {
    const s = m.get(h.path) ?? new Set();
    for (const r of h.rows) { if (r.n !== undefined) s.add(`R${r.n}`); if (r.o !== undefined) s.add(`L${r.o}`); }
    m.set(h.path, s);
  }
  return m;
}

// Whether a pending comment can be a line comment on GitHub: both ends of its range are in the PR diff.
export const inDiff = (lines, c) => c.start !== undefined && [c.start, c.end].every((n) => lines.get(c.file)?.has(`${c.old ? "L" : "R"}${n}`));

// One GitHub review (POST repos/{o}/{r}/pulls/{n}/reviews) from the pending comments: line comments for those in the
// diff, the rest appended to the body with file and line. outside: the comments moved into the body.
export function ghReview({ comments, event = "comment", summary = "", commit, lines }) {
  const inline = comments.filter((c) => inDiff(lines, c)), outside = comments.filter((c) => !inDiff(lines, c));
  const body = [summary.trim(), ...outside.map((c) => `**\`${c.file}\`${c.start === undefined ? "" : " " + lineLabel(c)}**\n\n${c.text.trim()}`)].filter(Boolean).join("\n\n");
  const payload = { commit_id: commit, event: GH_EVENT[event] ?? "COMMENT", body, comments: inline.map((c) => {
    const side = c.old ? "LEFT" : "RIGHT";
    return { path: c.file, line: c.end, side, ...(c.start !== c.end ? { start_line: c.start, start_side: side } : {}), body: c.text.trim() };
  }) };
  return { payload, outside };
}

// The selected rows' code as a GitHub suggestion block (new-side text of added and context lines).
export const suggestionBlock = (rows) => "```suggestion\n" + rows.filter((r) => r.kind === "+" || r.kind === " ").map((r) => r.text).join("\n") + "\n```";

// The items under one diff row: GitHub's comments on that line, the pending comments ending there (the one being
// edited replaced by the composer), and the composer when it opens under this row (composeKey: its row's lineKey).
export function lineThreads(r, comments, { composeKey = null, editId = null, gh = [] } = {}) {
  const out = [];
  for (const g of gh) if (atLine(r, g.line, g.side === "LEFT")) out.push({ t: "gh", g });
  for (const c of comments) {
    if (!atLine(r, c.end, c.old)) continue;
    if (c.id === editId) out.push({ t: "compose", c }, { t: "composeact", c });
    else out.push({ t: "comment", c }, { t: "cact", c });
  }
  if (!editId && composeKey && lineKey(r) === composeKey) out.push({ t: "compose" }, { t: "composeact" });
  return out;
}

// FNV-1a, 32 bit, hex: a short stable id, not security.
export function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

// Every hunk of a splitPatch result with a stable id (path + its lines without the @@ numbers, so a moved
// hunk keeps it) and a short alias h1..hn for the model.
export function hunksOf(files) {
  const out = [], seen = {};
  for (const f of files) {
    let cur = null;
    for (const line of f.lines) {
      if (line.startsWith("@@")) { cur = { path: f.path, lines: [line] }; out.push(cur); }
      else if (cur) cur.lines.push(line);
    }
  }
  return out.map((h, i) => {
    let id = `${h.path}:${hash(h.lines.slice(1).join("\n"))}`;
    seen[id] = (seen[id] ?? 0) + 1;
    if (seen[id] > 1) id += `#${seen[id]}`;
    return { ...h, id, alias: `h${i + 1}` };
  });
}

// The hunks that fit into max characters (in order), and the aliases of the rest.
export function budget(hunks, max = 60000) {
  const sent = [], cut = [];
  let used = 0;
  for (const h of hunks) {
    const size = h.path.length + h.alias.length + 6 + h.lines.reduce((n, l) => n + l.length + 1, 0);
    if (used + size > max) cut.push(h.alias); else { sent.push(h); used += size; }
  }
  return { sent, cut };
}

// ---- the review layout (review.js)

// Models for the AI review: the claude CLI's alias, its label, how many diff characters it is sent.
export const MODELS = { haiku: { label: "Haiku", chars: 60000 }, sonnet: { label: "Sonnet", chars: 150000 }, opus: { label: "Opus", chars: 150000 } };

// Lockfiles, snapshots, minified and generated code: sent last, so they are what a size cap cuts first.
export const lowValue = (path) => /(^|\/)([^/]*\.lock|package-lock\.json|pnpm-lock\.yaml|go\.sum)$|\.snap$|\.min\.(js|css)$|(^|\/)(dist|vendor|generated|__generated__)\//.test(path);

// What review.py gets: the hunks that fit the model (low-value ones cut first, the rest in diff order), the aliases
// cut, the cache file for exactly this hunk set and model, the source's latest for that model, and a status file.
// source: what it is kept under (the PR url, or repo#base); pr: the PR url or null; worktree: the checkout to read.
export function reviewRequest({ url, pr = url, worktree = null, files, model, context, dir }) {
  const hunks = hunksOf(files);
  const { sent, cut } = budget([...hunks.filter((h) => !lowValue(h.path)), ...hunks.filter((h) => lowValue(h.path))], MODELS[model].chars);
  const at = new Map(hunks.map((h, i) => [h.alias, i]));
  sent.sort((a, b) => at.get(a.alias) - at.get(b.alias));
  cut.sort((a, b) => at.get(a) - at.get(b));
  const base = `${dir}/rv-${hash(url)}`, out = `${base}-${hash(hunks.map((h) => h.id).sort().join(","))}-${model}.json`, latest = `${base}-${model}.json`;
  return { hunks, out, latest, status: `${out}.status`,
    req: { out, latest, status: `${out}.status`, model, context, pr, source: url, worktree, hunks: sent.map(({ alias, id, path, lines }) => ({ alias, id, path, lines })), cut } };
}

// Risk order: high, medium, low, then what is only skimmed. Older analyses (categories, suspects) map in.
export const RISKS = ["high", "medium", "low", "skim"];
export const RISK_LEVELS = ["minimal", "low", "medium", "high", "critical"]; // merge risk
const RULE_ORDER = ["fail", "pass", "n/a"];
const OLD_SKIM = new Set(["docs", "tests", "rename", "format", "generated"]);
const level = (x) => (RISKS.includes(x) ? x : "medium");

// Statements with their source (implemented | existing | spec, see arch.js sourceStyle) and evidence (file:line).
export const SOURCES = ["implemented", "existing", "spec"];
export const statementsOf = (list) => (Array.isArray(list) ? list : []).filter((x) => x?.text).map((x) => ({ text: String(x.text), source: SOURCES.includes(x.source) ? x.source : null, evidence: x.evidence || null }));

// The pictures' freshness: updated (refreshed after the text analysis, short: for which head) and older (made for
// another diff head than the shown one; without a refresh record: the analysis is not for today's hunks).
export function diagramsState(saved, head, exact = true) {
  const d = saved?.diagrams ?? null;
  return { updated: Boolean(d?.generated && saved?.generated && d.generated > saved.generated), short: d?.head ? String(d.head).slice(0, 7) : null,
    older: d?.head ? Boolean(head) && d.head !== head : !exact };
}

// A layer's (or the whole PR's) pictures: `visuals`, or the older single `visual`; only ones with nodes.
export const visualsOf = (x) => (Array.isArray(x?.visuals) ? x.visuals : x?.visual ? [x.visual] : []).filter((v) => v?.nodes?.length);

// Row r shows line n of the new side (old: of the removed side).
export const atLine = (r, n, old) => r.number === n && (old ? r.kind === "-" : r.kind === "+" || r.kind === " ");

// The model's analysis with aliases turned into hunk ids (unknown ones dropped): steps in risk order (then reading
// order), each with its explanation, questions (at most 3), flows (at most 3; traces at most 12 lines); every
// suggested line put on a row of its hunk (the hunk's first change when the model named a line it doesn't have: approx).
export function mapReview(answer, hunks) {
  const byAlias = new Map(hunks.map((h) => [h.alias, h]));
  const ids = (list) => [...new Set((list ?? []).map((a) => byAlias.get(String(a).trim())?.id).filter(Boolean))];
  const steps = (answer.steps ?? []).map((s, n) => {
    const risk = OLD_SKIM.has(s.category) ? "skim" : level(s.risk);
    return { title: s.title ?? "", why: s.why_it_matters ?? s.why ?? "", text: s.explanation ?? s.text ?? "", risk, skim: risk === "skim", isNew: Boolean(s.new), visuals: visualsOf(s),
      weight: risk === "high" ? "key" : risk === "skim" ? "skim" : "normal", order: Number(s.reading_order) || n + 1,
      questions: (s.check_questions ?? s.questions ?? []).filter(Boolean).slice(0, 3), hunks: ids(s.hunks), n,
      flows: (s.flows ?? []).slice(0, 3).map((f) => ({ function: f.function ?? "", at: f.at ?? "", inputs: f.inputs ?? [], output: f.output ?? null,
        side_effects: f.side_effects ?? [], calls: f.calls ?? [], trace: (f.trace ?? []).slice(0, 12) })) };
  }).sort((a, b) => RISKS.indexOf(a.risk) - RISKS.indexOf(b.risk) || a.order - b.order || a.n - b.n);
  const suspects = [];
  const lines = [...(answer.suspects ?? []).map((s) => ({ ...s, text: s.reason })), ...(answer.steps ?? []).flatMap((s) => s.suggestions ?? [])];
  for (const s of lines) {
    const h = byAlias.get(String(s.hunk).trim());
    if (!h) continue;
    const rows = diffRows(h.lines ?? []), exact = rows.find((r) => atLine(r, s.line, s.side === "old"));
    const row = exact ?? rows.find((r) => r.kind === "+" || r.kind === "-");
    if (!row) continue;
    const old = row.kind === "-", reason = s.text ?? "";
    suspects.push({ key: `${h.path}:${old ? "-" : "+"}${row.number}:${hash(reason)}`, hunk: h.id, path: h.path, line: row.number, old,
      severity: level(s.severity) === "skim" ? "low" : level(s.severity), reason, approx: !exact });
  }
  // Newer analyses add behavior, merge risk, effort, repo rule checks, an architecture picture and the blast radius;
  // older ones have none of them (null / empty).
  return { title: answer.title ?? "", summary: answer.summary ?? "", steps, suspects, behavior: answer.behavior ?? "",
    intent: statementsOf(answer.intent), behaviorPoints: statementsOf(answer.behavior_points),
    mergeRisk: RISK_LEVELS.includes(answer.merge_risk?.level) ? answer.merge_risk : null,
    effort: answer.effort?.score >= 1 ? { score: Math.min(5, Math.round(answer.effort.score)), why: answer.effort.why ?? "" } : null,
    rules: (answer.rule_checks ?? []).map((r) => ({ rule: r.rule ?? "", source: r.source ?? "", status: ["pass", "fail", "n/a"].includes(r.status) ? r.status : "n/a", where: r.where ?? null, why: r.why ?? "" }))
      .sort((a, b) => RULE_ORDER.indexOf(a.status) - RULE_ORDER.indexOf(b.status)),
    arch: answer.architecture?.nodes?.length ? answer.architecture : null, visuals: visualsOf(answer), blast: answer.blast_radius?.units?.length ? answer.blast_radius : null,
    asks: (answer.asks ?? []).map((a) => ({ text: a.text ?? "", coverage: ["seen", "partly", "absent", "extra"].includes(a.coverage) ? a.coverage : "absent", hunks: ids(a.hunks),
      elements: (a.elements ?? []).map(String) })) };
}

// A suspicious line taken over as a pending review comment (rows: its hunk's or file's rows); null when not shown there.
export function suspectComment(s, rows, id) {
  const i = rows.findIndex((r) => atLine(r, s.line, s.old));
  return i < 0 ? null : { id, file: s.path, ...selection(rows, i), text: s.reason, from: "ki" };
}

// A step's identity across re-analyses: its hunks (or its title when it has none).
export const stepKey = (s) => hash(s.hunks.join(",") || s.title);

// The new-side lines a hunk covers, [first, last] (last < first when it only removes lines, after line first-1),
// and new minus old line number before it (shift) and after it (after).
function span(header) {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))?/.exec(header), num = (x, len) => (len === 0 ? x + 1 : x);
  const ol = m[2] === undefined ? 1 : +m[2], nl = m[4] === undefined ? 1 : +m[4], of = num(+m[1], ol), first = num(+m[3], nl);
  return [first, first + nl - 1, first - of, first + nl - (of + ol)];
}

// One file for the Files view: its hunks (each a diffRows result, @@ row first) with the unchanged lines between them,
// as far as they are opened. full: the new file's lines (null: not loaded); open: {gap: {down, up}}, lines shown below
// the previous hunk and above the next; whole: every line; tail: unchanged lines may follow the last hunk.
// Rows carry h, their hunk's index; a gap still hiding lines is {kind: "gap", gap, hidden} (hidden null: not known yet).
export function fileRows(hunks, full, open = {}, whole = false, tail = true) {
  const out = [];
  let next = 1, shift = 0;
  const ctx = (n) => ({ kind: " ", number: n, n, o: n - shift, text: full[n - 1] || " " });
  const gap = (k, to) => {
    const size = to === null ? null : to - next + 1;
    if (size !== null && size <= 0) return;
    if (!full) { out.push({ kind: "gap", gap: k, hidden: size }); return; }
    const { down = 0, up = 0 } = whole ? { down: size } : open[k] ?? {};
    const top = Math.min(down, size), bottom = Math.min(up, size - top);
    for (let n = next; n < next + top; n++) out.push(ctx(n));
    if (size - top - bottom > 0) out.push({ kind: "gap", gap: k, hidden: size - top - bottom });
    for (let n = to - bottom + 1; n <= to; n++) out.push(ctx(n));
  };
  hunks.forEach((rows, k) => {
    const [first, last, before, after] = span(rows[0].text);
    shift = before;
    gap(k, first - 1);
    for (const r of rows) out.push({ ...r, h: k });
    next = Math.max(next, last + 1); shift = after;
  });
  if (tail) gap(hunks.length, full ? full.length : null);
  return out;
}

// Paths (diff order: git sorts them, so a folder's files are together) as a tree: {dir, name, path, depth};
// a closed folder hides what is in it.
export function fileTree(paths, closed = new Set()) {
  const out = [], seen = new Set();
  for (const p of paths) {
    const parts = p.split("/");
    let hidden = false;
    for (let i = 1; i < parts.length && !hidden; i++) {
      const dir = parts.slice(0, i).join("/");
      if (!seen.has(dir)) { seen.add(dir); out.push({ dir: true, name: parts[i - 1], path: dir, depth: i - 1 }); }
      hidden = closed.has(dir);
    }
    if (!hidden) out.push({ dir: false, name: parts[parts.length - 1], path: p, depth: parts.length - 1 });
  }
  return out;
}

// The same range for the UI (English); lineLabel stays for the prompts.
export const uiLine = ({ start, end, old }) => start === undefined ? "" :
  (start === end ? `line ${start}` : `lines ${start}–${end}`) + (old ? " (old, removed)" : "");

// A row's place for a selection that survives re-renders and refreshes: its side and line number ("+12" new side,
// added or context; "-7" removed). null for rows without a line (hunk headers, gaps).
export const lineKey = (r) => (r.number === undefined ? null : `${r.kind === "-" ? "-" : "+"}${r.number}`);

// The rows from line key a to line key b (either order) in one file's rows: [lo, hi], or null when either is not there.
export function rangeOf(rows, a, b) {
  const i = rows.findIndex((r) => lineKey(r) === a), j = rows.findIndex((r) => lineKey(r) === b);
  return i < 0 || j < 0 ? null : [Math.min(i, j), Math.max(i, j)];
}

// ---- reviewer findings (reviewers.py; review.js)

// Status reports the fixing agent appends, one JSON line each ({id, status: "fixed"|"wontfix", commit, note}): the
// last per id wins, broken lines (a half-written one) are skipped.
export function parseReports(text) {
  const out = {};
  for (const line of String(text ?? "").split("\n")) {
    try { const r = JSON.parse(line); if (r && r.id) out[r.id] = r; } catch { /* half a line */ }
  }
  return out;
}

// A finding's status: the agent's report beats the panel's own (open, progress, fixed, dismissed); a finding from
// an older head whose line changed since is "recheck" unless it is settled.
export function findingStatus(f, status, reports, head, lineNow) {
  const r = reports[f.id], own = status[f.id]?.s ?? "open";
  const s = r && !status[f.id]?.verify ? (r.status === "fixed" ? "fixed" : "dismissed") : own; // a verification beats the agent's report
  if ((s === "open" || s === "progress") && head && f.head && f.head !== head && lineNow !== undefined && lineNow.trim() !== (f.code ?? "").trim()) return "recheck";
  return s;
}

// One prompt asking the PR's agent to fix findings and to report each back as a JSON line in `report`.
export function fixPrompt(findings, pr, report, lang) {
  const items = findings.map((f, i) => [`${i + 1}. [${f.id}] ${f.severity} · ${f.reviewer} · \`${f.file}\`:${f.line}${f.end && f.end !== f.line ? `–${f.end}` : ""}: ${f.title}`,
    f.detail, f.suggestion ? `Suggestion: ${f.suggestion}` : null].filter(Boolean).join("\n"));
  return [`${pr ? `PR #${pr.number} "${pr.title}"${pr.url ? ` (${pr.url})` : ""}` : "This branch"}: please fix ${findings.length === 1 ? "this review finding" : `these ${findings.length} review findings`}.`,
    ...items,
    `Report each finding back once it is handled: append one JSON line per finding to ${report}, for example\n` +
    `echo '{"id": "${findings[0]?.id ?? "<id>"}", "status": "fixed", "commit": "<sha>", "note": "briefly, what you did"}' >> ${report}\n` +
    `(status "wontfix" with the reason in note when you don't fix it).`].join("\n\n") + answerIn(lang);
}

// ---- open reviews (pr-data/open-reviews.json; review.js writes it, shared "review.open" / "review.registry" publish it)

const DAY = 86400000, KEEP_CLOSED = 14 * DAY, MAX_REVIEWS = 50;

// The registry with this review created or updated: startedAt stays, lastTouched moves, fields merge.
export function touchReview(list, entry, now) {
  const old = list.find((r) => r.url === entry.url);
  const next = { status: "in-progress", ...old, ...entry, progress: { ...old?.progress, ...entry.progress }, startedAt: old?.startedAt ?? now, lastTouched: now };
  return [next, ...list.filter((r) => r.url !== entry.url)];
}

// Merged/closed PRs (prs.json state, updated over a day ago) count as done; done and sent ones go after 14 days
// untouched; at most MAX_REVIEWS, most recently touched first.
export function expireReviews(list, prs, now) {
  const state = new Map((prs ?? []).map((p) => [p.url, p]));
  return list.map((r) => {
    const p = state.get(r.url);
    const closed = p && (p.state === "merged" || p.state === "closed") && now - Date.parse(p.updatedAt ?? 0) > DAY;
    return closed && r.status !== "done" ? { ...r, status: "done", doneAt: now } : r;
  }).filter((r) => r.status === "in-progress" || now - (r.doneAt ?? r.lastTouched) < KEEP_CLOSED)
    .sort((a, b) => b.lastTouched - a.lastTouched).slice(0, MAX_REVIEWS);
}

// "3/9 steps · 2 comments · 1 open finding" for lists of open reviews.
export function progressLine(p = {}) {
  return [p.steps ? `${p.stepsChecked ?? 0}/${p.steps} steps` : null, p.files ? `${p.filesViewed ?? 0}/${p.files} files` : null,
    p.comments ? `${p.comments} ${p.comments === 1 ? "comment" : "comments"}` : null,
    p.findingsOpen ? `${p.findingsOpen} open ${p.findingsOpen === 1 ? "finding" : "findings"}` : null].filter(Boolean).join(" · ");
}

// Where a review was (review.js uiState, saved as JSON) as the fields to put back, and what to scroll to.
export function resumeFields(ui) {
  if (!ui) return null;
  return { fields: { tab: ui.tab ?? "files", fileFocus: ui.fileFocus ?? null, focusHunk: ui.focusHunk ?? null, cur: ui.cur ?? 0, order: ui.order ?? "risk", fsel: ui.fsel ?? null, page: ui.page === undefined ? "overview" : ui.page },
    scroll: ui.focusHunk ?? ui.fileFocus ?? null, model: ui.model ?? null, values: ui.values };
}

// ---- the review layout's virtual list: stable item keys, and clicks on code tokens

// A stable key per list item (row by file and line, cards by their id), so a click queued before the list changed
// (a definition card inserted, context opened) still names the item that was pressed. Repeats get #n.
export function itemKeys(items) {
  const seen = new Map();
  return items.map((it, i) => {
    let k;
    if (it.t === "row") { const r = it.src[it.ri]; k = `r|${it.path}|${lineKey(r) ?? `@${r.text}`}`; }
    else if (it.t === "gap") k = `g|${it.path}|${it.r.gap}`;
    else if (it.t === "file") k = `f|${it.f.path}`;
    else if (it.t === "path") k = `p|${it.h.id}`;
    else if (it.t === "step") k = `s|${it.i}`;
    else if (it.t === "sug" || it.t === "sugact") k = `${it.t}|${it.s.key}`;
    else if (it.t === "comment" || it.t === "cact") k = `${it.t}|${it.c.id}`;
    else if (it.t === "find" || it.t === "fact") k = `${it.t}|${it.f.id}`;
    else if (it.t === "def") k = `d|${it.d.key}`;
    else if (it.t === "compose" || it.t === "composeact") k = `x|${it.t}`;
    else if (it.t === "gh") k = `gh|${it.g.id}`;
    else k = `n|${it.text ?? i}`;
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return n ? `${k}#${n}` : k;
  });
}

// Tabs are drawn as spaces to the next multiple of TAB, so a press x maps to a column the same way everywhere.
export const TAB = 4;
export function expandTabs(text) {
  if (!text.includes("\t")) return text;
  let out = "";
  for (const ch of text) out += ch === "\t" ? " ".repeat(TAB - (out.length % TAB)) : ch;
  return out;
}

// The UTF-16 offset in `text` at column `col` of its tab-expanded form.
export function offsetAt(text, col) {
  let c = 0;
  for (let i = 0; i < text.length; i++) {
    const w = text[i] === "\t" ? TAB - (c % TAB) : 1;
    if (col < c + w) return i;
    c += w;
  }
  return text.length;
}

// A press at x (px from the list's left) on a code row: the clickable token under it and the language-server
// position — line on the row's side (1-based; new side for added and context rows) and the UTF-16 character in the
// original text. spans are for the tab-expanded text. null when no name is under the pointer.
export function tokenAt(row, spans, x, codeLeft, charW) {
  const col = Math.floor((x - codeLeft) / charW);
  if (col < 0 || row.number === undefined) return null;
  const ref = spans.find((s) => s.ref && s.start <= col && col < s.end);
  if (!ref) return null;
  const shown = expandTabs(row.text);
  return { name: shown.slice(ref.start, ref.end), side: row.kind === "-" ? "-" : "+", line: row.kind === "-" ? row.o ?? row.number : row.n ?? row.number,
    character: offsetAt(row.text, ref.start) };
}

// ---- since your last review (open-reviews.json `reviewed`: {sha, how: "sent"|"done"|"seen", at})

// The mark after this visit: sending or Mark done always moves it; just having the review open ("seen") moves it
// only to a new head, so it never downgrades a sent/done mark of the same head.
export function markReviewed(old, head, how, now) {
  if (!head) return old ?? null;
  return how === "seen" && old?.sha === head ? old : { sha: head, how, at: now };
}

// The head to diff from: the last mark, when the PR moved since; null when there is none or it is the head.
export const sinceBase = (entry, head) => (entry?.reviewed?.sha && head && entry.reviewed.sha !== head ? entry.reviewed : null);

// ---- fix verification (verify.py) and finding statuses

// Findings sent to Fix (status fixHead) whose PR head moved since, not settled and not verified on this head yet.
export function verifyCandidates(findings, status, head, statusOf) {
  return findings.filter((f) => {
    const st = status[f.id];
    return st?.fixHead && head && st.fixHead !== head && st.verify?.head !== head && statusOf(f) !== "dismissed";
  });
}

// verify.py's verdicts into the status map: fixed → ✓, not fixed → open again with the reason, unclear → as it was,
// with the note. Each keeps {verify: {result, reason, head, at}}.
export function applyVerification(status, results, head, now) {
  const out = { ...status }, at = new Date(now).toISOString();
  for (const r of results ?? []) {
    const old = status[r.id] ?? {}, verify = { result: r.verdict, reason: r.reason ?? "", head, at };
    out[r.id] = r.verdict === "fixed" ? { ...old, s: "fixed", at, verify } : r.verdict === "not_fixed" ? { ...old, s: "open", at, verify } : { ...old, verify };
  }
  return out;
}

// ---- pictures (review.py "visual" per layer, "architecture", "blast_radius")

// Column per node: the longest path from a node nothing points to (cycles broken by visiting order), so a flow reads
// left to right (or top to bottom). Unknown edge ends are ignored.
export function levels(nodes, edges) {
  const ids = new Set(nodes.map((n) => n.id)), out = new Map(nodes.map((n) => [n.id, []])), indeg = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges ?? []) if (ids.has(e.from) && ids.has(e.to) && e.from !== e.to) { out.get(e.from).push(e.to); indeg.set(e.to, indeg.get(e.to) + 1); }
  const level = new Map(), queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  for (const id of queue) level.set(id, 0);
  while (queue.length) {
    const id = queue.shift();
    for (const to of out.get(id)) {
      level.set(to, Math.max(level.get(to) ?? 0, level.get(id) + 1));
      indeg.set(to, indeg.get(to) - 1);
      if (indeg.get(to) === 0) queue.push(to);
    }
  }
  for (const n of nodes) if (!level.has(n.id)) level.set(n.id, 0); // in a cycle: first column
  return level;
}

// The spec-only elements of the pictures, by id: {id, label, page: "arch" | null, step: index | null}. Asks link to
// the ones they name.
export function specElements(ai) {
  const out = new Map(), add = (id, label, where) => { if (!out.has(id)) out.set(id, { id, label: label ?? id, ...where }); };
  for (const n of ai?.arch?.nodes ?? []) if (n.source === "spec") add(n.id, n.label, { page: "arch", step: null });
  for (const v of ai?.visuals ?? []) for (const n of v.nodes ?? []) if (n.source === "spec") add(n.id, n.label, { page: "arch", step: null });
  (ai?.steps ?? []).forEach((s, k) => { for (const v of s.visuals ?? []) for (const n of v.nodes ?? []) if (n.source === "spec") add(n.id, n.label, { page: null, step: k }); });
  return out;
}

// The layout of these pictures: arch.js archLayout.

// The blast radius as an architecture picture: upstream context, the changed units, downstream context (columns),
// context linked to the unit it touches (dashed edges carrying the relation).
export function blastArch(blast, findings = []) {
  const units = blast?.units ?? [], ctx = blast?.context ?? [];
  const nodes = [
    ...ctx.filter((c) => c.direction === "upstream").map((c) => ({ id: `c:${c.id}`, group: "up", label: c.file.split("/").pop(), description: c.relation, type: "context", status: "unchanged", file: c.file })),
    ...units.map((u) => ({ id: `u:${u.id}`, group: "unit", label: u.label, description: (u.files ?? []).join(", "), type: u.type ?? "", status: u.status === "new" || u.status === "added" ? "new" : u.status === "removed" ? "removed" : "changed",
      spots: u.spots ?? 0, file: u.files?.[0], findings: findings.filter((f) => (u.files ?? []).includes(f.file)) })),
    ...ctx.filter((c) => c.direction !== "upstream").map((c) => ({ id: `c:${c.id}`, group: "down", label: c.file.split("/").pop(), description: c.relation, type: "context", status: "unchanged", file: c.file })),
  ];
  const edges = ctx.filter((c) => units.some((u) => u.id === c.links_to)).map((c) => (c.direction === "upstream"
    ? { from: `c:${c.id}`, to: `u:${c.links_to}`, label: c.relation, dashed: true } : { from: `u:${c.links_to}`, to: `c:${c.id}`, label: c.relation, dashed: true }));
  return { groups: [{ id: "up", label: "Upstream", kind: "RELATED CONTEXT" }, { id: "unit", label: "Changed", kind: "" }, { id: "down", label: "Downstream", kind: "RELATED CONTEXT" }], nodes, edges,
    counts: { added: units.filter((u) => u.status === "new" || u.status === "added").length, changed: units.filter((u) => !["new", "added"].includes(u.status)).length,
      up: ctx.filter((c) => c.direction === "upstream").length, down: ctx.filter((c) => c.direction !== "upstream").length } };
}

// ---- pre-merge checks and merge blockers (no LLM: the analysis' rule checks, gh pr checks, mergeability)

export const CONVENTIONAL = /^(feat|fix|chore|docs|refactor|test|ci|build|perf|revert|style)(\([^)]+\))?!?: \S/;

// ctx: related.py's {checks: [{name, bucket}], mergeable}. Each check {name, ok: true|false|null (pending), why}.
export function preMergeChecks({ title, rules = [], ctx = null }) {
  const out = [];
  if (title) out.push({ name: "Conventional Commit title", ok: CONVENTIONAL.test(title), why: CONVENTIONAL.test(title) ? title : `"${title}" is not type(scope): subject` });
  for (const r of rules) if (r.status !== "n/a") out.push({ name: r.rule, ok: r.status === "pass", why: r.why, where: r.where, rule: true });
  for (const c of ctx?.checks ?? []) if (c.bucket !== "skipping") out.push({ name: `CI: ${c.name}`, ok: c.bucket === "pass" ? true : c.bucket === "pending" ? null : false, why: c.bucket, ci: true });
  if (ctx?.mergeable) out.push({ name: "No merge conflicts", ok: ctx.mergeable === "MERGEABLE" ? true : ctx.mergeable === "CONFLICTING" ? false : null, why: ctx.mergeable.toLowerCase() });
  return out;
}

// What stands between the PR and a merge, most severe first: conflicts, failing CI, failed rules, high/critical open
// findings, fixes not verified on this head, overlapping open PRs.
export function mergeBlockers({ checks = [], findings = [], unverified = 0, related = null }) {
  const out = [];
  if (checks.some((c) => c.name === "No merge conflicts" && c.ok === false)) out.push({ severity: "high", title: "Code conflicts need to be resolved", why: "The base branch changed the same lines since this branch was cut: merge or rebase the base first." });
  const ci = checks.filter((c) => c.ci && c.ok === false);
  if (ci.length) out.push({ severity: "high", title: `${ci.length} CI ${ci.length === 1 ? "check is" : "checks are"} failing`, why: ci.map((c) => c.name.replace(/^CI: /, "")).join(", ") });
  for (const c of checks.filter((x) => (x.rule || x.name === "Conventional Commit title") && x.ok === false)) out.push({ severity: "medium", title: `Rule not met: ${c.name}`, why: c.why ?? "", where: c.where });
  for (const f of findings.filter((x) => x.severity === "high" || x.severity === "critical")) out.push({ severity: "high", title: f.title, why: `${f.file}:${f.line} · open ${f.severity} finding`, finding: f.id });
  if (unverified) out.push({ severity: "medium", title: `${unverified} ${unverified === 1 ? "fix is" : "fixes are"} not verified`, why: "Sent to Fix before the last push: verify them on the new head." });
  for (const p of related?.open ?? []) if (p.overlap > 0) out.push({ severity: "low", title: `Overlaps with open PR #${p.number}`, why: `Both change ${p.overlap} ${p.overlap === 1 ? "file" : "files"} (${(p.files ?? []).slice(0, 3).join(", ")}): agree on the merge order.`, url: p.url });
  return out;
}

// ---- PR triage card (main.js list, registry consumers): no LLM, from what is cached; triage.py's why/priority beat the guess

const TYPES = { feat: "Feature", fix: "Fix", refactor: "Refactor", docs: "Docs", chore: "Chore", test: "Test", perf: "Performance", ci: "CI", build: "Build", revert: "Revert", style: "Style" };

// pr: prs.json entry; analysis: a mapReview result or null; size: {files, lines} or null; security: open security
// findings [{severity}]; related: related.py's; llm: triage.py's {priority, why} or null.
export function triageOf({ pr, analysis = null, size = null, security = [], related = null, llm = null }) {
  const type = TYPES[/^(\w+)(\(|!|:)/.exec(pr?.title ?? "")?.[1]] ?? "Change";
  const score = analysis?.effort?.score ?? (size ? (size.lines < 50 && size.files <= 3 ? 1 : size.lines < 400 ? 3 : 5) : null);
  const effort = score === null ? null : score <= 2 ? "Low effort" : score === 3 ? "Medium effort" : "High effort";
  const risk = analysis?.mergeRisk?.level ?? null, high = risk === "high" || risk === "critical";
  const sec = security.some((f) => f.severity === "high" || f.severity === "critical") || high ? "High security risk" : security.length ? "Security risk" : null;
  const overlap = (related?.open ?? []).filter((p) => p.overlap > 0).length;
  const priority = llm?.priority ?? (high || overlap ? 1 : risk === "medium" || score >= 4 ? 2 : 3);
  const why = llm?.why ?? (overlap ? `Review this early: ${overlap} other open ${overlap === 1 ? "PR touches" : "PRs touch"} the same files, so its assumptions shape theirs.`
    : high ? `Review this early: merge risk is ${risk}${analysis.mergeRisk.why ? ` (${analysis.mergeRisk.why})` : ""}.`
    : score !== null && score <= 2 && !sec ? "A quick look should do: small and low risk." : null);
  const depth = score === null ? null : score >= 3 || high ? "Deep review" : "Quick look";
  return { priority, why, chips: [sec, type, depth, effort].filter(Boolean) };
}

// ---- PRs you didn't open (main.js sources "This repo", "Review requested", "Open PR…")

// "https://github.com/o/r/pull/12" (also …/files), "o/r#12" or "o/r/pull/12" → {repo, number, url}; null otherwise.
export function parsePrRef(text) {
  const m = /^\s*(?:https?:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:#|\/pull\/)(\d+)(?:\/[\w/-]*)?(?:[?#].*)?\s*$/.exec(String(text ?? ""));
  return m ? { repo: m[1], number: Number(m[2]), url: `https://github.com/${m[1]}/pull/${m[2]}` } : null;
}

// A gh PR (pr list / pr view / search prs JSON) as a prs.json-like target the panel and the review layout take.
// No session: replies go to a new Claude tab. headSha is null for search results (gh pr view fills it on open).
export function ghTarget(p, { repo, context, cwd = null, source }) {
  const r = repo ?? p.repository?.nameWithOwner ?? /github\.com\/([^/]+\/[^/]+)\/pull/.exec(p.url ?? "")?.[1];
  return { url: p.url, repo: r, number: p.number, title: p.title, author: p.author?.login ?? null, state: p.isDraft ? "draft" : String(p.state ?? "open").toLowerCase(),
    head: p.headRefName ?? null, headSha: p.headRefOid ?? null, base: p.baseRefName ?? null, updatedAt: p.updatedAt ?? null, review: p.reviewDecision || null,
    add: p.additions ?? null, del: p.deletions ?? null, context, sessionContext: context, session: null, cwd, source };
}

// The source lists cache (pr-data/sources.json, {key: {at, prs}}): the newest max keys.
export function pruneSources(doc, max = 20) {
  return Object.fromEntries(Object.entries(doc ?? {}).sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0)).slice(0, max));
}

// ---- installing the review layout (startReview): mods/pr-review/review-layout.json into layouts/ on first use

// Whether a layout file is this mod's review layout: a block with the review part of pr-review.
export function isReviewLayout(text) {
  try {
    const walk = (n) => Boolean(n) && ((n.content?.mod === "pr-review" && n.content?.props?.part === "review") || (n.children ?? []).some(walk));
    return walk(JSON.parse(text));
  } catch { return false; }
}

// Which layout name to switch to and whether to write it, from the current layouts/review.json and
// layouts/pr-review.json (text, or null when missing). Never overwrites a file that is there.
export function layoutPlan(review, prReview) {
  if (review == null) return { name: "review", write: true };
  if (isReviewLayout(review)) return { name: "review", write: false };
  return { name: "pr-review", write: prReview == null };
}

