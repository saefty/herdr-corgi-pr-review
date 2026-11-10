// Pure helpers (no gpui, node-testable) for the review layout's deeper views: the resizable left column, "Ask about
// this" (one LLM call per question, a short thread per PR), "Show details" (a drill-down sub-diagram per node, with a
// breadcrumb) and Explore (a walkthrough of existing code without a PR). review.js draws them; review.py and
// explore.py make the calls.

// ---- the left column (Files / Layers / Findings): shared "review.leftWidth", null = the default
export const LEFT_W = { def: 560, min: 340, max: 0.65 };
// The column's width for a stored width w (null: default) in a window win px wide (0/undefined: not measured yet).
export function leftWidth(w, win) {
  const max = win > 0 ? Math.max(LEFT_W.min, Math.floor(win * LEFT_W.max)) : Infinity;
  return Math.min(max, Math.max(LEFT_W.min, Number.isFinite(w) ? Math.round(w) : LEFT_W.def));
}

// ---- a click on a diff row (review.js onItem; x from the list's left edge, w its width)
export const CHIP_W = 112; // the "+ Comment (c)" chip at the right end of the selection's last row
// What the click does: {sel: the new selection or null, open: open the composer, focus: keep typing in the open one}.
// The line numbers (and the sign column) open the composer at once, as GitHub's "+"; a shift-click that completes a
// range on the same file opens it too; a click on code selects (again: unselects); the chip opens it for the selection.
export function rowClick({ x, w, shift, gutterW, composing, editing, sel, path, k, rangeOk }) {
  const gutter = x < gutterW, chip = !composing && sel?.path === path && sel.b === k && x >= w - 12 - CHIP_W && x < w - 12;
  if (chip) return { sel, open: true };
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
  const s = Number.isInteger(focus?.layer) ? ai?.steps?.[focus.layer] : null;
  if (s) return { kind: "layer", layer: { title: s.title, why: s.why, text: s.text, visuals: s.visuals ?? [], evidence: s.evidence ?? [] } };
  return { kind: "picture" };
}

// The files a scope points at (its evidence), for picking diff hunks.
export function scopeFiles(scope) {
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
