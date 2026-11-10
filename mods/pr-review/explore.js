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
