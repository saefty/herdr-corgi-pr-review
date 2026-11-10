// The review layout's "change stack" pieces drawn natively (no libraries): the architecture picture, a layer's
// picture (flow, sequence, state machine, steps), stat cards, segmented bars, collapsible cards, the PR triage card.
// Pure layout lives in arch.js (archLayout) and pr.js (levels, blastArch); these only draw. UI text is English.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { levels } from "./pr.js";
import { archLayout, ARCH } from "./arch.js";

export const STATUS_COLOR = { new: "ansi2", added: "ansi2", changed: "accent", unchanged: "muted", removed: "ansi1" };
export const SEVERITY_COLOR = { critical: "ansi1", high: "ansi1", medium: "ansi3", low: "ansi4", minimal: "ansi2" };
const GLYPH = { component: "◧", data: "⛁", service: "⚙", "api·service": "⇄", api: "⇄", context: "</>", queue: "☰", job: "⏱", ui: "▣" };

export const chip = (t, label, color, solid = false) => div().flex_none().px(6).py(1).rounded(5).border_1().border_color(color)
  .when(solid, (e) => e.bg(color + "26")).text_size(11).font_semibold().text_color(color).child(label);

// A bar of segments [{weight, color}] in one row (CodeRabbit's stat cards).
export const segBar = (t, parts, h = 6) => h_flex().w_full().h(h).gap(2).children(parts.filter((p) => p.weight > 0)
  .map((p) => div().flex_grow(p.weight).flex_basis(0).h_full().rounded(3).bg(p.color)))
  .when(!parts.some((p) => p.weight > 0), (e) => e.child(div().w_full().h_full().rounded(3).bg(t.raised)));

export function statCard(t, id, label, big, bar, foot) {
  return v_flex().id(id).flex_1().min_w(0).p(12).gap(8).rounded(10).border_1().border_color(t.border).bg(t.surface)
    .child(div().text_size(12).font_semibold().text_color(t.muted).child(label))
    .child(div().text_size(22).font_semibold().child(big))
    .child(bar)
    .child(div().text_size(12).text_color(t.muted).truncate().child(foot));
}

// A card with a header that folds it; open/toggle come from the view.
export function foldCard(t, id, title, right, open, toggle, body) {
  return v_flex().id(id).flex_none().rounded(10).border_1().border_color(t.border).bg(t.surface)
    .child(h_flex().id(`${id}-h`).px(12).py(10).gap(8).items_center().cursor_pointer().on_click(toggle)
      .child(div().w(12).text_color(t.muted).child(open ? "▾" : "▸"))
      .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(14).child(title))
      .children(right ?? []))
    .when(open, (e) => e.child(v_flex().px(14).pb(12).gap(8).child(body())));
}

// The layout for a picture, memoized (the page renders often; the layout is the same until the analysis changes).
const memo = new Map();
export function archModel(arch, view = "diff", extra = () => 0) {
  const key = `${view}|${JSON.stringify(arch)}`;
  if (!memo.has(key)) { if (memo.size > 6) memo.delete(memo.keys().next().value); memo.set(key, archLayout(arch, view, extra)); }
  return memo.get(key);
}

// The whole PR's architecture (or the blast radius) at arch.js's positions: dashed group frames, node cards with glyph,
// title (2 lines), description (3 lines; the whole text as tooltip), type and status; each path on its own lane with
// an arrow, a hop where it crosses another, and its numbered badge. Labels are in archLegend.
// onNode(node, event, cx) for cards with a place (at or file); decorate(node) adds lines to a card (findings);
// opts {hl: path num to highlight, onHl(num | null, cx)}.
export function archView(L, t, id, onNode, decorate, opts = {}) {
  const color = (p) => (opts.hl === p.num ? t.accent : p.status === "new" || p.status === "changed" ? t.accent : t.muted);
  const W = (p) => (opts.hl === p.num ? 2.5 : 1.5);
  const hop = ARCH.HOP, els = [];
  L.paths.forEach((p, i) => {
    const c = color(p), w = W(p);
    p.segments.forEach((s, k) => {
      if (s.y1 === s.y2) {
        const x1 = Math.min(s.x1, s.x2), x2 = Math.max(s.x1, s.x2);
        const hx = L.hops.filter((h) => h.h.p === p.key && h.y === s.y1 && h.x > x1 && h.x < x2).map((h) => h.x).sort((a, b) => a - b);
        let from = x1;
        [...hx, null].forEach((x, j) => {
          const to = x === null ? x2 : x - hop / 2;
          if (to > from) { const seg = div().id(`${id}-e${i}-${k}-${j}`).absolute().left(from).top(s.y1).w(to - from).h(0).border_t(w).border_color(c); els.push(p.dashed ? seg.border_dashed() : seg); }
          if (x !== null) {
            els.push(div().id(`${id}-h${i}-${k}-${j}`).absolute().left(x - hop / 2).top(s.y1 - hop / 2).w(hop).h(hop / 2).overflow_hidden()
              .child(div().w(hop).h(hop).rounded_full().border_t(w).border_l(w).border_r(w).border_color(c)));
            from = x + hop / 2;
          }
        });
      } else {
        const seg = div().id(`${id}-e${i}-${k}`).absolute().left(s.x1).top(Math.min(s.y1, s.y2)).w(0).h(Math.abs(s.y2 - s.y1)).border_l(w).border_color(c);
        els.push(p.dashed ? seg.border_dashed() : seg);
      }
    });
    els.push(div().id(`${id}-a${i}`).absolute().left(p.arrow.left ? p.arrow.x : p.arrow.x - 9).top(p.arrow.y - 8).text_size(11).text_color(c).child(p.arrow.left ? "◀" : "▶"));
  });
  const badges = L.paths.map((p, i) => div().id(`${id}-b${i}`).absolute().left(p.badge.x - ARCH.BADGE / 2).top(p.badge.y - ARCH.BADGE / 2).w(ARCH.BADGE).h(ARCH.BADGE)
    .flex().items_center().justify_center().rounded_full().border_1().border_color(color(p)).bg(opts.hl === p.num ? t.accent + "33" : t.background)
    .text_size(11).text_color(t.foreground).tooltip(String(p.label || "")).child(String(p.num))
    .when(Boolean(opts.onHl), (e) => e.on_hover((on, cx) => opts.onHl(on ? p.num : null, cx))));
  const groups = L.groups.map((g, i) => div().id(`${id}-g${i}`).absolute().left(g.x).top(g.y).w(g.w).h(g.h).rounded(12).border_1().border_dashed()
    .border_color(t.border).child(h_flex().px(PAD_IN).h(26).items_center().gap(6).text_size(11.5)
      .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(t.foreground).child(g.label ?? ""))
      .child(div().flex_none().text_color(t.muted).child(g.kind ?? ""))));
  const nodes = L.nodes.map((n, i) => {
    const c = t[STATUS_COLOR[n.status] ?? "muted"], live = n.status && n.status !== "unchanged";
    return v_flex().id(`${id}-n${i}`).absolute().left(n.x).top(n.y).w(n.w).h(n.h).px(10).py(8).gap(3).rounded(8).border_1()
      .border_color(live ? c : t.border).when(live, (e) => e.border_l(4)).bg(n.status === "new" ? t.ansi2 + "14" : t.surface)
      .when(Boolean(n.cut), (e) => e.tooltip(`${n.label ?? n.id}\n\n${n.description ?? ""}`))
      .when(Boolean(onNode && (n.at || n.file)), (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((ev, cx) => onNode(n, ev, cx)))
      .child(h_flex().gap(6).items_start().text_size(12.5)
        .child(div().flex_none().h(17).text_color(t.muted).child(GLYPH[n.type] ?? "◇"))
        .child(div().flex_1().min_w(0).h(n.titleLines * 17).overflow_hidden().whitespace_normal().line_height(1.35).font_semibold().child(n.title))
        .when(n.spots > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.muted).child(`</> ${n.spots}`))))
      .when(n.descLines > 0, (e) => e.child(div().flex_none().h(n.descLines * 15).overflow_hidden().text_size(11).line_height(1.35).whitespace_normal().text_color(t.muted).child(n.desc)))
      .children(decorate ? decorate(n) : [])
      .child(div().flex_1())
      .child(h_flex().gap(6).items_center().text_size(10.5)
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(n.type ?? ""))
        .when(Boolean(n.status), (e) => e.child(chip(t, n.status === "new" ? "ADDED" : n.status.toUpperCase(), c))));
  });
  return div().id(id).relative().flex_none().w(L.width + 4).h(L.height + 4).children([...groups, ...els, ...nodes, ...badges]);
}
const PAD_IN = 10;

// The paths' labels: "① A, B → C: label", one row each; hovering a row highlights its path (opts as in archView).
// big: the blast radius, where the relation is the main information.
export function archLegend(L, t, id, title, opts = {}, big = false) {
  const name = new Map(L.nodes.map((n) => [n.id, n.label ?? n.id]));
  if (!L.paths.length) return div();
  return v_flex().id(id).flex_none().gap(2).p(big ? 12 : 10).rounded(10).border_1().border_color(t.border).bg(t.surface)
    .child(div().pb(4).text_size(big ? 13 : 12).font_semibold().text_color(t.muted).child(title))
    .children(L.paths.map((p) => h_flex().id(`${id}-r${p.num}`).gap(8).items_start().px(6).py(3).rounded(6)
      .when(opts.hl === p.num, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .when(Boolean(opts.onHl), (e) => e.on_hover((on, cx) => opts.onHl(on ? p.num : null, cx)))
      .child(div().flex_none().mt(1).w(18).h(18).flex().items_center().justify_center().rounded_full().border_1()
        .border_color(opts.hl === p.num || p.status ? t.accent : t.muted).text_size(11).text_color(t.foreground).child(String(p.num)))
      .child(div().flex_1().min_w(0).whitespace_normal().text_size(big ? 13 : 12).line_height(1.4)
        .child(`${p.from.map((f) => name.get(f)).join(", ")} → ${name.get(p.to)}${p.label ? `: ${p.label}` : ""}`))));
}

export const legend = (t) => h_flex().gap(10).text_size(11.5).text_color(t.muted).children([["Unchanged", "muted"], ["Changed", "accent"], ["New", "ansi2"], ["Removed", "ansi1"]]
  .map(([label, c]) => h_flex().gap(4).items_center().child(div().w(10).h(10).rounded(3).border_1().border_color(t[c]).bg(t[c] + "33")).child(label)));

// A layer's picture in the narrow left column. flow/architecture: rows by topological level, the edges leaving a
// level listed under it; sequence: participants, then numbered calls; state_machine: each state with its transitions;
// steps: a numbered list. Changed nodes and edges in the accent colour; onJump(at, cx) for nodes with a place.
export function visualCard(v, t, id, onJump) {
  const name = new Map(v.nodes.map((n) => [n.id, n.label ?? n.id])), c = (x) => (x?.changed ? t.accent : t.border);
  const box = (n, k) => v_flex().id(`${id}-b${k}`).flex_none().max_w(180).px(8).py(4).gap(2).rounded(6).border_1().border_color(c(n)).bg(t.background)
    .when(Boolean(n.at && onJump), (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { onJump(n.at, cx); cx.stop_propagation(); }))
    .child(div().text_size(12).font_semibold().text_color(n.changed ? t.accent : t.foreground).child(n.label ?? n.id))
    .when(Boolean(n.note), (e) => e.child(div().px(5).rounded(5).bg(t.accent + "1f").text_size(10.5).text_color(t.foreground).whitespace_normal().child(n.note)));
  const edge = (e, k, prefix = "") => div().id(`${id}-x${k}`).text_size(11.5).text_color(e.changed ? t.accent : t.muted).whitespace_normal()
    .child(`${prefix}${name.get(e.from) ?? e.from} → ${name.get(e.to) ?? e.to}${e.label ? ` · ${e.label}` : ""}`);
  let body;
  if (v.kind === "sequence") {
    body = v_flex().gap(6).child(h_flex().flex_wrap().gap(4).children(v.nodes.map(box))).children((v.edges ?? []).map((e, k) => edge(e, k, `${k + 1}. `)));
  } else if (v.kind === "state_machine") {
    body = v_flex().gap(6).children(v.nodes.map((n, k) => v_flex().gap(2).child(box(n, k))
      .children((v.edges ?? []).filter((e) => e.from === n.id).map((e, j) => div().pl(14).text_size(11.5).text_color(e.changed ? t.accent : t.muted)
        .whitespace_normal().child(`→ ${name.get(e.to) ?? e.to}${e.label ? ` · ${e.label}` : ""}`)))));
  } else if (v.kind === "steps") {
    const lv = levels(v.nodes, v.edges), order = [...v.nodes].sort((a, b) => lv.get(a.id) - lv.get(b.id));
    body = v_flex().gap(4).children(order.map((n, k) => h_flex().gap(6).items_start().child(div().w(16).flex_none().text_size(12).text_color(t.muted).child(`${k + 1}.`)).child(box(n, k))));
  } else {
    const lv = levels(v.nodes, v.edges), depth = Math.max(0, ...lv.values());
    body = v_flex().gap(4).children(Array.from({ length: depth + 1 }, (_, d) => v_flex().gap(4)
      .child(h_flex().flex_wrap().gap(4).children(v.nodes.filter((n) => lv.get(n.id) === d).map((n) => box(n, v.nodes.indexOf(n)))))
      .children((v.edges ?? []).filter((e) => lv.get(e.from) === d).map((e) => edge(e, `${d}-${v.edges.indexOf(e)}`, "↓ ")))));
  }
  return v_flex().id(id).flex_none().mt(4).p(10).gap(8).rounded(8).border_1().border_color(t.border).bg(t.surface)
    .child(h_flex().gap(8).items_center().text_size(11.5).child(div().font_semibold().text_color(t.muted).child(v.kind.replace("_", " ").toUpperCase()))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(v.title ?? "")))
    .child(body);
}

// The PR triage card (pr.js triageOf): priority, title, the why in an accent quote bar, chips, repo and number.
// ponytail: no @author; prs.json has none and these PRs come from your own sessions.
export function triageCard(t, id, pr, tri, onClick) {
  return v_flex().id(id).flex_none().px(8).py(6).gap(5).rounded(8).border_1().border_color(t.border).bg(t.surface).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(onClick)
    .child(h_flex().gap(6).items_center()
      .child(chip(t, `● P${tri.priority}`, tri.priority === 1 ? t.ansi1 : tri.priority === 2 ? t.ansi3 : t.muted))
      .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(12).child(pr.title ?? `#${pr.number}`)))
    .when(Boolean(tri.why), (e) => e.child(div().pl(8).border_l(3).border_color(t.accent).text_size(11.5).line_height(1.4).text_color(t.foreground).whitespace_normal().child(tri.why)))
    .child(h_flex().flex_wrap().gap(4).children(tri.chips.map((c) => chip(t, c, /security/i.test(c) ? t.ansi1 : t.muted))))
    .child(div().text_size(10.5).text_color(t.dim).child(`${pr.repo} #${pr.number}`));
}
