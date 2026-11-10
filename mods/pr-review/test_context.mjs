// Run: node test_context.mjs  (contexts: no plug-in → one default; a plug-in's document → its mapping)
import assert from "node:assert/strict";
import * as C from "./context.js";

// No plug-in: one implicit default context, no tags, nothing hidden, no env prefix, the settings' clone root.
{
  const doc = undefined, get = () => undefined;
  assert.equal(C.spaceContext(doc, "s1"), "default");
  assert.equal(C.prContext(doc, { repo: "acme/bookshelf", cwd: "/h/code/bookshelf" }, "/h"), "default");
  assert.equal(C.tagged(doc), false);
  assert.equal(C.shown(doc, "default", get), true);
  assert.deepEqual(C.envArgv(doc, "default"), []);
  assert.deepEqual(C.contextReq(doc, "default"), { id: "default", env: null });
  assert.deepEqual(C.cloneRoots(doc, "default", "~/code"), ["~/code"]);
  assert.deepEqual(C.claudeDirs(doc, "/h"), [{ id: "default", dir: "/h/.claude" }]);
  assert.equal(C.revealOf(doc, "default"), null);
}

// A plug-in with two contexts, rules, a space map and a view switch.
{
  const doc = {
    default: "blue",
    spaces: { s2: "red" },
    rules: [{ path: "~/code/red", context: "red" }, { remote: "github\\.com[:/]acme/", context: "blue" }],
    contexts: {
      blue: { label: "Blue", color: "ansi4", env: { CLAUDE_CONFIG_DIR: null }, cloneRoot: "~/code/blue", show: { key: "view", values: ["all", "blue"] }, reveal: { key: "view", value: "blue" } },
      red: { label: "Red", name: "the Red team", color: "#ff0000", env: { CLAUDE_CONFIG_DIR: "/h/.claude-red" }, cloneRoot: "~/code/red", tickets: false, show: { key: "view", values: ["all", "red"] }, reveal: { key: "view", value: "red" } },
    },
  };
  assert.equal(C.spaceContext(doc, "s1"), "blue");
  assert.equal(C.spaceContext(doc, "s2"), "red");
  assert.equal(C.prContext(doc, { repo: "widget/w", cwd: "/h/code/red/w" }, "/h"), "red"); // path rule
  assert.equal(C.prContext(doc, { repo: "acme/bookshelf", cwd: null }, "/h"), "blue"); // remote rule
  assert.equal(C.prContext(doc, { repo: "x/y" }, "/h", "red"), "red"); // no rule: the fallback
  assert.equal(C.prContext(doc, { repo: "x/y", context: "red" }, "/h"), "red"); // its own wins
  assert.equal(C.prContext(doc, { repo: "acme/y", context: "default" }, "/h"), "blue"); // one the plug-in doesn't know: the rules
  assert.equal(C.tagged(doc), true);
  assert.equal(C.labelOf(doc, "red"), "Red");
  assert.equal(C.nameOf(doc, "red"), "the Red team");
  assert.equal(C.nameOf(doc, "blue"), "Blue");
  assert.equal(C.colorOf(doc, "blue", { ansi4: "#00f", accent: "#888" }), "#00f");
  assert.equal(C.colorOf(doc, "red", { accent: "#888" }), "#ff0000");
  const view = (v) => (k) => (k === "view" ? v : undefined);
  assert.equal(C.shown(doc, "red", view("all")), true);
  assert.equal(C.shown(doc, "red", view("blue")), false);
  assert.equal(C.shown(doc, "red", view(undefined)), true); // the view switch not set yet: everything shows
  assert.deepEqual(C.revealOf(doc, "red"), { key: "view", value: "red" });
  assert.deepEqual(C.envArgv(doc, "blue"), ["env", "-u", "CLAUDE_CONFIG_DIR"]);
  assert.deepEqual(C.envArgv(doc, "red"), ["env", "CLAUDE_CONFIG_DIR=/h/.claude-red"]);
  assert.deepEqual(C.cloneRoots(doc, "red", "~/code"), ["~/code/red", "~/code", "~/code/blue"]);
  assert.deepEqual(C.claudeDirs(doc, "/h"), [{ id: "blue", dir: "/h/.claude" }, { id: "red", dir: "/h/.claude-red" }]);
  assert.equal(C.ruleContext("/h/code/redder", "https://github.com/a/b", doc.rules, "/h"), null); // a prefix is not a parent
  assert.equal(C.ruleContext(null, "https://github.com/a/b", [{ remote: "(", context: "z" }], "/h"), null); // bad regex
}
console.log("ok");
