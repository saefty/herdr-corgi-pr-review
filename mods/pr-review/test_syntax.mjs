// Run: node test_syntax.mjs
import assert from "node:assert/strict";
import { tokenize, langOf, highlightRows, highlightLines, colors, contrast, runs, renderLine, refAt, highlightJob, highlightStep } from "./syntax.js";

// [text, kind] pairs of a line, for readable asserts.
const kinds = (line, lang, state = null) => tokenize(line, lang, state).spans.map((s) => [line.slice(s.start, s.end), s.kind]);
const has = (line, lang, pair, state) => assert.ok(kinds(line, lang, state).some(([t, k]) => t === pair[0] && k === pair[1]), `${lang}: ${JSON.stringify(pair)} in ${JSON.stringify(kinds(line, lang, state))}`);

assert.equal(langOf("src/a.tsx"), "js");
assert.equal(langOf("x/Dockerfile"), "dockerfile");
assert.equal(langOf("main.tf"), "hcl");
assert.equal(langOf("sketch.ino"), "cpp");
assert.equal(langOf("README.md"), "markdown");
assert.equal(langOf("build.gradle.kts"), "kotlin");
assert.equal(langOf("LICENSE"), null);

// JS/TS: keywords, definitions, calls, members, PascalCase types, strings, comments.
const ts = kinds('export class Foo extends Bar { run() { return this.x.go(1, "a") } } // done', "js");
for (const p of [["export", "keyword"], ["Foo", "type"], ["Bar", "type"], ["run", "function"], ["go", "function"], ["x", "variable"], ["1", "number"], ['"a"', "string"], ["// done", "comment"]])
  assert.ok(ts.some(([t, k]) => t === p[0] && k === p[1]), JSON.stringify(p));
assert.ok(tokenize("const s = new Map()", "js").spans.find((s) => s.kind === "type").ref);
// Block comment and template literal carried across lines.
let r = tokenize("const a = 1; /* start", "js");
assert.deepEqual(r.state, { c: 1, end: "*/" });
r = tokenize("still comment */ const b = `x", "js", r.state);
assert.deepEqual(r.spans[0], { start: 0, end: 16, kind: "comment" });
assert.deepEqual(r.state, { end: "`" });
assert.deepEqual(kinds("y` + z", "js", r.state)[0], ["y`", "string"]);

// Python: def/class, decorators, f-strings, triple quotes across lines.
has("def load(path: str) -> Config:", "python", ["load", "function"]);
has("def load(path: str) -> Config:", "python", ["Config", "type"]);
has("@dataclass", "python", ["@dataclass", "function"]);
has('x = f"{a}" if True else None', "python", ['f"{a}"', "string"]);
has("x = True", "python", ["True", "boolean"]);
r = tokenize('doc = """first', "python");
assert.deepEqual(r.state, { end: '"""' });
r = tokenize('end""" + str(x)', "python", r.state);
assert.equal(r.state, null);
assert.deepEqual(kinds('end""" + str(x)', "python", { end: '"""' })[0], ['end"""', "string"]);

// Java: annotations, text blocks, generics.
has("@Override public List<String> names() {", "java", ["@Override", "type"]);
has("@Override public List<String> names() {", "java", ["List", "type"]);
has("record Point(int x, int y) {}", "java", ["Point", "type"]);
assert.deepEqual(tokenize('String q = """', "java").state, { end: '"""' });

// Go, Rust, HCL, YAML, JSON, Shell, SQL, Dockerfile, C++.
has("func (s *Server) Handle(w http.ResponseWriter) error {", "go", ["Handle", "function"]);
has("func (s *Server) Handle(w http.ResponseWriter) error {", "go", ["error", "type"]);
assert.deepEqual(tokenize("var s = `raw", "go").state, { end: "`" });
has("fn parse<'a>(s: &'a str) -> Result<Self, Error> { println!(\"x\"); }", "rust", ["parse", "function"]);
has("fn parse<'a>(s: &'a str) -> Result<Self, Error> { println!(\"x\"); }", "rust", ["'a", "type"]);
has("fn parse<'a>(s: &'a str) -> Result<Self, Error> { println!(\"x\"); }", "rust", ["println", "function"]);
has('resource "aws_s3_bucket" "logs" {', "hcl", ["resource", "keyword"]);
has("  bucket = var.name # c", "hcl", ["bucket", "variable"]);
r = tokenize("  policy = <<EOF", "hcl");
assert.deepEqual(r.state, { h: "EOF" });
assert.equal(tokenize("EOF", "hcl", r.state).state, null);
has("on: [push] # trigger", "yaml", ["on", "function"]);
has("enabled: true", "yaml", ["true", "boolean"]);
has('{"name": "x", "n": 1, "ok": null}', "json", ['"name"', "function"]);
has('{"name": "x", "n": 1, "ok": null}', "json", ['"x"', "string"]);
has('git log --format="%h" $REV | head', "shell", ["git", "function"]);
has('git log --format="%h" $REV | head', "shell", ["$REV", "constant"]);
has('git log --format="%h" $REV | head', "shell", ["head", "function"]);
has("SELECT id, name FROM users WHERE id = 1 -- x", "sql", ["SELECT", "keyword"]);
has("select id from t", "sql", ["from", "keyword"]);
has("FROM node:20 AS build", "dockerfile", ["AS", "keyword"]);
has('RUN npm ci && echo "ok"', "dockerfile", ["RUN", "keyword"]);
assert.deepEqual(tokenize("RUN a \\", "dockerfile").state, { cont: 1 });
has("#include <vector>", "cpp", ["#include", "keyword"]);
has("#include <vector>", "cpp", ["<vector>", "string"]);
has("template <typename T> class Foo : public Bar {", "cpp", ["Foo", "type"]);
has("std::vector<int> v = make(1);", "cpp", ["vector", "variable"]);
has("std::vector<int> v = make(1);", "cpp", ["make", "function"]);
r = tokenize('auto s = R"x(raw', "cpp");
assert.deepEqual(r.state, { end: ')x"' });
assert.equal(tokenize('more)x"; int y;', "cpp", r.state).state, null);
assert.deepEqual(tokenize("x", "nope"), { spans: [], state: null });

// Markdown: headings, fences in their language, links with href, inline code, emphasis, lists, front matter.
has("## Setup", "markdown", ["## Setup", "keyword"]);
const link = tokenize("See [the docs](../docs/a.md#install) and https://x.io.", "markdown", "md").spans.filter((s) => s.href);
assert.deepEqual(link.map((s) => s.href), ["../docs/a.md#install", "../docs/a.md#install", "https://x.io."]);
has("Use `npm ci` and **care**, not snake_case_name", "markdown", ["`npm ci`", "string"], "md");
has("Use `npm ci` and **care**, not snake_case_name", "markdown", ["**care**", "type"], "md");
assert.ok(!kinds("not snake_case_name here", "markdown", "md").length);
has("- [x] done", "markdown", ["-", "operator"], "md");
r = tokenize("```ts", "markdown", "md");
assert.equal(r.state.lang, "js");
has("const x = 1", "markdown", ["const", "keyword"], r.state);
assert.equal(tokenize("```", "markdown", r.state).state, null);
const fm = highlightLines(["---", "title: Hi", "---", "# Head"], "markdown");
assert.equal(fm[1][0].kind, "function");
assert.equal(fm[3][0].kind, "keyword");

// Diff rows: each side keeps its own state; hunk headers reset.
const rows = [{ kind: "@", text: "@@" }, { kind: "-", text: "/* old" }, { kind: "+", text: "let a = 1" }, { kind: " ", text: "b */ c" }, { kind: "@", text: "@@" }, { kind: "+", text: "x */" }];
const hl = highlightRows(rows, "js", "a.js");
assert.equal(hl[1][0].kind, "comment");
assert.equal(hl[2][0].kind, "keyword"); // new side never saw "/* old"
assert.notEqual(hl[3][0].kind, "comment"); // context row follows the new side's state
assert.notEqual(hl[5][0]?.kind, "comment"); // reset at "@"
assert.equal(highlightRows(rows, "js", "a.js"), hl); // memoized
assert.deepEqual(highlightRows(rows, null), rows.map(() => []));

// Colors: theme ANSI kept when readable, replaced when not.
const dark = { background: "#21252b", foreground: "#abb2bf", dim: "#5c6370", muted: "#7f848e", ansi1: "#e06c75", ansi2: "#98c379", ansi3: "#e5c07b", ansi4: "#61afef", ansi5: "#c678dd", ansi6: "#56b6c2", ansi14: "#56b6c2" };
const c = colors(dark);
assert.equal(c.keyword, "#c678dd");
const light = { ...dark, background: "#ffffff", foreground: "#1f2328", ansi3: "#f0f000" }; // unreadable yellow on white
const cl = colors(light);
assert.notEqual(cl.type, "#f0f000");
for (const [k, v] of Object.entries(cl)) if (k !== "comment") assert.ok(contrast(v, "#ffffff") >= 3, `${k} ${v}`);

// Runs: same-color neighbours merge, ref spans stay alone, text is covered exactly.
const line = "foo.bar(x) + 1";
const rs = runs(line, tokenize(line, "js").spans, c);
assert.equal(rs.map((x) => x.text).join(""), line);
assert.ok(rs.find((x) => x.text === "bar" && x.span?.ref));
const els = renderLine(() => { const e = { calls: [], child(t) { e.text = t; return e; } }; for (const m of ["flex_none", "whitespace_nowrap", "text_color"]) e[m] = () => e; return e; }, line, tokenize(line, "js").spans, c, (el, run) => ({ ...el, ref: run.text }));
assert.ok(els.some((e) => e.ref === "bar"));
assert.equal(line.slice(refAt(tokenize(line, "js").spans, 5).start, refAt(tokenize(line, "js").spans, 5).end), "bar");
assert.equal(refAt(tokenize(line, "js").spans, 11), null);

// Performance: 10k lines of mixed code.
const sample = ['import { a, b } from "./x.js";', "export function foo(bar, baz) {", "  const q = bar.map((x) => x * 2).filter(Boolean); // note",
  "  /* block */ return new Thing(q, `tpl ${baz}`);", "}", "class Thing extends Base { constructor(a, b) { super(a); this.b = b ?? 0x1f; } }"];
const big = Array.from({ length: 10000 }, (_, i) => ({ kind: i % 7 === 0 ? "-" : i % 5 === 0 ? "+" : " ", text: sample[i % sample.length] }));
const py = Array.from({ length: 10000 }, (_, i) => ({ kind: " ", text: ['def f(x: int) -> "Foo":', '    return {"a": [1, 2.5, None]}  # c', "    s = f'{x!r}' + other.call(y)"][i % 3] }));
highlightRows(big.slice(0, 500), "js"); // warm up the JIT
for (const [name, set, lang] of [["js", big, "js"], ["python", py, "python"]]) {
  const t0 = performance.now();
  highlightRows(set, lang);
  const ms = performance.now() - t0;
  console.log(`tokenize 10k ${name} lines: ${ms.toFixed(1)} ms`);
  assert.ok(ms < 150, `${name} too slow: ${ms} ms`);
}
const t1 = performance.now();
highlightRows(big, "js", "big.js"); highlightRows(big, "js", "big.js");
console.log(`10k lines, memoized second call included: ${(performance.now() - t1).toFixed(1)} ms`);
// Sliced highlighting gives the same spans as one pass, whatever the slice size (a negative budget stops every 32 rows).
{
  const rows = Array.from({ length: 200 }, (_, i) => ({ kind: i % 7 === 0 ? "-" : i % 5 === 0 ? " " : "+", text: i % 9 === 0 ? "/* open" : i % 9 === 3 ? "close */ const x = 1;" : `let v${i} = "s";` }));
  const job = highlightJob(rows, "js");
  let out = null, steps = 0;
  while (!(out = highlightStep(job, -1))) steps++;
  assert.deepEqual(out, highlightRows(rows, "js"));
  assert.ok(steps >= 5, `${steps} slices`);
}
console.log("syntax ok");
