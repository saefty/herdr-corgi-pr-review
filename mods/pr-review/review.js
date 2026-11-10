// The review layout (layouts/review.json): one PR in the whole window, as two copies of this mod.
// Part "bar": back, PR, context tag, model picker, cost. Part "review": left the AI's steps in risk order (or the file
// tree), right every diff line in one virtual list with suggestions and comments inline. Mixed into PrReview
// (main.js), so comments, the pending review and "Send review" are the panel's own code.
// Tabs: Files (since your last review, or the full PR), Layers (Overview, Security blast radius, Architecture impact,
// Verify, then the AI's layers; stack.js draws the pictures), Findings. Cheap context (since-diff, related PRs, CI checks)
// loads by itself; every LLM call (Analyze, Only new changes, Verify fixes) is a click.
// UI text is English; the AI's content stays as it answers. Keys (diff focused): j/k step (Files tab: file), n/p hunk, c comment, a/x take/drop suggestion, s/f Layers/Files, Esc back.
import { div } from "gpui-kit";
import { v_flex, h_flex, Input, Scrollbar, TextView, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { exec, run, theme, settings, readTextFile, writeTextFile, shared, setShared, appHome, nextCommand, watchFolder, openOverlay, closeOverlay, props, home } from "herdr";
import { parseReports, findingStatus, fixPrompt, hash, touchReview, expireReviews, resumeFields, itemKeys, expandTabs, tokenAt } from "./pr.js";
import * as C from "./context.js";
import { hasTool, copyText, openUrl, loadSetup, readConfig } from "./setup-view.js";
import { highlightRows, highlightLines, langOf, colors, renderLine, refAt } from "./syntax.js";
import { lookup, warm, contents, vscodeArgs, where } from "./defs.js";
import { diffRows, hunksOf, selection, uiLine, lineKey, rangeOf, MODELS, reviewRequest, mapReview, suspectComment, stepKey, fileRows, fileTree, atLine, splitPatch } from "./pr.js";
import { ghTarget, lowValue, markReviewed, sinceBase, verifyCandidates, applyVerification, blastArch, preMergeChecks, mergeBlockers, triageOf } from "./pr.js";
import { archView, archModel, archLegend, visualCard, statCard, segBar, foldCard, chip, legend, SEVERITY_COLOR } from "./stack.js";

const LEVEL = { high: "ansi1", medium: "ansi3", low: "ansi4", skim: "muted" };
const COVER = { seen: ["done", "ansi2"], partly: ["partly", "ansi3"], absent: ["missing", "ansi1"], extra: ["extra (not asked)", "ansi4"] };
// ponytail: GitHub's saturated diff hues; the theme's olive ansi2 under alpha turned the code background grey and dulled the syntax colors.
const tint = (kind) => (kind === "+" ? "#2ea043" : "#f85149");
const STATUS = { added: ["A", "ansi2"], deleted: ["D", "ansi1"], renamed: ["R", "ansi4"], modified: ["M", "ansi3"] };
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// Diff column geometry: clicks inside the virtual list are placed by x (one click handler per list).
const LEFT = 420, ROW = 22, GUTTER = 4 + 48 + 48 + 22, GAP_SEG = 110, BTN = 110, BTN_GAP = 8, ACT = 44;
const FILE_CHEV = 30, FILE_SEEN = 100, FILE_WHOLE = 124;
const MORE = 20; // lines per ↑/↓ click
const progressFile = () => `${appHome()}/pr-data/review-progress.json`; // per PR: progress and where you were (bounded)
const MAX_PROGRESS = 100;
// Open reviews, for other mods (PROVIDERS.md). Resume contract for any mod:
//   setShared("review.target", <a PR from pr-data/prs.json, or a registry entry's `target`>); run("layout.switch", { name: "review" })
// shared("review.open") is this file's in-progress and sent entries: [{url, number, repo, title, context, startedAt,
// lastTouched, headSha, status, progress: {stepsChecked, steps, filesViewed, files, comments, findingsOpen}, target}].
const openFile = () => `${appHome()}/pr-data/open-reviews.json`;
// shared("review.registry") is every entry, done ones too, with {at}: for plug-ins that mirror reviews elsewhere
// (PROVIDERS.md). Written on each registry change, 1.5 s after the last edit.
const model = () => (MODELS[shared("review.model")] ? shared("review.model") : "sonnet");
const cacheDir = () => `${appHome()}/pr-data/cache`;
const valuesOn = () => shared("review.values") !== false; // inline example values (flow traces), on by default
const clock = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
const CAP = { haiku: 1, sonnet: 3, opus: 10 }; // review.py BUDGET
const findDir = () => `${appHome()}/pr-data/findings`;
const ctxDoc = () => shared(C.CONTEXTS_KEY);
const prCtx = (pr) => C.prContext(ctxDoc(), pr, home());
const ALL_REVIEWERS = { claude: ["Claude code review", "ansi5"], security: ["Security review", "ansi1"], codex: ["Codex review", "ansi6"] };
// Codex is optional: offered only when `codex` is on PATH (Setup's last check). Labels stay for findings already there.
const REVIEWERS = ALL_REVIEWERS;
const reviewersNow = () => Object.entries(ALL_REVIEWERS).filter(([k]) => k !== "codex" || hasTool("codex"));
const FSTATUS = { open: ["Open", "muted"], progress: ["In progress", "ansi3"], fixed: ["Fixed ✓", "ansi2"], dismissed: ["Dismissed", "dim"], recheck: ["Recheck (code changed)", "ansi3"] };
const SEV = { high: "ansi1", medium: "ansi3", low: "ansi4" };
const PROBE = "0".repeat(40);
const CTX_MS = 10 * 60000; // related PRs, CI checks, mergeability (related.py): asked again after this while the review is open
const OPEN_ST = ["open", "progress", "recheck"];
// The Layers tab's pages (left nav); null: the diff of the current layer.
const PAGES = [["overview", "Overview"], ["blast", "Security blast radius"], ["arch", "Architecture impact"], ["verify", "Verify"]]; // measures the mono font's character width, for clicks on tokens inside the virtual list

// "Reviews ▾" in the bar opens this popup (props {part: "reviews"}): each reviewer with its last run; Run reaches the
// review copy through its nextCommand.
export function renderReviews() {
  const t = theme(), runs = shared("review.reviewers") ?? {};
  return v_flex().id("rv-reviews").size_full().p(8).gap(6).bg(t.popover).text_color(t.foreground).text_size(13)
    .children(reviewersNow().map(([k, [label, c]]) => {
      const r = runs[k] ?? {};
      return h_flex().id(`rv-rr-${k}`).gap(10).px(8).py(6).rounded(7).items_center().hover((s) => s.bg(t.hover))
        .child(div().w(8).h(8).rounded_full().bg(t[c]))
        .child(v_flex().flex_1().min_w(0)
          .child(div().font_semibold().child(label))
          .child(div().text_size(12).text_color(r.error ? t.ansi1 : t.muted).truncate().child(r.busy ? `running · ${clock(Date.now() - Date.parse(r.started))}`
            : r.error ? r.error : r.at ? `${r.count} findings · ${r.cost != null ? `$${Number(r.cost).toFixed(3)} · ` : ""}${clock(r.ms ?? 0)} · ${ago(r.at)}${k === "codex" ? " · Codex price not reported" : ""}` : "not run yet")))
        .child(r.busy ? div().child(SPIN[0]).frames(SPIN, 90) : pill(`rv-rrun-${k}`, t, r.at ? "Run again" : "Run", () => { run(`pr-review.reviewer:${k}`); closeOverlay(props().overlay); }));
    }))
    .child(div().px(8).pt(2).text_size(11.5).text_color(t.muted).child(`Claude reviews run read-only in a checkout of the PR head${C.tagged(ctxDoc()) ? ", with the PR's context" : ""}.${hasTool("codex") ? " Codex uses its own login." : ""}`));
}

// The title bar of the floating agent terminal (props {part: "agentbar", title}): drag it, close it.
export function renderAgentBar() {
  const t = theme();
  return h_flex().id("rv-agentbar").size_full().px(12).gap(8).items_center().bg(t.chrome).text_size(13).text_color(t.foreground)
    .child(div().flex_1().min_w(0).truncate().font_semibold().child(props().title ?? "Agent"))
    .child(div().text_size(12).text_color(t.muted).child("prompt pasted, not sent: add words, Enter to send"))
    .child(pill("rv-agent-close", t, "Close", () => closeOverlay(props().overlay)));
}
const stop = (_e, cx) => cx.stop_propagation(); // a control in the window-drag bar

// ponytail: last writer wins per key; a retry covers a concurrent write, not two copies editing one key at once.
export async function saveKey(path, key, value) {
  for (let attempt = 0; ; attempt++) {
    const before = await readTextFile(path).catch(() => null);
    const doc = before ? JSON.parse(before) : {};
    if (value === undefined) delete doc[key]; else doc[key] = value;
    try { return await writeTextFile(path, JSON.stringify(doc, null, 1), before); } catch (e) { if (attempt) throw e; }
  }
}

// Opens a PR in the review layout; Back returns to the layout shown now.
export function startReview(target) {
  const back = shared("layout");
  if (back && back !== "review") setShared("review.back", back);
  setShared("review.target", target);
  run("layout.switch", { name: "review" });
}
const leave = () => run("layout.switch", { name: shared("review.back") || "main" });

const pill = (id, t, label, click, on = false, color) => div().id(id).px(9).h(26).flex().items_center().rounded(6).border_1()
  .border_color(on ? t.accent : t.border).text_size(12.5).text_color(color ?? (on ? t.foreground : t.muted)).cursor_pointer()
  .hover((s) => s.text_color(t.foreground)).on_mouse_down("left", stop).on_click(click).child(label);
const badge = (t, label, color) => div().flex_none().px(6).py(1).rounded(5).border_1().border_color(color).text_size(11.5).font_semibold().text_color(color).child(label);
const riskBadge = (t, s) => badge(t, s.risk, t[LEVEL[s.risk]] ?? t.muted);
const kbd = (t, k) => div().px(5).min_w(18).h(18).flex().items_center().justify_center().rounded(4).border_1().border_color(t.border).bg(t.raised)
  .text_size(11).text_color(t.foreground).child(k);
// A button drawn inside the virtual list (no handler there: onItem places the click by x).
const button = (t, label, border, color) => div().w(BTN).h(28).flex_none().flex().items_center().justify_center().rounded(6).border_1()
  .border_color(border).bg(t.background).text_size(12.5).text_color(color).child(label);
// The model picker (shared "review.model": the AI analysis, Sonnet by default).
export const modelPills = (t, id) => h_flex().gap(4).children(Object.entries(MODELS).map(([k, v]) =>
  pill(`${id}-${k}`, t, v.label, () => setShared("review.model", k), model() === k)));

// What goes into and out of a changed function (review.py "flows"): signature, In and Out examples, side effects.
// onJump(event, cx): the function name was clicked.
export function flowCard(f, t, id, onJump) {
  const mono = settings().font_family ?? "JetBrains Mono";
  const code = (text) => v_flex().p(8).rounded(6).bg(t.background).font_family(mono).text_size(12).text_color(t.foreground)
    .children(String(text ?? "").split("\n").slice(0, 14).map((l) => div().child(l.replace(/^ +/, (m) => " ".repeat(m.length)) || " ")));
  const block = (label, parts) => v_flex().gap(4)
    .child(h_flex().gap(6).items_center().text_size(11.5).text_color(t.muted).child(div().font_semibold().child(label)).child(div().child("example")))
    .children(parts.map(([head, ex], k) => v_flex().id(`${id}-${label}-${k}`).gap(2)
      .child(div().font_family(mono).text_size(12).text_color(t.accent).child(head)).child(code(ex))));
  return v_flex().id(id).flex_none().mt(4).p(10).gap(8).rounded(8).border_1().border_color(t.border).bg(t.surface).text_size(13)
    .child(h_flex().gap(8).items_center()
      .child(div().id(`${id}-fn`).font_family(mono).font_semibold().text_color(t.accent).when(Boolean(onJump), (e) => e.cursor_pointer().on_click(onJump))
        .child(`${f.function}(${(f.inputs ?? []).map((i) => i.name).join(", ")})`))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(f.at ?? "")))
    .when((f.inputs ?? []).length > 0, (e) => e.child(block("In", f.inputs.map((i) => [`${i.name}: ${i.type}`, i.example]))))
    .when(Boolean(f.output), (e) => e.child(block("Out", [[f.output.type, f.output.example]])))
    .when((f.side_effects ?? []).length > 0, (e) => e.child(h_flex().flex_wrap().gap(4).children(f.side_effects.map((x) =>
      div().px(6).py(1).rounded(5).bg(t.raised).text_size(11.5).text_color(t.foreground).child(x)))))
    .when((f.calls ?? []).length > 0, (e) => e.child(div().text_size(11.5).text_color(t.muted).child(`calls: ${f.calls.join(", ")}`)));
}

// Markdown markers dropped where a line is drawn as plain text (list rows).
const plain = (s) => String(s ?? "").replace(/`([^`]*)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1");
const ago = (iso) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return !Number.isFinite(m) ? "" : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };


export const ReviewMode = {
  initReview(cx) {
    this.tab = "files"; this.cur = 0; this.focusHunk = null; this.fsel = null; this.sug = null;
    this.ai = null; this.aiBusy = false; this.aiError = null; this.aiModel = null;
    this.prog = { visited: new Set(), checked: {}, handled: {}, seen: new Set() };
    this.full = {}; this.gaps = {}; this.whole = new Set(); this.collapsed = new Set(); this.closedDirs = new Set();
    // Handles are made here only: creating one later (in a task) throws, which broke the definition view.
    this.lists = { steps: VirtualListScrollHandle.new(), files: VirtualListScrollHandle.new(), def: VirtualListScrollHandle.new() };
    this.order = "reading"; this.flowSel = null;
    this.page = "overview"; this.archMode = "diff"; this.fold = { summary: true, blockers: true, checks: false }; this.blastOpen = false;
    this.ctx = null; this.since = null; this.sinceOn = false; this.lastReviewed = null; this.verifyBusy = false;
    this.find = { list: [], runs: {}, status: {}, reports: {} }; this.ffilter = { reviewer: "all", severity: "all", status: "open" };
    // Reviewer runs and the fixing agent's reports land in pr-data/findings: follow that folder.
    cx.spawn(async (cx) => {
      await exec("mkdir", ["-p", findDir()]).catch(() => null);
      for (;;) { await watchFolder(findDir()).catch(() => null); await this.loadFindings(cx); }
    });
    this.press = { x: 0, w: 0, shift: false }; this.items = []; this.at = {};
    this.prSel = shared("review.target") ?? null;
    cx.spawn(async (cx) => { this.cfg = await readConfig(); await loadSetup(this, cx); });
    this.refresh(cx);
    this.fh.focus();
    cx.timer.after(400, () => this.fh.focus());
    // Commands for keys.json ("pr-review.files") and scripts (herdr-app do pr-review.step:2).
    cx.spawn(async (cx) => { for (;;) { const c = await nextCommand(); this.command(String(c), cx); cx.notify(); } });
  },

  command(c, cx) {
    const [name, ...rest] = c.split(":"), arg = rest.join(":");
    if (name === "steps" || name === "files" || name === "findings") this.tab = name;
    else if (name === "def") this.defineAt(arg, cx);
    else if (name === "page") { this.tab = "steps"; this.page = PAGES.some(([k]) => k === arg) ? arg : "overview"; }
    else if (name === "verify") this.runVerify(cx);
    else if (name === "step") this.goStep(arg === "next" ? this.cur + 1 : arg === "prev" ? this.cur - 1 : Number(arg), cx);
    else if (name === "hunk") this.goHunk(arg === "prev" ? -1 : 1, cx);
    else if (name === "file") { this.tab = "files"; this.collapsed.delete(arg); this.scrollTo("files", arg); }
    else if (name === "whole") { this.tab = "files"; this.toggleWhole(arg, cx); this.scrollTo("files", arg); }
    else if (name === "gap") { const [path, k] = arg.split("#"); this.tab = "files"; this.expand(path, Number(k), "all", cx); }
    else if (name === "analyze") this.loadAi(cx, "run");
    else if (name === "cancel") this.cancelAi(cx);
    else if (name === "reviewer") this.runReviewer(arg, cx);
    else if (name === "done") { this.registerReview(cx, { status: "done", doneAt: Date.now() }); this.note = "Marked done: it leaves the open reviews"; }
    else if (name === "findings") this.tab = "findings";
    else if (name === "back") leave();
    else if (name === "open") {
      cx.spawn(async () => {
        const prs = JSON.parse(await readTextFile(`${appHome()}/pr-data/prs.json`).catch(() => null) ?? "{}").prs ?? [];
        const pr = prs.find((p) => p.url === arg) ?? (shared("pr.picked") ?? {})[arg];
        if (pr) setShared("review.target", pr);
      });
    }
  },

  resetReview() {
    this.reviewKey = null; this.ai = null; this.aiError = null; this.aiModel = null; this.cur = 0; this.focusHunk = null; this.fsel = null; this.sug = null;
    this.full = {}; this.gaps = {}; this.whole = new Set(); this.collapsed = new Set(); this.hunks = null;
    this.ctx = null; this.since = null; this.sinceOn = false; this.lastReviewed = null; this.page = "overview"; this.aiFile = null; this.needClone = null;
  },

  // A new diff: its hunks, progress and the cached analysis, if any.
  async onSource(cx) {
    const url = this.prSel?.url;
    if (!url || !this.patch) return;
    this.hunks = hunksOf(this.patch).map((h) => ({ ...h, rows: diffRows(h.lines) }));
    this.byId = new Map(this.hunks.map((h) => [h.id, h]));
    this.fileHunks = new Map();
    for (const h of this.hunks) this.fileHunks.set(h.path, [...(this.fileHunks.get(h.path) ?? []), h]);
    const p = JSON.parse(await readTextFile(progressFile()).catch(() => null) ?? "{}")[url] ?? {};
    this.prog = { visited: new Set(p.visited ?? []), checked: p.checked ?? {}, handled: p.handled ?? {}, seen: new Set(p.seen ?? []) };
    this.collapsed = new Set(this.prog.seen);
    const back = resumeFields(p.ui);
    if (back) { // resume: where you were
      Object.assign(this, back.fields);
      if (back.model && back.model !== shared("review.model")) setShared("review.model", back.model);
      if (back.values !== undefined && back.values !== valuesOn()) setShared("review.values", back.values);
      this.pendingScroll = back.scroll;
    }
    this.uiSaved = JSON.stringify(this.uiState());
    this.head = this.prSel.headSha ?? null; // from prs.json (prs.py) or the branch's gh pr view; else asked when a file is opened
    // Since your last review: the mark before this visit (registerReview moves it to this head as "seen" afterwards).
    const reg = JSON.parse(await readTextFile(openFile()).catch(() => null) ?? "[]").find((r) => r.url === url);
    this.lastReviewed = reg?.reviewed ?? null;
    this.makeWorktree(cx);
    this.loadAi(cx, "cache"); // never runs by itself: Analyze is a click
    await this.loadFindings(cx);
    this.registerReview(cx); // opened: an open review from now on
    cx.notify();
  },

  // The PR head as files (worktree.py: a detached worktree of a dedicated clone under the clone root), for reviewers,
  // whole files and the LSP bridge: shared("review.worktree") = {url, head, path}. The current branch: its repo root.
  // clone: the "Clone to …" click; never otherwise (worktree.py exits 3 with the folder it would use).
  makeWorktree(cx, clone = false) {
    const url = this.prSel.url;
    this.worktree = null;
    if (this.prSel.space && this.root) {
      this.worktree = { url, head: this.head, path: this.root, local: true }; setShared("review.worktree", this.worktree); warm(this.root, (this.patch ?? []).map((f) => f.path));
      this.loadSince(cx); this.loadContext(cx); return;
    }
    // A PR you didn't open may use the active space's checkout of its repo (cwd); your own PRs keep the dedicated clones.
    const local = this.prSel.source && this.root ? ["--local", this.root] : [];
    this.cloning = clone;
    cx.spawn(async (cx) => {
      const roots = C.cloneRoots(ctxDoc(), this.ctxId(), this.cfg?.cloneRoot ?? "~/code").flatMap((d) => ["--root", d.replace(/^~(?=\/|$)/, home())]);
      const env = this.ctxEnv(this.ctxId()), argv = [...env, "python3", `${appHome()}/mods/pr-review/worktree.py`, url, ...roots, ...local, ...(clone ? ["--clone"] : [])];
      const r = await exec(argv[0], argv.slice(1), { timeout: 600000 })
        .catch((e) => ({ code: 1, stderr: String(e) }));
      this.cloning = false;
      if (this.prSel?.url !== url) return;
      if (r.code === 3) { this.needClone = JSON.parse(r.stdout).need_clone; this.loadContext(cx); cx.notify(); return; }
      this.needClone = null;
      if (r.code !== 0) { this.note = `Could not check out the PR head: ${r.stderr.trim().slice(0, 200)}`; cx.notify(); return; }
      const w = JSON.parse(r.stdout);
      this.head ??= w.head;
      this.worktree = { url, head: w.head, path: w.path };
      setShared("review.worktree", this.worktree);
      warm(w.path, (this.patch ?? []).map((f) => f.path)); // Java needs ~25 s cold
      if (this.pendingRun) { this.pendingRun = false; this.loadAi(cx, "run"); }
      this.loadSince(cx); this.loadContext(cx);
      cx.notify();
    });
  },

  // What changed since the head you last reviewed (worktree.py since: git in the checkout, no LLM). The Files tab
  // shows only that while "Since last review" is on.
  loadSince(cx) {
    const url = this.prSel?.url, w = this.worktree, base = sinceBase({ reviewed: this.lastReviewed }, w?.head ?? this.head);
    if (!w || !base) return;
    cx.spawn(async (cx) => {
      const r = await exec("python3", [`${appHome()}/mods/pr-review/worktree.py`, "since", w.path, base.sha, w.head ?? this.head, ...(this.patch ?? []).flatMap((f) => [f.path, ...(f.from ? [f.from] : [])])], { timeout: 400000 })
        .catch((e) => ({ code: 1, stderr: String(e) }));
      if (this.prSel?.url !== url) return;
      const d = r.code === 0 ? JSON.parse(r.stdout) : { mode: "full", patch: "", note: `Could not diff: ${r.stderr.trim().slice(0, 160)}` };
      const files = splitPatch(d.patch || ""), hunks = hunksOf(files).map((h) => ({ ...h, rows: diffRows(h.lines) })), fileHunks = new Map();
      for (const h of hunks) fileHunks.set(h.path, [...(fileHunks.get(h.path) ?? []), h]);
      this.since = { base, head: w.head ?? this.head, mode: d.mode, note: d.note, files: d.patch ? files : [], hunks, fileHunks };
      this.sinceOn = files.length > 0 && d.mode !== "full"; // start on the new changes; the banner switches back
      this.gaps = {};
      cx.notify();
    });
  },

  // Related PRs, CI checks and mergeability (related.py: gh and git, no LLM), cached per PR head in pr-data/cache.
  loadContext(cx) {
    const url = this.prSel?.url, head = this.worktree?.head ?? this.head;
    if (!url?.startsWith("https://") || !head) return;
    const out = `${cacheDir()}/ctx-${hash(url)}-${head}.json`;
    cx.spawn(async (cx) => {
      const before = JSON.parse(await readTextFile(out).catch(() => null) ?? "null");
      if (this.prSel?.url !== url) return;
      if (before) { this.ctx = before; this.publish(); cx.notify(); }
      if (before && Date.now() - Date.parse(before.at) < CTX_MS) return;
      const req = { url, head, base: this.prSel.base ?? "main", worktree: this.worktree?.path ?? null, files: (this.patch ?? []).map((f) => f.path).filter((f) => !lowValue(f)), out }; // lockfiles would relate everything
      const r = await exec("python3", [`${appHome()}/mods/pr-review/related.py`, JSON.stringify(req)], { timeout: 400000 }).catch(() => null);
      if (this.prSel?.url !== url || r?.code !== 0) return;
      this.ctx = JSON.parse(r.stdout);
      exec("python3", [`${appHome()}/mods/pr-review/prs.py`, "--prune"]).catch(() => null); // bounds the cache folder
      this.publish(); cx.notify();
    });
  },

  // Progress and where you were (tab, file, hunk, step, order, selection, model, values) for resuming; the oldest
  // PRs beyond MAX_PROGRESS go.
  saveProgress(cx) {
    const url = this.prSel?.url, p = this.prog;
    if (!url) return;
    const value = { visited: [...p.visited], checked: p.checked, handled: p.handled, seen: [...p.seen], ui: this.uiState(), at: Date.now() };
    cx.spawn(async (cx) => {
      try {
        for (let attempt = 0; ; attempt++) {
          const before = await readTextFile(progressFile()).catch(() => null), doc = before ? JSON.parse(before) : {};
          doc[url] = value;
          for (const k of Object.keys(doc).sort((a, b) => (doc[b].at ?? 0) - (doc[a].at ?? 0)).slice(MAX_PROGRESS)) delete doc[k];
          try { await writeTextFile(progressFile(), JSON.stringify(doc, null, 1), before); break; } catch (e) { if (attempt) throw e; }
        }
      } catch (e) { this.note = `Could not save progress: ${e}`; cx.notify(); }
    });
    this.registerReview(cx);
  },

  uiState() {
    return { tab: this.tab, fileFocus: this.fileFocus ?? null, focusHunk: this.focusHunk ?? null, cur: this.cur, order: this.order,
      fsel: this.fsel ?? null, page: this.page ?? null, model: model(), values: valuesOn() };
  },

  // Saves where you are a second after it last changed (render calls this; no timer runs while nothing changes).
  uiChanged(cx) {
    const now = JSON.stringify(this.uiState());
    if (now === this.uiSaved || !this.hunks) return;
    this.uiSaved = now;
    const gen = (this.uiGen = (this.uiGen ?? 0) + 1);
    cx.timer.after(1000, (cx) => { if (this.uiGen === gen) this.saveProgress(cx); });
  },

  progressNow() {
    const steps = this.ai?.steps ?? [];
    return { steps: steps.length, stepsChecked: steps.filter((s) => this.done(s)).length, files: this.patch?.length ?? 0, filesViewed: this.prog.seen.size,
      comments: this.comments.length, findingsOpen: this.find.list.filter((f) => ["open", "progress", "recheck"].includes(this.fstatus(f))).length };
  },

  // This PR in pr-data/open-reviews.json (and shared "review.open"), 1.5 s after the last change: opened, worked on,
  // sent, done. Merged/closed PRs turn done, old done/sent entries go (pr.js expireReviews).
  registerReview(cx, extra = {}) {
    const pr = this.prSel;
    if (!pr?.url || !this.hunks) return;
    this.regExtra = { ...this.regExtra, ...extra };
    if (extra.status === "sent" || extra.status === "done") { this.since = null; this.sinceOn = false; } // reviewed up to this head now
    const gen = (this.regGen = (this.regGen ?? 0) + 1);
    cx.timer.after(1500, (cx) => cx.spawn(async (cx) => {
      if (this.regGen !== gen || this.prSel?.url !== pr.url) return;
      const entry = { url: pr.url, number: pr.number, repo: pr.repo, title: pr.title ?? this.pr?.title, context: this.ctxId(), headSha: this.head,
        progress: this.progressNow(), target: pr, triage: this.triageNow(), ...this.regExtra };
      const how = this.regExtra.status === "sent" || this.regExtra.status === "done" ? this.regExtra.status : "seen";
      this.regExtra = {};
      const prs = JSON.parse(await readTextFile(`${appHome()}/pr-data/prs.json`).catch(() => null) ?? "{}").prs ?? [];
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = await readTextFile(openFile()).catch(() => null);
        entry.reviewed = markReviewed((before ? JSON.parse(before) : []).find((r) => r.url === pr.url)?.reviewed, this.worktree?.head ?? this.head, how, Date.now());
        const list = expireReviews(touchReview(before ? JSON.parse(before) : [], entry, Date.now()), prs, Date.now());
        try {
          await writeTextFile(openFile(), JSON.stringify(list, null, 1), before);
          setShared("review.open", list.filter((r) => r.status !== "done"));
          setShared("review.registry", { at: Date.now(), touched: entry.url, entries: list }); // already debounced (1.5 s)
          return;
        } catch { /* written meanwhile: again */ }
      }
    }));
  },

  // ---- the AI analysis (review.py), cached per hunk set and model

  // mode: "cache" shows what is there (exact, else this PR's last one for the model) and follows a run still going;
  // "run" (a click) starts review.py detached: it may take 15 minutes, longer than exec waits. Its status file says
  // busy/done/error; a gentle poll (5 s) follows it while it runs.
  // incremental (a click on "Only new changes"): sends only the changes since your last review plus the shown analysis;
  // review.py merges the new layers into it and saves the result for today's whole diff.
  loadAi(cx, mode, incremental = false) {
    const m = model(), url = this.prSel?.url;
    this.aiModel = m;
    if (!url || !this.patch) return;
    const job = reviewRequest({ url, pr: url.startsWith("https://") ? url : null, worktree: this.worktree?.path ?? null, files: this.patch, model: m, context: this.ctxReq(), dir: cacheDir() });
    if (mode === "run") {
      if (this.aiBusy) return;
      if (!job.req.hunks.length) { this.aiError = "No diff"; return cx.notify(); }
      if (!this.worktree && !this.prSel.space) { this.pendingRun = true; this.note = "Analysis starts once the PR head is checked out…"; return cx.notify(); }
      let req = job.req;
      if (incremental) {
        if (!this.since?.files.length || !this.aiFile) return;
        const inc = reviewRequest({ url, files: this.since.files, model: m, context: this.ctxReq(), dir: cacheDir() }).req, n = (a) => a.replace(/^h/, "n");
        req = { ...job.req, hunks: inc.hunks.map((h) => ({ ...h, alias: n(h.alias) })), cut: inc.cut.map(n), previous: this.aiFile,
          since: { base: this.since.base.sha, head: this.since.head }, full: job.hunks.map((h) => ({ alias: h.alias, id: h.id, path: h.path, head: h.lines[0] })) };
      }
      this.aiError = null; this.aiBusy = { model: m, started: Date.now(), status: job.status, incremental };
      exec("sh", ["-c", 'nohup python3 "$0" "$1" >/dev/null 2>&1 &', `${appHome()}/mods/pr-review/review.py`, JSON.stringify(req)])
        .catch((e) => { this.aiError = String(e); this.aiBusy = false; cx.notify(); });
      this.publish(); this.pollAi(cx, job, url, m);
      return cx.notify();
    }
    cx.spawn(async (cx) => {
      const [text, fallback, st] = await Promise.all([readTextFile(job.out).catch(() => null), readTextFile(job.latest).catch(() => null), readTextFile(job.status).catch(() => null)]);
      if (this.prSel?.url !== url || model() !== m) return;
      const status = st ? JSON.parse(st) : null;
      this.ai = text || fallback ? this.mapSaved(JSON.parse(text ?? fallback), Boolean(text)) : null;
      this.aiFile = text ? job.out : fallback ? job.latest : null;
      if (status?.busy && Date.now() - Date.parse(status.started) < 20 * 60000) { // a run started earlier, maybe from another copy
        this.aiBusy = { model: m, started: Date.parse(status.started), status: job.status, pid: status.pid };
        this.pollAi(cx, job, url, m);
      }
      if (this.ai && !this.focusHunk) this.goStep(0, cx, false);
      this.publish(); cx.notify();
    });
  },

  pollAi(cx, job, url, m) {
    cx.timer.after(5000, (cx) => cx.spawn(async (cx) => {
      if (this.prSel?.url !== url || !this.aiBusy) return;
      const st = JSON.parse(await readTextFile(job.status).catch(() => null) ?? "null");
      if (st?.busy || !st) { if (st?.pid) this.aiBusy.pid = st.pid; cx.notify(); return this.pollAi(cx, job, url, m); }
      this.aiBusy = false;
      if (st.error) this.aiError = st.error;
      else {
        const text = await readTextFile(job.out).catch(() => null);
        if (text && model() === m) { this.ai = this.mapSaved(JSON.parse(text), true); this.aiFile = job.out; this.goStep(0, cx, false); }
      }
      this.publish(); cx.notify();
    }));
  },

  cancelAi(cx) {
    const b = this.aiBusy;
    if (!b) return;
    this.aiBusy = false; this.aiError = "Cancelled";
    cx.spawn(async (cx) => {
      if (b.pid) await exec("sh", ["-c", 'pkill -P "$0"; kill "$0"', String(b.pid)]).catch(() => null); // review.py and its claude
      const before = await readTextFile(b.status).catch(() => null);
      await writeTextFile(b.status, JSON.stringify({ error: "Cancelled" }), before).catch(() => null);
      this.publish(); cx.notify();
    });
  },

  // A saved analysis on today's diff: hunks by id (gone ones make a step "veraltet"), plus the hunks no step covers.
  mapSaved(saved, exact) {
    const hs = saved.hunks.map((h) => ({ ...h, ...(this.byId.get(h.id) ?? {}) }));
    const r = mapReview(saved.answer, hs), covered = new Set(r.steps.flatMap((s) => s.hunks));
    const cut = new Set(exact ? saved.cut : []), left = this.hunks.filter((h) => !covered.has(h.id));
    const extra = (title, why, list) => (list.length ? [{ title, why, text: "", risk: "low", order: 9999, questions: [], flows: [], hunks: list.map((h) => h.id), pseudo: true }] : []);
    r.steps.push(...extra(`Not analyzed (${left.filter((h) => cut.has(h.alias)).length} hunks)`, "Too large for the model: read these yourself.", left.filter((h) => cut.has(h.alias))),
      ...extra(`In no step (${left.filter((h) => !cut.has(h.alias)).length} hunks)`, exact ? "The model put these hunks in no step." : "New since the analysis.", left.filter((h) => !cut.has(h.alias))));
    for (const s of r.steps) s.stale = s.hunks.length > 0 && !s.hunks.some((id) => this.byId.has(id));
    return { ...r, exact, cost: saved.cost, ms: saved.ms, budget: saved.budget, model: saved.model, model_id: saved.model_id, generated: saved.generated, cut: saved.cut ?? [], task: saved.task ?? {},
      incremental: saved.incremental ?? null };
  },

  // What the bar shows: the analysis on screen, or the one running.
  publish() {
    const a = this.ai;
    setShared("review.meta", { url: this.prSel?.url ?? null, model: this.aiModel, busy: this.aiBusy?.model ?? null, error: this.aiError,
      shown: a ? { model: a.model, model_id: a.model_id, cost: a.cost, exact: a.exact, mergeRisk: a.mergeRisk, effort: a.effort } : null,
      checks: this.prSel ? this.checksNow().reduce((n, c) => ({ ok: n.ok + (c.ok === true), fail: n.fail + (c.ok === false) }), { ok: 0, fail: 0 }) : null });
  },

  // The AI steps in risk order or in reading order (the toggle); without an analysis one step with every hunk.
  steps() {
    const all = this.ai?.steps ?? (this.hunks?.length ? [{ title: "All changes", why: "No analysis yet.", text: "", risk: "low", order: 1, questions: [], flows: [], hunks: this.hunks.map((h) => h.id), pseudo: true }] : []);
    return this.order === "reading" ? [...all].sort((a, b) => a.order - b.order) : all;
  },
  present(s) { return s.hunks.filter((id) => this.byId?.has(id)); },
  done(s) {
    const k = stepKey(s);
    return k in this.prog.checked ? this.prog.checked[k] : this.present(s).length > 0 && this.present(s).every((id) => this.prog.visited.has(id));
  },
  openSugs(path) { return (this.ai?.suspects ?? []).filter((s) => (!path || s.path === path) && !this.prog.handled[s.key]); },

  // ---- reviewer findings (reviewers.py): pr-data/findings/<url hash>.json, the agent's reports in .jsonl

  async loadFindings(cx) {
    const url = this.prSel?.url;
    if (!url) return;
    const base = `${findDir()}/${hash(url)}`;
    const [doc, rep] = await Promise.all([readTextFile(`${base}.json`).catch(() => null), readTextFile(`${base}.jsonl`).catch(() => null)]);
    if (this.prSel?.url !== url) return;
    const d = doc ? JSON.parse(doc) : {};
    this.find = { ...this.find, list: d.findings ?? [], runs: d.runs ?? {}, status: d.status ?? {}, reports: parseReports(rep) };
    for (const r of Object.values(this.find.runs)) if (r.busy && Date.now() - Date.parse(r.started) > 30 * 60000) { r.busy = false; r.error = "Stopped without a result"; }
    setShared("review.reviewers", this.find.runs);
    cx.notify();
  },

  runReviewer(kind, cx) {
    const pr = this.prSel, w = this.worktree;
    if (!reviewersNow().some(([k]) => k === kind) || !pr?.url) return;
    if (!w || w.local) { this.note = !w ? "Could not run: the PR head is not checked out yet" : "Could not run: reviewers need a PR (not a branch diff)"; return cx.notify(); }
    const req = { kind, url: pr.url, number: pr.number, context: this.ctxReq(), model: model(), worktree: w.path, base: pr.base ?? "main",
      head: w.head, level: "medium", file: `${findDir()}/${hash(pr.url)}.json` };
    this.find.runs[kind] = { busy: true, started: new Date().toISOString() };
    setShared("review.reviewers", { ...this.find.runs });
    exec("sh", ["-c", 'nohup python3 "$0" "$1" >/dev/null 2>&1 &', `${appHome()}/mods/pr-review/reviewers.py`, JSON.stringify(req)])
      .catch((e) => { this.note = `Could not start ${REVIEWERS[kind][0]}: ${e}`; cx.notify(); });
    cx.notify();
  },

  // A finding's line in the diff's rows (hunks plus opened context), or -1: then it is "outside the diff".
  findRow(f) { return this.rowsFor(f.file, true).findIndex((r) => atLine(r, f.line, false)); },
  fstatus(f) {
    const rows = this.rowsFor(f.file, true), r = rows.find((x) => atLine(x, f.line, false));
    return findingStatus(f, this.find.status, this.find.reports, this.head, r?.text);
  },
  // The findings the filters let through (status "open" includes recheck and in progress).
  shownFindings() {
    const { reviewer, severity, status } = this.ffilter;
    return this.find.list.filter((f) => (reviewer === "all" || f.reviewer === reviewer) && (severity === "all" || f.severity === severity)
      && (status === "all" || (status === "open" ? ["open", "progress", "recheck"].includes(this.fstatus(f)) : this.fstatus(f) === status)));
  },

  // A status set by hand drops an earlier verification; extra: {fixHead} when it goes to Fix.
  setFinding(f, st, cx, extra = {}) {
    const at = new Date().toISOString();
    this.writeStatus(cx, (status) => ({ ...status, [f.id]: { ...status[f.id], s: st, at, verify: undefined, ...extra } }));
  },

  // The findings' status map changed by fn, here and in the file (compare-and-swap against reviewers.py writing it).
  writeStatus(cx, fn) {
    const file = `${findDir()}/${hash(this.prSel.url)}.json`;
    this.find.status = fn(this.find.status);
    cx.spawn(async (cx) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = await readTextFile(file).catch(() => null), doc = before ? JSON.parse(before) : {};
        doc.status = fn(doc.status ?? {});
        try { await writeTextFile(file, JSON.stringify(doc, null, 1), before); return; } catch { /* changed meanwhile: again */ }
      }
      this.note = "Could not save the finding's status"; cx.notify();
    });
    cx.notify();
  },

  headNow() { return this.worktree?.head ?? this.head; },
  verifyList() { return verifyCandidates(this.find.list, this.find.status, this.headNow(), (f) => this.fstatus(f)); },

  // "Verify fixes (N)" (a click): one call (verify.py, "PR fix verification") in the PR's context with the review's
  // model; fixed → ✓, not fixed → open again with the reason, unclear → as it was with the note.
  runVerify(cx) {
    const list = this.verifyList(), head = this.headNow(), w = this.worktree, url = this.prSel?.url;
    if (!list.length || this.verifyBusy) return;
    if (!w) { this.note = "Could not verify: the PR head is not checked out yet"; return cx.notify(); }
    this.verifyBusy = { started: Date.now(), n: list.length };
    const req = { context: this.ctxReq(), model: model(), worktree: w.path, head,
      items: list.map((f) => ({ id: f.id, file: f.file, line: f.line, title: f.title, detail: f.detail, suggestion: f.suggestion, since: this.find.status[f.id].fixHead })) };
    cx.spawn(async (cx) => {
      const r = await exec("python3", [`${appHome()}/mods/pr-review/verify.py`, JSON.stringify(req)], { timeout: 600000 }).catch((e) => ({ code: 1, stderr: String(e) }));
      this.verifyBusy = false;
      if (this.prSel?.url !== url) return;
      if (r.code !== 0) { this.note = `Could not verify: ${r.stderr.trim().slice(0, 200)}`; return cx.notify(); }
      const { results, cost } = JSON.parse(r.stdout);
      this.writeStatus(cx, (st) => applyVerification(st, results, head, Date.now()));
      const n = (v) => results.filter((x) => x.verdict === v).length;
      this.note = `Verified ${results.length}: ${n("fixed")} fixed, ${n("not_fixed")} not fixed, ${n("unclear")} unclear${cost != null ? ` · $${Number(cost).toFixed(3)}` : ""}`;
      cx.notify();
    });
    cx.notify();
  },

  findingText(f) {
    const rows = this.rowsFor(f.file), i = rows.findIndex((r) => atLine(r, f.line, false));
    const code = i >= 0 ? selection(rows, i, rows.findIndex((r) => atLine(r, f.end ?? f.line, false)) >= 0 ? rows.findIndex((r) => atLine(r, f.end ?? f.line, false)) : i).hunk : f.code;
    return `${REVIEWERS[f.reviewer]?.[0] ?? f.reviewer} (${f.severity}): \`${f.file}\`:${f.line} — ${f.title}\n\n${f.detail}${f.suggestion ? `\n\nSuggested: ${f.suggestion}` : ""}\n\n\`\`\`\n${code ?? ""}\n\`\`\`\n\n`;
  },

  findingComment(f, cx) {
    const rows = this.rowsFor(f.file), i = rows.findIndex((r) => atLine(r, f.line, false));
    const anchor = i >= 0 ? selection(rows, i) : { start: f.line, end: f.line, old: false, hunk: f.code };
    this.comments = [...this.comments, { id: Date.now().toString(36), file: f.file, ...anchor, text: `${f.title}: ${f.detail}${f.suggestion ? ` Suggested: ${f.suggestion}` : ""}`, from: f.reviewer }];
    this.persist(cx); this.note = "Added to the pending review"; cx.notify();
  },

  // Opens the PR's agent in a floating window over the review and pastes the finding there without sending it. With
  // the chatbar mod present (shared "chatbar.api"), its bubble takes the draft instead (PROVIDERS.md, chatbar.request).
  // ponytail: goes through the clipboard (hc send always presses Enter), so the clipboard holds the prompt after.
  discuss(f, cx) {
    const text = this.findingText(f), origin = this.prSel;
    const agent = origin?.session ? this.sessionAgent(origin) : this.target(origin?.space ?? null);
    cx.spawn(async (cx) => {
      if (agent && shared("chatbar.api")) { // the chat bubble drafts it; nothing is sent
        setShared("chatbar.request", { action: "draft", terminal: agent.address, text, from: "pr-review", at: Date.now() });
        this.setFinding(f, "progress", cx);
        return cx.notify();
      }
      await copyText(text);
      if (!agent) {
        if (origin?.session && origin.cwd) run("tab.new", { space: this.spaceFor(this.ctxId(), origin.cwd), folder: origin.cwd, name: `PR #${origin.number}`,
          argv: [...this.ctxEnv(origin.sessionContext ?? this.ctxId()), "claude", "--resume", origin.session] });
        this.note = origin?.session ? "No live agent: resumed the PR's session in a new tab; the finding is on the clipboard (⌘V)" : "No agent for this PR: the finding is on the clipboard";
        return cx.notify();
      }
      openOverlay({ kind: "window", key: "review-agent", width: 920, height: 620, layout: { type: "column", children: [
        { type: "block", size: { px: 34 }, content: { mod: "pr-review", props: { part: "agentbar", title: agent.tab_name || agent.title || "Agent" } } },
        { type: "block", content: { terminal: agent.address } }] } });
      cx.timer.after(450, () => { run("pane.focus", { terminal: agent.address }); run("terminal.paste"); });
      this.setFinding(f, "progress", cx);
    });
  },

  fix(list, cx) {
    if (!list.length) return;
    const report = `${findDir()}/${hash(this.prSel.url)}.jsonl`;
    this.deliver(fixPrompt(list, this.pr, report, this.lang()), cx, list.length === 1 ? "Fix" : `Fix (${list.length})`, (cx) => { for (const f of list) this.setFinding(f, "progress", cx, { fixHead: this.headNow() }); });

  },

  // ---- definitions (defs.js: language servers through lsp_bridge.py, on the PR head checkout)

  lspRoot() { return this.worktree?.path ?? (this.prSel?.space ? this.root : null); },

  define(it, r, cx) {
    const spans = this.spanMap?.get(it.src)?.spans?.[it.ri] ?? [];
    const tok = tokenAt(r, spans, this.press.x, GUTTER, this.charW ?? 7.8);
    if (!tok) { this.note = "⌘-click a name for its definition"; return cx.notify(); }
    this.lookupDef(it.path, r, tok, cx);
  },

  // The command "def:<path>:<line>:<name>": the definition of the first <name> on that new-side line, like a ⌘-click.
  defineAt(arg, cx) {
    const [path, line, name] = String(arg ?? "").split(":"), r = path && this.rowsFor(path).find((x) => atLine(x, Number(line), false));
    const character = r && name ? r.text.indexOf(name) : -1;
    if (character < 0) { this.note = `No ${name ?? "name"} on ${path}:${line}`; return cx.notify(); }
    this.tab = "files"; this.jumpTo(`${path}:${line}`, cx);
    this.lookupDef(path, r, { name, line: Number(line), character, side: "+" }, cx);
  },

  lookupDef(path, r, tok, cx) {
    const q = { root: this.lspRoot(), rev: this.worktree?.head ?? this.head ?? "", path, line: tok.line, character: tok.character, side: tok.side };
    const d = { key: `${path}:${lineKey(r)}`, name: tok.name, res: null };
    this.defAt = d;
    cx.spawn(async (cx) => {
      d.res = await lookup(q).catch((e) => ({ status: "error", message: String(e), definitions: [] }));
      // The last lookup, for debugging: what was clicked, where it was asked, what came back.
      setShared("pr.defs.last", { ...q, name: tok.name, status: d.res.status, message: d.res.message, def: d.res.definitions?.[0] ? where(d.res.definitions[0]) : null, at: new Date().toISOString() });
      if (this.defAt === d) cx.notify();
    });
    cx.notify();
  },

  // Jump to a definition: in the diff, its line; else the file at that line in a read-only view (Back or Esc returns).
  // Files beyond 6000 lines (system headers) show 6000 lines around it.
  goDef(def, cx) {
    const inDiff = def.inRoot && this.fileHunks?.has(def.path) && this.rowsFor(def.path).some((r) => atLine(r, def.line, false));
    if (inDiff) { this.defAt = null; return this.jumpTo(`${def.path}:${def.line}`, cx); }
    const root = this.lspRoot();
    cx.spawn(async (cx) => {
      const text = def.inRoot ? await readTextFile(`${root}/${def.path}`).catch(() => null) : await contents(root, def.uri).catch(() => null);
      if (text === null || text === undefined) { this.note = `Could not open ${where(def)}`; return cx.notify(); }
      const all = text.replace(/\n$/, "").split("\n"), from = Math.max(0, def.line - 3000);
      const lines = all.slice(from, from + 6000).map(expandTabs);
      this.defFile = { path: def.path, line: def.line, from, lines, spans: highlightLines(lines, langOf(def.path), `def:${def.uri ?? def.path}:${from}`) };
      this.lists.def.scroll_to_item(Math.max(0, def.line - from - 6), "top");
      cx.notify();
    });
  },

  // What a lookup that found nothing says, per status.
  defMessage(res) {
    return { none: "no definition found", starting: "the language server is starting (first use can take ~25 s): ⌘-click again in a moment",
      timeout: "the language server took too long: ⌘-click again", "no-root": "the PR head is not checked out yet", "old-side": "removed lines have no definition (new side only)" }[res.status]
      ?? res.message ?? res.status;
  },

  defItem(it, t) {
    const d = it.d, res = d.res, def = res?.definitions?.[0], c = colors(t);
    const head = !res ? `Looking up ${d.name}…` : def ? `${d.name} → ${where(def)}${res.definitions.length > 1 ? ` (+${res.definitions.length - 1})` : ""}` : `${d.name}: ${this.defMessage(res)}`;
    // The bridge sends the preview as lines (an array): splitting it as text threw and took the whole review down.
    const raw = Array.isArray(def?.preview) ? def.preview : String(def?.preview ?? "").split("\n");
    const pre = raw.slice(0, 5).map(expandTabs), spans = def ? highlightLines(pre, langOf(def.path)) : [], first = def?.previewStart ?? def?.line ?? 1;
    return div().w_full().h(this.sizeOf(it)).pl(GUTTER).pr(16).py(6).child(v_flex().size_full().px(12).py(8).gap(6).rounded(8).border_1().border_l(4)
      .border_color(t.accent).bg(t.surface).text_size(13)
      .child(h_flex().h(18).gap(8).items_center().child(div().font_semibold().child(head)).when(!res, (e) => e.child(div().child(SPIN[0]).frames(SPIN, 90))))
      .child(v_flex().flex_1().min_h(0).overflow_hidden().p(6).rounded(6).bg(t.background).font_family(settings().font_family ?? "JetBrains Mono").text_size(12.5)
        .children(pre.map((l, i) => h_flex().h(18).overflow_hidden().when(first + i === def?.line, (e) => e.bg(t.accent + "1f"))
          .child(div().w(40).flex_none().pr(8).text_right().text_color(t.muted).child(String(first + i))).children(renderLine(div, l, spans[i] ?? [], c)))))
      .child(h_flex().gap(BTN_GAP)
        .child(div().w(BTN + 40).h(26).flex().items_center().justify_center().rounded(6).border_1().border_color(def ? t.accent : t.border).text_size(12.5).text_color(def ? t.foreground : t.muted).child("Go to definition"))
        .child(div().w(BTN + 40).h(26).flex().items_center().justify_center().rounded(6).border_1().border_color(t.border).text_size(12.5).text_color(def ? t.foreground : t.muted).child("Open in VS Code"))
        .child(div().px(10).h(26).flex().items_center().text_size(12.5).text_color(t.muted).child("Close"))));
  },

  // The file behind a definition outside the diff, highlighted, read-only.
  defView(t) {
    const f = this.defFile, c = colors(t), mono = settings().font_family ?? "JetBrains Mono";
    return v_flex().flex_1().min_h(0)
      .child(h_flex().flex_none().h(40).px(12).gap(10).items_center().bg(t.raised).border_b(1).border_color(t.border).text_size(13)
        .child(pill("rv-def-back", t, "← Back to the diff", (_e, cx) => { this.defFile = null; cx.notify(); }))
        .child(div().flex_1().min_w(0).truncate().font_family(mono).font_semibold().child(`${f.path}:${f.line}`)))
      .child(div().flex_1().min_h(0).relative()
        .child(v_virtual_list("rv-def-list", f.lines.length, ROW, (i) => String(i), (range) => f.lines.slice(range.start, range.end).map((l, k) => {
          const i = range.start + k;
          return h_flex().h(ROW).w_full().font_family(mono).text_size(13).when(f.from + i + 1 === f.line, (e) => e.bg(t.accent + "26"))
            .child(div().w(56).flex_none().pr(10).text_right().text_color(t.muted).child(String(f.from + i + 1)))
            .child(h_flex().flex_1().min_w(0).overflow_hidden().children(renderLine(div, l, f.spans[i] ?? [], c)));
        })).track_scroll(this.lists.def).size_full())
        .child(Scrollbar.vertical("rv-def-list").absolute().inset_0()));
  },

  // ---- navigation

  visit(id, cx) {
    this.focusHunk = id;
    if (id && !this.prog.visited.has(id)) { this.prog.visited.add(id); this.saveProgress(cx); }
  },

  itemsOf(view) { return view === "steps" ? this.stepsItems() : this.filesItems(); }, // the Findings tab shows the Files list

  scrollTo(view, key) {
    const { at } = this.itemsOf(view);
    if (at[key] !== undefined) this.lists[view].scroll_to_item(at[key], "top");
  },

  // A flow's "path:line" to the hunk that holds it (in the AI list, else the Files view).
  jumpTo(at, cx) {
    const [, path, line] = /^(.*?):(\d+)/.exec(at ?? "") ?? [];
    const h = (this.hunks ?? []).find((x) => path && (x.path === path || x.path.endsWith(`/${path}`)) && x.rows.some((r) => r.n === Number(line)))
      ?? (this.hunks ?? []).find((x) => path && (x.path === path || x.path.endsWith(`/${path}`)));
    if (!h) { this.note = `Could not find ${at} in the diff`; return cx.notify(); }
    this.visit(h.id, cx); this.page = null; // from a Layers page: show the diff
    const view = this.tab === "steps" && this.itemsOf("steps").at[h.id] !== undefined ? "steps" : "files";
    if (view === "files") { if (this.tab !== "findings") this.tab = "files"; this.collapsed.delete(h.path); this.sinceOn = false; } // the whole PR has every hunk
    const k = `+${line}`, { items } = this.itemsOf(view), row = items.findIndex((x) => x.t === "row" && x.path === h.path && lineKey(x.src[x.ri]) === k);
    if (line && row >= 0) { this.fsel = { path: h.path, a: k, b: k }; this.lists[view].scroll_to_item(Math.max(0, row - 3), "top"); }
    else this.scrollTo(view, h.id);
    cx.notify();
  },

  goStep(i, cx, scroll = true) {
    const steps = this.steps();
    if (!steps.length) return;
    this.cur = Math.max(0, Math.min(i, steps.length - 1));
    this.visit(this.present(steps[this.cur])[0] ?? null, cx);
    this.fsel = null; this.sug = null;
    if (scroll) { this.tab = "steps"; this.page = null; this.scrollTo("steps", `s${this.cur}`); }
  },

  // n/p: the next hunk of the step (Layers) or of the whole diff (Files).
  goHunk(dir, cx) {
    const list = this.tab === "steps" ? this.present(this.steps()[this.cur] ?? { hunks: [] }) : this.shown().hunks.map((h) => h.id);
    const id = list[list.indexOf(this.focusHunk) + dir] ?? (list.includes(this.focusHunk) ? null : list[0]);
    if (!id) return;
    if (this.tab === "files") this.collapsed.delete((this.byId.get(id) ?? this.shown().hunks.find((h) => h.id === id))?.path);
    this.visit(id, cx); this.fsel = null; this.sug = this.openSugs().find((s) => s.hunk === id)?.key ?? null;
    this.scrollTo(this.tab, id);
  },

  goFile(dir) {
    const paths = this.shown().patch.map((f) => f.path);
    const path = paths[paths.indexOf(this.fileFocus) + dir] ?? paths[0];
    if (path) { this.fileFocus = path; this.scrollTo("files", path); }
  },

  // ---- the diff as list items (one virtual list per tab)

  pushRows(items, at, rows, path, hunkOf) {
    const sugs = this.openSugs(path), cms = this.comments.filter((c) => c.file === path), used = new Set();
    const finds = this.find.list.filter((f) => f.file === path && ["open", "progress", "recheck"].includes(this.fstatus(f)));
    rows.forEach((r, ri) => {
      if (r.kind === "gap") { items.push({ t: "gap", path, r }); return; }
      const hunk = hunkOf(r);
      if (hunk && at[hunk] === undefined) at[hunk] = items.length;
      items.push({ t: "row", path, src: rows, ri, hunk });
      if (r.number === undefined) return;
      if (this.defAt && this.defAt.key === `${path}:${lineKey(r)}`) items.push({ t: "def", d: this.defAt });
      for (const s of sugs) if (atLine(r, s.line, s.old)) items.push({ t: "sug", s }, { t: "sugact", s });
      for (const c of cms) if (atLine(r, c.end, c.old)) { used.add(c); items.push({ t: "comment", c }, { t: "cact", c }); }
      if (r.kind !== "-") for (const f of finds) if (f.line === r.number) items.push({ t: "find", f }, { t: "fact", f });
    });
    return cms.filter((c) => !used.has(c));
  },

  stepsItems(steps = this.steps()) {
    const items = [], at = {};
    steps.forEach((s, i) => {
      at[`s${i}`] = items.length;
      items.push({ t: "step", s, i });
      const present = this.present(s);
      if (s.stale) items.push({ t: "note", text: "Outdated: these hunks are no longer in the diff." });
      for (const id of present) {
        const h = this.byId.get(id);
        at[id] = items.length;
        items.push({ t: "path", h });
        this.pushRows(items, at, h.rows, h.path, () => id);
      }
    });
    return { items, at };
  },

  // The diff the Files tab shows: only the changes since your last review while that is on, else the whole PR.
  shown() {
    return this.sinceOn && this.since ? { patch: this.since.files, fileHunks: this.since.fileHunks, hunks: this.since.hunks }
      : { patch: this.patch ?? [], fileHunks: this.fileHunks, hunks: this.hunks ?? [] };
  },

  filesItems() {
    const items = [], at = {}, sh = this.shown();
    for (const f of sh.patch) {
      at[f.path] = items.length;
      items.push({ t: "file", f });
      if (this.collapsed.has(f.path)) continue;
      const hs = sh.fileHunks?.get(f.path) ?? [], full = Array.isArray(this.full[f.path]) ? this.full[f.path] : null;
      if (typeof this.full[f.path] === "string") items.push({ t: "note", text: this.full[f.path] });
      if (f.binary) { items.push({ t: "note", text: "Binary file" }); continue; }
      if (!hs.length) { items.push({ t: "note", text: f.status === "renamed" ? `Renamed from ${f.from}, content unchanged` : "No text change" }); continue; }
      const rows = fileRows(hs.map((h) => h.rows), full, this.gaps[f.path], this.whole.has(f.path), f.status === "modified" || f.status === "renamed");
      const loose = this.pushRows(items, at, rows, f.path, (r) => (r.h === undefined ? null : hs[r.h].id));
      for (const c of loose) items.push({ t: "comment", c, loose: true }, { t: "cact", c });
    }
    return { items, at };
  },


  // ---- clicks in the list: one handler for all rows (gpui-kit); where in the row comes from the press

  onItem(key, cx) {
    const it = this.byKey?.get(key); // a stable key: the item pressed, even if the list changed since
    if (!it) return;
    const { x, shift } = this.press;
    this.fh.focus();
    if (it.t === "row") {
      if (it.hunk) this.visit(it.hunk, cx);
      const r = it.src[it.ri];
      if (r.number === undefined) return;
      if (this.press.cmd) return this.define(it, r, cx); // ⌘-click a name: its definition
      // Selections are (file, line keys), not row indexes: rows are rebuilt on every render.
      const k = lineKey(r), f = this.fsel;
      if (shift && f && f.path === it.path && rangeOf(this.rowsFor(it.path), f.a, k)) this.fsel = { ...f, b: k };
      else this.fsel = f?.path === it.path && f.a === k && f.b === k ? null : { path: it.path, a: k, b: k };
      this.sug = null;
    } else if (it.t === "sug") { this.sug = this.sug === it.s.key ? null : it.s.key; this.visit(it.s.hunk, cx); }
    else if (it.t === "comment") this.editComment(it.c, cx);
    else if (it.t === "def") {
      const b = x - GUTTER - 12, which = b >= 0 && b < BTN + 40 ? 0 : b >= BTN + 40 + BTN_GAP && b < 2 * (BTN + 40) + BTN_GAP ? 1 : b >= 2 * (BTN + 40 + BTN_GAP) ? 2 : -1;
      const d = it.d.res?.definitions?.[0];
      if (which === 2) this.defAt = null;
      else if (d && which === 0) this.goDef(d, cx);
      else if (d && which === 1) { const a = vscodeArgs(this.lspRoot(), d); if (a) exec("code", a); else this.note = "Could not open: the definition is not a local file"; }
    } else if (it.t === "fact") {
      const b = x - GUTTER - 12, which = Math.floor(b / (BTN + BTN_GAP)), inside = b >= 0 && b % (BTN + BTN_GAP) < BTN;
      if (inside && which === 0) this.findingComment(it.f, cx);
      else if (inside && which === 1) this.discuss(it.f, cx);
      else if (inside && which === 2) this.fix([it.f], cx);
      else if (inside && which === 3) this.setFinding(it.f, "dismissed", cx);
    } else if (it.t === "find") { this.tab = "findings"; this.ffocus = it.f.id; }
    else if (it.t === "sugact" || it.t === "cact") {
      const b = x - GUTTER - 12, which = b >= 0 && b < BTN ? 0 : b >= BTN + BTN_GAP && b < 2 * BTN + BTN_GAP ? 1 : -1;
      if (it.t === "sugact" && which === 0) this.takeSug(it.s, cx);
      else if (it.t === "sugact" && which === 1) this.dropSug(it.s, cx);
      else if (it.t === "cact" && which === 0) this.editComment(it.c, cx);
      else if (it.t === "cact" && which === 1) this.dropComment(it.c, cx);
    } else if (it.t === "gap") this.expand(it.path, it.r.gap, x < GUTTER + GAP_SEG ? "down" : x < GUTTER + 2 * GAP_SEG ? "up" : "all", cx);
    else if (it.t === "file") {
      const p = it.f.path;
      this.fileFocus = p;
      if (x >= FILE_CHEV && x < FILE_CHEV + FILE_SEEN) this.toggleSeen(p, cx);
      else if (x >= FILE_CHEV + FILE_SEEN && x < FILE_CHEV + FILE_SEEN + FILE_WHOLE && this.shown().fileHunks?.has(p)) this.toggleWhole(p, cx);
      else if (this.collapsed.has(p)) this.collapsed.delete(p); else this.collapsed.add(p);
    } else if (it.t === "step") this.goStep(it.i, cx, false);
    else if (it.t === "path") this.visit(it.h.id, cx);
    cx.notify();
  },

  toggleSeen(path, cx) {
    if (this.prog.seen.has(path)) { this.prog.seen.delete(path); this.collapsed.delete(path); }
    else { this.prog.seen.add(path); this.collapsed.add(path); }
    this.saveProgress(cx);
  },

  toggleWhole(path, cx) {
    if (this.whole.has(path)) this.whole.delete(path);
    else { this.whole.add(path); this.collapsed.delete(path); this.loadFull(path, cx); }
  },

  expand(path, k, how, cx) {
    const g = (this.gaps[path] ??= {}), cur = g[k] ?? { down: 0, up: 0 };
    g[k] = how === "all" ? { down: 1e9, up: 0 } : { ...cur, [how]: cur[how] + MORE };
    this.loadFull(path, cx);
  },

  // The file at the PR head: from the local clone when it has that commit, else from GitHub.
  loadFull(path, cx) {
    if (this.full[path] !== undefined && !String(this.full[path]).startsWith("Could not load")) return;
    this.full[path] = "Loading file…";
    const url = this.prSel.url, repo = /github\.com\/([^/]+\/[^/]+)\/pull/.exec(url)?.[1];
    cx.spawn(async (cx) => {
      let text = null;
      try {
        if (!this.head) {
          const v = await exec("gh", ["pr", "view", url, "--json", "headRefOid"], { timeout: 30000 });
          if (v.code !== 0) throw new Error("PR head unknown");
          this.head = JSON.parse(v.stdout).headRefOid;
        }
        const head = this.head, w = this.worktree;
        // The worktree's file needs no process; a clone that has the commit one; GitHub the network.
        if (w && w.head === head && !w.local) text = await readTextFile(`${w.path}/${path}`).catch(() => null);
        const local = text === null && this.root ? await exec("git", ["cat-file", "-p", `${head}:${path}`], { cwd: this.root }).catch(() => null) : null;
        if (text !== null) {} else if (local?.code === 0) text = local.stdout;
        else {
          const r = await exec("gh", ["api", "-H", "Accept: application/vnd.github.raw", `repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${head}`], { timeout: 60000 });
          if (r.code !== 0) throw new Error(r.stderr.trim().slice(0, 160));
          text = r.stdout;
        }
      } catch (e) { if (this.prSel?.url === url) this.full[path] = `Could not load the file: ${String(e).replace(/^Error: /, "")}`; }
      if (this.prSel?.url !== url) return;
      if (text !== null) this.full[path] = text.replace(/\n$/, "").split("\n");
      cx.notify();
    });
  },

  // ---- suggestions and comments

  focusedSug() {
    const open = this.openSugs();
    return open.find((s) => s.key === this.sug) ?? open.find((s) => s.hunk === this.focusHunk) ?? null;
  },

  takeSug(s, cx) {
    const h = this.byId.get(s.hunk), c = h && suspectComment(s, h.rows, Date.now().toString(36));
    if (!c) { this.note = "Could not accept: that line is no longer in the diff"; return; }
    this.comments = [...this.comments, c]; this.persist(cx);
    this.prog.handled[s.key] = "taken"; this.saveProgress(cx); this.sug = null;
  },

  dropSug(s, cx) { this.prog.handled[s.key] = "dropped"; this.saveProgress(cx); this.sug = null; },

  // One file's rows as the Files view shows them (hunks plus opened context): what selections are measured on.
  // whole: of the whole PR even while only the changes since your last review are shown (findings are on the PR).
  rowsFor(path, whole = false) {
    const sh = whole ? { patch: this.patch ?? [], fileHunks: this.fileHunks } : this.shown();
    const hs = sh.fileHunks?.get(path) ?? [], f = sh.patch.find((x) => x.path === path), full = Array.isArray(this.full[path]) ? this.full[path] : null;
    return fileRows(hs.map((h) => h.rows), full, this.gaps[path], this.whole.has(path), f?.status === "modified" || f?.status === "renamed");
  },

  // The selected range as a comment anchor (lines, side, quoted code); null when nothing (or nothing valid) is selected.
  selAnchor() {
    const f = this.fsel, rows = f ? this.rowsFor(f.path) : null, range = rows && rangeOf(rows, f.a, f.b);
    return range ? selection(rows, range[0], range[1]) : null;
  },

  // c: the selection, else the focused suggestion's line, else the first change of the focused hunk.
  ensureSel() {
    if (this.fsel) return;
    const h = this.byId?.get(this.focusHunk) ?? this.hunks?.[0];
    if (!h) return;
    const s = this.focusedSug(), i = s ? h.rows.findIndex((r) => atLine(r, s.line, s.old)) : h.rows.findIndex((r) => r.kind === "+" || r.kind === "-");
    if (i >= 0) this.fsel = { path: h.path, a: lineKey(h.rows[i]), b: lineKey(h.rows[i]) };
  },

  addFull(cx) {
    const text = this.question.trim();
    if (!text || !this.reviewKey) return;
    if (this.editing) this.comments = this.comments.map((c) => (c.id === this.editing.id ? { ...c, text } : c));
    else if (this.selAnchor()) this.comments = [...this.comments, { id: Date.now().toString(36), file: this.fsel.path, ...this.selAnchor(), text }];
    else { this.note = "Select a line first (click it; shift-click: a range)"; return cx.notify(); }
    this.editing = null; this.question = ""; this.input.set_value(""); this.fsel = null;
    this.fh.focus(); this.persist(cx); cx.notify();
  },

  onReviewKey(e, cx) {
    if (this.typing) { if (e.key === "escape") { this.cancel(cx); cx.stop_propagation(); } return; }
    const k = e.keystroke;
    if (k === "j" || k === "k") {
      const d = k === "j" ? 1 : -1;
      if (this.tab === "steps") this.goStep(this.cur + d, cx); else this.goFile(d);
    }
    else if (k === "n" || k === "p") this.goHunk(k === "n" ? 1 : -1, cx);
    else if (k === "c") { this.ensureSel(); this.input.focus(); }
    else if (k === "a" || k === "x") { const s = this.focusedSug(); if (s) (k === "a" ? this.takeSug(s, cx) : this.dropSug(s, cx)); }
    else if (k === "s" || k === "f") this.tab = k === "s" ? "steps" : "files";
    else if (k === "escape") { if (this.defFile) this.defFile = null; else if (this.defAt) this.defAt = null; else leave(); }
    else return;
    cx.stop_propagation(); cx.notify();
  },

  // ---- render: the bar

  renderBar() {
    const t = theme(), pr = shared("review.target"), meta = shared("review.meta") ?? {}, m = model();
    const shown = meta.url === pr?.url ? meta.shown : null, busy = meta.url === pr?.url ? meta.busy : null;
    return h_flex().id("rv-bar").size_full().pl(84).pr(14).gap(10).items_center().bg(t.chrome).text_color(t.foreground).text_size(13.5)
      .child(pill("rv-back", t, "← Back", () => leave()))
      .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(14).child(pr ? `#${pr.number} ${pr.title ?? ""}` : "Review"))
      .when(Boolean(pr), (e) => e.child(div().flex_none().text_size(12).text_color(t.muted).child(`${pr.repo ?? ""}#${pr.number ?? ""}`))
        .child(badge(t, pr.state ?? "?", t[{ open: "ansi2", draft: "dim", merged: "ansi5", closed: "ansi1" }[pr.state]] ?? t.dim))
        .when(C.tagged(ctxDoc()), (e) => e.child(badge(t, C.labelOf(ctxDoc(), prCtx(pr)), C.colorOf(ctxDoc(), prCtx(pr), t)))))
      .when(Boolean(shown?.mergeRisk || shown?.effort), (e) => e.child(this.riskBadges(t, shown, "rv-bar")))
      .when(Boolean(meta.url === pr?.url && meta.checks && meta.checks.ok + meta.checks.fail > 0), (e) => e.child(pill("rv-checks-btn", t,
        h_flex().gap(6).child("Pre-merge checks").child(div().text_color(t.ansi2).child(`✓ ${meta.checks.ok}`)).child(div().text_color(meta.checks.fail ? t.ansi1 : t.muted).child(`✗ ${meta.checks.fail}`)),
        () => run("pr-review.page:overview"))))
      .child(pill("rv-done", t, "Mark done", () => run("pr-review.done")))
      .child(pill("rv-reviews-btn", t, Object.values(shared("review.reviewers") ?? {}).some((r) => r.busy) ? "Reviews ⋯" : "Reviews ▾",
        () => openOverlay({ mod: "pr-review", props: { part: "reviews" }, kind: "popup", width: 460, height: 250 })))
      .child(pill("rv-values", t, `Values: ${valuesOn() ? "On" : "Off"}`, () => setShared("review.values", !valuesOn()), valuesOn()))
      .child(h_flex().flex_none().gap(4).p(3).items_center().rounded(8).border_1().border_color(t.border)
        .children(Object.entries(MODELS).map(([k, v]) => pill(`rv-m-${k}`, t, v.label, () => setShared("review.model", k), m === k)))
        .child(div().px(6).text_size(12).text_color(meta.error ? t.ansi1 : t.muted)
          .child(busy ? h_flex().gap(6).child(div().child(SPIN[0]).frames(SPIN, 90)).child(`${MODELS[busy]?.label} analyzing…`)
            : shown ? `${MODELS[shown.model]?.label ?? shown.model}${shown.cost != null ? ` · $${shown.cost.toFixed(3)}` : ""}${shown.exact ? "" : " · older diff"}`
            : meta.error ? "Analysis failed" : "Not analyzed")));
  },

  // ---- render: the left column

  stepRow(s, i, t) {
    const on = i === this.cur && !this.page, done = this.done(s), touched = this.filesOf(s).length;
    return v_flex().id(`rv-step-${i}`).flex_none().px(10).py(8).gap(6).rounded(8).cursor_pointer().when(on, (e) => e.bg(t.selected)).hover((st) => st.bg(t.hover))
      .on_click((_e, cx) => { this.goStep(i, cx); cx.notify(); })
      .child(h_flex().gap(8).items_center()
        .child(div().id(`rv-chk-${i}`).w(18).flex_none().text_size(14).text_color(done ? t.ansi2 : t.dim).cursor_pointer()
          .on_click((_e, cx) => { this.prog.checked[stepKey(s)] = !done; this.saveProgress(cx); cx.stop_propagation(); cx.notify(); }).child(done ? "✓" : String(i + 1)))
        .child(div().flex_1().min_w(0).text_size(14.5).font_semibold().text_color(s.stale ? t.dim : t.foreground).when(!on, (e) => e.truncate()).child(plain(s.title)))
        .when(Boolean(s.isNew), (e) => e.child(badge(t, "new", t.accent)))
        .when(Boolean(s.stale), (e) => e.child(badge(t, "outdated", t.ansi3)))
        .when(!s.pseudo, (e) => e.child(riskBadge(t, s))))
      .child(div().pl(26).text_size(12).text_color(t.muted).child(`${touched} ${touched === 1 ? "file" : "files"} touched`))
      .child(div().pl(26).text_size(13.5).line_height(1.5).text_color(on ? t.foreground : t.muted)
        .child(on ? TextView.markdown(`rv-why-${stepKey(s)}`, s.why) : div().truncate().child(plain(s.why))))
      .when(on && Boolean(s.text), (e) => e.child(div().pl(26).text_size(13.5).line_height(1.5).text_color(t.foreground)
        .child(TextView.markdown(`rv-ex-${stepKey(s)}`, s.text))))
      .when(on && s.questions.length > 0, (e) => e.child(v_flex().pl(26).pt(2).gap(8)
        .child(div().text_size(11.5).font_semibold().text_color(t.muted).child("CHECK"))
        .children(s.questions.map((q, k) => h_flex().id(`rv-q-${i}-${k}`).gap(8).items_start().text_size(13.5).line_height(1.5)
          .child(div().flex_none().text_color(t.accent).child("?"))
          .child(div().flex_1().min_w(0).child(TextView.markdown(`rv-q-${stepKey(s)}-${k}`, this.asked(s, q))))))))
      .when(on && Boolean(s.visual), (e) => e.child(div().pl(26).child(visualCard(s.visual, t, `rv-vis-${i}`, (at, cx) => this.jumpTo(at, cx)))))
      .when(on, (e) => e.children((s.flows ?? []).map((f, k) => {
        const picked = this.flowOf()?.f === f;
        return div().pl(26).child(div().rounded(9).border_1().border_color(picked ? t.accent : t.chrome).child(flowCard(f, t, `rv-flow-${i}-${k}`,
          (_e, cx) => { this.flowSel = { step: stepKey(s), k }; this.jumpTo(f.at, cx); cx.stop_propagation(); })));
      })))
      .when(on, (e) => e.children(this.openSugs().filter((x) => s.hunks.includes(x.hunk)).map((x) => this.sugCard(x, t, true))));
  },

  // The flow whose trace shows inline: the one picked in the current step, else its first.
  flowOf() {
    const s = this.steps()[this.cur];
    if (!s?.flows?.length) return null;
    const k = this.flowSel?.step === stepKey(s) ? this.flowSel.k : 0;
    return { f: s.flows[k] ?? s.flows[0] };
  },

  // Inline example values (IntelliJ-style) for rows: "path:line" -> "name = value, …" from the shown flow's trace.
  traceMap() {
    const f = valuesOn() ? this.flowOf()?.f : null, out = new Map();
    for (const tr of f?.trace ?? []) {
      const path = this.patch?.find((x) => x.path === tr.path || x.path.endsWith(`/${tr.path}`))?.path ?? tr.path;
      out.set(`${path}:${tr.line}`, tr.values);
    }
    return out;
  },

  sugCard(s, t, small) {
    const c = t[LEVEL[s.severity]];
    return v_flex().id(`rv-sc-${s.key}`).flex_none().ml(small ? 26 : 0).mt(4).px(10).py(8).gap(6).rounded(8).border_1().border_l(3)
      .border_color(this.sug === s.key ? t.accent : c).bg(t.surface).text_size(13.5).cursor_pointer()
      .on_click((_e, cx) => { this.sug = s.key; this.visit(s.hunk, cx); this.scrollTo(this.tab, s.hunk); cx.stop_propagation(); cx.notify(); })
      .child(h_flex().gap(8).items_center().child(badge(t, s.severity, c))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(`${s.path.split("/").pop()} · line ${s.line}${s.old ? " (old)" : ""}${s.approx ? " ~" : ""}`)))
      .child(div().line_height(1.5).child(TextView.markdown(`rv-sr-${s.key}-${small}`, s.reason)))
      .child(h_flex().gap(8)
        .child(pill(`rv-take-${s.key}-${small}`, t, "Accept (a)", (_e, cx) => { this.takeSug(s, cx); cx.stop_propagation(); cx.notify(); }, false, t.foreground))
        .child(pill(`rv-drop-${s.key}-${small}`, t, "Dismiss (x)", (_e, cx) => { this.dropSug(s, cx); cx.stop_propagation(); cx.notify(); })));
  },

  // ---- the Layers tab: the left nav (pages, what needs attention, the layers) and the pages it opens

  checksNow() { return preMergeChecks({ title: this.pr?.title ?? this.prSel?.title, rules: this.ai?.rules ?? [], ctx: this.ctx }); },
  openFindings() { return this.find.list.filter((f) => OPEN_ST.includes(this.fstatus(f))); },
  blockersNow(checks = this.checksNow()) { return mergeBlockers({ checks, findings: this.openFindings(), unverified: this.verifyList().length, related: this.ctx }); },
  // The triage for this PR (pr.js triageOf, no LLM), for the registry and its consumers.
  triageNow() {
    const lines = (this.patch ?? []).reduce((n, f) => n + f.add + f.del, 0);
    return triageOf({ pr: this.prSel ?? {}, analysis: this.ai, size: { files: this.patch?.length ?? 0, lines },
      security: this.openFindings().filter((f) => f.reviewer === "security"), related: this.ctx });
  },
  filesOf(s) { return [...new Set(this.present(s).map((id) => this.byId.get(id).path))]; },
  // "file.ts — question": a check question with the file it is about.
  asked(s, q) { const f = this.filesOf(s)[0]; return f ? `${f.split("/").pop()} — ${q}` : q; },

  // What to look at first: high-risk layers not checked yet, failed repo rules, fixes to verify, high merge blockers.
  attention() {
    const out = [];
    this.steps().forEach((s, i) => { if (s.risk === "high" && !s.pseudo && !this.done(s)) out.push({ label: plain(s.title), why: "High-risk layer", go: (cx) => this.goStep(i, cx) }); });
    for (const r of this.ai?.rules ?? []) if (r.status === "fail") out.push({ label: r.rule, why: `Repo rule failed · ${r.source}`, go: (cx) => (r.where ? this.jumpTo(r.where, cx) : (this.page = "overview")) });
    const n = this.verifyList().length;
    if (n) out.push({ label: `${n} ${n === 1 ? "fix" : "fixes"} to verify`, why: "Sent to Fix before the last push", go: () => { this.page = "verify"; } });
    for (const b of this.blockersNow().filter((x) => x.severity === "high" && !x.finding)) out.push({ label: b.title, why: b.why, go: () => { this.page = "overview"; } });
    return out;
  },

  stepsPane(t) {
    const steps = this.steps(), ai = this.ai, checked = steps.filter((s) => this.done(s)).length, m = model();
    const run = (label) => div().id("rv-run").px(12).h(30).flex().items_center().rounded(8).text_size(13).bg(t.solid).text_color(t.solid_foreground)
      .cursor_pointer().on_click((_e, cx) => this.loadAi(cx, "run")).child(label);
    const nav = (k, label, right) => h_flex().id(`rv-nav-${k}`).flex_none().h(30).px(10).gap(8).items_center().rounded(7).cursor_pointer()
      .when(this.page === k, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.page = k; cx.notify(); })
      .child(div().flex_1().min_w(0).truncate().text_size(13.5).font_semibold().text_color(this.page === k ? t.foreground : t.muted).child(label))
      .children(right.filter(Boolean));
    const sec = this.find.list.filter((f) => f.reviewer === "security" && OPEN_ST.includes(this.fstatus(f))).length;
    const changed = (ai?.arch?.nodes ?? []).some((n) => n.status && n.status !== "unchanged"), toVerify = this.verifyList().length;
    const attention = ai ? this.attention() : [], pr = this.prSel ?? {};
    const canInc = Boolean(ai && this.aiFile && this.since?.files.length && !this.aiBusy);
    return v_flex().flex_1().min_h(0)
      .child(v_flex().flex_none().px(14).py(10).gap(8).border_b(1).border_color(t.border)
        .when(Boolean(ai), (e) => e.child(div().text_size(12).text_color(t.muted)
          .child(`${MODELS[ai.model]?.label ?? ai.model}${ai.cost != null ? ` · $${ai.cost.toFixed(3)}` : ""}${ai.budget ? ` of $${ai.budget} cap` : ""}${ai.ms ? ` · ${clock(ai.ms)}` : ""} · ${ago(ai.generated)}${ai.exact ? "" : " · older diff"}${ai.incremental ? " · incl. changes since last review" : ""}`)))
        .when(Boolean(ai?.mergeRisk || ai?.effort), (e) => e.child(this.riskBadges(t, ai, "rv-lb")))
        .when(!ai && !this.aiBusy, (e) => e.child(v_flex().gap(8).py(4)
          .child(div().text_size(13.5).line_height(1.5).child(`No ${MODELS[m].label} analysis for this diff yet. One thorough run reads the code around the changes and groups them into layers by intent, with explanations, check questions, suspicious lines, merge risk, review effort, repo rule checks, pictures and example values. It can take several minutes.`))
          .child(h_flex().gap(10).items_center().child(run(`Analyze with ${MODELS[m].label}`))
            .child(div().text_size(12).text_color(t.muted).child(this.estimate(m))))))
        .when(Boolean(this.aiBusy), (e) => e.child(h_flex().gap(8).items_center().text_size(13).text_color(t.muted).child(div().child(SPIN[0]).frames(SPIN, 90))
          .child(div().flex_1().child(`${MODELS[this.aiBusy.model]?.label} is reading ${this.aiBusy.incremental ? "the new changes" : "the code"} · ${clock(Date.now() - this.aiBusy.started)} · cap $${CAP[this.aiBusy.model]}`))
          .child(pill("rv-cancel", t, "Cancel", (_e, cx) => this.cancelAi(cx), false, t.ansi1))))
        .when(Boolean(this.aiError), (e) => e.child(div().text_size(12.5).text_color(t.ansi1).whitespace_normal().child(this.aiError)))
        .when(Boolean(ai && !ai.exact), (e) => e.child(div().text_size(12.5).text_color(t.ansi3).whitespace_normal().child(canInc ? "Analysis of an older diff: re-analyze, or analyze only the new changes." : "Analysis of an older diff: re-analyze for the current state.")))
        .when(Boolean(ai?.cut.length), (e) => e.child(div().text_size(12.5).text_color(t.ansi3).whitespace_normal().child(`${ai.cut.length} hunks were too large for ${MODELS[ai.model]?.label ?? ai.model} and are not analyzed (layer "Not analyzed").`)))
        .child(h_flex().flex_wrap().gap(6).items_center().text_size(12.5)
          .child(h_flex().gap(2).p(2).rounded(7).border_1().border_color(t.border).children([["reading", "Layers"], ["risk", "By risk"]].map(([k, label]) =>
            div().id(`rv-order-${k}`).px(8).h(22).flex().items_center().rounded(5).cursor_pointer().bg(this.order === k ? t.selected : t.chrome)
              .text_color(this.order === k ? t.foreground : t.muted).on_click((_e, cx) => { this.order = k; this.cur = 0; cx.notify(); }).child(label))))
          .child(pill("rv-prev", t, "‹ Prev", (_e, cx) => { this.goStep(this.cur - 1, cx); cx.notify(); }))
          .child(pill("rv-next", t, "Next ›", (_e, cx) => { this.goStep(this.cur + 1, cx); cx.notify(); }))
          .when(Boolean(ai || this.aiError), (e) => e.child(pill("rv-rerun", t, this.aiBusy ? "Running…" : "Re-analyze", (_e, cx) => this.loadAi(cx, "run"))))
          .when(canInc, (e) => e.child(pill("rv-reinc", t, "Only new changes", (_e, cx) => this.loadAi(cx, "run", true), false, t.accent)
            .tooltip(`Analyze only the ${this.since.files.length} files changed since your last review and merge the new layers in`)))))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("rv-steps-left").absolute().inset_0().overflow_y_scroll().p(8).gap(4)
          .child(nav("overview", "Overview", [pr.state && badge(t, pr.state === "open" ? "Open" : pr.state, t[{ open: "ansi2", draft: "dim", merged: "ansi5", closed: "ansi1" }[pr.state]] ?? t.dim)]))
          .child(nav("blast", "Security blast radius", [sec > 0 && badge(t, String(sec), t.ansi1)]))
          .child(nav("arch", "Architecture impact", [changed && badge(t, "Changed", t.accent)]))
          .child(nav("verify", "Verify", [toVerify > 0 && badge(t, String(toVerify), t.ansi3)]))
          .when(attention.length > 0, (e) => e.child(v_flex().flex_none().mt(8).p(10).gap(6).rounded(8).border_1().border_l(3).border_color(t.ansi3).bg(t.ansi3 + "10")
            .child(div().text_size(11.5).font_semibold().text_color(t.ansi3).child("NEEDS YOUR ATTENTION"))
            .children(attention.slice(0, 6).map((a, k) => v_flex().id(`rv-att-${k}`).cursor_pointer().hover((s) => s.bg(t.hover)).rounded(5).px(4).py(2)
              .on_click((_e, cx) => { a.go(cx); cx.notify(); })
              .child(div().text_size(13).font_semibold().truncate().child(a.label)).child(div().text_size(12).text_color(t.muted).truncate().child(a.why))))))
          .child(h_flex().flex_none().mt(10).px(10).gap(8).items_center().text_size(11.5).font_semibold().text_color(t.muted)
            .child(div().flex_1().child(this.order === "reading" ? "LAYERS" : "LAYERS BY RISK")).child(div().child(`${checked} of ${steps.length} checked`)))
          .children(steps.map((s, i) => this.stepRow(s, i, t))))
        .child(Scrollbar.vertical("rv-steps-left").absolute().inset_0()));
  },

  riskBadges(t, ai, id) {
    const r = ai.mergeRisk, e = ai.effort, cap = (x) => x[0].toUpperCase() + x.slice(1);
    return h_flex().flex_wrap().gap(6)
      .when(Boolean(r), (x) => x.child(badge(t, `Merge risk: ${cap(r.level)}`, t[SEVERITY_COLOR[r.level]]).id(`${id}-risk`).tooltip(r.why || r.level)))
      .when(Boolean(e), (x) => x.child(badge(t, `Review effort ${e.score}/5`, e.score >= 4 ? t.ansi3 : t.muted).id(`${id}-eff`).tooltip(e.why || "")));
  },

  // The page beside the Layers nav (instead of the diff).
  pageView(t) {
    const body = { overview: () => this.overviewPage(t), arch: () => this.archPage(t), blast: () => this.blastPage(t), verify: () => this.verifyPage(t) }[this.page];
    return div().flex_1().min_h(0).relative()
      .child(v_flex().id(`rv-page-${this.page}`).absolute().inset_0().overflow_y_scroll().px(24).py(18).gap(14).child(body ? body() : div()))
      .child(Scrollbar.vertical(`rv-page-${this.page}`).absolute().inset_0());
  },

  // "4 files changed since your last review (abc1234 → def5678)" with Since last review / Full PR.
  sinceBanner(t) {
    const s = this.since;
    if (!s) return null;
    const seg = (on, label, click) => div().id(`rv-since-${on}`).px(10).h(24).flex().items_center().rounded(5).cursor_pointer().text_size(12.5)
      .bg(this.sinceOn === on ? t.selected : t.chrome).text_color(this.sinceOn === on ? t.foreground : t.muted).on_click(click).child(label);
    const text = s.files.length ? `${s.files.length} ${s.files.length === 1 ? "file" : "files"} changed since your last review (${s.base.sha.slice(0, 7)} → ${String(s.head).slice(0, 7)})`
      : `The PR moved since your last review (${s.base.sha.slice(0, 7)} → ${String(s.head).slice(0, 7)})`;
    return v_flex().flex_none().px(14).py(8).gap(4).bg(t.accent + "14").border_b(1).border_color(t.border)
      .child(h_flex().gap(10).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().child(text))
        .when(s.files.length > 0, (e) => e.child(h_flex().gap(2).p(2).rounded(7).border_1().border_color(t.border)
          .child(seg(true, "Since last review", (_e, cx) => { this.sinceOn = true; this.gaps = {}; this.tab = "files"; cx.notify(); }))
          .child(seg(false, "Full PR", (_e, cx) => { this.sinceOn = false; this.gaps = {}; cx.notify(); })))))
      .when(Boolean(s.note), (e) => e.child(div().text_size(12).text_color(t.ansi3).whitespace_normal().child(s.note)));
  },

  overviewPage(t) {
    const pr = this.prSel ?? {}, ai = this.ai, files = this.patch ?? [], task = ai?.task ?? {};
    const add = files.reduce((n, f) => n + f.add, 0), del = files.reduce((n, f) => n + f.del, 0);
    const layers = (ai?.steps ?? []).filter((s) => !s.pseudo), hues = ["accent", "ansi4", "ansi5", "ansi6", "ansi3", "ansi2"];
    const finds = this.openFindings(), sev = ["high", "medium", "low"].map((k) => [k, finds.filter((f) => f.severity === k).length]);
    const checks = this.checksNow(), blockers = this.blockersNow(checks), ok = checks.filter((c) => c.ok === true).length, bad = checks.filter((c) => c.ok === false).length;
    const fold = (k) => (_e, cx) => { this.fold[k] = !this.fold[k]; cx.notify(); };
    const section = (title) => div().pt(4).text_size(11.5).font_semibold().text_color(t.muted).child(title);
    const sevPills = h_flex().flex_wrap().gap(6).children(sev.filter(([, n]) => n).map(([k, n]) => chip(t, `${n} ${k}`, t[SEVERITY_COLOR[k]], true)));
    const ctx = this.ctx, related = [...(ctx?.open ?? []).map((p) => ({ ...p, state: "open" })), ...(ctx?.merged ?? []).map((p) => ({ ...p, state: "merged" }))];
    return v_flex().gap(14).max_w(1100)
      .child(div().text_size(12).text_color(t.muted).child(`Updated ${ago(ai?.generated ?? pr.updatedAt ?? new Date().toISOString())}`))
      .child(h_flex().gap(10).items_start().child(div().flex_1().min_w(0).text_size(22).font_semibold().line_height(1.3).whitespace_normal().child(pr.title ?? `#${pr.number}`))
        .when(Boolean(pr.state), (e) => e.child(badge(t, pr.state === "open" ? "Open" : pr.state, t[{ open: "ansi2", draft: "dim", merged: "ansi5", closed: "ansi1" }[pr.state]] ?? t.dim))))
      .when(Boolean(ai?.mergeRisk || ai?.effort), (e) => e.child(this.riskBadges(t, ai, "rv-ob")))
      .when(Boolean(this.since), (e) => e.child(div().rounded(8).overflow_hidden().border_1().border_color(t.border).child(this.sinceBanner(t))))
      .child(h_flex().gap(12)
        .child(statCard(t, "rv-st-layers", "Layers", ai ? `${layers.length} ${layers.length === 1 ? "layer" : "layers"}` : "—",
          segBar(t, layers.map((s, k) => ({ weight: 1, color: t[hues[k % hues.length]] }))), layers.map((s) => plain(s.title)).join(" · ") || "Not analyzed yet"))
        .child(statCard(t, "rv-st-files", "Files changed", `${files.length} ${files.length === 1 ? "file" : "files"}`,
          segBar(t, [{ weight: add, color: t.ansi2 }, { weight: del, color: t.ansi1 }]), `+${add} −${del}`))
        .child(statCard(t, "rv-st-find", "Severity findings", `${finds.length} ${finds.length === 1 ? "finding" : "findings"}`,
          segBar(t, sev.map(([k, n]) => ({ weight: n, color: t[SEVERITY_COLOR[k]] }))), sev.filter(([, n]) => n).map(([k, n]) => `${n} ${k[0].toUpperCase()}${k.slice(1)}`).join(" ") || "None open")))
      .child(foldCard(t, "rv-checks", "Pre-merge checks", [div().text_color(t.ansi2).font_semibold().child(`✓ ${ok}`), div().text_color(bad ? t.ansi1 : t.muted).font_semibold().child(`✗ ${bad}`)],
        this.fold.checks, fold("checks"), () => v_flex().gap(4).children(checks.map((c, k) => h_flex().id(`rv-ck-${k}`).gap(8).items_start().text_size(13)
          .when(Boolean(c.where), (e) => e.cursor_pointer().on_click((_e, cx) => this.jumpTo(c.where, cx)))
          .child(div().w(14).flex_none().text_color(c.ok === true ? t.ansi2 : c.ok === false ? t.ansi1 : t.ansi3).child(c.ok === true ? "✓" : c.ok === false ? "✗" : "…"))
          .child(div().flex_1().min_w(0).whitespace_normal().child(`${c.name}${c.why && c.ok !== true ? ` — ${c.why}` : ""}`))))
          .when(!ctx, (e) => e.child(div().text_size(12).text_color(t.muted).child("CI checks and mergeability load in the background…")))))
      .child(foldCard(t, "rv-summary", "Summary", [sevPills], this.fold.summary, fold("summary"), () => v_flex().gap(10)
        .child(section("WHAT CHANGED"))
        .child(v_flex().gap(4).child(div().text_size(12).font_semibold().text_color(t.muted).child("Intent"))
          .child(h_flex().flex_wrap().gap(6).items_center().child(div().text_size(13.5).child(task.title ?? pr.title ?? ""))
            .when(Boolean(task.jira), (e) => e.child(chip(t, `Linked issue ${task.jira}`, t.accent))))
          .when(Boolean(task.note), (e) => e.child(div().text_size(12).text_color(t.ansi3).whitespace_normal().child(task.note))))
        .when(Boolean(ai?.behavior), (e) => e.child(v_flex().gap(4).child(div().text_size(12).font_semibold().text_color(t.muted).child("Behavior"))
          .child(div().text_size(13.5).line_height(1.5).child(TextView.markdown(`rv-beh-${ai.generated}`, ai.behavior)))))
        .when(Boolean(ai?.summary), (e) => e.child(div().text_size(13.5).line_height(1.5).child(TextView.markdown(`rv-sum-${ai.generated}`, ai.summary))))
        .when(!ai, (e) => e.child(div().text_size(13).text_color(t.muted).child("No analysis yet: Analyze in the left column.")))
        .when(Boolean(ai), (e) => e.child(this.asksPane(t)))))
      .child(foldCard(t, "rv-blockers", `${blockers.length} merge ${blockers.length === 1 ? "blocker" : "blockers"} to act on`,
        blockers.length ? [chip(t, blockers[0].severity, t[SEVERITY_COLOR[blockers[0].severity]], true)] : [], this.fold.blockers, fold("blockers"),
        () => v_flex().gap(8).when(!blockers.length, (e) => e.child(div().text_size(13).text_color(t.muted).child("Nothing blocks the merge that this review knows of.")))
          .children(blockers.map((b, k) => v_flex().id(`rv-bl-${k}`).gap(2).p(8).rounded(7).border_1().border_l(3).border_color(t[SEVERITY_COLOR[b.severity]]).cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { if (b.url) this.openRelated(b, cx); else if (b.where) this.jumpTo(b.where, cx); else if (b.finding) { this.tab = "findings"; this.ffocus = b.finding; } cx.notify(); })
            .child(div().text_size(13.5).font_semibold().child(b.title)).child(div().text_size(12.5).text_color(t.muted).whitespace_normal().child(b.why))))))
      .when(Boolean(ai?.rules.length), (e) => e.child(v_flex().gap(6).child(section(`REPO RULES · ${ai.rules.filter((r) => r.status === "fail").length} failed`))
        .children(ai.rules.map((r, k) => h_flex().id(`rv-rule-${k}`).gap(8).items_start().p(6).rounded(6).hover((s) => s.bg(t.hover))
          .when(Boolean(r.where), (x) => x.cursor_pointer().on_click((_e, cx) => this.jumpTo(r.where, cx)))
          .child(chip(t, r.status === "pass" ? "✓ pass" : r.status === "fail" ? "✗ fail" : "n/a", t[{ pass: "ansi2", fail: "ansi1" }[r.status] ?? "muted"]))
          .child(v_flex().flex_1().min_w(0).gap(2).child(div().text_size(13.5).font_semibold().whitespace_normal().child(r.rule))
            .child(div().text_size(12).text_color(t.muted).whitespace_normal().child(`${r.source}${r.where ? ` · ${r.where}` : ""}${r.why ? ` — ${r.why}` : ""}`)))))))
      .child(v_flex().gap(6).child(section(`RELATED PRS${ctx ? ` · ${related.length}` : ""}`))
        .when(!ctx, (e) => e.child(div().text_size(12.5).text_color(t.muted).child("Looking for PRs that touch the same files…")))
        .when(Boolean(ctx) && !related.length, (e) => e.child(div().text_size(12.5).text_color(t.muted).child("No other open PR and no PR merged in the last 90 days touches these files.")))
        .children(related.map((p) => h_flex().id(`rv-rel-${p.number}`).gap(8).items_center().p(6).rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.openRelated(p, cx))
          .child(chip(t, p.state, p.state === "open" ? t.ansi2 : t.ansi5))
          .child(div().flex_none().text_size(13).text_color(t.muted).child(`#${p.number}`))
          .child(div().flex_1().min_w(0).truncate().text_size(13.5).child(p.title))
          .child(div().id(`rv-relf-${p.number}`).flex_none().text_size(12).text_color(t.muted).tooltip((p.files ?? []).join("\n") || "-").child(`${p.overlap} ${p.overlap === 1 ? "file" : "files"} overlap`)))));
  },

  // A related PR in the review layout (the resume contract): prs.json's entry, else one built from gh pr view on this
  // review's context; the browser when gh can't read it.
  openRelated(p, cx) {
    cx.spawn(async () => {
      const prs = JSON.parse(await readTextFile(`${appHome()}/pr-data/prs.json`).catch(() => null) ?? "{}").prs ?? [];
      const known = prs.find((x) => x.url === p.url);
      if (known) return startReview(known);
      const r = p.url ? await exec("gh", ["pr", "view", p.url, "--json", "number,title,author,headRefName,headRefOid,baseRefName,updatedAt,isDraft,state,url,additions,deletions,reviewDecision"], { timeout: 30000 }).catch(() => null) : null;
      if (r?.code === 0) startReview(ghTarget(JSON.parse(r.stdout), { context: this.ctxId(), source: "related", cwd: this.prSel?.cwd ?? null }));
      else if (p.url) openUrl(p.url);
    });
  },

  archPage(t) {
    const a = this.ai?.arch;
    const seg = (k, label) => div().id(`rv-av-${k}`).px(10).h(24).flex().items_center().rounded(5).cursor_pointer().text_size(12.5)
      .bg(this.archMode === k ? t.selected : t.chrome).text_color(this.archMode === k ? t.foreground : t.muted).on_click((_e, cx) => { this.archMode = k; cx.notify(); }).child(label);
    if (!a) return div().text_size(13.5).text_color(t.muted).child(this.ai ? "This analysis has no architecture picture (older analysis, or the PR touches no architecture). Re-analyze for one." : "No analysis yet: Analyze in the left column.");
    const groups = new Set(a.nodes.map((n) => n.group)).size, L = archModel(a, this.archMode);
    const opts = { hl: this.archHl, onHl: (k, cx) => { if (this.archHl !== k) { this.archHl = k; cx.notify(); } } };
    return v_flex().gap(12)
      .child(div().text_size(20).font_semibold().child("Architecture impact"))
      .child(h_flex().w_full().gap(12).items_center().flex_wrap() // wraps onto two rows when narrow
        .child(div().flex_none().text_size(13).text_color(t.muted).child(`${groups} ${groups === 1 ? "system" : "systems"} | ${(a.edges ?? []).length} edges`))
        .child(div().flex_none().child(legend(t)))
        .child(h_flex().flex_none().gap(2).p(2).rounded(7).border_1().border_color(t.border).child(seg("diff", "Structural diff")).child(seg("before", "Before")).child(seg("after", "After"))))
      .child(div().id("rv-arch-scroll").w_full().overflow_x_scroll().pb(8)
        .child(archView(L, t, "rv-arch", (n, _e, cx) => this.jumpTo(n.at, cx), null, opts)))
      .child(archLegend(L, t, "rv-arch-edges", "Edges", opts));
  },

  blastPage(t) {
    const sec = this.find.list.filter((f) => f.reviewer === "security"), runs = this.find.runs.security;
    const blast = this.ai?.blast ?? (sec.length ? { units: [...new Set(sec.map((f) => f.file))].map((file, k) => ({ id: `f${k}`, label: file.split("/").pop(), type: "file", status: "changed", files: [file], spots: (this.fileHunks?.get(file) ?? []).length })), context: [] } : null);
    const header = v_flex().p(12).gap(8).rounded(10).border_1().border_color(t.border).bg(t.surface)
      .child(h_flex().gap(10).items_center().child(div().flex_1().text_size(20).font_semibold().child("Security blast radius"))
        .when(Boolean(blast), (e) => e.child(pill("rv-bl-expand", t, this.blastOpen ? "Collapse all" : "Expand all", (_e, cx) => { this.blastOpen = !this.blastOpen; cx.notify(); })))
        .child(!sec.length && !runs?.at && !runs?.busy ? div().text_size(12.5).text_color(t.muted).child("No security review yet:") : chip(t, `Security · ${sec.length}`, sec.length ? t.ansi1 : t.muted))
        .child(pill("rv-bl-run", t, runs?.busy ? "Security review running…" : runs?.at ? "Run security review again" : "Run security review", (_e, cx) => this.runReviewer("security", cx))))
      .child(div().text_size(13).text_color(t.muted).child("See the risks and the parts of the diff driving them."));
    if (!blast) return v_flex().gap(12).child(header).child(div().text_size(13.5).text_color(t.muted).child(this.ai ? "No blast radius in this analysis and no security findings yet." : "No analysis yet: Analyze in the left column, or run the security review."));
    const b = blastArch(blast, sec.filter((f) => OPEN_ST.includes(this.fstatus(f))));
    const L = archModel(b, "diff", (n) => Math.min(2, n.findings?.length ?? 0));
    const opts = { hl: this.blastHl, onHl: (k, cx) => { if (this.blastHl !== k) { this.blastHl = k; cx.notify(); } } };
    const deco = (n) => (n.findings ?? []).slice(0, 2).map((f) => h_flex().gap(4).items_center().child(chip(t, f.severity, t[SEVERITY_COLOR[f.severity]] ?? t.muted, true))
      .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.foreground).child(f.title)));
    const go = (n, _e, cx) => { const h = this.fileHunks?.get(n.file)?.[0]; if (h) this.jumpTo(`${n.file}:${h.rows.find((r) => r.n)?.n ?? ""}`, cx); else if (n.file) { this.note = `${n.file} is not in the diff (related context)`; cx.notify(); } };
    return v_flex().gap(12)
      .child(header.child(div().text_size(13).font_semibold().child(`${b.counts.added} Added | ${b.counts.changed} Changed | ${b.counts.up} Upstream | ${b.counts.down} Downstream`)))
      .child(div().id("rv-blast-scroll").w_full().overflow_x_scroll().pb(8).child(archView(L, t, "rv-blast", go, deco, opts)))
      .child(archLegend(L, t, "rv-blast-edges", "How the context links to the changes", opts, true))
      .when(this.blastOpen, (e) => e.children((blast.units ?? []).flatMap((u) => (u.files ?? []).flatMap((file) => (this.fileHunks?.get(file) ?? []).map((h) => this.hunkBlock(h, t, `${u.id}`))))));
  },

  // A hunk drawn plainly (pages: outside the virtual list), at most 60 lines.
  hunkBlock(h, t, key) {
    const mono = settings().font_family ?? "JetBrains Mono";
    return v_flex().id(`rv-hb-${key}-${h.id}`).flex_none().rounded(8).border_1().border_color(t.border).overflow_hidden().font_family(mono).text_size(12)
      .child(div().px(10).py(4).bg(t.raised).text_color(t.muted).truncate().child(`${h.path}  ${h.rows[0]?.text ?? ""}`))
      .children(h.rows.slice(1, 61).map((r) => h_flex().h(18).when(r.kind === "+" || r.kind === "-", (e) => e.bg(tint(r.kind) + "1a"))
        .child(div().w(44).flex_none().pr(6).text_right().text_color(t.muted).child(r.number === undefined ? "" : String(r.number)))
        .child(div().w(14).flex_none().text_color(r.kind === "+" ? t.ansi2 : r.kind === "-" ? t.ansi1 : t.muted).child(r.kind === " " ? "" : r.kind))
        .child(div().flex_1().min_w(0).truncate().child(expandTabs(r.text)))));
  },

  verifyPage(t) {
    const list = this.verifyList(), done = this.find.list.filter((f) => this.find.status[f.id]?.verify), m = model();
    const card = (f) => {
      const v = this.find.status[f.id]?.verify, c = { fixed: "ansi2", not_fixed: "ansi1", unclear: "ansi3" }[v?.result] ?? "muted";
      return v_flex().id(`rv-vf-${f.id}`).gap(4).p(10).rounded(8).border_1().border_l(4).border_color(t[c]).bg(t.surface).cursor_pointer()
        .on_click((_e, cx) => { this.ffocus = f.id; this.jumpTo(`${f.file}:${f.line}`, cx); })
        .child(h_flex().gap(8).items_center().child(badge(t, f.severity, t[SEV[f.severity]] ?? t.muted))
          .child(div().flex_1().min_w(0).truncate().text_size(13.5).font_semibold().child(f.title))
          .child(div().text_size(12).text_color(t.muted).child(`${f.file.split("/").pop()}:${f.line}`)))
        .child(div().text_size(12.5).text_color(v ? t[c] : t.muted).whitespace_normal().child(v ? `${{ fixed: "Fixed ✓", not_fixed: "Not fixed: reopened", unclear: "Unclear" }[v.result]} — ${v.reason} (${String(v.head).slice(0, 7)})`
          : `Sent to Fix at ${String(this.find.status[f.id].fixHead).slice(0, 7)}; the head is ${String(this.headNow()).slice(0, 7)} now`));
    };
    return v_flex().gap(12)
      .child(div().text_size(20).font_semibold().child("Verify"))
      .child(div().text_size(13.5).text_color(t.muted).whitespace_normal().child(`Findings sent to Fix before the last push. One ${MODELS[m].label} call reads what changed in their files since and says fixed, not fixed or unclear: fixed ones get ✓, not fixed ones open again with the reason.`))
      .child(h_flex().gap(10).items_center()
        .child(div().id("rv-verify").px(14).h(32).flex().items_center().rounded(8).text_size(13.5).font_semibold().bg(list.length && !this.verifyBusy ? t.solid : t.raised)
          .text_color(list.length && !this.verifyBusy ? t.solid_foreground : t.muted).when(list.length > 0, (e) => e.cursor_pointer()).on_click((_e, cx) => this.runVerify(cx))
          .child(this.verifyBusy ? `Verifying ${this.verifyBusy.n}…` : `Verify fixes (${list.length})`))
        .when(Boolean(this.verifyBusy), (e) => e.child(div().child(SPIN[0]).frames(SPIN, 90))))
      .when(!list.length && !done.length, (e) => e.child(div().text_size(13).text_color(t.muted).child("Nothing to verify: no finding was sent to Fix before the PR head moved.")))
      .children(list.map(card))
      .when(done.length > 0, (e) => e.child(div().pt(6).text_size(11.5).font_semibold().text_color(t.muted).child(`VERIFIED · ${done.length}`)).children(done.map(card)));
  },

  // A rough price before running: input from the diff size, output and thinking from earlier runs; the cap is review.py's.
  estimate(m) {
    const chars = Math.min(MODELS[m].chars, (this.hunks ?? []).reduce((n, h) => n + h.lines.reduce((k, l) => k + l.length + 1, 0), 0));
    const [inp, out] = { haiku: [1, 5], sonnet: [3, 15], opus: [5, 25] }[m];
    // ponytail: reading the code with tools multiplies input; ×4 from the first runs, a guess until the ledger says more.
    const usd = (((chars / 3.5 + 3000) * 4) * inp + 15000 * out) / 1e6;
    return `≈ $${usd.toFixed(2)} · cap $${CAP[m]}`;
  },

  asksPane(t) {
    const task = this.ai.task ?? {};
    return v_flex().flex_none().mt(14).pt(12).px(10).gap(8).border_t(1).border_color(t.border).text_size(13.5)
      .child(div().font_semibold().text_size(14.5).child("Check against the task"))
      .child(div().text_size(12).text_color(t.muted).child(`PR description${task.jira ? ` + Jira ${task.jira}` : ""}`))
      .when(Boolean(task.note), (e) => e.child(div().text_size(12).text_color(t.ansi3).whitespace_normal().child(task.note)))
      .when(!this.ai.asks.length, (e) => e.child(div().text_color(t.muted).child("No task found.")))
      .children(this.ai.asks.map((a, i) => h_flex().id(`rv-ask-${i}`).gap(8).items_start().p(4).rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { const id = a.hunks.find((x) => this.byId.has(x)); if (id) { this.tab = "files"; this.collapsed.delete(this.byId.get(id).path); this.visit(id, cx); this.scrollTo("files", id); } cx.notify(); })
        .child(div().w(78).flex_none().text_size(12).font_semibold().text_color(t[COVER[a.coverage][1]]).child(COVER[a.coverage][0]))
        .child(div().flex_1().min_w(0).line_height(1.5).child(TextView.markdown(`rv-ask-${this.ai.generated}-${i}`, a.text)))
        .when(a.hunks.length > 0, (e) => e.child(div().flex_none().text_size(11.5).text_color(t.muted).child(`${a.hunks.length} ↗`)))));
  },

  // Reviewer findings with filters (reviewer, severity, status), counts, the per-finding workflow, and the ones
  // outside the diff (clicking opens the file whole at that line's hunk, or its header).
  findingsPane(t) {
    const all = this.find.list, shown = this.shownFindings(), f = this.ffilter, runs = this.find.runs;
    const count = (pred) => all.filter(pred).length;
    const chip = (key, value, label, n) => div().id(`rv-ff-${key}-${value}`).px(8).h(24).flex().items_center().rounded(6).cursor_pointer().text_size(12)
      .bg(f[key] === value ? t.selected : t.chrome).text_color(f[key] === value ? t.foreground : t.muted).border_1().border_color(f[key] === value ? t.accent : t.border)
      .on_click((_e, cx) => { this.ffilter = { ...this.ffilter, [key]: value }; cx.notify(); }).child(n === undefined ? label : `${label} ${n}`);
    const inDiff = shown.filter((x) => this.findRow(x) >= 0), outside = shown.filter((x) => this.findRow(x) < 0);
    const open = shown.filter((x) => ["open", "recheck"].includes(this.fstatus(x)));
    const card = (x) => {
      const st = this.fstatus(x), c = t[REVIEWERS[x.reviewer]?.[1]] ?? t.accent, r = this.find.reports[x.id];
      return v_flex().id(`rv-fc-${x.id}`).flex_none().px(10).py(8).gap(6).rounded(8).border_1().border_l(4).border_color(this.ffocus === x.id ? t.accent : c).bg(t.surface).text_size(13.5)
        .child(h_flex().gap(8).items_center().child(badge(t, x.severity, t[SEV[x.severity]])).child(div().text_size(12).font_semibold().text_color(c).child(REVIEWERS[x.reviewer]?.[0] ?? x.reviewer))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(`${x.file.split("/").pop()}:${x.line}`))
          .child(div().id(`rv-fchk-${x.id}`).text_size(14).cursor_pointer().text_color(st === "fixed" ? t.ansi2 : t.muted)
            .on_click((_e, cx) => { this.setFinding(x, st === "fixed" ? "open" : "fixed", cx); cx.stop_propagation(); }).child(st === "fixed" ? "✓" : "○")))
        .child(div().id(`rv-ft-${x.id}`).font_semibold().cursor_pointer().on_click((_e, cx) => { this.ffocus = x.id; this.jumpTo(`${x.file}:${x.line}`, cx); }).child(x.title))
        .child(div().line_height(1.5).child(TextView.markdown(`rv-fd-${x.id}`, x.detail + (x.suggestion ? `\n\n**Suggested:** ${x.suggestion}` : ""))))
        .child(div().text_size(12).text_color(t[FSTATUS[st]?.[1]] ?? t.muted).child(`${FSTATUS[st]?.[0] ?? st}${r?.commit ? ` · ${String(r.commit).slice(0, 8)}` : ""}${r?.note ? ` · ${r.note}` : ""}`))
        .when(Boolean(this.find.status[x.id]?.verify), (e) => { const v = this.find.status[x.id].verify; return e.child(div().text_size(12).whitespace_normal()
          .text_color(t[{ fixed: "ansi2", not_fixed: "ansi1" }[v.result] ?? "ansi3"]).child(`Verified ${String(v.head).slice(0, 7)}: ${v.result.replace("_", " ")} — ${v.reason}`)); })
        .child(h_flex().flex_wrap().gap(6)
          .child(pill(`rv-fcm-${x.id}`, t, "Comment", (_e, cx) => this.findingComment(x, cx)))
          .child(pill(`rv-fdi-${x.id}`, t, "Discuss in chat", (_e, cx) => this.discuss(x, cx)))
          .child(pill(`rv-ffx-${x.id}`, t, "Fix", (_e, cx) => this.fix([x], cx), false, t.foreground))
          .child(pill(`rv-fdm-${x.id}`, t, "Dismiss", (_e, cx) => this.setFinding(x, "dismissed", cx))));
    };
    const sevs = ["high", "medium", "low"].map((k) => [k, all.filter((x) => x.severity === k && OPEN_ST.includes(this.fstatus(x))).length]).filter(([, n]) => n);
    return v_flex().flex_1().min_h(0)
      .child(v_flex().flex_none().px(14).py(10).gap(8).border_b(1).border_color(t.border)
        .child(h_flex().gap(8).items_center().child(div().text_size(14.5).font_semibold().child("Severity findings"))
          .child(div().text_size(12.5).text_color(t.muted).child([`${all.length} ${all.length === 1 ? "finding" : "findings"}`, ...sevs.map(([k, n]) => `${n} ${k}`)].join(" · "))))
        .child(h_flex().flex_wrap().gap(4).child(chip("reviewer", "all", "All", all.length))
          .children(Object.entries(REVIEWERS).filter(([k]) => reviewersNow().some(([n]) => n === k) || this.find.list.some((x) => x.reviewer === k)).map(([k, [label]]) => chip("reviewer", k, label.replace(" review", ""), count((x) => x.reviewer === k)))))
        .child(h_flex().flex_wrap().gap(4).child(chip("severity", "all", "Any severity"))
          .children(["high", "medium", "low"].map((v) => chip("severity", v, v, count((x) => x.severity === v)))))
        .child(h_flex().flex_wrap().gap(4).children([["open", "Open"], ["fixed", "Fixed"], ["dismissed", "Dismissed"], ["all", "All"]].map(([v, label]) =>
          chip("status", v, label, v === "all" ? all.length : v === "open" ? count((x) => ["open", "progress", "recheck"].includes(this.fstatus(x))) : count((x) => this.fstatus(x) === v)))))
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().text_size(12).text_color(t.muted).child(Object.values(runs).some((r) => r.busy) ? "A reviewer is running…" : all.length ? `${shown.length} shown` : "No findings yet: run a reviewer from Reviews ▾ in the top bar."))
          .when(open.length > 0, (e) => e.child(pill("rv-fixall", t, `Fix ${open.length} open (shown)`, (_e, cx) => this.fix(open, cx), false, t.foreground)))))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("rv-find-left").absolute().inset_0().overflow_y_scroll().p(8).gap(6)
          .children(inDiff.map(card))
          .when(outside.length > 0, (e) => e.child(div().pt(8).text_size(12).font_semibold().text_color(t.muted).child(`OUTSIDE THE DIFF · ${outside.length}`)).children(outside.map(card))))
        .child(Scrollbar.vertical("rv-find-left").absolute().inset_0()));
  },

  filesPane(t) {
    const files = this.shown().patch, byPath = new Map(files.map((f) => [f.path, f]));
    const seen = files.filter((f) => this.prog.seen.has(f.path)).length;
    const add = files.reduce((n, f) => n + f.add, 0), del = files.reduce((n, f) => n + f.del, 0);
    return v_flex().flex_1().min_h(0)
      .child(h_flex().flex_none().px(14).h(38).gap(10).items_center().border_b(1).border_color(t.border).text_size(12.5)
        .child(div().flex_1().text_color(t.muted).child(`${seen} of ${files.length} files viewed`))
        .child(div().text_color(t.ansi2).child(`+${add}`)).child(div().text_color(t.ansi1).child(`−${del}`)))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("rv-tree").absolute().inset_0().overflow_y_scroll().p(6)
          .children(fileTree(files.map((f) => f.path), this.closedDirs).map((n) => {
            const f = byPath.get(n.path), cm = f ? this.comments.filter((c) => c.file === f.path).length : 0, sg = f ? this.openSugs(f.path).length : 0;
            return h_flex().id(`rv-t-${n.dir ? "d" : "f"}-${n.path}`).h(28).flex_none().pl(8 + 14 * n.depth).pr(8).gap(8).items_center().rounded(6).text_size(13).cursor_pointer()
              .when(!n.dir && this.fileFocus === n.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => {
                if (n.dir) { if (this.closedDirs.has(n.path)) this.closedDirs.delete(n.path); else this.closedDirs.add(n.path); }
                else { this.tab = "files"; this.fileFocus = n.path; this.collapsed.delete(n.path); this.scrollTo("files", n.path); }
                cx.notify();
              })
              .child(div().w(12).flex_none().text_color(t.muted).child(n.dir ? (this.closedDirs.has(n.path) ? "▸" : "▾") : ""))
              .when(!n.dir, (e) => e.child(div().w(14).flex_none().text_size(11.5).font_semibold().text_color(t[STATUS[f.status][1]]).child(STATUS[f.status][0])))
              .child(div().flex_1().min_w(0).truncate().text_color(n.dir ? t.muted : this.prog.seen.has(n.path) ? t.muted : t.foreground).child(n.dir ? `${n.name}/` : n.name))
              .when(sg > 0, (e) => e.child(div().text_size(11.5).text_color(t.ansi3).child(`⚑ ${sg}`)))
              .when(cm > 0, (e) => e.child(div().text_size(11.5).text_color(t.accent).child(`● ${cm}`)))
              .when(!n.dir && f.add > 0, (e) => e.child(div().text_size(11.5).text_color(t.ansi2).child(`+${f.add}`)))
              .when(!n.dir && f.del > 0, (e) => e.child(div().text_size(11.5).text_color(t.ansi1).child(`−${f.del}`)))
              .when(!n.dir, (e) => e.child(div().id(`rv-seen-${n.path}`).w(16).flex_none().text_color(this.prog.seen.has(n.path) ? t.ansi2 : t.muted)
                .on_click((_e, cx) => { this.toggleSeen(n.path, cx); cx.stop_propagation(); cx.notify(); }).child(this.prog.seen.has(n.path) ? "☑" : "☐")));
          })))
        .child(Scrollbar.vertical("rv-tree").absolute().inset_0()));
  },

  // ---- render: the diff list (inside the virtual list: no handlers, onItem places clicks by x)

  // Lines a wrapped text takes in a card of the diff column (UI font ≈ 7.4 px per char at 13.5 px).
  lines(text) { return Math.max(1, Math.ceil(String(text).length / Math.max(30, ((this.listW ?? 900) - GUTTER - 60) / 7.4))) + (String(text).match(/\n/g)?.length ?? 0); },

  sizeOf(it) {
    if (it.t === "row") return it.src[it.ri].kind === "@" ? 30 : ROW;
    if (it.t === "step") return 66 + 24 * it.s.questions.length;
    if (it.t === "sug") return 44 + 21 * this.lines(it.s.reason);
    if (it.t === "comment") return 44 + 21 * this.lines(it.c.text);
    if (it.t === "sugact" || it.t === "cact" || it.t === "fact") return ACT;
    if (it.t === "def") return 190;
    if (it.t === "find") return 44 + 21 * Math.min(3, this.lines(`${it.f.title} ${it.f.detail}`));
    return { path: 30, file: 44, gap: 30, note: 30 }[it.t];
  },

  item(it, t) {
    const mono = (e) => e.font_family(settings().font_family ?? "JetBrains Mono");
    if (it.t === "row") {
      const r = it.src[it.ri];
      if (r.kind === "@") {
        const m = /^(@@[^@]*@@)\s?(.*)$/.exec(r.text) ?? [null, r.text, ""];
        return mono(h_flex()).h(30).w_full().pl(GUTTER - 4).pr(12).gap(10).items_center().bg(t.accent + "14").border_t(1).border_b(1).border_color(t.border).text_size(12.5)
          .child(div().flex_none().text_color(t.muted).child(m[1])).child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(m[2]));
      }
      const on = Boolean(this.selKeys && this.fsel?.path === it.path && this.selKeys.has(lineKey(r)));
      const tone = r.kind === "+" ? t.ansi2 : r.kind === "-" ? t.ansi1 : null, focus = it.hunk && it.hunk === this.focusHunk;
      const num = (n) => div().w(48).h_full().flex_none().pr(8).flex().items_center().justify_end().text_color(t.muted).child(n === undefined ? "" : String(n));
      return mono(h_flex()).h(ROW).w_full().text_size(13).cursor_pointer()
        .when(Boolean(tone), (e) => e.bg(tint(r.kind) + "1a")).when(on, (e) => e.bg(t.selection))
        .child(div().w(4).h_full().flex_none().when(on, (e) => e.bg(t.accent)).when(!on && Boolean(focus), (e) => e.bg(t.accent + "55")))
        .child(h_flex().h_full().flex_none().when(Boolean(tone), (e) => e.bg(tint(r.kind) + "40")).child(num(r.o)).child(num(r.n)))
        .child(div().w(22).flex_none().text_center().font_semibold().text_color(tone ?? t.muted).child(r.kind === " " ? "" : r.kind === "-" ? "−" : "+"))
        .child(div().flex_1().min_w(0).pr(12).truncate().text_color(t.foreground).child(this.code(r, it)))
        .when(Boolean(this.traces?.get(`${it.path}:${r.n}`)) && r.kind !== "-", (e) => e.child(div().flex_none().max_w(460).mr(12).px(8).h(18).flex().items_center()
          .rounded(9).bg(t.accent + "1f").italic().text_size(12).text_color(t.muted).truncate().child(this.traces.get(`${it.path}:${r.n}`))));
    }
    if (it.t === "gap") {
      const h = it.r.hidden, seg = (label) => div().w(GAP_SEG).flex_none().child(label);
      return h_flex().h(30).w_full().items_center().bg(t.surface).border_t(1).border_b(1).border_color(t.border).text_size(12.5).text_color(t.accent).cursor_pointer()
        .child(div().w(GUTTER).flex_none().text_center().text_color(t.muted).child("⋯"))
        .child(seg(`↓ ${MORE} lines`)).child(seg(`↑ ${MORE} lines`))
        .child(div().flex_1().child(h === null ? "Load rest of file" : `Show all ${h} lines`));
    }
    if (it.t === "sug" || it.t === "sugact") {
      const s = it.s, c = t[LEVEL[s.severity]];
      const card = (e) => e.border_l(4).border_r(1).border_color(this.sug === s.key ? t.accent : c).bg(c + "14");
      if (it.t === "sugact") {
        return div().w_full().h(ACT).pl(GUTTER).pr(16).pb(6).child(card(h_flex()).size_full().px(12).gap(BTN_GAP).items_center().border_b(1)
          .child(button(t, "Accept (a)", c, t.foreground)).child(button(t, "Dismiss (x)", t.border, t.muted)));
      }
      return div().w_full().h(this.sizeOf(it)).pl(GUTTER).pr(16).pt(6).child(card(v_flex()).size_full().px(12).pt(8).gap(6).border_t(1).text_size(13.5)
        .child(h_flex().h(18).gap(8).items_center().child(badge(t, s.severity, c)).child(div().text_size(12).text_color(t.muted).child(`AI suggestion · line ${s.line}${s.approx ? " ~" : ""}`)))
        .child(div().flex_1().min_h(0).overflow_hidden().line_height(1.55).whitespace_normal().child(plain(s.reason))));
    }
    if (it.t === "find" || it.t === "fact") {
      const f = it.f, c = t[REVIEWERS[f.reviewer]?.[1]] ?? t.accent, st = this.fstatus(f);
      const card = (e) => e.border_l(4).border_r(1).border_color(c).bg(c + "12");
      if (it.t === "fact") {
        return div().w_full().h(ACT).pl(GUTTER).pr(16).pb(6).child(card(h_flex()).size_full().px(12).gap(BTN_GAP).items_center().border_b(1)
          .child(button(t, "Comment", t.border, t.foreground)).child(button(t, "Discuss in chat", t.border, t.foreground))
          .child(button(t, "Fix", c, t.foreground)).child(button(t, "Dismiss", t.border, t.muted)));
      }
      return div().w_full().h(this.sizeOf(it)).pl(GUTTER).pr(16).pt(6).child(card(v_flex()).size_full().px(12).pt(8).gap(4).border_t(1).text_size(13.5)
        .child(h_flex().h(18).gap(8).items_center().child(badge(t, f.severity, t[SEV[f.severity]])).child(div().text_size(12).font_semibold().text_color(c).child(REVIEWERS[f.reviewer]?.[0] ?? f.reviewer))
          .child(div().text_size(12).text_color(t[FSTATUS[st]?.[1]] ?? t.muted).child(FSTATUS[st]?.[0] ?? st)))
        .child(div().flex_1().min_h(0).overflow_hidden().line_height(1.55).whitespace_normal().child(`${f.title}. ${plain(f.detail)}`)));
    }
    if (it.t === "comment" || it.t === "cact") {
      const c = it.c, at = Number.parseInt(c.id, 36), time = Number.isFinite(at) ? new Date(at).toTimeString().slice(0, 5) : "";
      const card = (e) => e.border_l(4).border_r(1).border_color(this.editing?.id === c.id ? t.accent : t.border).bg(t.surface);
      if (it.t === "cact") {
        return div().w_full().h(ACT).pl(GUTTER).pr(16).pb(6).child(card(h_flex()).size_full().px(12).gap(BTN_GAP).items_center().border_b(1)
          .child(button(t, "Edit", t.border, t.foreground)).child(button(t, "Delete", t.border, t.ansi1)));
      }
      return div().w_full().h(this.sizeOf(it)).pl(GUTTER).pr(16).pt(6).child(card(v_flex()).size_full().px(12).pt(8).gap(6).border_t(1).text_size(13.5)
        .child(h_flex().h(18).gap(8).items_center().text_size(12)
          .child(div().font_semibold().text_color(t.foreground).child("You"))
          .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(`${time} · pending${c.from === "ki" ? " · from AI suggestion" : ""}${it.loose ? ` · ${uiLine(c)}, not shown` : ""}`)))
        .child(div().flex_1().min_h(0).overflow_hidden().line_height(1.55).whitespace_normal().text_color(t.foreground).child(c.text)));
    }
    if (it.t === "file") {
      const f = it.f, closed = this.collapsed.has(f.path), seen = this.prog.seen.has(f.path), [letter, col] = STATUS[f.status];
      const n = this.comments.filter((c) => c.file === f.path).length, whole = this.whole.has(f.path);
      return h_flex().h(44).w_full().items_center().bg(this.fileFocus === f.path ? t.selected : t.raised).border_t(1).border_b(1).border_color(t.border).text_size(13).cursor_pointer()
        .child(div().w(FILE_CHEV).flex_none().text_center().text_color(t.muted).child(closed ? "▸" : "▾"))
        .child(div().w(FILE_SEEN).flex_none().text_size(12.5).text_color(seen ? t.ansi2 : t.muted).child(seen ? "☑ Viewed" : "☐ Viewed"))
        .child(div().w(FILE_WHOLE).flex_none().text_size(12.5).text_color(whole ? t.accent : t.muted).child(this.shown().fileHunks?.has(f.path) ? (whole ? "◉ Whole file" : "○ Whole file") : ""))

        .child(div().w(22).flex_none().text_size(12).font_semibold().text_color(t[col]).child(letter))
        .child(mono(div()).flex_1().min_w(0).truncate().font_semibold().text_size(13.5).child(f.status === "renamed" ? `${f.from} → ${f.path}` : f.path))
        .when(n > 0, (e) => e.child(div().px(8).text_size(12).text_color(t.accent).child(`● ${n}`)))
        .child(div().px(4).text_size(12.5).text_color(t.ansi2).child(`+${f.add}`)).child(div().pl(2).pr(16).text_size(12.5).text_color(t.ansi1).child(`−${f.del}`));
    }
    if (it.t === "step") {
      const s = it.s, on = it.i === this.cur;
      return v_flex().w_full().h(this.sizeOf(it)).px(16).pt(10).gap(4).bg(on ? t.selected : t.raised).border_t(1).border_color(t.border).cursor_pointer()
        .child(h_flex().h(24).gap(10).items_center()
          .child(div().text_size(14).font_semibold().text_color(this.done(s) ? t.ansi2 : t.muted).child(this.done(s) ? "✓" : `${it.i + 1}`))
          .child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().child(plain(s.title)))
          .when(!s.pseudo, (e) => e.child(riskBadge(t, s))))
        .child(div().h(22).truncate().text_size(13.5).text_color(t.foreground).child(plain(s.why)))
        .children(s.questions.map((q) => div().h(24).truncate().text_size(13.5).text_color(t.muted).child(`?  ${plain(this.asked(s, q))}`)));
    }
    if (it.t === "def") return this.defItem(it, t);
    if (it.t === "path") return mono(h_flex()).h(30).w_full().px(16).items_center().text_size(12.5).text_color(t.muted).truncate().child(it.h.path);
    return div().h(30).w_full().px(16).flex().items_center().text_size(12.5).text_color(t.ansi3).child(it.text);
  },

  // A row's code: plain text now; phase 3 (syntax.js) swaps in highlighted spans here.
  // A row's code, highlighted (syntax.js); spans per row array are computed once per render (spanMap).
  code(r, it) {
    const m = this.spanMap?.get(it.src);
    return h_flex().overflow_hidden().children(renderLine(div, m?.shown[it.ri]?.text ?? r.text, m?.spans[it.ri] ?? [], this.syn));
  },

  renderReview(cx) {
    const t = theme(), target = shared("review.target") ?? null;
    if (target?.url !== this.prSel?.url) { this.prSel = target; this.resetReview(); }
    // After a refresh for the previous target ended; queued, since refresh() notifies and render may not.
    if (!this.refreshQueued && this.prSel && this.key() !== this.context) {
      this.refreshQueued = true;
      cx.timer.after(0, (cx) => { this.refreshQueued = false; this.refresh(cx); });
    }
    if (this.hunks && model() !== this.aiModel && !this.aiBusy) this.loadAi(cx, "cache");
    const other = target && !C.shown(ctxDoc(), prCtx(target), shared);
    const root = v_flex().id("rv-root").size_full().bg(t.background).text_color(t.foreground).text_size(13.5)
      .on_size_change((size, cx) => { if (Math.abs((this.listW ?? 0) - (size.width - LEFT)) > 8) { this.listW = size.width - LEFT; cx.notify(); } })
      .track_focus(this.fh).on_key_down((e, cx) => this.onReviewKey(e, cx));
    if (!target || other) {
      return root.items_center().justify_center().gap(12).text_color(t.muted)
        .child(div().child(other ? `This PR belongs to ${C.nameOf(ctxDoc(), prCtx(target))}, which the current view hides.`
          : 'No PR selected: click "Review" on a PR in the PR panel.'))
        .child(pill("rv-empty-back", t, "← Back (Esc)", () => leave()));
    }
    this.traces = this.traceMap();
    const { items, at } = this.itemsOf(this.tab === "steps" ? "steps" : "files");
    if (this.pendingScroll && at[this.pendingScroll] !== undefined) { this.lists[this.tab === "steps" ? "steps" : "files"].scroll_to_item(at[this.pendingScroll], "top"); this.pendingScroll = null; }
    this.uiChanged(cx);
    this.syn = colors(t); this.spanMap = new Map();
    for (const it of items) {
      if (it.t !== "row" || this.spanMap.has(it.src)) continue;
      const shown = it.src.map((r) => (r.text?.includes("\t") ? { ...r, text: expandTabs(r.text) } : r)); // tabs drawn as spaces: clicks map back
      this.spanMap.set(it.src, { shown, spans: highlightRows(shown, langOf(it.path), `${this.worktree?.head ?? ""}:${it.path}`) });
    }
    const keys = itemKeys(items);
    this.items = items; this.at = at; this.byKey = new Map(keys.map((k, i) => [k, items[i]]));
    const listId = `rv-list-${this.tab === "steps" ? "steps" : "files"}`, sug = this.openSugs().find((s) => s.key === this.sug);
    const anchor = this.selAnchor();
    const range = this.fsel && rangeOf(this.rowsFor(this.fsel.path), this.fsel.a, this.fsel.b);
    this.selKeys = range ? new Set(this.rowsFor(this.fsel.path).slice(range[0], range[1] + 1).map(lineKey)) : null;
    const where = this.editing ? "Editing comment" : this.fsel ? `On ${this.fsel.path.split("/").pop()}, ${uiLine(anchor)}` : "Click a line number to comment (shift-click: a range)";
    const canSend = Boolean((this.root || this.pr) && !this.sending), n = this.comments.length;
    const tabBtn = (id, label) => div().id(`rv-tab-${id}`).flex_1().h(32).flex().items_center().justify_center().rounded(7).text_size(13.5).cursor_pointer()
      .bg(this.tab === id ? t.selected : t.chrome).text_color(this.tab === id ? t.foreground : t.muted).when(this.tab === id, (e) => e.font_semibold()).hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { this.tab = id; cx.notify(); }).child(label);
    return root
      .child(h_flex().flex_1().min_h(0)
        .child(v_flex().w(LEFT).flex_none().h_full().bg(t.chrome).border_r(1).border_color(t.border)
          .child(h_flex().flex_none().p(8).gap(6).border_b(1).border_color(t.border)
            .child(tabBtn("files", `Files · ${this.shown().patch.length}`)).child(tabBtn("steps", `Layers${this.ai ? ` · ${this.ai.steps.filter((s) => !s.pseudo).length}` : ""}`))
            .child(tabBtn("findings", `Findings${this.find.list.length ? ` · ${this.find.list.filter((x) => ["open", "progress", "recheck"].includes(this.fstatus(x))).length}` : ""}`)))
          .child(this.tab === "steps" ? this.stepsPane(t) : this.tab === "findings" ? this.findingsPane(t) : this.filesPane(t)))
        .child(v_flex().flex_1().min_w(0).h_full()
          .child(div().id("rv-probe").absolute().top(-100).font_family(settings().font_family ?? "JetBrains Mono").text_size(13).whitespace_nowrap()
            .on_size_change((size, cx) => { const w = size.width / PROBE.length; if (w > 0 && Math.abs((this.charW ?? 0) - w) > 0.01) { this.charW = w; cx.notify(); } }).child(PROBE))
          .when(Boolean(this.defFile), (e) => e.child(this.defView(t)))
          .when(!this.defFile && this.tab === "steps" && Boolean(this.page), (e) => e.child(this.pageView(t)))
          .when(!this.defFile && this.tab === "files" && Boolean(this.since), (e) => e.child(this.sinceBanner(t)))
          .when(Boolean(this.needClone), (e) => e.child(h_flex().flex_none().px(14).py(8).gap(10).items_center().bg(t.ansi3 + "1c").border_b(1).border_color(t.border).text_size(12.5)
            .child(div().flex_1().min_w(0).whitespace_normal().child(`No local clone of ${target.repo ?? "this repo"}: reviewers, whole files, definitions and the AI analysis need one. The diff works without.`))
            .child(pill("rv-clone", t, this.cloning ? "Cloning…" : `Clone to ${this.needClone.replace(home(), "~")}`, (_e, cx) => { if (!this.cloning) { this.makeWorktree(cx, true); cx.notify(); } }, false, t.foreground))))

          .when(!this.defFile && !(this.tab === "steps" && this.page), (e) => e.child(div().id(`${listId}-wrap`).flex_1().min_h(0).relative()

            .on_mouse_down("left", (e, cx) => { this.press = { x: e.local_position?.x ?? 0, w: e.bounds?.width ?? this.listW ?? 900, shift: e.modifiers.shift, cmd: e.modifiers.platform }; this.fh.focus(); })
            .child(items.length
              ? v_virtual_list(listId, items.length, items.map((it) => this.sizeOf(it)), (i) => keys[i], (range) => items.slice(range.start, range.end).map((it) => this.item(it, t)))
                .track_scroll(this.lists[this.tab === "steps" ? "steps" : "files"]).on_item_click((key, cx) => this.onItem(key, cx)).size_full()
              : div().p(20).text_size(13.5).text_color(this.error ? t.ansi1 : t.muted).child(this.error || (this.loading || !this.patch
                ? h_flex().gap(8).child(div().child(SPIN[0]).frames(SPIN, 90)).child("Loading…") : "No diff")))
            .child(Scrollbar.vertical(listId).absolute().inset_0())))
          .when(Boolean(sug), (e) => e.child(div().flex_none().p(10).border_t(1).border_color(t.border).child(this.sugCard(sug, t, false))))
          .when(Boolean(this.note), (e) => e.child(div().flex_none().px(14).pt(8).text_size(12.5).text_color(/Could not|Not sent|Select a line/.test(this.note ?? "") ? t.ansi1 : t.muted).child(this.note)))
          .child(v_flex().flex_none().px(14).py(10).gap(8).border_t(1).border_color(t.border).bg(t.chrome)
            .child(h_flex().gap(12).items_center()
              .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(this.fsel || this.editing ? t.foreground : t.muted).child(where))
              .child(h_flex().flex_none().gap(10).items_center().text_size(12).text_color(t.muted)
                .children([["j", "k", "step"], ["n", "p", "hunk"], ["c", null, "comment"], ["a", "x", "suggestion"], ["⌘", "click", "definition"], ["Esc", null, "back"]].map(([a, b, what]) =>
                  h_flex().gap(3).items_center().child(kbd(t, a)).when(Boolean(b), (e) => e.child(kbd(t, b))).child(div().pl(2).child(what))))))
            .child(h_flex().gap(8).items_center()
              .child(div().id("rv-input").flex_1().min_w(0).h(36).px(12).flex().items_center().rounded(8).border_1().bg(t.background).border_color(this.typing ? t.accent : t.border).cursor_text()
                .on_mouse_down("left", (_e, cx) => { if (!this.editing) this.ensureSel(); cx.stop_propagation(); })
                .child(Input.new(this.input).h_full().text_size(13.5).text_color(t.foreground)))
              .child(pill("rv-comment", t, this.editing ? "Save" : "Comment", (_e, cx) => this.addFull(cx), false, this.question.trim() ? t.foreground : t.muted))
              .when(Boolean(this.editing), (e) => e.child(pill("rv-cdel", t, "Delete", (_e, cx) => { this.dropComment(this.editing, cx); }, false, t.ansi1)))
              .child(div().w(1).h(24).bg(t.border))
              .child(div().flex_none().text_size(13).text_color(t.muted).child(`${n} pending ${n === 1 ? "comment" : "comments"}`))
              .when(n > 0, (e) => e.child(pill("rv-rdrop", t, "Discard", (_e, cx) => { this.comments = []; this.persist(cx); cx.notify(); })))
              .child(div().id("rv-send").px(14).h(36).flex().items_center().rounded(8).text_size(13.5).font_semibold().bg(canSend && n ? t.solid : t.raised)
                .text_color(canSend && n ? t.solid_foreground : t.muted).when(canSend && n > 0, (e) => e.cursor_pointer())
                .on_click((_e, cx) => this.sendReview(cx)).child(this.sending ? "…" : "Send review"))))));
  },
};
