// Pure helpers for the panel's state (main.js) and a layer's flow picture (stack.js visualCard). No gpui imports, so
// node tests them (test_views.mjs).
import { transitionText } from "./arch.js";

// The panel is either picking a PR (none chosen yet, or PRs ▾ open) or showing the chosen one (its diff or walkthrough).
// chosen: a PR, or the current branch picked from the list.
export const panelState = ({ chosen, picking }) => (!chosen || picking ? "picking" : "selected");

// The body tab of a chosen PR: "walk" or "diff" (Setup has its own page).
export const bodyTab = (view) => (view === "walk" ? "walk" : "diff");

// In progress: the newest `max` unless all are asked for; more: how many are left out.
export const IN_PROGRESS_MAX = 3;
export function capped(list, all = false, max = IN_PROGRESS_MAX) {
  return all ? { shown: list, more: 0 } : { shown: list.slice(0, max), more: Math.max(0, list.length - max) };
}

// A flow (or a layer's architecture) visual as archLayout's input: its groups, else one implicit group for all nodes;
// a node's note is its card's description; `changed` becomes status "changed"; an edge's text is its label (or
// "event [guard] / action"). Sources (implemented, existing, spec) pass through, so the cards style the same way.
export function flowArch(v) {
  const groups = (v?.groups ?? []).filter((g) => g?.id);
  const implicit = groups.length ? null : { id: "flow", label: "", kind: "" };
  const status = (x) => x.status ?? (x.changed ? "changed" : undefined);
  return {
    groups: implicit ? [implicit] : groups,
    nodes: (v?.nodes ?? []).map((n) => ({ id: n.id, label: n.label ?? n.id, description: n.description ?? n.note ?? "", type: n.type,
      group: implicit ? implicit.id : n.group, status: status(n), source: n.source, at: n.at, evidence: n.evidence })),
    edges: [...(v?.edges ?? []), ...(v?.transitions ?? [])].map((e) => ({ from: e.from, to: e.to, label: transitionText(e),
      status: status(e), source: e.source, evidence: e.evidence, dashed: e.dashed })),
  };
}

// One wheel/trackpad event over a sideways scroller inside the scrolling page (review.js hscroll). g: the gesture so
// far ({axis, at} | null); a gesture keeps the axis it starts with (mostly sideways: only the picture moves; mostly
// down: the page scrolls) and ends after GESTURE_MS without an event or on a new touch; shift+wheel is sideways.
// Gives the gesture, the offset clamped to [0, max] and used (the picture took the event: the page must not).
export const GESTURE_MS = 150;
export function wheelStep(g, { dx = 0, dy = 0, t, phase, shift = false }, x, max) {
  let axis = phase === "started" || !g || t - g.at > GESTURE_MS ? null : g.axis;
  if (!axis && (dx || dy)) axis = Math.abs(dx) > Math.abs(dy) || shift ? "x" : "y";
  const used = axis === "x" && max > 0, clamp = (v) => Math.max(0, Math.min(max, v));
  return { g: { axis, at: t }, x: clamp(used ? x - (dx || (shift ? dy : 0)) : x), used };
}

// gh pr diff refuses PRs over 300 files (HTTP 406 / too_large): then the diff is made from a local clone.
export const diffTooLarge = (msg) => /HTTP 406|exceeded the maximum number of files|too_large/i.test(String(msg));

// The "List pull request files" API's files as gh-pr-diff-shaped text (pr.js splitPatch). A file without a patch
// (binary, or too large for GitHub) keeps its header and a note.
export function filesToDiff(files) {
  const out = [];
  for (const f of files) {
    const from = f.previous_filename ?? f.filename, added = f.status === "added", removed = f.status === "removed";
    out.push(`diff --git a/${from} b/${f.filename}`);
    if (added) out.push("new file mode 100644");
    else if (removed) out.push("deleted file mode 100644");
    else if (f.status === "renamed") out.push(`rename from ${from}`, `rename to ${f.filename}`);
    if (f.patch) out.push(`--- ${added ? "/dev/null" : `a/${from}`}`, `+++ ${removed ? "/dev/null" : `b/${f.filename}`}`, f.patch);
    else out.push(`Binary files a/${from} and b/${f.filename} differ`, `No diff from GitHub for this file (binary or too large): +${f.additions ?? 0} -${f.deletions ?? 0}`);
  }
  return out.join("\n") + "\n";
}

// ---- files folded when a review opens: lock files and generated output, and big changes (click the header to open)
const LOCK = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|go\.sum|flake\.lock|gradle\.lockfile|[^/]*\.lock|[^/]*\.min\.(js|css)|[^/]*\.map)$/;
export const FOLD_LINES = 400;
export const foldOnOpen = (patch) => (patch ?? []).filter((f) => LOCK.test(f.path) || (f.add ?? 0) + (f.del ?? 0) > FOLD_LINES).map((f) => f.path);

// ---- the Files list's room (review.js filesItems): gpui-kit's virtual list holds at most 10000 items, so a big PR
// opens the files around where you read and folds the rest; each folded file keeps its height as one tall item, so
// the scrollbar spans the whole PR and nothing jumps when files open or fold while you scroll.
// files: the files that could open, in document order: {path, i (place in the PR), n (rows)}. Which fold
// (overBudget): the file at `center` first, then the ones you opened last (the newest RECENT), then the nearest
// to `center`, below before above on a tie; what doesn't fit in `cap` rows folds.
export const RECENT = 8;
export function allocate({ files, center = 0, recent = [], cap }) {
  const rank = new Map(recent.slice(0, RECENT).map((p, i) => [p, i]));
  const key = (f) => (f.i === center ? 0 : rank.has(f.path) ? 1 + rank.get(f.path) : 1e6 + 2 * Math.abs(f.i - center) + (f.i < center ? 1 : 0));
  const over = new Set();
  let used = 0;
  for (const f of [...files].sort((a, b) => key(a) - key(b))) { if (used + f.n > cap) over.add(f.path); else used += f.n; }
  return over;
}

// Index of the last sorted value <= x (0 when none): the file whose header is at or above an item.
export function lastAtOrBelow(sorted, x) {
  let lo = 0, hi = sorted.length - 1, k = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (sorted[m] <= x) { k = m; lo = m + 1; } else hi = m - 1; }
  return k;
}

// Whether to open the files around the view again, and around which file (null: leave it). heads: the item index
// of each file's header, in order; top: each item's y (top[i], one past the last too); folds: [top, bottom] of the
// folded files' items, in order; start..end: the items on screen; center: the file the room was given around.
// Only when a folded file is within `margin` px of the view and you have moved to another file: scrolling inside
// the open part changes nothing, so it doesn't reshuffle while you read.
export function recenter({ heads, top, folds, start, end, center, margin }) {
  if (!folds.length || !heads.length) return null;
  const at = lastAtOrBelow(heads, start);
  if (at === center) return null;
  const y0 = top[start] - margin, y1 = top[Math.min(end, top.length - 1)] + margin;
  let lo = 0, hi = folds.length; // the first fold that ends below y0
  while (lo < hi) { const m = (lo + hi) >> 1; if (folds[m][1] < y0) lo = m + 1; else hi = m; }
  return lo < folds.length && folds[lo][0] <= y1 ? at : null;
}

// A sideways scroller's visible width (review.js hscroll): its measured width less what the Ask drawer covers at the
// right, so the scroll reaches the picture's last columns; never under 100 px.
export const hsVisible = (measured, covered = 0) => Math.max(100, measured - covered);
