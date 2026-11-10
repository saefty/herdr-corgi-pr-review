// Go-to-definition and hover for the diff, through lsp_bridge.py (real language servers, kept warm by one local
// HTTP daemon). One `exec` per app session starts or finds the bridge; every hover/click after that is a `fetch` to
// 127.0.0.1 with the bridge's token. Results are cached per (root, rev, path, line, character).
// Also: Markdown link targets (relative files, #anchors, web links) and the VS Code jump.
import { exec, appHome } from "herdr";

const BRIDGE = () => `${appHome()}/mods/pr-review/lsp_bridge.py`;
const LSP_EXT = new Set(["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "py", "pyi", "go", "rs", "tf", "tfvars", "java",
  "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "hxx", "ino"]);
const ext = (path) => (path.split("/").pop().includes(".") ? path.split(".").pop().toLowerCase() : "");
/** Whether the bridge has a language server for this file. */
export const supported = (path) => LSP_EXT.has(ext(path));

// ponytail: module scope on purpose: every copy of the mod shares one bridge connection and one cache.
let conn = null, viaExec = false;
const cache = new Map();
const MAX = 500;

function connect(fresh = false) {
  if (!conn || fresh) {
    conn = exec("python3", [BRIDGE(), "start"], { timeout: 20000 }).then((r) => {
      const c = JSON.parse(r.stdout || "{}");
      if (!c.port) throw new Error(c.message || r.stderr || "LSP bridge did not start");
      return c;
    });
    conn.catch(() => { conn = null; });
  }
  return conn;
}

/** POST to the bridge. Retries once with a fresh connection (the bridge idles out after 20 min); falls back to the
 *  bridge's `call` mode through exec when fetch can't reach 127.0.0.1. */
// Checkouts whose code may run inside language servers (build scripts, proc macros, project TypeScript). Everything
// else is someone else's code: the bridge starts its servers in safe mode. See review.js trustedPr.
const trusted = new Set();
export function setTrusted(root, yes) { if (yes) trusted.add(root); else trusted.delete(root); }
export async function call(endpoint, body) {
  if (body?.root) body = { ...body, trusted: trusted.has(body.root) };
  if (!viaExec) {
    for (const fresh of [false, true]) {
      let c;
      try { c = await connect(fresh); } catch (e) { return { status: "error", message: String(e.message ?? e) }; }
      try {
        const r = await fetch(`http://127.0.0.1:${c.port}${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Bridge-Token": c.token }, body: JSON.stringify(body) });
        if (r.status === 403) continue; // a new bridge with a new token
        return await r.json();
      } catch {
        if (fresh) viaExec = true; // a freshly started bridge and still no answer: fetch can't reach 127.0.0.1 here
      }
    }
  }
  const r = await exec("python3", [BRIDGE(), "call", endpoint, JSON.stringify(body)], { timeout: 30000 });
  try { return JSON.parse(r.stdout); } catch { return { status: "error", message: r.stderr || "LSP bridge failed" }; }
}

const remember = (key, p) => {
  if (cache.size >= MAX) cache.delete(cache.keys().next().value);
  cache.set(key, p);
  // Only final answers stay: "starting" (Java index), timeouts and errors are asked again next time.
  p.then((r) => { p.value = r; if (!["ok", "none", "unsupported"].includes(r.status)) cache.delete(key); });
  return p;
};

/**
 * Definition + hover for one position. `side`: "+" or " " (new side; `line` is the new line number), "-" (old side).
 * `root`: a checkout at the reviewed revision (null when the repo is not local / no PR worktree yet).
 * `character`: UTF-16 offset in the line, e.g. a syntax span's `start`.
 * Resolves to {status, message, definitions: [{path, line, character, inRoot, uri, preview, previewStart}], markdown}.
 * status: ok | none | starting | timeout | unsupported | no-root | old-side | error. Never rejects.
 */
export function lookup({ root, rev = "", path, line, character, side = "+" }) {
  if (!root) return Promise.resolve({ status: "no-root", message: "Repo not local", definitions: [], markdown: "" });
  if (side === "-") return Promise.resolve({ status: "old-side", message: "New side only", definitions: [], markdown: "" });
  if (!supported(path)) return Promise.resolve({ status: "unsupported", message: `No language server for .${ext(path) || "this"} files`, definitions: [], markdown: "" });
  const key = `${root}\0${rev}\0${path}\0${line}\0${character}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const req = { root, path, line, character };
  return remember(key, Promise.all([call("/definition", req), call("/hover", req)]).then(([d, h]) => {
    const busy = [d, h].find((r) => r.status === "starting" || r.status === "timeout" || r.status === "error");
    return {
      status: d.status === "ok" || h.status === "ok" ? "ok" : busy?.status ?? d.status,
      message: busy?.message ?? d.message ?? "",
      definitions: d.definitions ?? [],
      markdown: h.markdown ?? "",
    };
  }));
}

/** The finished result for a position, or undefined: for render, never starts a request. */
export const peek = (q) => cache.get(`${q.root}\0${q.rev ?? ""}\0${q.path}\0${q.line}\0${q.character}`)?.value;

/** Full text behind a definition outside the diff: a file in or outside root, or a decompiled/attached-source Java
 *  class (jdt://). For the read-only full-file view. */
export async function contents(root, uri) {
  const r = await call("/contents", { root, uri });
  return r.status === "ok" ? r.text : null;
}

/** Starts the language servers a diff needs (one cheap hover per file type) so the first real hover is warm;
 *  Java's index takes ~25 s cold. Call once when a review opens. */
export function warm(root, paths) {
  if (!root) return;
  const seen = new Set();
  for (const path of paths) if (supported(path) && !seen.has(ext(path))) { seen.add(ext(path)); call("/hover", { root, path, line: 1, character: 0 }); }
}

/** Runs fn(cx) after the pointer rests `ms` on the same key; a later rest() or cancelRest() drops it. */
export function rest(view, key, cx, fn, ms = 300) {
  const gen = (view.restGen = (view.restGen ?? 0) + 1);
  view.restKey = key;
  cx.timer.after(ms, (cx) => { if (view.restGen === gen) fn(cx); });
}
export function cancelRest(view) { view.restGen = (view.restGen ?? 0) + 1; view.restKey = null; }

/** VS Code jump for a definition (only when it is a local file). */
export function vscodeArgs(root, def) {
  const file = def.inRoot ? `${root}/${def.path}` : def.uri?.startsWith("file://") ? decodeURIComponent(def.uri.slice(7)) : null;
  return file ? ["-g", `${file}:${def.line}:${(def.character ?? 0) + 1}`] : null;
}

/** Short label for the hover card: "src/a.ts:12" or "java.lang.String:144". */
export const where = (def) => `${def.path}:${def.line}`;

// --- Markdown links -------------------------------------------------------------------------------------------

/** Where a Markdown link in `fromPath` goes: {kind: "web", url} | {kind: "file", path, anchor} | {kind: "anchor", anchor}
 *  | null (mailto, absolute site paths, outside the repo). */
export function linkTarget(fromPath, href) {
  if (/^https?:\/\//i.test(href)) return { kind: "web", url: href };
  if (/^[a-z][\w+.-]*:/i.test(href) || href.startsWith("//")) return null;
  const [file, anchor = ""] = href.split("#");
  if (!file) return { kind: "anchor", anchor };
  const parts = file.startsWith("/") ? [] : fromPath.split("/").slice(0, -1);
  for (const p of decodeURI(file).split("/")) {
    if (p === "..") { if (!parts.length) return null; parts.pop(); }
    else if (p && p !== ".") parts.push(p);
  }
  return { kind: "file", path: parts.join("/"), anchor };
}

/** GitHub's heading anchor. */
export const slug = (heading) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");

/** 1-based line of the heading an anchor points to, or null. Repeated headings get -1, -2 like on GitHub. */
export function headingLine(text, anchor) {
  if (!anchor) return 1;
  const seen = new Map();
  let fence = false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
    const m = !fence && /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(lines[i]);
    if (!m) continue;
    const base = slug(m[1].replace(/[*_`]|\[([^\]]*)\]\([^)]*\)/g, "$1")), n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    if ((n ? `${base}-${n}` : base) === anchor.toLowerCase()) return i + 1;
  }
  return null;
}
