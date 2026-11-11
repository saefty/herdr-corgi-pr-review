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
