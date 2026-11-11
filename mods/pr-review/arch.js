// The architecture picture's layout (also the blast radius): pure and deterministic, drawn by stack.js archView.
// Every call points left to right. Columns come from the calls: inside a group, a node sits right of what calls it
// (longest chain); a group starts far enough right that each call into it goes right too, and groups whose columns
// overlap stack vertically (so a group can span columns, and several groups can share one). A call that closes a
// cycle, or that would skip a column, is not drawn as a line: it is a short stub at the source with a chip naming the
// target ("→ Code host API ⑧"). The other calls reach the next column on a lane of their own in the gutter between;
// calls to the same target with the same meaning (label) merge into one lane and one entry port (a bus). When one node
// calls several cards of one group, one trunk enters the group's frame and fans out in its left inset (a fan).
// Inside a column, groups and nodes are ordered by their neighbours (barycentre sweeps) so lines cross less; lane
// order per gutter is the one with the fewest crossings, and a crossing that stays gets a hop. Labels are not drawn
// on lines: each path has a numbered badge (a stub: its chip), and the text goes in a legend. Cards grow with their
// text: title up to 2 lines, description up to 3 (cut with an ellipsis; the full text is the tooltip). A node with
// `states` (an orchestrator: Step Functions, a state machine) shows them as a vertical lane in its card, and each
// state's `calls` leaves the card at that state's row.

export const ARCH = { W: 230, PAD: 12, HEAD: 30, GAP_Y: 18, GAP_G: 20, LANE: 12, GAP_MIN: 64, BADGE: 18, HOP: 8, PORT: 12,
  STUB: 16, CHIP_H: 24, CHIP_GAP: 30, CH: 6.4, FAN: 30, ROW: 18, TITLE_CH: 29, DESC_CH: 38 };

// Word-wrapped lines of text at `per` characters (long words are split).
export function wrapLines(text, per) {
  const out = [];
  let line = "";
  for (let word of String(text ?? "").split(/\s+/).filter(Boolean)) {
    while (word.length > per) { if (line) { out.push(line); line = ""; } out.push(word.slice(0, per)); word = word.slice(per); }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= per) line += ` ${word}`;
    else { out.push(line); line = word; }
  }
  if (line) out.push(line);
  return out;
}

// At most `max` lines: {text, lines, cut}; a cut text ends in "…".
export function clampText(text, per, max) {
  const all = wrapLines(text, per);
  if (all.length <= max) return { text: all.join(" "), lines: all.length, cut: false };
  const keep = all.slice(0, max);
  keep[max - 1] = `${keep[max - 1].slice(0, per - 1).replace(/\s+\S*$/, (m) => (keep[max - 1].length > per - 2 ? "" : m))}…`;
  return { text: keep.join(" "), lines: max, cut: true };
}

const circled = (n) => (n >= 1 && n <= 20 ? String.fromCharCode(0x2460 + n - 1) : `(${n})`);
const norm = (s) => String(s ?? "").trim().toLowerCase();
const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

// The order with the lowest cost: every permutation for up to 4 items (24 tries), else adjacent swaps from the given
// order until nothing improves. ponytail: a full search of 6 items (720 layouts) timed the render out.
export function bestOrder(items, cost, start = items) {
  if (items.length <= 4) {
    let best = null, bestCost = Infinity;
    for (const p of permutations(items)) { const k = cost(p); if (k < bestCost) { best = p; bestCost = k; } if (k === 0) break; }
    return best;
  }
  let order = [...start], cur = cost(order);
  for (let improved = true, rounds = 0; improved && cur > 0 && rounds < items.length; rounds++) {
    improved = false;
    for (let i = 0; i + 1 < order.length; i++) {
      const next = [...order]; [next[i], next[i + 1]] = [next[i + 1], next[i]];
      const k = cost(next);
      if (k < cur) { order = next; cur = k; improved = true; }
    }
  }
  return order;
}
export function permutations(list) {
  if (list.length <= 1) return [list];
  return list.flatMap((x, i) => permutations([...list.slice(0, i), ...list.slice(i + 1)]).map((p) => [x, ...p]));
}

// Items ordered so that every pair [a, b] has a before b; when only cycles are left, the earliest remaining item goes
// next (its incoming pairs are the ones that close a cycle). Deterministic.
export function topo(items, pairs) {
  const left = [...items], out = [];
  while (left.length) {
    const k = Math.max(0, left.findIndex((x) => !pairs.some(([a, b]) => b === x && a !== x && left.includes(a))));
    out.push(left.splice(k, 1)[0]);
  }
  return out;
}

// Crossings between horizontal and vertical segments of different paths: [{h, v, x, y}].
export function crossings(paths) {
  const hs = [], vs = [];
  for (const p of paths) for (const s of p.segments) (s.y1 === s.y2 ? hs : vs).push({ p: p.key, ...s });
  const out = [];
  for (const h of hs) {
    const [hx1, hx2] = [Math.min(h.x1, h.x2), Math.max(h.x1, h.x2)];
    for (const v of vs) {
      if (h.p === v.p) continue;
      const [vy1, vy2] = [Math.min(v.y1, v.y2), Math.max(v.y1, v.y2)];
      if (v.x1 > hx1 + 2 && v.x1 < hx2 - 2 && h.y1 > vy1 + 2 && h.y1 < vy2 - 2) out.push({ h, v, x: v.x1, y: h.y1 });
    }
  }
  return out;
}

const overlaps = (a, b, m = 0) => a.x < b.x + b.w + m && b.x < a.x + a.w + m && a.y < b.y + b.h + m && b.y < a.y + a.h + m;

// Where a picture's element comes from: implemented (in this PR's diff, evidence file:line), existing (already in the
// codebase, unchanged), spec (only in the PR description, ticket, ADRs or spec docs, not found in the diff: planned or
// missing). Old analyses have no source and are drawn as before. tone: "status" (the New/Changed colours), "muted".
export const SPEC_TIP = "From the PR description/ticket, not found in the diff";
export function sourceStyle(source) {
  if (source === "spec") return { source, dashed: true, tone: "status", chip: "spec", tip: SPEC_TIP };
  if (source === "existing") return { source, dashed: false, tone: "muted", chip: null, tip: "Already in the codebase, unchanged" };
  return { source: source === "implemented" ? source : null, dashed: false, tone: "status", chip: null, tip: null };
}
// Whether a picture (architecture or visual) says where its elements come from (then the legend shows the sources).
export const hasSources = (x) => [...(x?.nodes ?? []), ...(x?.edges ?? []), ...(x?.transitions ?? []), ...(x?.nodes ?? []).flatMap((n) => n.states ?? [])].some((e) => e?.source);

// The focus on one node: the paths that touch it and the cards at their other ends stay; the rest is dimmed.
// {id, nodes: Set of ids, paths: Set of path nums}, or null (no focus, or the node is not in this view).
export function archFocus(L, id) {
  if (!id || !L.nodes.some((n) => n.id === id)) return null;
  const nodes = new Set([id]), paths = new Set();
  for (const p of L.paths) {
    if (p.to !== id && !p.from.includes(id)) continue;
    paths.add(p.num); nodes.add(p.to);
    if (p.to === id) p.from.forEach((f) => nodes.add(f));
  }
  return { id, nodes, paths };
}

// view: "diff" all, "before" without new nodes, "after" without removed ones. extra(n): more lines in a card (findings).
// Returns {groups, nodes, paths, trunks, hops, width, height}; every box in px. paths: one per legend row {key, num,
// mark, kind: "next" | "fan" | "stub", from: [ids], to, label, edges: [indexes], segments: [{x1, y1, x2, y2}],
// arrow: {x, y, left}, badge: {x, y} (null for a stub), chip: {x, y, w, h, text} (stubs), trunk (fans: the trunk's
// key; the trunk's segments are part of each of its paths), dashed, status}. trunks: [{key, segments}] for hops.
// fit: narrow cards (160 px, two lines of description) for a picture that is much wider than the view.
export const FIT = { W: 160, TITLE_CH: 19, DESC_CH: 25, DESC_LINES: 2 };
export function archLayout(arch, view = "diff", extra = () => 0, fit = false) {
  const { PAD, HEAD, GAP_Y, GAP_G, LANE, GAP_MIN, BADGE, PORT, STUB, CHIP_H, CHIP_GAP, CH, FAN, ROW } = ARCH;
  const { W, TITLE_CH, DESC_CH } = fit ? FIT : ARCH, DESC_LINES = fit ? FIT.DESC_LINES : 3;
  const hide = view === "before" ? "new" : view === "after" ? "removed" : null;
  const nodes0 = (arch?.nodes ?? []).filter((n) => n.status !== hide);
  const known = new Set((arch?.groups ?? []).map((g) => g.id));
  const groups = [...(arch?.groups ?? []).filter((g) => nodes0.some((n) => n.group === g.id)),
    ...(nodes0.some((n) => !known.has(n.group)) ? [{ id: "\0", label: "System", kind: "" }] : [])];
  const byId = new Map(nodes0.map((n) => [n.id, { ...n, at: n.at ?? (n.source === "implemented" ? n.evidence : undefined), g: known.has(n.group) ? n.group : "\0", states: (n.states ?? []).filter((s) => s?.name) }]));
  const gOf = (id) => byId.get(id).g;
  const edges = (arch?.edges ?? []).map((e, i) => ({ ...e, i })).filter((e) => byId.has(e.from) && byId.has(e.to) && e.from !== e.to);
  // A state's call is an edge from its orchestrator that leaves at the state's row: an edge the analysis has, or one
  // made from the state (labelled with its name).
  for (const n of byId.values()) n.states.forEach((s, k) => {
    if (!byId.has(s.calls) || s.calls === n.id) return;
    const e = edges.find((x) => x.from === n.id && x.to === s.calls && x.anchor === undefined);
    if (e) e.anchor = k;
    else edges.push({ from: n.id, to: s.calls, label: s.name, anchor: k, status: s.status, source: s.source, evidence: s.evidence, i: edges.length + 1000 });
  });
  const gIds = groups.map((g) => g.id), ids0 = nodes0.map((n) => n.id);

  // 1. Columns: sub-columns inside each group by its own calls, then each group's first column so calls between
  // groups go right, then everything pulled right next to what it calls (as far as its group allows).
  const gOrder = topo(gIds, edges.map((e) => [gOf(e.from), gOf(e.to)]).filter(([a, b]) => a !== b)), gRank = new Map(gOrder.map((g, k) => [g, k]));
  const sub = new Map();
  for (const g of gIds) {
    const inner = edges.filter((e) => gOf(e.from) === g && gOf(e.to) === g).map((e) => [e.from, e.to]);
    const order = topo(ids0.filter((id) => gOf(id) === g), inner), r = new Map(order.map((id, k) => [id, k]));
    for (const id of order) sub.set(id, Math.max(0, ...inner.filter(([a, b]) => b === id && r.get(a) < r.get(id)).map(([a]) => sub.get(a) + 1)));
  }
  const cross = edges.filter((e) => gRank.get(gOf(e.from)) < gRank.get(gOf(e.to))), base = new Map();
  for (const g of gOrder) base.set(g, Math.max(0, ...cross.filter((e) => gOf(e.to) === g).map((e) => base.get(gOf(e.from)) + sub.get(e.from) + 1 - sub.get(e.to))));
  for (const g of [...gOrder].reverse()) {
    const out = cross.filter((e) => gOf(e.from) === g);
    if (out.length) base.set(g, Math.max(base.get(g), Math.min(...out.map((e) => base.get(gOf(e.to)) + sub.get(e.to) - 1 - sub.get(e.from)))));
  }
  const col = new Map(ids0.map((id) => [id, base.get(gOf(id)) + sub.get(id)]));
  const lastCol = (g) => Math.max(...ids0.filter((id) => gOf(id) === g).map((id) => col.get(id)));
  const pullRight = () => {
    for (const id of [...ids0].sort((a, b) => col.get(b) - col.get(a))) {
      const out = edges.filter((e) => e.from === id && col.get(e.to) > col.get(id));
      if (out.length) col.set(id, Math.max(col.get(id), Math.min(lastCol(gOf(id)), ...out.map((e) => col.get(e.to) - 1))));
    }
  };
  pullRight();
  // A group that only receives calls (external services) and starts inside the columns of a group calling it would be
  // stacked below that whole frame, its lines running down past the picture: it gets its own column right of it.
  const range = (g) => { const cs = ids0.filter((id) => gOf(id) === g).map((id) => col.get(id)); return [Math.min(...cs), Math.max(...cs)]; };
  // ponytail: only plain services (no calls among themselves); a group with its own chain keeps stacking below.
  const sink = (g) => !edges.some((e) => gOf(e.from) === g) && edges.some((e) => gOf(e.to) === g && gOf(e.from) !== g);
  let moved = false;
  for (const g of gIds.filter(sink)) {
    const lo = range(g)[0], over = gIds.filter((h) => h !== g && !sink(h) && edges.some((e) => gOf(e.from) === h && gOf(e.to) === g)).map(range).filter(([a, b]) => a <= lo && lo <= b);
    if (!over.length) continue;
    const shift = Math.max(...over.map(([, b]) => b)) + 1 - lo;
    for (const id of ids0) if (gOf(id) === g) col.set(id, col.get(id) + shift);
    moved = true;
  }
  if (moved) pullRight();
  const ncol = Math.max(0, ...col.values()) + 1;
  const kindOf = (e) => (col.get(e.to) - col.get(e.from) === 1 ? "next" : "stub");
  const nexts = edges.filter((e) => kindOf(e) === "next");

  // 2. Order: groups and nodes by the mean position of their neighbours, a few sweeps (ties keep the given order),
  // then per group column of up to 6 cards the order with the fewest swapped neighbour pairs.
  const nb = new Map(ids0.map((id) => [id, []]));
  for (const e of nexts) { nb.get(e.from).push(e.to); nb.get(e.to).push(e.from); }
  // Groups stack in order of their first column (one reaching in from the left sits on top), then by gl.
  const gLo = new Map(gIds.map((g) => [g, Math.min(...ids0.filter((id) => gOf(id) === g).map((id) => col.get(id)))]));
  let gl = [...gIds], pos = new Map(ids0.map((id, k) => [id, k]));
  const gCmp = (a, b) => gLo.get(a) - gLo.get(b) || gl.indexOf(a) - gl.indexOf(b);
  const colIds = (c) => ids0.filter((id) => col.get(id) === c).sort((a, b) => gCmp(gOf(a), gOf(b)) || pos.get(a) - pos.get(b));
  const rows = () => new Map(Array.from({ length: ncol }, (_, c) => colIds(c)).flatMap((ids) => ids.map((id, r) => [id, r / Math.max(1, ids.length - 1)])));
  for (let sweep = 0; sweep < 4; sweep++) {
    const row = rows(), bc = new Map(ids0.map((id) => [id, nb.get(id).length ? avg(nb.get(id).map((x) => row.get(x))) : row.get(id)]));
    pos = new Map([...ids0].sort((a, b) => bc.get(a) - bc.get(b) || pos.get(a) - pos.get(b)).map((id, k) => [id, k]));
    const gbc = new Map(gIds.map((g) => [g, avg(ids0.filter((id) => gOf(id) === g).map((id) => bc.get(id)))]));
    gl = [...gl].sort((a, b) => gbc.get(a) - gbc.get(b) || gIds.indexOf(a) - gIds.indexOf(b));
  }
  // Then exact search where it is small: the order of the groups sharing a column (up to 4), then the cards of each
  // group column (up to 6), each by the number of swapped call pairs between neighbouring columns.
  const swapped = () => {
    const row = rows();
    let n = 0;
    for (const a of nexts) for (const b of nexts) if (col.get(a.from) === col.get(b.from) && row.get(a.from) < row.get(b.from) && row.get(a.to) > row.get(b.to)) n++;
    return n;
  };
  for (let c = 0; c < ncol; c++) {
    const gs = gl.filter((g) => colIds(c).some((id) => gOf(id) === g)), slots = gs.map((g) => gl.indexOf(g));
    if (gs.length < 2 || gs.length > 4) continue;
    let best = gl, bestCost = swapped();
    for (const p of permutations(gs)) {
      const prev = gl;
      gl = [...gl]; p.forEach((g, k) => { gl[slots[k]] = g; });
      const k = swapped();
      if (k < bestCost) { best = gl; bestCost = k; }
      gl = prev;
    }
    gl = best;
  }
  for (let c = 0; c < ncol; c++) for (const g of gl) {
    const block = colIds(c).filter((id) => gOf(id) === g);
    if (block.length < 2 || block.length > 6) continue;
    const slots = block.map((id) => pos.get(id)).sort((a, b) => a - b), set = (order) => order.forEach((id, k) => pos.set(id, slots[k]));
    set(bestOrder(block, (p) => { set(p); return swapped(); }));
  }

  // 3. Paths: stubs; fans (one source, three or more calls into one group, not from a state row); buses (same target, same
  // meaning share one lane and one port).
  const fanKey = (e) => `${e.from}>${gOf(e.to)}`, fanN = new Map();
  for (const e of nexts) if (e.anchor === undefined) fanN.set(fanKey(e), (fanN.get(fanKey(e)) ?? 0) + 1);
  // An orchestrator's state rows calling one target merge into one path: a line from each row into one trunk.
  const paths = [], trunks = [], byKey = new Map(), anchorOf = new Map(); // `${pathKey}:${from}` -> [state index]
  for (const e of edges) {
    const kind = kindOf(e), fan = kind === "next" && e.anchor === undefined && fanN.get(fanKey(e)) > 2;
    const key = kind === "stub" ? `stub:${e.i}` : fan ? `fan:${fanKey(e)}:${e.i}` : e.anchor !== undefined ? `rows:${e.from}>${e.to}` : `next:${e.to}:${norm(e.label)}:${e.source ?? ""}`;
    if (!byKey.has(key)) {
      const p = { key, kind: fan ? "fan" : kind, to: e.to, from: [], edges: [], label: e.label ?? "", dashed: Boolean(e.dashed) || e.source === "spec", source: e.source ?? null,
        evidence: e.evidence ?? null, status: e.status ?? (e.changed ? "changed" : null) };
      byKey.set(key, p); paths.push(p);
      if (fan) {
        const tk = `fan:${fanKey(e)}`;
        let tr = trunks.find((x) => x.key === tk);
        if (!tr) trunks.push(tr = { key: tk, kind: "trunk", from: [e.from], branches: [] });
        tr.branches.push(p); p.trunk = tk;
      }
    }
    const p = byKey.get(key);
    if (!p.from.includes(e.from)) p.from.push(e.from);
    p.edges.push(e.i);
    if (e.anchor !== undefined) {
      anchorOf.set(`${key}:${e.from}`, [...(anchorOf.get(`${key}:${e.from}`) ?? []), e.anchor].sort((a, b) => a - b));
      if (e.label && !p.label.split(", ").includes(e.label)) p.label = p.label ? `${p.label}, ${e.label}` : e.label;
    }
    if (e.status === "new" || e.status === "changed" || e.changed) p.status = p.status ?? e.status ?? "changed";
  }
  paths.forEach((p, k) => { p.num = k + 1; p.mark = circled(k + 1); });
  const srcCol = (p) => col.get(p.from[0]);

  // 4. Ports per card side: incoming on the left (a bus's target end, a fan branch), outgoing on the right (a bus
  // source, a fan trunk, a stub).
  const ports = new Map(); // `${id}:${side}` -> [{p, end, from, stub}]
  const addPort = (id, s, item) => { const k = `${id}:${s}`; ports.set(k, [...(ports.get(k) ?? []), item]); };
  for (const p of paths) {
    if (p.kind === "stub") addPort(p.from[0], "r", { p, end: "from", stub: true });
    else addPort(p.to, "l", { p, end: "to" });
    if (p.kind === "next") for (const f of p.from) addPort(f, "r", { p, end: "from", from: f });
  }
  for (const tr of trunks) addPort(tr.from[0], "r", { p: tr, end: "from" });

  // 5. Card sizes from their text and states, at least room for their ports (a side with stubs: room for chips).
  const size = new Map();
  for (const id of ids0) {
    const n = byId.get(id), title = clampText(n.label ?? n.id, TITLE_CH, 2), desc = clampText(n.description ?? "", DESC_CH, DESC_LINES);
    const stateTop = 8 + title.lines * 17 + 3 + (desc.lines ? desc.lines * 15 + 3 : 0) + (extra(n) ?? 0) * 18 + 4;
    const content = n.states.length ? stateTop + n.states.length * ROW + 6 + 16 + 8 : 8 + title.lines * 17 + (desc.lines ? 4 + desc.lines * 15 : 0) + (extra(n) ?? 0) * 18 + 6 + 16 + 8;
    const need = (s) => { const items = ports.get(`${id}:${s}`) ?? []; return (items.length + 1) * (items.some((it) => it.stub) ? CHIP_GAP : PORT); };
    size.set(id, { h: Math.max(72, content, need("l"), n.states.length ? 0 : need("r")), title, desc, stateTop });
  }

  // 6. Geometry. Column insets for fan spines (per group column), stub zones and lanes per gutter, then groups
  // stacked where their columns overlap (in barycentre order), cards stacked inside.
  const spine = new Map(), inset = Array(ncol).fill(0);
  for (const tr of trunks) {
    const b = tr.branches[0].to, k = `${gOf(b)}@${col.get(b)}`, j = [...spine.values()].filter((v) => v.k === k).length;
    spine.set(tr.key, { k, j }); inset[col.get(b)] = Math.max(inset[col.get(b)], 10 + j * LANE + FAN - PAD);
  }
  const zone = Array(ncol).fill(0), lanesN = Array(ncol).fill(0);
  for (const p of paths) if (p.kind === "stub") {
    // The chip: the path's number as a badge (as on drawn lines), then "→ target" at 12 px (stack.js archView).
    const l = String(byId.get(p.to).label ?? p.to), text = `→ ${l.length > 30 ? `${l.slice(0, 29)}…` : l}`;
    p.chip = { text, w: Math.min(260, Math.round(text.length * 6.3 + 12 + BADGE + 6)), h: CHIP_H }; // ~6.3 px per char at 12 px
    zone[srcCol(p)] = Math.max(zone[srcCol(p)], STUB + 4 + p.chip.w + 8 - PAD);
  }
  for (const p of [...paths.filter((q) => q.kind === "next"), ...trunks]) lanesN[srcCol(p)]++;
  const cw = inset.map((i) => i + W + 2 * PAD);
  const gw = cw.map((_, c) => (c < ncol - 1 ? Math.max(GAP_MIN, zone[c] + lanesN[c] * LANE + 28) : zone[c]));
  const colX = [];
  for (let c = 0; c < ncol; c++) colX[c] = c ? colX[c - 1] + cw[c - 1] + gw[c - 1] : 0;

  const frames = [], at = new Map(), nodes = [];
  for (const g of [...gl].sort(gCmp)) {
    const mine = ids0.filter((id) => gOf(id) === g), lo = Math.min(...mine.map((id) => col.get(id))), hi = Math.max(...mine.map((id) => col.get(id)));
    const stack = (c) => colIds(c).filter((id) => gOf(id) === g);
    const tall = Math.max(...Array.from({ length: hi - lo + 1 }, (_, k) => stack(lo + k).reduce((s, id, j) => s + size.get(id).h + (j ? GAP_Y : 0), 0)));
    const y = Math.max(0, ...frames.filter((f) => f.lo <= hi && lo <= f.hi).map((f) => f.y + f.h + GAP_G));
    frames.push({ g, lo, hi, y, h: HEAD + PAD + tall + PAD });
    for (let c = lo; c <= hi; c++) {
      let yy = y + HEAD + PAD;
      stack(c).forEach((id, row) => {
        const n = byId.get(id), s = size.get(id);
        const node = { ...n, col: c, row, x: colX[c] + PAD + inset[c], y: yy, h: s.h, w: W, title: s.title.text, titleLines: s.title.lines,
          desc: s.desc.text, descLines: s.desc.lines, cut: s.title.cut || s.desc.cut, stateTop: n.states.length ? s.stateTop : null };
        delete node.g;
        nodes.push(node); at.set(id, node); yy += s.h + GAP_Y;
      });
    }
  }
  nodes.sort((a, b) => ids0.indexOf(a.id) - ids0.indexOf(b.id));

  // Port y: a state's call at its row; the rest spread along the side (above the states), by the other end's height.
  const portY = new Map(); // `${pathKey}:${end}:${id}` -> y
  const otherY = (it) => { const ends = it.p.kind === "trunk" ? it.p.branches.map((b) => b.to) : it.end === "to" ? it.p.from : [it.p.to]; return avg(ends.map((id) => at.get(id).y + at.get(id).h / 2)); };
  for (const [k, items] of ports) {
    const id = k.slice(0, k.lastIndexOf(":")), n = at.get(id), right = k.endsWith(":r");
    const fixed = (it) => (right ? anchorOf.get(`${it.p.key}:${id}`) : undefined);
    const free = items.filter((it) => fixed(it) === undefined).map((it, j) => [it, otherY(it), j]).sort((a, b) => a[1] - b[1] || a[2] - b[2]);
    const span = right && n.stateTop !== null ? n.stateTop : n.h;
    free.forEach(([it], j) => portY.set(`${it.p.key}:${it.end}:${it.from ?? id}`, Math.round(n.y + (span * (j + 1)) / (free.length + 1))));
    for (const it of items) if (fixed(it) !== undefined) portY.set(`${it.p.key}:${it.end}:${it.from ?? id}`, Math.round(n.y + n.stateTop + fixed(it)[0] * ROW + ROW / 2));
  }
  const PY = (p, end, id) => portY.get(`${p.key}:${end}:${id}`);
  // Every row a path leaves a card at: a state row each for merged state calls, else its one port.
  const rowsY = (p, f) => anchorOf.get(`${p.key}:${f}`)?.map((k) => Math.round(at.get(f).y + at.get(f).stateTop + k * ROW + ROW / 2)) ?? [PY(p, "from", f)];
  const spineX = (tr) => colX[col.get(tr.branches[0].to)] + 10 + spine.get(tr.key).j * LANE;
  const ysOf = (p) => (p.kind === "trunk" ? [PY(p, "from", p.from[0]), ...p.branches.map((b) => PY(b, "to", b.to))] : [PY(p, "to", p.to), ...p.from.flatMap((f) => rowsY(p, f))]);

  // A bus's or trunk's segments for given lane xs (path key -> x). A trunk goes straight when its source is level
  // with one of its branches' rows (it then needs no lane).
  const build = (p, lane) => {
    const x = lane.get(p.key), segs = [];
    if (p.kind === "trunk") {
      const sx = at.get(p.from[0]).x + W, sy = PY(p, "from", p.from[0]), bys = p.branches.map((b) => PY(b, "to", b.to));
      const ty = Math.min(Math.max(sy, Math.min(...bys)), Math.max(...bys)), sp = spineX(p);
      if (sy === ty) segs.push({ x1: sx, y1: sy, x2: sp, y2: sy });
      else segs.push({ x1: sx, y1: sy, x2: x, y2: sy }, { x1: x, y1: sy, x2: x, y2: ty }, { x1: x, y1: ty, x2: sp, y2: ty });
      return { segs, ty, sp };
    }
    const tx = at.get(p.to).x, ty = PY(p, "to", p.to), ys = [ty];
    for (const f of p.from) for (const sy of rowsY(p, f)) { ys.push(sy); segs.push({ x1: at.get(f).x + W, y1: sy, x2: x, y2: sy }); }
    if (Math.max(...ys) > Math.min(...ys)) segs.push({ x1: x, y1: Math.min(...ys), x2: x, y2: Math.max(...ys) });
    segs.push({ x1: x, y1: ty, x2: tx, y2: ty });
    return { segs, arrow: { x: tx, y: ty, left: false } };
  };

  // Lane order per gutter: the permutation (small gutters) or sort with the fewest crossings inside the gutter.
  const lane = new Map();
  for (let c = 0; c < ncol - 1; c++) {
    const items = [...paths.filter((p) => p.kind === "next" && srcCol(p) === c), ...trunks.filter((tr) => srcCol(tr) === c)];
    if (!items.length) continue;
    const left = colX[c] + cw[c] + zone[c] + 14;
    const trialOf = (order) => new Map(order.map((p, k) => [p.key, left + k * LANE]));
    const cost = (order) => { const trial = trialOf(order); return crossings(order.map((p) => ({ key: p.key, segments: build(p, trial).segs }))).length; };
    const tyOf = (p) => (p.kind === "trunk" ? Math.min(...p.branches.map((b) => PY(b, "to", b.to))) : PY(p, "to", p.to));
    const start = [...items].sort((a, b) => tyOf(a) - tyOf(b) || Math.min(...ysOf(a)) - Math.min(...ysOf(b)));
    for (const [k, v] of trialOf(bestOrder(items, cost, start))) lane.set(k, v);
  }

  for (const p of paths.filter((q) => q.kind === "next")) { const b = build(p, lane); p.segments = b.segs; p.arrow = b.arrow; }
  for (const tr of trunks) {
    const { segs, ty, sp } = build(tr, lane), bys = tr.branches.map((b) => PY(b, "to", b.to));
    for (const p of tr.branches) {
      const by = PY(p, "to", p.to), cx = at.get(p.to).x;
      p.segments = [...segs, ...(by !== ty ? [{ x1: sp, y1: ty, x2: sp, y2: by }] : []), { x1: sp, y1: by, x2: cx, y2: by }];
      p.arrow = { x: cx, y: by, left: false };
    }
    tr.segments = [...segs, ...(Math.max(...bys) > Math.min(...bys) ? [{ x1: sp, y1: Math.min(...bys), x2: sp, y2: Math.max(...bys) }] : []),
      ...tr.branches.map((p) => p.segments.at(-1))];
  }
  for (const p of paths.filter((q) => q.kind === "stub")) {
    const f = at.get(p.from[0]), sx = f.x + W, sy = PY(p, "from", f.id);
    p.segments = [{ x1: sx, y1: sy, x2: sx + STUB, y2: sy }];
    p.arrow = { x: sx + STUB, y: sy, left: false };
    Object.assign(p.chip, { x: sx + STUB + 4, y: sy - CHIP_H / 2 });
  }
  const hops = crossings([...paths.filter((p) => p.kind === "next"), ...trunks]);

  // Numbers in reading order: by the source's column, then where the line leaves it (top to bottom). A stub's chip
  // carries its number. ponytail: the chip keeps the width measured with its first number (same digit count up to 20).
  const startOf = (p) => (p.kind === "stub" ? { c: srcCol(p), y: p.chip.y + CHIP_H / 2 } : { c: srcCol(p), y: Math.min(...p.segments.filter((g) => g.y1 === g.y2 && g.x1 === at.get(p.from[0])?.x + W).map((g) => g.y1), p.segments[0].y1) });
  const reading = new Map(paths.map((p, k) => [p, { ...startOf(p), k }]));
  paths.sort((a, b) => reading.get(a).c - reading.get(b).c || reading.get(a).y - reading.get(b).y || reading.get(a).k - reading.get(b).k);
  paths.forEach((p, k) => { const old = p.mark; p.num = k + 1; p.mark = circled(k + 1); if (p.chip) p.chip.text = p.chip.text.replace(old, p.mark); });

  // Badges: a fan branch's next to its card; else at the start of its line, next to the row it leaves (then its lane,
  // then its target line); never on a card, a chip or another badge. Stubs carry their number in the chip.
  const rects = [...nodes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h })), ...paths.filter((p) => p.chip).map((p) => p.chip)], placed = [];
  for (const p of paths) {
    if (p.kind === "stub") { p.badge = null; continue; }
    const segs = [...p.segments].sort((a, b) => (Math.abs(b.y2 - b.y1) + Math.abs(b.x2 - b.x1) * 0.5) - (Math.abs(a.y2 - a.y1) + Math.abs(a.x2 - a.x1) * 0.5));
    const first = p.kind === "next" ? p.segments.find((g) => g.y1 === g.y2 && g.y1 === reading.get(p).y && g.x2 > g.x1) : null;
    const spots = p.kind === "fan" ? [{ x: p.arrow.x - FAN + 12, y: p.arrow.y }] : first ? [0, 1, 2].map((k) => ({ x: first.x1 + 14 + k * (BADGE + 4), y: first.y1 })) : [];
    for (const s of segs) for (const t of [0.5, 0.3, 0.7, 0.15, 0.85]) spots.push({ x: s.x1 + (s.x2 - s.x1) * t, y: s.y1 + (s.y2 - s.y1) * t });
    const box = (q) => ({ x: q.x - BADGE / 2, y: q.y - BADGE / 2, w: BADGE, h: BADGE });
    const free = spots.find((q) => !rects.some((r) => overlaps(box(q), r, 2)) && !placed.some((b) => overlaps(box(q), b, 2))) ?? spots[0] ?? { x: 0, y: 0 };
    p.badge = { x: Math.round(free.x), y: Math.round(free.y) };
    placed.push(box(p.badge));
  }

  const outGroups = frames.map((f) => ({ ...groups.find((g) => g.id === f.g), x: colX[f.lo], y: f.y, w: colX[f.hi] + cw[f.hi] - colX[f.lo], h: f.h, cols: [f.lo, f.hi] }))
    .sort((a, b) => gIds.indexOf(a.id) - gIds.indexOf(b.id));
  const width = ncol ? colX[ncol - 1] + cw[ncol - 1] + gw[ncol - 1] : 0;
  const height = Math.max(0, ...frames.map((f) => f.y + f.h));
  return { groups: outGroups, nodes, paths, trunks, hops, width, height };
}

// ---- state diagrams (a layer's state_machine picture): top to bottom

export const SM = { W: 300, NODE: 150, H: 28, NOTE_H: 48, DOT: 14, DUMMY: 14, GAP_X: 18, GAP_Y: 40, BACK: 10, CHILD_W: 108, CHILD_H: 24, STUB: 10, CHIP: 96 };

// A transition's text: "event [guard] / action" when given, else its label.
export const transitionText = (e) => (`${e.event ?? ""}${e.guard ? ` [${e.guard}]` : ""}${e.action ? ` / ${e.action}` : ""}`.trim() || String(e.label ?? "").trim());
const isError = (e) => e.error === "catch" || e.error === "retry" || (!e.event && /^(catch|retry)\b/i.test(String(e.label ?? "")));

// A state machine (Step Functions) or state diagram (an entity's lifecycle) laid out top to bottom: a start dot, the
// states by their longest path from it, an end ring under the last ones. States in one layer sit side by side (a
// choice forks into columns); Parallel and Map states are blocks with their branches side by side (children: nodes
// with `parent`, grouped by `branch`). Forward transitions run down (fork and merge in the gap between layers, long
// ones through spacers); transitions back up (a lifecycle going back) run in return lanes on the left; self-loops (a
// small loop on the card's right edge with its text) and Catch/Retry stubs ("Catch → Fail", "Retry ×3") each get a
// row beside the card, with room kept free to its right, so several never stack and none runs into the next card.
// v: {nodes: [{id, label, type, changed, note, at, parent, branch}], edges | transitions: [{from, to, label | event,
// guard, action, changed, error: "catch" | "retry"}]}. Returns {nodes, edges, backs, loops, stubs, width, height}.
export function stateLayout(v, width = SM.W) {
  const nodes0 = (v?.nodes ?? []).filter((n) => n?.id), byId = new Map(nodes0.map((n) => [n.id, { ...n, at: n.at ?? (n.source === "implemented" ? n.evidence : undefined) }]));
  const all = [...(v?.edges ?? []), ...(v?.transitions ?? [])].filter((e) => byId.has(e.from) && byId.has(e.to)).map((e, i) => ({ ...e, i, text: transitionText(e) }));
  const blockOf = (id) => { const p = byId.get(id)?.parent; return byId.has(p) && p !== id ? p : null; };
  const top = (id) => blockOf(id) ?? id;
  const errors = all.filter(isError), plain = all.filter((e) => !isError(e));
  const inner = plain.filter((e) => blockOf(e.from) && blockOf(e.from) === blockOf(e.to));
  const outer = plain.filter((e) => !inner.includes(e)).map((e) => ({ ...e, a: top(e.from), b: top(e.to) }));
  const loopsE = outer.filter((e) => e.a === e.b), flow = outer.filter((e) => e.a !== e.b);
  // States only reached by a Catch and leading nowhere (a Fail) appear in the stubs, not as cards.
  const onlyErr = (id) => errors.some((e) => top(e.to) === id) && !flow.some((e) => e.a === id || e.b === id);
  const ids = nodes0.filter((n) => !blockOf(n.id) && !onlyErr(n.id)).map((n) => n.id);
  const order = topo(ids, flow.map((e) => [e.a, e.b])), rank = new Map(order.map((id, k) => [id, k]));
  const fwd = flow.filter((e) => rank.get(e.a) < rank.get(e.b)), back = flow.filter((e) => rank.get(e.a) > rank.get(e.b));
  const layer = new Map();
  for (const id of order) layer.set(id, 1 + Math.max(0, ...fwd.filter((e) => e.b === id).map((e) => layer.get(e.a))));
  // Start and end: the start dot points at the states nothing leads to; the end ring follows those that lead nowhere.
  const roots = ids.filter((id) => !fwd.some((e) => e.b === id)), sinks = ids.filter((id) => !flow.some((e) => e.a === id));
  const last = Math.max(0, ...layer.values());
  layer.set("\0start", 0);
  const links = [...roots.map((id) => ({ a: "\0start", b: id, text: "", i: -1 })), ...fwd];
  if (sinks.length) { layer.set("\0end", last + 1); links.push(...sinks.map((id) => ({ a: id, b: "\0end", text: "", i: -2 }))); }
  // Spacers where a transition skips layers.
  const chain = new Map(); // link -> [ids through layers]
  for (const e of links) {
    const ids2 = [e.a];
    for (let l = layer.get(e.a) + 1; l < layer.get(e.b); l++) { const d = `\0d${e.i}:${e.a}>${e.b}:${l}`; layer.set(d, l); ids2.push(d); }
    chain.set(e, [...ids2, e.b]);
  }
  // Order inside layers: barycentre sweeps down and up; states with a transition back lean left (their return lane
  // is on the left), spacers lean right; ties keep the given order.
  const nl = Math.max(...layer.values()) + 1, rows = Array.from({ length: nl }, () => []);
  const given = (id) => (byId.has(id) ? nodes0.findIndex((n) => n.id === id) : 1e3);
  for (const [id, l] of layer) rows[l].push(id);
  rows.forEach((r) => r.sort((a, b) => given(a) - given(b)));
  const up = new Map(), down = new Map();
  for (const c of chain.values()) for (let k = 0; k + 1 < c.length; k++) { (down.get(c[k]) ?? down.set(c[k], []).get(c[k])).push(c[k + 1]); (up.get(c[k + 1]) ?? up.set(c[k + 1], []).get(c[k + 1])).push(c[k]); }
  const lean = (id) => (back.some((e) => e.a === id || e.b === id) ? -0.5 : id.startsWith("\0d") ? 0.25 : 0);
  for (let sweep = 0; sweep < 4; sweep++) {
    const pos = new Map(rows.flatMap((r) => r.map((id, k) => [id, r.length > 1 ? k / (r.length - 1) : 0.5])));
    const range = sweep % 2 ? [...rows.keys()].reverse() : [...rows.keys()];
    for (const l of range) {
      const nbr = sweep % 2 ? down : up;
      const bc = (id) => { const o = nbr.get(id) ?? []; return (o.length ? avg(o.map((x) => pos.get(x))) : pos.get(id)) + lean(id) * 0.01; };
      rows[l] = rows[l].map((id, k) => [id, bc(id), k]).sort((a, b) => a[1] - b[1] || a[2] - b[2]).map((x) => x[0]);
    }
  }
  // Sizes: a card (taller with a note or several stubs), a block with its branches, a dot, a spacer.
  const stubsOf = (id) => errors.filter((e) => top(e.from) === id), loopsOf = (id) => loopsE.filter((e) => e.a === id);
  const side = (id) => loopsOf(id).length + stubsOf(id).length, sideW = (id) => (side(id) ? SM.STUB + 4 + SM.CHIP : 0);
  const branchesOf = (id) => {
    const kids = nodes0.filter((n) => blockOf(n.id) === id), keyOf = new Map();
    for (const k of kids) keyOf.set(k.id, k.branch ?? null);
    // Without branch numbers, children linked by transitions share a branch.
    for (let pass = 0; pass < kids.length; pass++) for (const e of inner) if (blockOf(e.from) === id && keyOf.get(e.from) !== keyOf.get(e.to)) {
      if (keyOf.get(e.to) === null) keyOf.set(e.to, keyOf.get(e.from)); else if (keyOf.get(e.from) === null) keyOf.set(e.from, keyOf.get(e.to));
    }
    kids.forEach((k, j) => { if (keyOf.get(k.id) === null) keyOf.set(k.id, `#${j}`); });
    const keys = [...new Set(kids.map((k) => keyOf.get(k.id)))];
    return keys.map((key) => topo(kids.filter((k) => keyOf.get(k.id) === key).map((k) => k.id), inner.map((e) => [e.from, e.to])));
  };
  const box = new Map();
  for (const [id] of layer) {
    if (id === "\0start" || id === "\0end") box.set(id, { w: SM.DOT, h: SM.DOT });
    else if (id.startsWith("\0d")) box.set(id, { w: SM.DUMMY, h: 0 });
    else {
      const n = byId.get(id), br = branchesOf(id);
      if (br.length) box.set(id, { w: Math.max(SM.NODE, br.length * SM.CHILD_W + (br.length - 1) * 8 + 16), h: 26 + Math.max(...br.map((b) => b.length)) * (SM.CHILD_H + 10) + 4, br });
      else box.set(id, { w: SM.NODE, h: Math.max(n.note ? SM.NOTE_H : SM.H, side(id) * 20 + 8) });
    }
  }
  const lanesLeft = back.length ? 10 + back.length * SM.BACK : 6;
  const stubW = Math.max(0, ...ids.map(sideW));
  const rowW = (r) => r.reduce((s, id) => s + box.get(id).w, 0) + SM.GAP_X * Math.max(0, r.length - 1);
  const inner0 = Math.max(width - lanesLeft - stubW, ...rows.map(rowW));
  let y = 0;
  const at = new Map();
  rows.forEach((r, l) => {
    const h = Math.max(SM.DOT, ...r.map((id) => box.get(id).h));
    // Centred on the states (spacers beside them), so a plain chain stays one straight column.
    const xs = [];
    let x = 0;
    for (const id of r) { xs.push(x); x += box.get(id).w + SM.GAP_X + sideW(id); }
    const real = r.map((id, k) => [id, k]).filter(([id]) => !id.startsWith("\0d")), lo = real.length ? xs[real[0][1]] : 0;
    const hi = real.length ? xs[real.at(-1)[1]] + box.get(real.at(-1)[0]).w : x - SM.GAP_X;
    const shift = Math.max(lanesLeft - (xs[0] ?? 0), lanesLeft + inner0 / 2 - (lo + hi) / 2);
    r.forEach((id, k) => { const b = box.get(id); at.set(id, { id, x: Math.round(xs[k] + shift), y, w: b.w, h: id.startsWith("\0d") ? h : b.h, layer: l }); });
    rows[l].bottom = y + h; rows[l].top = y;
    y += h + SM.GAP_Y;
  });
  // Forward transitions: out of the source's bottom, down to the source's own line in the gap, across, down into the
  // target's top. Exits and entries are spread along the card side (ordered by the other end), so every transition
  // has its own last stretch, where its label goes; a lone exit or entry is in the middle (a chain stays straight).
  const hops = []; // [{e, k, a, b}]
  for (const [e, c] of chain) for (let k = 0; k + 1 < c.length; k++) hops.push({ e, k, a: c[k], b: c[k + 1] });
  const mid0 = (id) => at.get(id).x + at.get(id).w / 2;
  const spread = (id, list, other) => {
    const n = at.get(id), sorted = [...list].sort((p, q) => mid0(other(p)) - mid0(other(q)) || p.e.i - q.e.i);
    return new Map(sorted.map((h, j) => [h, Math.round(n.x + (n.w * (j + 1)) / (sorted.length + 1))]));
  };
  const exitX = new Map(), entryX = new Map();
  for (const id of at.keys()) {
    for (const [h, x] of spread(id, hops.filter((h) => h.a === id), (h) => h.b)) exitX.set(h, x);
    for (const [h, x] of spread(id, hops.filter((h) => h.b === id), (h) => h.a)) entryX.set(h, x);
  }
  const bent = (h) => exitX.get(h) !== entryX.get(h);
  const forkIdx = new Map(rows.map((r) => r.filter((id) => hops.some((h) => h.a === id && bent(h)))).flatMap((list) => list.map((id, k) => [id, k])));
  const edges = [];
  for (const [e, c] of chain) {
    const segs = [];
    let labelAt = null;
    for (const h of hops.filter((x) => x.e === e)) {
      const s = at.get(h.a), t = at.get(h.b), sx = exitX.get(h), tx = entryX.get(h);
      const mid = rows[s.layer].bottom + 10 + Math.min(4, forkIdx.get(h.a) ?? 0) * 5;
      if (sx === tx) segs.push({ x1: sx, y1: s.y + s.h, x2: sx, y2: t.y });
      else segs.push({ x1: sx, y1: s.y + s.h, x2: sx, y2: mid }, { x1: sx, y1: mid, x2: tx, y2: mid }, { x1: tx, y1: mid, x2: tx, y2: t.y });
      if (h.k === 0) {
        // The label: beside the first hop's last stretch, as wide as the room up to the next entry into that card.
        const next = [...entryX].filter(([o, x]) => o.b === h.b && x > tx).map(([, x]) => x);
        const room = Math.min(next.length ? Math.min(...next) : at.get(h.b).x + at.get(h.b).w + 60, at.get(h.b).x + Math.max(at.get(h.b).w, 120) + 80) - tx - 8;
        labelAt = { x: tx + 5, y: sx === tx ? s.y + s.h + (t.y - s.y - s.h - 13) / 2 : mid + 2, w: Math.max(40, Math.round(room)) };
      }
    }
    const end = segs.at(-1);
    edges.push({ key: `f${e.i}:${e.a}>${e.b}`, from: e.a, to: e.b, text: e.a === "\0start" ? "" : e.text, changed: Boolean(e.changed) || e.status === "new" || e.status === "changed",
      source: e.source ?? null, dashed: e.source === "spec", evidence: e.evidence ?? null,
      segments: segs.filter((x) => x.y1 !== x.y2 || x.x1 !== x.x2), arrow: { x: end.x2, y: end.y2 }, labelAt });
  }
  // Each label as wide as the room up to the nearest other line or card to its right (at most 160 px).
  const cards = [...at.values()].filter((n) => !n.id.startsWith("\0d"));
  for (const e of edges) {
    const l = e.labelAt;
    if (!l) continue;
    const walls = [...edges.filter((o) => o !== e).flatMap((o) => o.segments.filter((x) => x.x1 === x.x2 && x.x1 > l.x && Math.max(x.y1, x.y2) > l.y && Math.min(x.y1, x.y2) < l.y + 13).map((x) => x.x1)),
      ...cards.filter((n) => n.x > l.x && n.y < l.y + 13 && n.y + n.h > l.y).map((n) => n.x)];
    l.w = Math.max(24, Math.min(160, ...walls.map((x) => x - l.x - 4)));
  }
  // Back: from the source's left side out to its lane, up, and into the target's left side (outermost lane: the longest).
  const backs = [...back].sort((a, b) => (layer.get(a.a) - layer.get(a.b)) - (layer.get(b.a) - layer.get(b.b))).map((e, k) => {
    const s = at.get(e.a), t = at.get(e.b), laneX = lanesLeft - 8 - k * SM.BACK, sy = s.y + s.h / 2 + 4, ty = t.y + t.h / 2 - 4;
    return { key: `b${e.i}`, from: e.a, to: e.b, text: e.text, changed: Boolean(e.changed) || e.status === "new" || e.status === "changed", laneX, sx: s.x, sy, tx: t.x, ty,
      source: e.source ?? null, dashed: e.source === "spec",
      segments: [{ x1: s.x, y1: sy, x2: laneX, y2: sy }, { x1: laneX, y1: ty, x2: laneX, y2: sy }, { x1: laneX, y1: ty, x2: t.x, y2: ty }] };
  });
  // Side rows, centred on the card: its self-loops first, then its stubs.
  const rowY = (id, k) => { const n = at.get(id); return Math.round(n.y + n.h / 2 + (k - (side(id) - 1) / 2) * 20); };
  const loops = ids.filter((id) => at.has(id)).flatMap((id) => loopsOf(id).map((e, k) => ({ key: `l${e.i}`, id, text: e.text, changed: Boolean(e.changed) || e.status === "new" || e.status === "changed",
    source: e.source ?? null, dashed: e.source === "spec", x: at.get(id).x + at.get(id).w - 7, y: rowY(id, k) - 6, w: SM.STUB + 4 + SM.CHIP - 10 })));
  const stubs = ids.flatMap((id) => stubsOf(id).map((e, k) => {
    const n = at.get(id), y0 = rowY(id, loopsOf(id).length + k), retry = e.error === "retry" || /^retry/i.test(String(e.label ?? ""));
    const name = byId.get(e.to)?.label ?? e.to;
    const text = retry ? (e.text || "Retry") : `${e.text || "Catch"} → ${name}`;
    return { key: `s${e.i}`, from: id, to: e.to, text, changed: Boolean(e.changed) || e.status === "new" || e.status === "changed", source: e.source ?? null, dashed: e.source === "spec", x1: n.x + n.w, x2: n.x + n.w + SM.STUB, y: Math.round(y0), chip: { x: n.x + n.w + SM.STUB + 4, y: Math.round(y0) - 9, w: SM.CHIP, h: 18 } };
  }));
  const kids = (id) => (box.get(id)?.br ?? []).flatMap((b, j) => b.map((cid, k) => ({ ...byId.get(cid), x: at.get(id).x + 8 + j * (SM.CHILD_W + 8), y: at.get(id).y + 26 + k * (SM.CHILD_H + 10), w: SM.CHILD_W, h: SM.CHILD_H, branch: j, step: k })));
  const out = [...at.values()].filter((n) => !n.id.startsWith("\0d")).map((n) => (n.id.startsWith("\0") ? { ...n, kind: n.id === "\0start" ? "start" : "end" }
    : { ...byId.get(n.id), ...n, kind: box.get(n.id).br ? "block" : "state", children: kids(n.id), changed: Boolean(byId.get(n.id).changed) }));
  const right = Math.max(width, ...out.map((n) => n.x + n.w), ...stubs.map((s) => s.chip.x + s.chip.w), ...loops.map((l) => l.x + 17 + l.w));
  return { nodes: out, edges, backs, loops, stubs, width: Math.ceil(right + 2), height: Math.max(0, y - SM.GAP_Y) };
}
