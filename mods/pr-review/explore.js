// Pure helpers (no gpui, node-testable) for the review layout's deeper views: the resizable left column, "Ask about
// this" (one LLM call per question, a short thread per PR), "Show details" (a drill-down sub-diagram per node, with a
// breadcrumb) and Explore (a walkthrough of existing code without a PR). review.js draws them; review.py and
// explore.py make the calls.
import { hash, mapReview } from "./pr.js";

// ---- the left column (Files / Layers / Findings): shared "review.leftWidth", null = the default
export const LEFT_W = { def: 560, min: 340, max: 0.65 };
// The column's width for a stored width w (null: default) in a window win px wide (0/undefined: not measured yet).
export function leftWidth(w, win) {
  const max = win > 0 ? Math.max(LEFT_W.min, Math.floor(win * LEFT_W.max)) : Infinity;
  return Math.min(max, Math.max(LEFT_W.min, Number.isFinite(w) ? Math.round(w) : LEFT_W.def));
}

// ---- a click on a diff row (review.js onItem; x from the list's left edge, w its width)
export const CHIP_W = 112, ASK_W = 54; // the "+ Comment (c)" chip at the right end of the selection's last row, "Ask" left of it
// What the click does: {sel: the new selection or null, open: open the composer, focus: keep typing in the open one}.
// The line numbers (and the sign column) open the composer at once, as GitHub's "+"; a shift-click that completes a
// range on the same file opens it too; a click on code selects (again: unselects); the chip opens it for the selection.
export function rowClick({ x, w, shift, gutterW, composing, editing, sel, path, k, rangeOk }) {
  const last = !composing && sel?.path === path && sel.b === k, chip = last && x >= w - 12 - CHIP_W && x < w - 12;
  const gutter = x < gutterW, ask = last && x >= w - 20 - CHIP_W - ASK_W && x < w - 20 - CHIP_W;
  if (chip) return { sel, open: true };
  if (ask) return { sel, ask: true };
  if (composing && !gutter && !shift) return { sel, focus: true };
  if (shift && sel?.path === path && rangeOk) return { sel: { ...sel, b: k }, open: !editing };
  if (gutter) return { sel: { path, a: k, b: k }, open: true };
  return { sel: sel?.path === path && sel.a === k && sel.b === k ? null : { path, a: k, b: k }, open: false };
}

// Who gets a key pressed in the review (review.js onReviewKey, on the root): the composer or summary while typing
// there; the review's single-key shortcuts only while the root itself has the keyboard; a focused input (Ask about
// this, the Explore topic) keeps its letters, and Esc there hands the keyboard back to the review.
export function keyRoute({ typing, rootFocused, key }) {
  if (typing) return "typing";
  if (!rootFocused) return key === "escape" ? "blur" : "pass";
  return "shortcut";
}

// ---- evidence ("path:line")
export const pathOf = (at) => (/^(.*?):\d+/.exec(String(at ?? ""))?.[1] ?? (at ? String(at) : null));
export const lineOf = (at) => Number(/:(\d+)/.exec(String(at ?? ""))?.[1] ?? 0) || null;
const sameFile = (a, b) => Boolean(a && b) && (a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`));

// The architecture as the ask and drill calls see it: node ids as they are, edges as e<index> (archView's paths keep
// the index, so highlights find their badge).
export function pictureOf(arch) {
  return { nodes: (arch?.nodes ?? []).map((n) => ({ id: n.id, label: n.label, group: n.group, type: n.type, status: n.status, source: n.source, evidence: n.at ?? n.evidence ?? null, description: n.description })),
    edges: (arch?.edges ?? []).map((e, i) => ({ id: `e${i}`, from: e.from, to: e.to, label: e.label, source: e.source, evidence: e.evidence ?? null })) };
}

// What a question or drill-down is about: a node of the architecture (with its edges), a layer, or nothing (the whole
// picture). focus: {node: id} | {layer: index} | {visual: {title, node}} | null.
export function scopeOf(ai, focus) {
  const pic = pictureOf(ai?.arch);
  if (focus?.node) {
    const node = pic.nodes.find((n) => n.id === focus.node) ?? (focus.label ? { id: focus.node, label: focus.label, evidence: focus.at ?? null } : null);
    if (node) return { kind: "node", node, edges: pic.edges.filter((e) => e.from === node.id || e.to === node.id) };
  }
  if (focus?.range?.file) return { kind: "range", range: focus.range };
  const s = Number.isInteger(focus?.layer) ? ai?.steps?.[focus.layer] : null;
  if (s) return { kind: "layer", layer: { title: s.title, why: s.why, text: s.text, visuals: s.visuals ?? [], evidence: s.evidence ?? [] } };
  return { kind: "picture" };
}

// The files a scope points at (its evidence), for picking diff hunks.
export function scopeFiles(scope) {
  if (scope.kind === "range") return [scope.range.file];
  const at = scope.kind === "node" ? [scope.node.evidence, ...scope.edges.map((e) => e.evidence)]
    : scope.kind === "layer" ? [...scope.layer.evidence, ...scope.layer.visuals.flatMap((v) => [...(v.nodes ?? []).map((n) => n.at ?? n.evidence), ...(v.edges ?? []).map((e) => e.evidence)])] : [];
  return [...new Set(at.map(pathOf).filter(Boolean))];
}

// The diff hunks for those files (bounded), as {path, lines}; layerHunks: the hunk ids of a layer, taken first.
export function hunksFor(paths, hunks, layerHunks = [], max = 12, maxChars = 24000) {
  const pick = [...(hunks ?? []).filter((h) => layerHunks.includes(h.id)), ...(hunks ?? []).filter((h) => !layerHunks.includes(h.id) && paths.some((p) => sameFile(h.path, p)))];
  const out = [];
  let used = 0;
  for (const h of pick) {
    const size = h.lines.reduce((n, l) => n + l.length + 1, 0);
    if (out.length >= max || used + size > maxChars) break;
    out.push({ path: h.path, lines: h.lines }); used += size;
  }
  return out;
}

// ---- Ask about this: the answer, a short thread per PR

export const ASK_TURNS = 6, ASK_THREADS = 40, ASK_HISTORY = 4;
// The model's answer, kept to what exists: highlight ids in the picture, evidence as path:line.
export function mapAnswer(raw, arch) {
  const pic = pictureOf(arch), nodes = new Set(pic.nodes.map((n) => n.id)), edges = new Set(pic.edges.map((e) => e.id));
  const h = raw?.highlights ?? {};
  return { text: String(raw?.text ?? "").trim(),
    highlights: { nodes: [...new Set((h.nodes ?? []).map(String))].filter((id) => nodes.has(id)), edges: [...new Set((h.edges ?? []).map(String))].filter((id) => edges.has(id)) },
    evidence: (raw?.evidence ?? []).filter((e) => /^.+:\d+/.test(String(e?.at ?? ""))).slice(0, 8).map((e) => ({ at: String(e.at), why: String(e.why ?? "") })) };
}

// doc: {<source>: {at, turns: [{q, scope, a, at}]}}. Adds a turn (the last ASK_TURNS stay), keeps the newest ASK_THREADS.
export function threadAdd(doc, key, turn, now = Date.now()) {
  const next = { ...(doc ?? {}), [key]: { at: now, turns: [...(doc?.[key]?.turns ?? []), { ...turn, at: now }].slice(-ASK_TURNS) } };
  for (const k of Object.keys(next).sort((a, b) => next[b].at - next[a].at).slice(ASK_THREADS)) delete next[k];
  return next;
}
export const threadOf = (doc, key) => doc?.[key]?.turns ?? [];
// What a follow-up question sends along: the last few turns, question and answer text.
export const history = (turns) => (turns ?? []).slice(-ASK_HISTORY).map((t) => ({ q: t.q, a: t.a?.text ?? "" }));

// The answer's highlights in a laid-out picture (arch.js layout L), through the focus mechanism: the first highlighted
// node is focused, the first highlighted edge's badge lit.
export function highlightOf(L, a) {
  const ids = new Set(L?.nodes?.map((n) => n.id) ?? []), focus = (a?.highlights?.nodes ?? []).find((id) => ids.has(id)) ?? null;
  const idx = (a?.highlights?.edges ?? []).map((e) => Number(String(e).slice(1)));
  const p = (L?.paths ?? []).find((x) => x.edges.some((i) => idx.includes(i)));
  return { focus, hl: p?.num ?? null };
}

// What a scope is called in the drawer's header.
export const rangeLabel = (r) => `${String(r.file).split("/").pop()}:${r.start}${r.end !== r.start ? `–${r.end}` : ""}`;

// ---- Pins: an answer pinned to the card or edge it is about, or to the asked lines; private notes, never posted.
export const PINS = 40, PIN_PRS = 40;
// The pin's one-line summary: the answer's first sentence, short.
export function pinSummary(text) {
  const t = String(text ?? "").replace(/[`*_]/g, "").replace(/\s+/g, " ").trim(), first = (/^(.+?[.!?])(\s|$)/.exec(t)?.[1] ?? t);
  return first.length > 90 ? `${first.slice(0, 89)}…` : first;
}
// Where an answer pins: its first highlighted card, else its first edge, else the asked lines, else the asked card.
export function pinAnchor(turn) {
  const h = turn?.a?.highlights ?? {}, sc = turn?.scope ?? {};
  if (h.nodes?.length) return { node: h.nodes[0] };
  if (h.edges?.length) return { edge: h.edges[0] };
  if (sc.kind === "range") return { file: sc.range.file, start: sc.range.start, end: sc.range.end, old: Boolean(sc.range.old) };
  if (sc.kind === "node") return { node: sc.node.id };
  return null;
}
// doc: {<source>: {at, pins: [{id, anchor, summary, evidence, text, q, at}]}}; one pin per answer, bounded.
export function pinAdd(doc, key, turn, now = Date.now()) {
  const anchor = pinAnchor(turn);
  if (!anchor) return doc;
  const pin = { id: `p${turn.at ?? now}`, anchor, summary: pinSummary(turn.a?.text), evidence: turn.a?.evidence?.[0]?.at ?? null, text: turn.a?.text ?? "", q: turn.q ?? "", at: now };
  const pins = [...(doc?.[key]?.pins ?? []).filter((p) => p.id !== pin.id), pin].slice(-PINS), next = { ...(doc ?? {}), [key]: { at: now, pins } };
  for (const k of Object.keys(next).sort((a, b) => next[b].at - next[a].at).slice(PIN_PRS)) delete next[k];
  return next;
}
export const pinDrop = (doc, key, id, now = Date.now()) => ({ ...(doc ?? {}), [key]: { at: now, pins: (doc?.[key]?.pins ?? []).filter((p) => p.id !== id) } });
export const pinsOf = (doc, key) => doc?.[key]?.pins ?? [];
// Pins on a laid-out picture (arch.js layout L): attached ones with a spot (a card's top edge, an edge's badge), the
// rest unattached (the card went with a refresh): never dropped. A code pin also marks the card whose place is its file.
export function pinsOn(pins, L) {
  const on = [], off = [];
  for (const pin of pins) {
    const a = pin.anchor ?? {};
    const n = a.node ? L?.nodes?.find((x) => x.id === a.node) : a.file ? L?.nodes?.find((x) => pathOf(x.at ?? x.evidence) && sameFile(pathOf(x.at ?? x.evidence), a.file)) : null;
    const p = a.edge ? L?.paths?.find((x) => x.edges.includes(Number(String(a.edge).slice(1)))) : null;
    if (n) on.push({ pin, x: n.x + 10, y: n.y - 9, w: n.w - 20 });
    else if (p?.badge) on.push({ pin, x: p.badge.x + 12, y: p.badge.y - 9, w: 200 });
    else if (!a.file) off.push(pin);
  }
  return { on, off };
}
// The code pins of a file, by the line they hang under.
export const codePins = (pins, file) => pins.filter((p) => p.anchor?.file && sameFile(p.anchor.file, file));

// ---- Show details: a sub-diagram per node, a breadcrumb, a bounded cache per node and diff head

export const DRILLS = 60;
// stack: [{id, label, group?}] from the top picture down; pushing an item already on it goes back to it.
export function drillPush(stack, item) {
  const k = (stack ?? []).findIndex((x) => x.id === item.id);
  return k >= 0 ? stack.slice(0, k + 1) : [...(stack ?? []), item];
}
// A breadcrumb click: depth 0 closes the drill-down, k keeps the first k levels.
export const drillTo = (stack, k) => (stack ?? []).slice(0, Math.max(0, k));
// "Architecture › Workers › Stages handler": the root, the first node's group (not a level), every level.
export function crumbs(stack, root) {
  const out = [{ label: root, depth: 0 }];
  (stack ?? []).forEach((x, k) => { if (k === 0 && x.group) out.push({ label: x.group, depth: null }); out.push({ label: x.label, depth: k + 1 }); });
  return out;
}
export const drillKey = (source, head, stack) => `${source}|${head ?? ""}|${(stack ?? []).map((x) => x.id).join("/")}`;
// doc: {<key>: {at, ...}}: put one, keep the newest max.
export function cachePut(doc, key, value, max = DRILLS, now = Date.now()) {
  const next = { ...(doc ?? {}), [key]: { ...value, at: now } };
  for (const k of Object.keys(next).sort((a, b) => next[b].at - next[a].at).slice(max)) delete next[k];
  return next;
}

const KINDS = ["flow", "sequence", "state_machine"];
const SOURCES = ["implemented", "existing", "spec"];
// The drill-down's answer as a visual stack.js visualCard draws: sample values go into the node's note (as the
// debugger values), payloads into the edge labels; unknown kinds become flow.
export function mapDrill(raw) {
  const v = raw?.visual ?? {}, kind = KINDS.includes(v.kind) ? v.kind : "flow";
  const nodes = (v.nodes ?? []).filter((n) => n?.id).slice(0, 12).map((n) => ({ id: String(n.id), label: n.label ?? n.id, at: n.at ?? n.evidence ?? undefined,
    note: [n.note, n.values ? `= ${n.values}` : null].filter(Boolean).join("\n") || undefined, changed: Boolean(n.changed), type: n.type,
    source: SOURCES.includes(n.source) ? n.source : undefined, evidence: n.evidence ?? undefined }));
  const ids = new Set(nodes.map((n) => n.id));
  const link = (e) => ({ from: String(e.from), to: String(e.to), label: e.label ?? "", event: e.event, guard: e.guard, action: e.action, changed: Boolean(e.changed),
    source: SOURCES.includes(e.source) ? e.source : undefined, evidence: e.evidence ?? undefined });
  const edges = [...(v.edges ?? []), ...(v.transitions ?? [])].filter((e) => ids.has(String(e?.from)) && ids.has(String(e?.to))).slice(0, 16).map(link);
  return { summary: String(raw?.summary ?? "").trim(), visual: { kind, title: v.title ?? "", nodes, ...(kind === "state_machine" ? { edges: [], transitions: edges } : { edges }) } };
}

// ---- Explore: a walkthrough of existing code, saved per repo and topic

export const EXPLORE_MAX = 20;
export const exploreId = (root, topic) => hash(`${root}\0${String(topic).trim().toLowerCase()}`);
// The Explorations list: newest first, one per repo and topic, at most max; dropped: the ids that fell off (their files go).
export function exploreIndex(list, entry, max = EXPLORE_MAX) {
  const all = [entry, ...(list ?? []).filter((x) => x.id !== entry.id)];
  return { list: all.slice(0, max), dropped: all.slice(max).map((x) => x.id) };
}

// Every place a walkthrough cites (layers' evidence, pictures, flows, statements), per file with its lines.
export function citedFiles(ai) {
  const at = [...(ai?.intent ?? []), ...(ai?.behaviorPoints ?? [])].map((x) => x.evidence);
  for (const n of ai?.arch?.nodes ?? []) at.push(n.at, n.evidence, ...(n.states ?? []).map((s) => s.evidence));
  for (const e of ai?.arch?.edges ?? []) at.push(e.evidence);
  const vis = [...(ai?.visuals ?? []), ...(ai?.steps ?? []).flatMap((s) => s.visuals ?? [])];
  for (const v of vis) at.push(...(v.nodes ?? []).flatMap((n) => [n.at, n.evidence]), ...[...(v.edges ?? []), ...(v.transitions ?? [])].map((e) => e.evidence));
  for (const s of ai?.steps ?? []) at.push(...(s.evidence ?? []), ...(s.flows ?? []).flatMap((f) => [f.at, ...(f.trace ?? []).map((t) => `${t.path}:${t.line}`)]));
  const files = new Map();
  for (const x of at) {
    const p = pathOf(x), l = lineOf(x);
    if (!p || !l || /^https?:/.test(p)) continue;
    const set = files.get(p) ?? new Set();
    set.add(l);
    files.set(p, set);
  }
  return [...files].map(([path, lines]) => ({ path, lines: [...lines].sort((a, b) => a - b) })).sort((a, b) => a.path.localeCompare(b.path));
}

// A saved exploration (explore.py) in the shape the review layout draws: layers without hunks, each with its evidence;
// Question / How it works as the statements; everything existing.
export function exploreAi(saved) {
  const a = saved?.answer ?? {};
  const raw = (a.steps ?? []).map((s) => ({ ...s, hunks: [], check_questions: [], suggestions: [] }));
  const r = mapReview({ ...a, intent: a.question, behavior_points: a.how_it_works, behavior: a.summary, steps: raw, rule_checks: [], asks: [] }, []);
  for (const s of r.steps) s.evidence = (raw[s.n]?.evidence ?? []).filter((x) => lineOf(x));
  const ai = { ...r, explore: true, exact: true, topic: saved?.topic ?? "", root: saved?.root ?? null, repo: saved?.repo ?? null, cost: saved?.cost ?? null, ms: saved?.ms ?? null,
    budget: saved?.budget ?? null, model: saved?.model ?? null, model_id: saved?.model_id ?? null, generated: saved?.generated ?? null, cut: [], task: {}, diagrams: null };
  return { ...ai, files: citedFiles(ai) };
}

// ---- the analysis' scope (review.py): "Read 38 of 41 files in detail, 3 skimmed (lockfiles)"
export function scopeLine(scope) {
  if (!scope?.files) return "";
  const passes = scope.passes > 1 ? ` · ${scope.passes} passes` : "";
  return `Read ${scope.detailed} of ${scope.files} ${scope.files === 1 ? "file" : "files"} in detail${scope.skimmed ? `, ${scope.skimmed} skimmed${scope.why ? ` (${scope.why})` : ""}` : ""}${passes}`;
}

// ---- Explore's trust (Restricted Mode for language servers): only a github.com remote names a repo; a folder without
// one is trusted only when you trusted that folder, a repo when it is yours (owner = your gh login) or you trusted it.
export function repoOfRemote(url) {
  const u = String(url ?? "").trim(), scp = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(\.git)?$/.exec(u);
  if (scp) return `${scp[1]}/${scp[2]}`;
  try {
    const p = new URL(u);
    if (p.hostname !== "github.com" || !["https:", "ssh:"].includes(p.protocol)) return null;
    const [owner, name] = p.pathname.replace(/^\//, "").replace(/\.git$/, "").split("/");
    return owner && name ? `${owner}/${name}` : null;
  } catch { return null; }
}
export function exploreTrust({ repo, root, login, trustedRepos = [], trustedRoots = [] }) {
  if (!root) return false;
  if (!repo) return trustedRoots.includes(root);
  return (Boolean(login) && repo.split("/")[0].toLowerCase() === String(login).toLowerCase()) || trustedRepos.includes(repo) || trustedRoots.includes(root);
}
