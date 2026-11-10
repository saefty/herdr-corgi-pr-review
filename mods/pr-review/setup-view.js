// The Setup view (the panel's "Setup" pill, and by itself on first open): which programs are there, what each
// enables, and how to install the missing ones. The result is cached in shared "pr-review.setup"
// ({at, os, found, auth}); "Check again" re-runs it. "Install in terminal" opens a tab with the command typed at a
// prompt but not run: Enter runs it. Also small helpers other files share (clipboard, browser, settings file).
import { div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar } from "gpui-base";
import { exec, run, shared, setShared, appHome, readTextFile } from "herdr";
import { checkScript, parseCheck, report, blockers, found, pretypeArgv } from "./setup.js";

export const SETUP_KEY = "pr-review.setup";
const MARK = { ok: ["✓", "ansi2"], missing: ["missing", "ansi1"], "optional-missing": ["not installed", "muted"], "logged-out": ["logged out", "ansi3"] };
const GROUPS = [["required", "Required"], ["optional", "Optional"], ["lsp", "Go to definition (language servers; a missing one only turns it off for that language)"]];

export const hasTool = (name) => found(shared(SETUP_KEY), name);

// The settings file (optional, PROVIDERS.md): language, cloneRoot, globalRules, ledger, sessionTitles.
export const configFile = () => `${appHome()}/pr-review.config.json`;
export async function readConfig() {
  try { return JSON.parse(await readTextFile(configFile()) ?? "{}") ?? {}; } catch { return {}; }
}

// Clipboard and browser on macOS and Linux.
export const copyText = (text) => exec("sh", ["-c", 'printf %s "$0" | (pbcopy 2>/dev/null || wl-copy 2>/dev/null || xclip -selection clipboard 2>/dev/null)', text]).catch(() => null);
export const openUrl = (url) => exec("sh", ["-c", 'open "$0" 2>/dev/null || xdg-open "$0"', url]).catch(() => null);

// Runs the check (one shell, about 2 s) unless a cached one is there and !force.
export function runSetup(view, cx, force = true) {
  if (view.setupBusy || (!force && shared(SETUP_KEY))) return;
  view.setupBusy = true;
  cx.spawn(async (cx) => {
    const [r, os] = await Promise.all([exec("sh", ["-c", checkScript()], { timeout: 30000 }).catch((e) => ({ stdout: "", stderr: String(e) })),
      exec("uname", ["-s"]).then((x) => (/linux/i.test(x.stdout) ? "linux" : "darwin")).catch(() => "darwin")]);
    setShared(SETUP_KEY, { at: Date.now(), os, ...parseCheck(r.stdout) });
    view.setupBusy = false;
    cx.notify();
  });
}

// On first open (nothing cached): check, and show Setup when something required is missing.
export async function loadSetup(view, cx) {
  if (shared(SETUP_KEY)) return;
  runSetup(view, cx, true);
  view.setupFirst = true;
}

const rows = () => { const s = shared(SETUP_KEY); return s ? report(s, s.os) : null; };

// The PR panel's banner when a required program is missing or logged out; null otherwise.
export function setupBanner(view, t) {
  const r = rows(), b = r ? blockers(r) : [];
  if (view.setupFirst && b.length && view.view !== "setup") { view.view = "setup"; view.setupFirst = false; }
  if (!b.length || view.view === "setup") return null;
  return h_flex().flex_none().px(14).py(6).gap(8).items_center().bg(t.ansi1 + "1c").border_b(1).border_color(t.border).text_size(12)
    .child(div().flex_1().min_w(0).whitespace_normal().child(`Needs ${b.map((x) => `${x.id}${x.status === "logged-out" ? " (logged out)" : ""}`).join(", ")} to work.`))
    .child(div().id("pr-setup-banner").px(8).py(1).rounded(5).border_1().border_color(t.border).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { view.view = "setup"; cx.notify(); }).child("Open Setup"));
}

function install(view, row, cx) {
  run("tab.new", { name: `Install ${row.id}`, argv: pretypeArgv(row.install) });
  view.note = `Opened a terminal with "${row.install}" typed in: press Enter there to run it, then Check again.`;
  cx.notify();
}

export function renderSetup(view, t) {
  const s = shared(SETUP_KEY), r = rows();
  const btn = (id, label, click, strong = false) => div().id(id).flex_none().px(8).h(22).flex().items_center().rounded(5).border_1()
    .border_color(strong ? t.accent : t.border).text_size(11).text_color(strong ? t.foreground : t.muted).cursor_pointer()
    .hover((st) => st.text_color(t.foreground)).on_click(click).child(label);
  const line = (x) => v_flex().flex_none().px(8).py(5).gap(2).rounded(6).hover((st) => st.bg(t.hover))
    .child(h_flex().gap(8).items_center()
      .child(div().flex_none().w(84).text_size(11).text_color(t[MARK[x.status][1]]).child(MARK[x.status][0]))
      .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(12).child(x.id))
      .when(Boolean(x.install), (e) => e
        .child(btn(`setup-copy-${x.id}`, "Copy", (_e, cx) => { copyText(x.install); view.note = `Copied: ${x.install}`; cx.notify(); }))
        .child(btn(`setup-run-${x.id}`, x.status === "logged-out" ? "Log in in terminal" : "Install in terminal", (_e, cx) => install(view, x, cx), x.need === "required"))))
    .child(div().pl(92).text_size(11).text_color(t.muted).whitespace_normal().child(x.what))
    .when(Boolean(x.install), (e) => e.child(div().pl(92).text_size(11).text_color(t.dim).font_family("JetBrains Mono").child(x.install)))
    .when(!x.install && x.status !== "ok", (e) => e.child(div().pl(92).text_size(11).text_color(t.dim).child("See the project's install page for this OS.")));
  return div().flex_1().min_h(0).relative()
    .child(v_flex().id("pr-setup").absolute().inset_0().overflow_y_scroll().p(10).gap(8)
      .child(h_flex().flex_none().gap(8).items_center()
        .child(div().flex_1().min_w(0).text_size(12).text_color(t.muted).whitespace_normal()
          .child(view.setupBusy ? "Checking…" : s ? `Checked ${new Date(s.at).toLocaleTimeString()}. A mod can't install programs; Install opens a terminal with the command typed in, not run.` : "Not checked yet."))
        .child(btn("setup-check", view.setupBusy ? "…" : "Check again", (_e, cx) => runSetup(view, cx, true)))
        .child(btn("setup-close", "Close", (_e, cx) => { view.view = "diff"; cx.notify(); })))
      .children(r ? GROUPS.map(([need, title]) => v_flex().flex_none().gap(2)
        .child(div().px(8).pt(4).text_size(11).font_semibold().text_color(t.muted).child(title.toUpperCase()))
        .children(r.filter((x) => x.need === need).map(line))) : []))
    .child(Scrollbar.vertical("pr-setup").absolute().inset_0());
}
