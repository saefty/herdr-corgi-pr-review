// Run: node test_defs.mjs            (pure parts)
//      LIVE=1 node test_defs.mjs     (also a real lookup through lsp_bridge.py: pyright on a small repo made here)
// "herdr" is stubbed with child_process + Node's fetch, so defs.js runs here as it does in the mod.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { homedir } from "node:os";

const stub = `import { execFile } from "node:child_process";
export const appHome = () => process.env.HERDR_APP_HOME || "${homedir()}/.config/herdr-app";
export const exec = (cmd, args, o = {}) => new Promise((ok) => execFile(cmd, args, { cwd: o.cwd, timeout: o.timeout }, (e, stdout, stderr) => ok({ code: e ? e.code ?? 1 : 0, stdout, stderr })));`;
registerHooks({ resolve: (s, c, next) => (s === "herdr" ? { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true } : next(s, c)) });
const d = await import("./defs.js");

assert.ok(d.supported("a/b.ts") && d.supported("x.java") && d.supported("s.ino") && !d.supported("README.md"));
assert.deepEqual(await d.lookup({ root: null, path: "a.py", line: 1, character: 0 }), { status: "no-root", message: "Repo not local", definitions: [], markdown: "" });
assert.equal((await d.lookup({ root: "/x", path: "a.py", line: 1, character: 0, side: "-" })).status, "old-side");
assert.equal((await d.lookup({ root: "/x", path: "a.md", line: 1, character: 0 })).message, "No language server for .md files");

assert.deepEqual(d.linkTarget("docs/guide/a.md", "../b.md#setup-steps"), { kind: "file", path: "docs/b.md", anchor: "setup-steps" });
assert.deepEqual(d.linkTarget("docs/a.md", "./img/x%20y.png"), { kind: "file", path: "docs/img/x y.png", anchor: "" });
assert.deepEqual(d.linkTarget("README.md", "/docs/c.md"), { kind: "file", path: "docs/c.md", anchor: "" });
assert.deepEqual(d.linkTarget("a.md", "#usage"), { kind: "anchor", anchor: "usage" });
assert.deepEqual(d.linkTarget("a.md", "https://x.io/a"), { kind: "web", url: "https://x.io/a" });
assert.equal(d.linkTarget("a.md", "../../etc/passwd"), null);
assert.equal(d.linkTarget("a.md", "mailto:x@y"), null);
assert.equal(d.slug("Setup & Install (macOS)"), "setup--install-macos");
const md = "# Title\n\n## Usage\ntext\n```\n## not a heading\n```\n## Usage\n## `Code` and [link](x)";
assert.equal(d.headingLine(md, "usage"), 3);
assert.equal(d.headingLine(md, "usage-1"), 8);
assert.equal(d.headingLine(md, "code-and-link"), 9);
assert.equal(d.headingLine(md, "missing"), null);
assert.deepEqual(d.vscodeArgs("/r", { inRoot: true, path: "src/a.ts", line: 3, character: 4 }), ["-g", "/r/src/a.ts:3:5"]);
assert.equal(d.vscodeArgs("/r", { inRoot: false, uri: "jdt://contents/x" }), null);

if (process.env.LIVE) {
  const { mkdtempSync, writeFileSync } = await import("node:fs"), { execFileSync } = await import("node:child_process"), { tmpdir } = await import("node:os");
  const root = mkdtempSync(`${tmpdir()}/defs-`), path = "tool.py";
  writeFileSync(`${root}/${path}`, "def gh(args):\n    return args\n\n\nprint(gh([1]))\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  const line = 5, character = "print(".length;
  for (const label of ["first (bridge start/connect + maybe cold server)", "cached"]) {
    const t0 = performance.now();
    const r = await d.lookup({ root, rev: "HEAD", path, line, character });
    console.log(`${label}: ${(performance.now() - t0).toFixed(0)} ms`, r.status, r.definitions.map(d.where), JSON.stringify(r.markdown.slice(0, 60)));
    assert.equal(r.status, "ok");
    assert.equal(r.definitions[0].line, 1);
  }
  const t0 = performance.now();
  const r = await d.call("/hover", { root, path, line, character: character + 1 });
  console.log(`uncached hover over fetch: ${(performance.now() - t0).toFixed(0)} ms`, r.status);
  assert.equal(d.peek({ root, rev: "HEAD", path, line, character }).status, "ok");
}
console.log("defs ok");
