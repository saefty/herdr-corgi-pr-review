// Syntax highlighting for diff lines, no dependencies. tokenize(line, lang, state) -> {spans, state}:
// spans are [{start, end, kind, ref?, href?}] in UTF-16 offsets; kind is one of the Editor's semantic names
// (keyword string comment function type number constant variable operator punctuation boolean). `ref: true` marks
// names worth a go-to-definition (types, called functions, members, Markdown links). `state` carries block comments,
// multi-line strings, heredocs and Markdown fences from one line to the next of the same file side.
// Pure module: no gpui import, so `node test_syntax.mjs` can load it.

const words = (s) => new Set(s.split(" ").filter(Boolean));
const C_OPS = { line: ["//"], block: ["/*", "*/"] };
const SPECS = {
  js: { ...C_OPS, quotes: "'\"`", multi: ["`"], defType: "class interface type enum namespace", defFn: "function",
    kw: "break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new return super switch this throw try typeof var void while with yield async await as of static get set type interface enum implements private protected public readonly declare namespace abstract keyof infer is satisfies module",
    consts: "null undefined NaN Infinity", types: "string number boolean any unknown never void object symbol bigint" },
  python: { line: ["#"], quotes: "'\"", multi: ['"""', "'''"], prefixes: true, decorators: "function", defType: "class", defFn: "def",
    kw: "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case",
    consts: "None self cls", bools: "True False", types: "int str float bool list dict set tuple bytes object type" },
  java: { ...C_OPS, quotes: "'\"", multi: ['"""'], decorators: "type", defType: "class interface enum record", defFn: "",
    kw: "abstract assert break case catch class continue default do else enum extends final finally for if implements import instanceof interface native new package private protected public return static strictfp super switch synchronized this throw throws transient try volatile while var record sealed permits yield",
    consts: "null", types: "int long short byte char float double boolean void" },
  kotlin: { ...C_OPS, quotes: "'\"", multi: ['"""'], decorators: "type", defType: "class interface object typealias", defFn: "fun",
    kw: "as break class continue do else for fun if in interface is object package return super this throw try typealias val var when while by catch constructor data enum finally get import init internal lateinit open override private protected public sealed set suspend companion inline reified",
    consts: "null", types: "Int Long Short Byte Char Float Double Boolean Unit String Any Nothing" },
  cpp: { ...C_OPS, quotes: "'\"", preproc: true, rawStrings: true, defType: "class struct enum union namespace concept", defFn: "",
    kw: "alignas alignof asm auto break case catch class const consteval constexpr constinit const_cast continue co_await co_return co_yield decltype default delete do dynamic_cast else enum explicit export extern final for friend goto if import inline module mutable namespace new noexcept operator override private protected public register reinterpret_cast requires return sizeof static static_assert static_cast struct switch template this thread_local throw try typedef typeid typename union using virtual volatile while concept",
    consts: "nullptr NULL", types: "void bool char char8_t char16_t char32_t wchar_t short int long float double signed unsigned size_t ssize_t ptrdiff_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t byte boolean word" },
  go: { ...C_OPS, quotes: "'\"`", multi: ["`"], defType: "type", defFn: "func",
    kw: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var",
    consts: "nil iota", types: "bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any" },
  rust: { ...C_OPS, quotes: "\"", lifetimes: true, macros: true, defType: "struct enum trait type union mod", defFn: "fn",
    kw: "as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while",
    consts: "None", types: "i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str" },
  hcl: { line: ["#", "//"], block: ["/*", "*/"], quotes: "\"", heredoc: true, keys: "variable", defType: "", defFn: "",
    kw: "resource data module variable output locals provider terraform for in if for_each count depends_on lifecycle dynamic content backend required_providers moved import check",
    consts: "null" },
  shell: { line: ["#"], quotes: "'\"", vars: true, firstWordFn: true, defType: "", defFn: "function",
    kw: "if then else elif fi for while until do done case esac in function return local export readonly declare set unset shift exit source alias break continue trap eval exec" },
  sql: { line: ["--"], block: ["/*", "*/"], quotes: "'", nocase: true, defType: "table view", defFn: "function",
    kw: "select from where and or not insert into values update set delete create table alter drop index join left right inner outer full cross on group by order having limit offset as distinct union all is in exists between like ilike case when then else end primary key foreign references default with returning begin commit rollback view if replace function returns language asc desc unique constraint add column cascade grant revoke",
    consts: "null", types: "int integer smallint bigint serial bigserial varchar char text boolean bool timestamp timestamptz date time interval uuid json jsonb numeric decimal real float double" },
  yaml: { line: ["#"], quotes: "'\"", keys: "function", consts: "null ~", bools: "true false yes no on off True False", kw: "" },
  json: { quotes: "\"", keys: "function", consts: "null", kw: "" },
};
for (const s of Object.values(SPECS)) {
  for (const k of ["kw", "consts", "types"]) s[k] = words(s[k] ?? "");
  s.bools = words(s.bools ?? "true false");
  s.defType = words(s.defType ?? "");
  s.defFn = words(s.defFn ?? "");
}

const EXT = { ts: "js", tsx: "js", mts: "js", cts: "js", js: "js", jsx: "js", mjs: "js", cjs: "js", py: "python", pyi: "python",
  java: "java", c: "cpp", h: "cpp", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp", ino: "cpp", kt: "kotlin", kts: "kotlin", go: "go", rs: "rust", tf: "hcl", tfvars: "hcl", hcl: "hcl", yml: "yaml", yaml: "yaml",
  toml: "yaml", json: "json", jsonc: "json", sh: "shell", bash: "shell", zsh: "shell", md: "markdown", markdown: "markdown",
  sql: "sql", dockerfile: "dockerfile" };

/** Highlighter language for a path (null: plain text). */
export function langOf(path) {
  const name = path.split("/").pop().toLowerCase();
  if (name === "dockerfile" || name.startsWith("dockerfile.") || name.endsWith(".dockerfile")) return "dockerfile";
  if (name === "makefile" || name.endsWith(".env")) return "shell";
  return EXT[name.includes(".") ? name.split(".").pop() : ""] ?? null;
}

const IDENT = /[A-Za-z_$][\w$]*/y, IDENT_NO$ = /[A-Za-z_][\w]*/y;
const NUM = /0[xX][\da-fA-F_]+n?|0[bB][01_]+n?|0[oO][0-7_]+|(?:\d[\d_]*(?:\.\d[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?[a-zA-Z]*/y;
const PUNCT = "{}[]();,.";
const PYPREFIX = /[rRbBfFuU]{1,2}(?=['"])/y, RUST_CHAR = /'(?:\\.|[^'\\])'/y, RUST_LT = /'[A-Za-z_]\w*/y;
const PREPROC = /\s*#\s*[a-z]+/y, INCLUDE = /\s*<[^>]*>/y, RAW = /R"([^(\s"\\]{0,16})\(/y;
const HEREDOC = /<<-?([A-Z_]+)\s*$/y, SHVAR = /\$(?:\{[^}]*\}|[A-Za-z_]\w*|[0-9@*#?$!-])/y;
const OPS = "+-*/%=<>!&|^~?:";
const isSpace = (c) => c === 32 || c === 9;
const isDigit = (c) => c >= 48 && c <= 57;
const isIdStart = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
const pascal = (w) => /^[A-Z][A-Z0-9]*[a-z]/.test(w);
const allCaps = (w) => w.length > 1 && /^[A-Z][A-Z0-9_]*$/.test(w);

/** One line -> {spans, state}. `state` is null at the start of a file (or after a gap). */
export function tokenize(line, lang, state = null) {
  if (lang === "markdown") return markdown(line, state);
  if (lang === "dockerfile") return dockerfile(line, state);
  const spec = SPECS[lang];
  if (!spec) return { spans: [], state: null };
  return scan(line, spec, state, 0, []);
}

// Scans line[from..] with spec, appending to spans.
function scan(line, spec, state, from, spans) {
  const n = line.length, push = (start, end, kind, extra) => { if (end > start) spans.push(extra ? { start, end, kind, ...extra } : { start, end, kind }); };
  let i = from;
  // Continue a construct left open on the previous line.
  if (state) {
    if (state.h) { // heredoc: ends on a line that is just the marker
      if (line.trim() === state.h) { push(0, n, "keyword"); return { spans, state: null }; }
      push(0, n, "string"); return { spans, state };
    }
    const end = line.indexOf(state.end, i);
    const kind = state.c ? "comment" : "string";
    if (end < 0) { push(i, n, kind); return { spans, state }; }
    push(i, end + state.end.length, kind);
    i = end + state.end.length;
    state = null;
  }
  if (spec.preproc) {
    PREPROC.lastIndex = i;
    if (PREPROC.test(line)) {
      push(line.indexOf("#", i), PREPROC.lastIndex, "keyword"); i = PREPROC.lastIndex;
      INCLUDE.lastIndex = i;
      if (INCLUDE.test(line)) { push(line.indexOf("<", i), INCLUDE.lastIndex, "string"); i = INCLUDE.lastIndex; }
    }
  }
  let prevWord = "", prevChar = 0, first = true;
  const ident = spec.vars ? IDENT_NO$ : IDENT;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (isSpace(c)) { i++; continue; }
    const ch = line[i];
    // Comments.
    if (spec.line && spec.line.some((p) => line.startsWith(p, i))) { push(i, n, "comment"); break; }
    if (spec.block && line.startsWith(spec.block[0], i)) {
      const end = line.indexOf(spec.block[1], i + 2);
      if (end < 0) { push(i, n, "comment"); return { spans, state: { c: 1, end: spec.block[1] } }; }
      push(i, end + 2, "comment"); i = end + 2; prevChar = 0; continue;
    }
    // Strings (with Python prefixes like f"", rb'').
    let q = -1;
    if (spec.quotes.includes(ch)) q = i;
    else if (spec.prefixes && "rRbBfFuU".includes(ch)) { PYPREFIX.lastIndex = i; if (PYPREFIX.test(line)) q = PYPREFIX.lastIndex; }
    if (q >= 0) {
      const multi = spec.multi?.find((m) => line.startsWith(m, q));
      if (multi) {
        const end = line.indexOf(multi, q + multi.length);
        if (end < 0) { push(i, n, "string"); return { spans, state: { end: multi } }; }
        push(i, end + multi.length, "string"); i = end + multi.length; prevChar = 0; continue;
      }
      {
        const quote = line[q]; let j = q + 1;
        while (j < n && line[j] !== quote) j += line[j] === "\\" && quote !== "`" ? 2 : 1;
        const end = Math.min(j + 1, n);
        // JSON/YAML keys: a string followed by ":".
        const key = spec.keys && /^\s*:/.test(line.slice(end, end + 8));
        push(i, end, key ? spec.keys : "string"); i = end; prevChar = 0; first = false; continue;
      }
    }
    if (spec.rawStrings && ch === "R" && line[i + 1] === '"') { // C++ R"delim( ... )delim"
      RAW.lastIndex = i;
      if (RAW.test(line)) {
        const close = `)${/R"([^(]*)\(/.exec(line.slice(i))[1]}"`, end = line.indexOf(close, RAW.lastIndex);
        if (end < 0) { push(i, n, "string"); return { spans, state: { end: close } }; }
        push(i, end + close.length, "string"); i = end + close.length; continue;
      }
    }
    if (spec.lifetimes && ch === "'") { // Rust: 'x' char literal or 'a lifetime
      RUST_CHAR.lastIndex = i;
      if (RUST_CHAR.test(line)) { push(i, RUST_CHAR.lastIndex, "string"); i = RUST_CHAR.lastIndex; continue; }
      RUST_LT.lastIndex = i;
      if (RUST_LT.test(line)) { push(i, RUST_LT.lastIndex, "type"); i = RUST_LT.lastIndex; continue; }
    }
    if (spec.heredoc && line.startsWith("<<", i)) {
      HEREDOC.lastIndex = i;
      if (HEREDOC.test(line)) { push(i, n, "keyword"); return { spans, state: { h: /<<-?([A-Z_]+)/.exec(line.slice(i))[1] } }; }
    }
    if (spec.vars && ch === "$") { // shell $VAR, ${VAR}, $1
      SHVAR.lastIndex = i;
      if (SHVAR.test(line)) { push(i, SHVAR.lastIndex, "constant"); i = SHVAR.lastIndex; first = false; continue; }
    }
    if (spec.decorators && ch === "@") {
      IDENT.lastIndex = i + 1;
      if (IDENT.test(line)) { push(i, IDENT.lastIndex, spec.decorators, { ref: true }); i = IDENT.lastIndex; continue; }
    }
    if (isDigit(c) || (ch === "." && isDigit(line.charCodeAt(i + 1)))) {
      NUM.lastIndex = i;
      if (NUM.test(line)) { push(i, NUM.lastIndex, "number"); i = NUM.lastIndex; prevChar = 0; first = false; continue; }
    }
    if (isIdStart(c)) {
      ident.lastIndex = i;
      ident.test(line);
      const end = ident.lastIndex, w = line.slice(i, end), lw = spec.nocase ? w.toLowerCase() : w;
      let j = end; while (j < n && isSpace(line.charCodeAt(j))) j++;
      const next = line[j], member = prevChar === 46 || (prevChar === 58 && line[i - 2] === ":"); // "." or "::"
      let kind = null, ref = false;
      if (spec.keys && ((next === "=" && line[j + 1] !== "=") || (spec.keys !== "variable" && next === ":"))) kind = spec.keys;
      else if (!member && spec.kw.has(lw)) kind = "keyword";
      else if (spec.bools.has(lw)) kind = "boolean";
      else if (!member && spec.consts.has(lw)) kind = "constant";
      else if (spec.types.has(lw)) kind = "type";
      else if (spec.defType.has(prevWord)) { kind = "type"; ref = true; }
      else if (spec.defFn.has(prevWord)) { kind = "function"; ref = true; }
      else if (spec.macros && next === "!" && line[j + 1] !== "=") { kind = "function"; ref = true; }
      else if (next === "(" || (spec.firstWordFn && first)) { kind = prevWord === "new" && pascal(w) ? "type" : "function"; ref = true; }
      else if (pascal(w)) { kind = "type"; ref = true; }
      else if (allCaps(w)) { kind = "constant"; ref = true; }
      else if (member) { kind = "variable"; ref = true; }
      if (kind) push(i, end, kind, ref ? { ref: true } : null);
      prevWord = lw; prevChar = line.charCodeAt(end - 1); first = false; i = end; continue;
    }
    push(i, i + 1, PUNCT.includes(ch) ? "punctuation" : OPS.includes(ch) ? "operator" : "punctuation");
    prevChar = c; if (ch !== "." && ch !== ":") prevWord = ""; first = ch === ";" || ch === "|" || ch === "&";
    i++;
  }
  return { spans, state: null };
}

const DOCKER = /^(\s*)(FROM|RUN|CMD|COPY|ADD|ENV|ARG|WORKDIR|EXPOSE|ENTRYPOINT|USER|LABEL|VOLUME|HEALTHCHECK|SHELL|ONBUILD|STOPSIGNAL|MAINTAINER)\b/i;
function dockerfile(line, state) {
  if (state?.cont) { const r = scan(line, SPECS.shell, null, 0, []); return { spans: r.spans, state: /\\\s*$/.test(line) ? state : null }; }
  if (/^\s*#/.test(line)) return { spans: [{ start: 0, end: line.length, kind: "comment" }], state: null };
  const m = DOCKER.exec(line);
  if (!m) return { spans: [], state: null };
  const spans = [{ start: m[1].length, end: m[0].length, kind: "keyword" }];
  const as = / AS /i.exec(line);
  if (/^from$/i.test(m[2]) && as) spans.push({ start: as.index + 1, end: as.index + 3, kind: "keyword" });
  else scan(line, SPECS.shell, null, m[0].length, spans);
  return { spans, state: /\\\s*$/.test(line) ? { cont: 1 } : null };
}

// Markdown: front matter, headings, fences (highlighted in the fence's language), quotes, lists, tables, inline code,
// emphasis, links. Link spans carry `href`.
const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)/;
function markdown(line, state) {
  const n = line.length, spans = [];
  if (state?.fm) { // front matter
    if (/^(---|\.\.\.)\s*$/.test(line)) return { spans: [{ start: 0, end: n, kind: "punctuation" }], state: null };
    return { spans: scan(line, SPECS.yaml, null, 0, []).spans, state };
  }
  if (state?.fence) {
    const m = FENCE.exec(line);
    if (m && m[2][0] === state.fence[0] && m[2].length >= state.fence.length && !m[3]) return { spans: [{ start: 0, end: n, kind: "punctuation" }], state: null };
    if (!state.lang) return { spans: [{ start: 0, end: n, kind: "string" }], state };
    const r = tokenize(line, state.lang, state.inner);
    return { spans: r.spans, state: { ...state, inner: r.state } };
  }
  if (state === null && /^---\s*$/.test(line)) return { spans: [{ start: 0, end: n, kind: "punctuation" }], state: { fm: 1 } };
  const fence = FENCE.exec(line);
  if (fence) {
    spans.push({ start: 0, end: n, kind: "punctuation" });
    return { spans, state: { fence: fence[2], lang: fence[3] ? langOf(`x.${fence[3].toLowerCase()}`) ?? FENCE_LANG[fence[3].toLowerCase()] ?? null : null, inner: null } };
  }
  const h = /^\s{0,3}#{1,6}(\s|$)/.exec(line);
  if (h) return { spans: [{ start: 0, end: n, kind: "keyword" }], state: "md" };
  if (/^\s{0,3}>/.test(line)) { spans.push({ start: 0, end: line.indexOf(">") + 1, kind: "comment" }); inline(line, line.indexOf(">") + 1, spans); return { spans, state: "md" }; }
  if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) return { spans: [{ start: 0, end: n, kind: "punctuation" }], state: "md" };
  const li = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s)?/.exec(line);
  let from = 0;
  if (li) { spans.push({ start: li[1].length, end: li[1].length + li[2].length, kind: "operator" }); from = li[0].length; if (li[4]) spans.push({ start: from - li[4].length, end: from - 1, kind: "constant" }); }
  inline(line, from, spans);
  return { spans, state: "md" };
}
const FENCE_LANG = { typescript: "js", javascript: "js", python: "python", golang: "go", rust: "rust", terraform: "hcl", shell: "shell", console: "shell", docker: "dockerfile" };

const INLINE = /(`+)(.+?)\1|!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\[([^\]]+)\]\[[^\]]*\]|<(https?:\/\/[^>\s]+)>|(?<!\w)(\*\*|__)(?=\S)(.+?\S)\7(?!\w)|(?<!\w)(\*|_)(?=\S)(.+?\S)\9(?!\w)|(\|)|https?:\/\/[^\s)>\]]+/g;
function inline(line, from, spans) {
  INLINE.lastIndex = from;
  for (let m; (m = INLINE.exec(line));) {
    const s = m.index, e = s + m[0].length;
    if (m[1]) spans.push({ start: s, end: e, kind: "string" });
    else if (m[4] !== undefined) {
      const textEnd = s + m[0].indexOf("](") + 1;
      spans.push({ start: s, end: textEnd, kind: "function", ref: true, href: m[4] });
      spans.push({ start: textEnd, end: e, kind: "string", ref: true, href: m[4] });
    } else if (m[5]) spans.push({ start: s, end: e, kind: "function" });
    else if (m[6]) spans.push({ start: s, end: e, kind: "string", ref: true, href: m[6] });
    else if (m[7]) spans.push({ start: s, end: e, kind: "type" });
    else if (m[9]) spans.push({ start: s, end: e, kind: "constant" });
    else if (m[11]) spans.push({ start: s, end: e, kind: "punctuation" });
    else spans.push({ start: s, end: e, kind: "string", ref: true, href: m[0] });
  }
}

// Diff rows -> spans per row, with one state per side: context and "+" rows continue the new side, context and "-"
// the old one. "@" (hunk header) rows reset both, since the lines between hunks are unknown.
// ponytail: a block comment opened in hidden lines starts uncolored; carrying it would need the full file.
const memo = new Map();
export function highlightRows(rows, lang, key = null) {
  if (!lang) return rows.map(() => EMPTY);
  const k = key === null ? null : `${key}\0${lang}\0${rows.length}\0${hashRows(rows)}`;
  if (k !== null && memo.has(k)) return memo.get(k);
  let olds = null, news = null;
  const out = rows.map((r) => {
    if (r.kind === "@") { olds = news = null; return EMPTY; }
    const text = r.text ?? "";
    if (r.kind === "-") { const t = tokenize(text, lang, olds); olds = t.state; return t.spans; }
    const t = tokenize(text, lang, news); news = t.state;
    if (r.kind !== "+") olds = tokenize(text, lang, olds).state; // context: both sides see it
    return t.spans;
  });
  if (k !== null) { if (memo.size > 200) memo.delete(memo.keys().next().value); memo.set(k, out); }
  return out;
}
/** Whole file (full-file view): spans per line. */
export const highlightLines = (lines, lang, key = null) => highlightRows(lines.map((text) => ({ kind: "+", text })), lang, key);
const EMPTY = Object.freeze([]);
function hashRows(rows) {
  let h = 0x811c9dc5;
  for (const r of rows) { const t = r.kind + (r.text ?? ""); for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 0x01000193); h = Math.imul(h ^ 10, 0x01000193); }
  return (h >>> 0).toString(16);
}

// Colors: the theme's ANSI palette (tuned for t.background by the theme's author), each checked for contrast; a
// fixed One Dark / GitHub Light color replaces any that falls under 3:1.
const DARK = { keyword: "#c678dd", string: "#98c379", comment: "#7f848e", function: "#61afef", type: "#e5c07b", number: "#d19a66",
  constant: "#56b6c2", boolean: "#d19a66", operator: "#abb2bf", punctuation: "#8b929e", variable: "#e06c75", "string.escape": "#56b6c2" };
const LIGHT = { keyword: "#cf222e", string: "#0a3069", comment: "#6e7781", function: "#8250df", type: "#953800", number: "#0550ae",
  constant: "#0550ae", boolean: "#0550ae", operator: "#57606a", punctuation: "#57606a", variable: "#953800", "string.escape": "#0a3069" };
const FROM_THEME = { keyword: "ansi5", string: "ansi2", comment: "dim", function: "ansi4", type: "ansi3", number: "ansi6", constant: "ansi6",
  boolean: "ansi6", operator: "muted", punctuation: "muted", variable: "ansi1", "string.escape": "ansi14" };
let colorMemo = null;
export function colors(t, bg = t.background) {
  const key = `${bg}${t.foreground}${t.ansi1}${t.ansi2}${t.ansi3}${t.ansi4}${t.ansi5}${t.ansi6}${t.dim}${t.muted}`;
  if (colorMemo?.key === key) return colorMemo.c;
  const dark = luminance(bg) < 0.35, fixed = dark ? DARK : LIGHT, c = { plain: t.foreground ?? (dark ? "#d4d4d4" : "#1f2328") };
  for (const [name, from] of Object.entries(FROM_THEME)) {
    const v = t[from];
    c[name] = v && /^#[0-9a-f]{6}/i.test(v) && contrast(v, bg) >= (name === "comment" ? 2.5 : 3) ? v.slice(0, 7) : fixed[name];
  }
  colorMemo = { key, c };
  return c;
}
/** Colors for EditorState.new({syntax}) so the full-file view matches the diff. */
export const editorSyntax = (t) => { const { plain, ...rest } = colors(t); return rest; };
function luminance(hex) {
  if (!/^#[0-9a-f]{6}/i.test(hex ?? "")) return 0;
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
export function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }

/** Spans -> runs covering the whole text: [{start, end, text, color, span?}]. Neighbours with the same color merge;
 *  a `ref` span stays its own run (it gets its own element for hover and click). */
export function runs(text, spans, c) {
  const out = [];
  const add = (start, end, color, span) => {
    if (end <= start) return;
    const last = out[out.length - 1];
    if (!span && last && !last.span && last.color === color) { last.end = end; last.text = text.slice(last.start, end); return; }
    out.push({ start, end, text: text.slice(start, end), color, span });
  };
  let at = 0;
  for (const s of spans) {
    if (s.start < at) continue;
    add(at, s.start, c.plain);
    add(s.start, s.end, c[s.kind] ?? c.plain, s.ref ? s : null);
    at = s.end;
  }
  add(at, text.length, c.plain);
  return out;
}

/** gpui children for one line. `div` is gpui-kit's (passed in so this module stays pure); `decorate(el, run, i)` may
 *  wrap or extend ref runs (id, hover, click, HoverCard). */
export function renderLine(div, text, spans, c, decorate = null) {
  if (!spans.length) return [div().flex_none().whitespace_nowrap().text_color(c.plain).child(text)];
  return runs(text, spans, c).map((r, i) => {
    const el = div().flex_none().whitespace_nowrap().text_color(r.color).child(r.text);
    return r.span && decorate ? decorate(el, r, i) : el;
  });
}

/** The clickable span at a UTF-16 offset (or null). For lists that can't hold per-token handlers (gpui virtual lists):
 *  offset = floor((press.x - codeLeft) / charWidth) in a monospaced row. */
export const refAt = (spans, offset) => spans.find((s) => s.ref && s.start <= offset && offset < s.end) ?? null;
