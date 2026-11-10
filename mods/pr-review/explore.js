// Pure helpers (no gpui, node-testable) for the review layout (review.js).

// ---- the left column (Files / Layers / Findings): shared "review.leftWidth", null = the default
export const LEFT_W = { def: 560, min: 340, max: 0.65 };
// The column's width for a stored width w (null: default) in a window win px wide (0/undefined: not measured yet).
export function leftWidth(w, win) {
  const max = win > 0 ? Math.max(LEFT_W.min, Math.floor(win * LEFT_W.max)) : Infinity;
  return Math.min(max, Math.max(LEFT_W.min, Number.isFinite(w) ? Math.round(w) : LEFT_W.def));
}
