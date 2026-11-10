// Contexts: an optional, opaque grouping of PRs supplied by a plug-in mod through shared "pr-review.contexts"
// (see PROVIDERS.md). A context can carry a label and colour (a tag in the UI), env vars for the claude/gh calls,
// a clone folder, and whether the current view shows it. No plug-in: one implicit "default" context, no tags, no
// filtering. Pure functions: callers pass the shared document (and a shared() getter where state is read).

export const CONTEXTS_KEY = "pr-review.contexts";
export const DEFAULT = "default";

export const defaultOf = (doc) => doc?.default ?? DEFAULT;
export const infoOf = (doc, id) => doc?.contexts?.[id] ?? {};
// Tags and filters only make sense with two or more contexts.
export const tagged = (doc) => Object.keys(doc?.contexts ?? {}).length > 1;
export const labelOf = (doc, id) => infoOf(doc, id).label ?? id;
// A phrase for sentences ("the Blue profile"); falls back to the label.
export const nameOf = (doc, id) => infoOf(doc, id).name ?? labelOf(doc, id);
export const colorOf = (doc, id, theme) => { const c = infoOf(doc, id).color; return c ? theme[c] ?? c : theme.accent; };

// Rules: [{path, context} | {remote, context}], first match wins. Path rules match the folder and everything under
// it (case-insensitive, ~ is home); remote rules are a case-insensitive regex on the repo URL. null: none matched.
export function ruleContext(folder, remote, rules, home) {
  const norm = (p) => String(p ?? "").replace(/^~(?=\/|$)/, home).replace(/\/+$/, "").toLowerCase();
  const f = norm(folder);
  for (const r of rules ?? []) {
    if (r.path) { const p = norm(r.path); if (p && f && (f === p || f.startsWith(`${p}/`))) return r.context; }
    else if (r.remote && remote) { try { if (new RegExp(r.remote, "i").test(remote)) return r.context; } catch { /* a bad regex matches nothing */ } }
  }
  return null;
}

// A space's context: the plug-in's map, else the default.
export const spaceContext = (doc, spaceId) => doc?.spaces?.[spaceId] ?? defaultOf(doc);

// A context id the document knows (any id when there is no plug-in).
export const known = (doc, id) => Boolean(id) && (!doc?.contexts || Object.keys(doc.contexts).length === 0 || id in doc.contexts);

// A PR's context: its own (set when it was listed) when the plug-in knows it, else the rules on its folder and repo,
// else the fallback.
export const prContext = (doc, pr, home, fallback) =>
  (known(doc, pr?.context) ? pr.context : null) ?? ruleContext(pr?.cwd ?? pr?.target?.cwd, pr?.repo ? `https://github.com/${pr.repo}` : null, doc?.rules, home) ?? fallback ?? defaultOf(doc);

// Whether the current view shows a context: `show: {key, values}` reads shared(key); a missing value shows all.
export function shown(doc, id, get) {
  const v = infoOf(doc, id).show;
  if (!v?.key) return true;
  const cur = get(v.key);
  return cur === undefined || cur === null || (v.values ?? []).includes(cur);
}

// `reveal: {key, value}`: what to set so the view shows this context; null when it can't be revealed.
export const revealOf = (doc, id) => infoOf(doc, id).reveal ?? null;

// The env prefix for a command run in a context: ["env", "-u", "X", "Y=v"]; [] without env vars. null unsets.
export function envArgv(doc, id) {
  const env = infoOf(doc, id).env ?? {};
  const keys = Object.keys(env);
  if (!keys.length) return [];
  return ["env", ...keys.flatMap((k) => (env[k] === null ? ["-u", k] : [`${k}=${env[k]}`]))];
}

// What Python scripts get: {id, env} (env null: inherit).
export const contextReq = (doc, id) => ({ id, env: infoOf(doc, id).env ?? null });

// Folders to look for an existing clone in, this context's first; the clone goes into the first one.
export function cloneRoots(doc, id, fallback) {
  const own = infoOf(doc, id).cloneRoot;
  const others = Object.values(doc?.contexts ?? {}).map((c) => c.cloneRoot);
  return [...new Set([own, fallback, ...others].filter(Boolean))];
}

// The Claude config folders to scan for session PRs, one per distinct CLAUDE_CONFIG_DIR (unset: ~/.claude).
export function claudeDirs(doc, home) {
  const ids = Object.keys(doc?.contexts ?? {});
  const list = (ids.length ? ids : [defaultOf(doc)]).map((id) => ({ id, dir: infoOf(doc, id).env?.CLAUDE_CONFIG_DIR ?? `${home}/.claude` }));
  const seen = new Set();
  return list.filter((c) => !seen.has(c.dir) && seen.add(c.dir));
}
