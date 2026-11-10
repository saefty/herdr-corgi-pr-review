// The architecture picture's layout (also the blast radius): pure and deterministic, drawn by stack.js archView.
// Groups are columns; inside one, nodes are ordered by their neighbours (barycentre sweeps) so lines cross less.
// Every edge runs in a gutter between columns on a lane of its own; edges to the same target with the same meaning
// (label) merge into one lane and one entry port (a bus), anything else gets its own lane and port. Edges inside a
// column use lanes right of it; edges that skip a column go down to a channel under the cards. Ports are spread
// along the card side, ordered by where the other end is. Lane order per gutter is the one with the fewest
// crossings; a crossing that stays gets a hop on the horizontal line. Labels are not drawn on lines: each path has a
// numbered badge on its lane, and the text goes in a legend. Cards grow with their text: title up to 2 lines,
// description up to 3 (cut with an ellipsis; the full text is the tooltip).

export const ARCH = { W: 230, PAD: 12, HEAD: 30, GAP_Y: 18, LANE: 12, GAP_MIN: 64, BADGE: 18, HOP: 8, PORT: 12, TITLE_CH: 29, DESC_CH: 38 };

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

function permutations(list) {
  if (list.length <= 1) return [list];
  return list.flatMap((x, i) => permutations([...list.slice(0, i), ...list.slice(i + 1)]).map((p) => [x, ...p]));
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

// view: "diff" all, "before" without new nodes, "after" without removed ones. extra(n): more lines in a card (findings).
// Returns {groups, nodes, paths, hops, badges, width, height}; every box in px. paths: one per lane (merged edges
// share one) {key, num, mark, from: [ids], to, label, edges: [indexes], segments: [{x1, y1, x2, y2}], arrow: {x, y, left},
// badge: {x, y}, dashed, status}.
export function archLayout(arch, view = "diff", extra = () => 0) {
  const { W, PAD, HEAD, GAP_Y, LANE, GAP_MIN, BADGE, PORT, TITLE_CH, DESC_CH } = ARCH;
  const hide = view === "before" ? "new" : view === "after" ? "removed" : null;
  const nodes0 = (arch?.nodes ?? []).filter((n) => n.status !== hide);
  const known = new Set((arch?.groups ?? []).map((g) => g.id));
  const groups = [...(arch?.groups ?? []).filter((g) => nodes0.some((n) => n.group === g.id)),
    ...(nodes0.some((n) => !known.has(n.group)) ? [{ id: "\0", label: "System", kind: "" }] : [])];
  const colOf = new Map(groups.map((g, i) => [g.id, i]));
  const byId = new Map(nodes0.map((n) => [n.id, { ...n, col: colOf.get(known.has(n.group) ? n.group : "\0") }]));
  const edges = (arch?.edges ?? []).map((e, i) => ({ ...e, i })).filter((e) => byId.has(e.from) && byId.has(e.to) && e.from !== e.to);

  // Order inside columns: barycentre of the neighbours' rows, a few sweeps; ties keep the given order.
  const cols = groups.map((_, c) => nodes0.filter((n) => byId.get(n.id).col === c).map((n) => n.id));
  const nb = new Map(nodes0.map((n) => [n.id, []]));
  for (const e of edges) { nb.get(e.from).push(e.to); nb.get(e.to).push(e.from); }
  const rowOf = () => new Map(cols.flatMap((ids) => ids.map((id, r) => [id, r / Math.max(1, ids.length - 1)])));
  for (let sweep = 0; sweep < 4; sweep++) {
    const order = sweep % 2 ? [...cols.keys()].reverse() : [...cols.keys()];
    for (const c of order) {
      const row = rowOf();
      const bc = (id) => { const o = nb.get(id).filter((x) => byId.get(x).col !== c); return o.length ? o.reduce((s, x) => s + row.get(x), 0) / o.length : row.get(id); };
      cols[c] = cols[c].map((id, k) => [id, bc(id), k]).sort((a, b) => a[1] - b[1] || a[2] - b[2]).map((x) => x[0]);
    }
  }

  // Then, per column of up to 7 cards, the order with the fewest estimated crossings: inner edges spanning cards that
  // send lines right, inner edges interleaving, and lines to a neighbour column in swapped order.
  for (const [c, ids] of cols.entries()) {
    if (ids.length < 2 || ids.length > 7) continue;
    const row = rowOf(), local = edges.filter((e) => byId.get(e.from).col === c || byId.get(e.to).col === c);
    const inner = local.filter((e) => byId.get(e.from).col === c && byId.get(e.to).col === c);
    const right = (id) => local.filter((e) => (e.from === id || e.to === id) && (byId.get(e.from).col > c || byId.get(e.to).col > c || (byId.get(e.from).col === c && byId.get(e.to).col === c))).length;
    const cost = (order) => {
      const r = new Map(order.map((id, k) => [id, k]));
      let n = 0;
      const spans = inner.map((e) => [Math.min(r.get(e.from), r.get(e.to)), Math.max(r.get(e.from), r.get(e.to)), e]);
      for (const [lo, hi] of spans) for (const id of order.slice(lo + 1, hi)) n += right(id);
      for (const [a, b] of spans) for (const [x, y] of spans) if (a < x && x < b && b < y) n++;
      const cross = local.filter((e) => byId.get(e.from).col !== byId.get(e.to).col).map((e) => { const mine = byId.get(e.from).col === c ? e.from : e.to, other = mine === e.from ? e.to : e.from; return [r.get(mine), row.get(other), Math.sign(byId.get(other).col - c)]; });
      for (const [a, oa, sa] of cross) for (const [b, ob, sb] of cross) if (sa === sb && a < b && oa > ob) n++;
      return n;
    };
    let best = ids, bestCost = cost(ids);
    for (const p of permutations(ids)) { const k = cost(p); if (k < bestCost) { best = p; bestCost = k; } }
    cols[c] = best;
  }

  // Paths: same target + same meaning share one (and one port); skips and inner edges keyed the same way.
  const kindOf = (e) => { const a = byId.get(e.from).col, b = byId.get(e.to).col; return a === b ? "inner" : Math.abs(a - b) === 1 ? "next" : "skip"; };
  const paths = [], pathOf = new Map();
  for (const e of edges) {
    const kind = kindOf(e), dir = byId.get(e.to).col >= byId.get(e.from).col ? 1 : -1;
    const key = kind === "skip" ? `skip:${e.i}` : `${kind}:${e.to}:${norm(e.label)}:${dir}:${kind === "next" ? byId.get(e.from).col : ""}`;
    if (!pathOf.has(key)) { const p = { key, kind, dir, to: e.to, from: [], edges: [], label: e.label ?? "", dashed: Boolean(e.dashed), status: e.status ?? (e.changed ? "changed" : null) }; pathOf.set(key, p); paths.push(p); }
    const p = pathOf.get(key);
    if (!p.from.includes(e.from)) p.from.push(e.from);
    p.edges.push(e.i);
    if (e.status === "new" || e.status === "changed" || e.changed) p.status = p.status ?? e.status ?? "changed";
  }
  paths.forEach((p, k) => { p.num = k + 1; p.mark = circled(k + 1); });

  // Ports per card side: a path's target end is one port; each source end is one.
  const side = (p, end) => (p.kind === "inner" ? "r" : (end === "to") === (p.dir > 0) ? "l" : "r");
  const ports = new Map(); // `${id}:${side}` -> [{p, end, from}]
  const addPort = (id, s, item) => { const k = `${id}:${s}`; ports.set(k, [...(ports.get(k) ?? []), item]); };
  for (const p of paths) {
    addPort(p.to, side(p, "to"), { p, end: "to" });
    for (const f of p.from) addPort(f, side(p, "from"), { p, end: "from", from: f });
  }

  // Card sizes from their text, at least room for their ports.
  const nodes = [];
  for (const [c, ids] of cols.entries()) {
    let y = HEAD + PAD;
    for (const id of ids) {
      const n = byId.get(id), title = clampText(n.label ?? n.id, TITLE_CH, 2), desc = clampText(n.description ?? "", DESC_CH, 3);
      const content = 8 + title.lines * 17 + (desc.lines ? 4 + desc.lines * 15 : 0) + (extra(n) ?? 0) * 18 + 6 + 16 + 8;
      const most = Math.max(ports.get(`${id}:l`)?.length ?? 0, ports.get(`${id}:r`)?.length ?? 0);
      const h = Math.max(72, content, (most + 1) * PORT);
      nodes.push({ ...n, col: c, row: ids.indexOf(id), y, h, w: W, title: title.text, titleLines: title.lines, desc: desc.text, descLines: desc.lines, cut: title.cut || desc.cut });
      y += h + GAP_Y;
    }
  }
  const at = new Map(nodes.map((n) => [n.id, n]));
  const colBottom = cols.map((ids) => Math.max(HEAD + PAD, ...ids.map((id) => at.get(id).y + at.get(id).h)) + PAD);

  // Gutters: gutter g is right of column g. Lanes: inner paths of column g, then paths between g and g+1, then skip legs.
  const gut = groups.map(() => []);
  for (const p of paths) {
    const a = at.get(p.from[0]).col, b = at.get(p.to).col;
    if (p.kind === "inner") gut[a].push({ p, leg: "all" });
    else if (p.kind === "next") gut[Math.min(a, b)].push({ p, leg: "all" });
    else { gut[p.dir > 0 ? a : a - 1].push({ p, leg: "out" }); gut[p.dir > 0 ? b - 1 : b].push({ p, leg: "in" }); }
  }
  const gw = gut.map((g, i) => (i === groups.length - 1 ? (g.length ? g.length * LANE + 20 : 0) : Math.max(GAP_MIN, g.length * LANE + 28)));
  const frameX = [];
  groups.forEach((_, i) => { frameX[i] = i === 0 ? 0 : frameX[i - 1] + W + 2 * PAD + gw[i - 1]; });
  for (const n of nodes) n.x = frameX[n.col] + PAD;

  // Port y: spread along the side, ordered by the other end's height.
  const portY = new Map(); // `${pathKey}:${end}:${id}` -> y
  // A skip path heads for the channel under the cards: its ports go to the bottom of the side.
  const otherY = (it) => { if (it.p.kind === "skip") return Infinity; const n = it.end === "to" ? it.p.from.map((f) => at.get(f)) : [at.get(it.p.to)]; return n.reduce((s, x) => s + x.y + x.h / 2, 0) / n.length; };
  for (const [k, items] of ports) {
    const id = k.slice(0, k.lastIndexOf(":")), n = at.get(id);
    const sorted = items.map((it, j) => [it, otherY(it), j]).sort((a, b) => a[1] - b[1] || a[2] - b[2]);
    sorted.forEach(([it], j) => portY.set(`${it.p.key}:${it.end}:${it.from ?? id}`, Math.round(n.y + (n.h * (j + 1)) / (sorted.length + 1))));
  }
  const portX = (id, s) => (s === "l" ? at.get(id).x : at.get(id).x + W);

  // Channel under the cards for skip paths, one row each.
  const skips = paths.filter((p) => p.kind === "skip");
  const chan = new Map(skips.map((p, k) => [p.key, Math.max(...colBottom) + 14 + k * LANE]));

  // A path's segments for given lane xs ({out, in, all} per path key).
  const build = (p, lane) => {
    const segs = [], tx = portX(p.to, side(p, "to")), ty = portY.get(`${p.key}:to:${p.to}`);
    if (p.kind !== "skip") {
      const x = lane.get(`${p.key}:all`), ys = [ty];
      for (const f of p.from) { const sy = portY.get(`${p.key}:from:${f}`); ys.push(sy); segs.push({ x1: portX(f, side(p, "from")), y1: sy, x2: x, y2: sy }); }
      if (Math.max(...ys) > Math.min(...ys)) segs.push({ x1: x, y1: Math.min(...ys), x2: x, y2: Math.max(...ys) });
      segs.push({ x1: x, y1: ty, x2: tx, y2: ty });
      return { segs, arrow: { x: tx, y: ty, left: tx < x } };
    }
    const f = p.from[0], sy = portY.get(`${p.key}:from:${f}`), xo = lane.get(`${p.key}:out`), xi = lane.get(`${p.key}:in`), cy = chan.get(p.key);
    segs.push({ x1: portX(f, side(p, "from")), y1: sy, x2: xo, y2: sy }, { x1: xo, y1: sy, x2: xo, y2: cy }, { x1: xo, y1: cy, x2: xi, y2: cy },
      { x1: xi, y1: cy, x2: xi, y2: ty }, { x1: xi, y1: ty, x2: tx, y2: ty });
    return { segs, arrow: { x: tx, y: ty, left: tx < xi } };
  };

  // The part of a skip path inside one gutter: port to lane, and the lane down to (or up from) the channel.
  const legSegs = (it, lane) => {
    const p = it.p, x = lane.get(`${p.key}:${it.leg}`), cy = chan.get(p.key);
    const id = it.leg === "out" ? p.from[0] : p.to, end = it.leg === "out" ? "from" : "to", y = portY.get(`${p.key}:${end}:${id}`);
    return [{ x1: portX(id, side(p, end)), y1: y, x2: x, y2: y }, { x1: x, y1: y, x2: x, y2: cy }];
  };

  // Lane order per gutter: the permutation (small gutters) or sort with the fewest crossings inside the gutter.
  const lane = new Map();
  gut.forEach((items, g) => {
    if (!items.length) return;
    const left = frameX[g] + W + 2 * PAD + 14;
    const inner = items.filter((it) => it.p.kind === "inner"), rest = items.filter((it) => it.p.kind !== "inner");
    const ymid = (it) => { const ys = [portY.get(`${it.p.key}:to:${it.p.to}`), ...it.p.from.map((f) => portY.get(`${it.p.key}:from:${f}`))]; return ys; };
    const cands = (list) => list.length <= 6 ? permutations(list) : [
      list, [...list].sort((a, b) => Math.min(...ymid(a)) - Math.min(...ymid(b))), [...list].sort((a, b) => Math.max(...ymid(b)) - Math.max(...ymid(a))),
      [...list].sort((a, b) => (Math.max(...ymid(a)) - Math.min(...ymid(a))) - (Math.max(...ymid(b)) - Math.min(...ymid(b))))];
    let best = null;
    for (const ci of cands(inner)) for (const cr of cands(rest)) {
      const order = [...ci, ...cr], trial = new Map(lane);
      order.forEach((it, k) => trial.set(`${it.p.key}:${it.leg}`, left + k * LANE));
      const local = order.map((it) => ({ key: it.p.key, segments: it.leg === "all" ? build(it.p, trial).segs : legSegs(it, trial) }));
      const n = crossings(local).length;
      if (!best || n < best.n) best = { n, trial };
      if (n === 0) break;
    }
    for (const [k, v] of best.trial) lane.set(k, v);
  });

  for (const p of paths) { const b = build(p, lane); p.segments = b.segs; p.arrow = b.arrow; }
  const hops = crossings(paths);

  // Badges: on the path's own lane (its longest vertical), else its target line; never on a card or another badge.
  const rects = nodes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h })), placed = [];
  for (const p of paths) {
    const segs = [...p.segments].sort((a, b) => (Math.abs(b.y2 - b.y1) + Math.abs(b.x2 - b.x1) * 0.5) - (Math.abs(a.y2 - a.y1) + Math.abs(a.x2 - a.x1) * 0.5));
    const spots = [];
    for (const s of segs) for (const t of [0.5, 0.3, 0.7, 0.15, 0.85]) spots.push({ x: s.x1 + (s.x2 - s.x1) * t, y: s.y1 + (s.y2 - s.y1) * t });
    const box = (q) => ({ x: q.x - BADGE / 2, y: q.y - BADGE / 2, w: BADGE, h: BADGE });
    const free = spots.find((q) => !rects.some((r) => overlaps(box(q), r, 2)) && !placed.some((b) => overlaps(box(q), b, 2))) ?? spots[0] ?? { x: 0, y: 0 };
    p.badge = { x: Math.round(free.x), y: Math.round(free.y) };
    placed.push(box(p.badge));
  }

  const outGroups = groups.map((g, i) => ({ ...g, x: frameX[i], y: 0, w: W + 2 * PAD, h: colBottom[i] }));
  const width = (frameX[groups.length - 1] ?? 0) + W + 2 * PAD + (gw[groups.length - 1] ?? 0);
  const height = Math.max(0, ...colBottom, ...[...chan.values()].map((y) => y + 12));
  return { groups: outGroups, nodes, paths, hops, width, height };
}
