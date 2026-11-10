#!/usr/bin/env python3
"""The AI analysis of one PR (or branch diff) for the review layout's "AI" tab and the panel's walkthrough.

argv[1]: JSON {out, latest, status, model (haiku|sonnet|opus), context ({id, env, tickets}), pr (url or
null), source, worktree (the PR head checked out, or the repo root; null: diff only), hunks: [{alias, id, path,
lines}], cut: [aliases left out for size]; incremental runs add previous (the shown analysis' file), since
({base, head}) and full (today's whole-diff hunks [{alias, id, path, head}]) and send only the new hunks (n1..)}.
One thorough run (--effort high; read-only tools in the worktree so it can check callers and types) for: a summary,
the check against the task (PR title/body + the Jira ticket a key names, via acli when installed), and steps with risk,
why it matters, an explanation, reading order, check questions, suggestions on lines and flows (example payloads in
and out of changed functions, with a trace of values per line). Also behavior, merge risk, review effort, repo rule checks (rules
from the checkout's CLAUDE.md/AGENTS.md/CONTRIBUTING.md/.github instructions/ADRs plus the configured global rules), an
architecture picture, the blast radius (upstream candidates from git grep) and an optional picture per layer. Writes {source, model, model_id, hunks, answer, cut,
cost, ms, budget, task, generated} to `out` and `latest`; `status` holds {busy, pid, started} while it runs, then
{done} or {error}. Every call goes to the optional usage ledger (llm.py). Texts are in the configured language. Exit 1 with the reason on stderr.
"""
import datetime as dt
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys

import llm  # noqa: E402  (this folder)

FEATURE = "Review analysis"
FEATURE_INC = "Review analysis (since last review)"
FEATURE_DIAGRAMS = "Review diagrams"
BUDGET_DIAGRAMS = {"haiku": 0.5, "sonnet": 1.5, "opus": 5.0}
BUDGET = {"haiku": 1.0, "sonnet": 3.0, "opus": 10.0}  # --max-budget-usd per run
TIMEOUT = 15 * 60
KEY = re.compile(r"(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,6})(?![A-Za-z0-9])")
NOT_JIRA = {"PR", "ADR", "PEP", "CWE", "UTF", "SHA", "ISO", "RFC", "CVE", "GH", "HTTP", "TLS", "X86", "ARM", "MD5", "BASE64"}
LEVELS = ["high", "medium", "low"]
READ_ONLY = ["Read", "Grep", "Glob", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash(git blame:*)",
             "Bash(git grep:*)", "Bash(git ls-files:*)"]
SYSTEM = ("You are a thorough, experienced code reviewer and guide a person through the review of a pull request in {lang}: "
          "ordered by risk, with concrete check points and only real suspicious spots verified in the code, no style "
          "criticism. Take your time: read callers, types and surrounding code before you claim anything. "
          "At the end, answer only in the requested JSON.")
S, STRINGS = {"type": "string"}, {"type": "array", "items": {"type": "string"}}
FLOW = {"type": "object", "required": ["function", "at", "inputs", "output"], "properties": {
    "function": S, "at": S,
    "inputs": {"type": "array", "items": {"type": "object", "required": ["name", "type", "example"], "properties": {"name": S, "type": S, "example": S}}},
    "output": {"type": "object", "required": ["type", "example"], "properties": {"type": S, "example": S}},
    "side_effects": STRINGS, "calls": STRINGS,
    "trace": {"type": "array", "maxItems": 12, "items": {"type": "object", "required": ["path", "line", "values"], "properties": {
        "path": S, "line": {"type": "integer"}, "values": S}}}}}
# A picture of one layer (or of the whole PR); the model picks the kinds that explain it best (or leaves them out).
# state_machine: nodes may carry a type (Step Functions state types), parent/branch (inside a Parallel or Map state);
# transitions carry event [guard] / action, and error ("catch" | "retry") for error paths.
# Where an element comes from: implemented (in this PR's diff; evidence file:line), existing (already in the codebase,
# unchanged), spec (only in the PR description, ticket, ADRs or spec docs, not found in the diff).
SOURCE = {"enum": ["implemented", "existing", "spec"]}
STATEMENT = {"type": "object", "required": ["text", "source"], "properties": {"text": S, "source": SOURCE, "evidence": S}}
STATE_TYPES = ["task", "choice", "parallel", "map", "wait", "pass", "fail", "succeed", "state"]
TRANSITION = {"type": "object", "required": ["from", "to"], "properties": {
    "from": S, "to": S, "label": S, "event": S, "guard": S, "action": S, "changed": {"type": "boolean"}, "error": {"enum": ["catch", "retry"]},
    "source": SOURCE, "evidence": S}}
VISUAL = {"type": "object", "required": ["kind", "title", "nodes", "edges"], "properties": {
    "kind": {"enum": ["architecture", "flow", "sequence", "state_machine", "steps"]}, "title": S,
    "nodes": {"type": "array", "maxItems": 12, "items": {"type": "object", "required": ["id", "label"], "properties": {
        "id": S, "label": S, "changed": {"type": "boolean"}, "note": S, "at": S, "type": {"enum": STATE_TYPES}, "parent": S, "branch": {"type": "integer"},
        "source": SOURCE, "evidence": S}}},
    "edges": {"type": "array", "maxItems": 16, "items": TRANSITION},
    "transitions": {"type": "array", "maxItems": 16, "items": TRANSITION}}}
VISUALS = {"type": "array", "maxItems": 3, "items": VISUAL}
STATUS = {"enum": ["new", "changed", "unchanged", "removed"]}
ARCHITECTURE = {"type": "object", "required": ["groups", "nodes", "edges"], "properties": {
    "groups": {"type": "array", "maxItems": 5, "items": {"type": "object", "required": ["id", "label", "kind"], "properties": {"id": S, "label": S, "kind": S}}},
    "nodes": {"type": "array", "maxItems": 12, "items": {"type": "object", "required": ["id", "group", "label", "description", "type", "status"], "properties": {
        "id": S, "group": S, "label": S, "description": S, "type": S, "status": STATUS, "at": S, "source": SOURCE, "evidence": S,
        "states": {"type": "array", "maxItems": 10, "items": {"type": "object", "required": ["name", "type"], "properties": {
            "name": S, "type": {"enum": STATE_TYPES}, "calls": S, "status": STATUS, "source": SOURCE, "evidence": S}}}}}},
    "edges": {"type": "array", "maxItems": 16, "items": {"type": "object", "required": ["from", "to", "label"], "properties": {
        "from": S, "to": S, "label": S, "status": STATUS, "source": SOURCE, "evidence": S}}}}}
BLAST = {"type": "object", "required": ["units", "context"], "properties": {
    "units": {"type": "array", "maxItems": 8, "items": {"type": "object", "required": ["id", "label", "type", "status", "files", "spots"], "properties": {
        "id": S, "label": S, "type": S, "status": {"enum": ["added", "changed", "removed"]}, "files": STRINGS, "spots": {"type": "integer"}}}},
    "context": {"type": "array", "maxItems": 8, "items": {"type": "object", "required": ["id", "file", "direction", "relation", "links_to"], "properties": {
        "id": S, "file": S, "direction": {"enum": ["upstream", "downstream"]}, "relation": S, "links_to": S}}}}}
SCHEMA = {"type": "object", "required": ["title", "summary", "behavior", "merge_risk", "effort", "rule_checks", "architecture", "blast_radius", "steps", "asks"], "properties": {
    "title": S, "summary": S, "behavior": S,
    "merge_risk": {"type": "object", "required": ["level", "why"], "properties": {"level": {"enum": ["minimal", "low", "medium", "high", "critical"]}, "why": S}},
    "effort": {"type": "object", "required": ["score", "why"], "properties": {"score": {"type": "integer", "minimum": 1, "maximum": 5}, "why": S}},
    "rule_checks": {"type": "array", "maxItems": 20, "items": {"type": "object", "required": ["rule", "source", "status", "why"], "properties": {
        "rule": S, "source": S, "status": {"enum": ["pass", "fail", "n/a"]}, "where": S, "why": S}}},
    "architecture": ARCHITECTURE, "blast_radius": BLAST, "visuals": VISUALS,
    "intent": {"type": "array", "maxItems": 6, "items": STATEMENT}, "behavior_points": {"type": "array", "maxItems": 6, "items": STATEMENT},
    "asks": {"type": "array", "items": {"type": "object", "required": ["text", "coverage", "hunks"], "properties": {
        "text": S, "coverage": {"enum": ["seen", "partly", "absent", "extra"]}, "hunks": STRINGS, "elements": STRINGS}}},
    "steps": {"type": "array", "items": {"type": "object", "required": ["title", "risk", "why_it_matters", "explanation", "reading_order", "hunks", "check_questions"], "properties": {
        "title": S, "risk": {"enum": LEVELS + ["skim"]}, "why_it_matters": S, "explanation": S, "reading_order": {"type": "integer"},
        "hunks": STRINGS, "check_questions": {**STRINGS, "maxItems": 3},
        "suggestions": {"type": "array", "items": {"type": "object", "required": ["hunk", "line", "side", "severity", "text"], "properties": {
            "hunk": S, "line": {"type": "integer"}, "side": {"enum": ["new", "old"]}, "severity": {"enum": LEVELS}, "text": S}}},
        "flows": {"type": "array", "maxItems": 3, "items": FLOW}, "visuals": VISUALS}}}}}


def jira_key(title, branch, body):
    """The first ticket key: in title and body only written in capitals (SHELF-12), in the branch in any case (shelf-12-x)."""
    for text, any_case in ((title, False), (branch, True), (body, False)):
        for m in KEY.finditer(text or ""):
            project = m[1].upper()
            if (any_case or m[1].isupper()) and project not in NOT_JIRA and not project.isdigit():
                return f"{project}-{m[2]}"
    return None


def adf_text(node):
    """Plain text of a Jira description (Atlassian Document Format, or already a string)."""
    if isinstance(node, str):
        return node
    if isinstance(node, list):
        return "".join(adf_text(n) for n in node)
    if not isinstance(node, dict):
        return ""
    text = node.get("text", "") + adf_text(node.get("content", []))
    return text + "\n" if node.get("type") in ("paragraph", "heading", "listItem", "codeBlock") else text


def jira(key):
    r = subprocess.run(["acli", "jira", "workitem", "view", key, "--json", "--fields", "summary,description"],
                       capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout).strip()[:200])
    fields = json.loads(r.stdout).get("fields") or {}
    return f"{key}: {fields.get('summary') or ''}\n\n{adf_text(fields.get('description')).strip()}".strip()


def task(pr, tickets=True):
    """The PR's title and body, and its Jira ticket when there is one (read with `acli` when it is on PATH and the
    context allows tickets); a note says what was skipped. None: no PR."""
    if not (pr or "").startswith("https://"):
        return None
    r = subprocess.run(["gh", "pr", "view", pr, "--json", "title,body,headRefName"], capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError(f"gh pr view: {r.stderr.strip()[:200]}")
    d = json.loads(r.stdout)
    out = {"title": d["title"], "text": f"PR: {d['title']}\n\n{d.get('body') or ''}".strip(), "jira": None, "note": None}
    key = jira_key(d["title"], d.get("headRefName"), d.get("body"))
    if key and not tickets:
        out["note"] = f"{key}: tickets are off for this context, skipped"
    elif key and not shutil.which("acli"):
        out["note"] = f"{key}: acli not installed, ticket skipped"
    elif key:
        try:
            out["text"] += "\n\nJira ticket " + jira(key)[:6000]
            out["jira"] = key
        except Exception as e:  # noqa: BLE001 - the review goes on without the ticket
            out["note"] = f"{key}: Jira not readable ({e})"
    return out


def numbered(lines):
    """Hunk lines with their line number (new side; removed lines: old side) so the model can name lines."""
    out, old, new = [], 0, 0
    for line in lines:
        m = re.match(r"@@ -(\d+)(?:,\d+)? \+(\d+)", line)
        if m:
            old, new = int(m[1]), int(m[2])
            out.append(line)
        elif line[:1] == "-":
            out.append(f"-{old:>5} {line[1:]}")
            old += 1
        elif line[:1] == "+":
            out.append(f"+{new:>5} {line[1:]}")
            new += 1
        elif line[:1] == " ":
            out.append(f" {new:>5} {line[1:]}")
            old, new = old + 1, new + 1
        else:
            out.append(line)
    return out


RULE_FILES = ("CLAUDE.md", "AGENTS.md", "CONTRIBUTING.md", ".github/CONTRIBUTING.md", "docs/CONTRIBUTING.md")
RULE_BUDGET, FILE_BUDGET = 12000, 4000
def global_rules():
    """Conventions every PR is checked against (settings: globalRules), besides the repo's own rules files."""
    return str(llm.config().get("globalRules") or "").strip()


def adr_digest(text):
    """An ADR's title and its status and decision sections only."""
    lines, out, keep = text.splitlines(), [], False
    for line in lines:
        if line.startswith("#"):
            keep = not out or bool(re.search(r"status|decision|entscheidung|beschluss", line, re.I))  # ADR headings, also German
            if not out:
                out.append(line)
                continue
        if keep:
            out.append(line)
    return "\n".join(out).strip()[:800]


def repo_rules(root, budget=RULE_BUDGET):
    """The repo's own rules from the checkout: CLAUDE.md, AGENTS.md, CONTRIBUTING.md, .github instructions (each
    capped), then ADR titles and status/decision sections (docs/adr, adr), all within `budget` characters, plus the
    global conventions from the settings. Text for the prompt; '' parts are skipped."""
    root = pathlib.Path(root) if root else None
    parts = []
    if root and root.is_dir():
        files = [root / f for f in RULE_FILES] + sorted((root / ".github").glob("**/*instructions*.md"))
        for f in files:
            if f.is_file():
                parts.append(f"### {f.relative_to(root)}\n{f.read_text(errors='replace').strip()[:FILE_BUDGET]}")
        for d in ("docs/adr", "adr", "docs/decisions"):
            for f in sorted((root / d).glob("*.md"))[-30:]:  # ponytail: the 30 newest by name; ADRs are numbered
                parts.append(f"### {f.relative_to(root)}\n{adr_digest(f.read_text(errors='replace'))}")
    g = global_rules()
    out = [f"### Global conventions\n{g}"] if g else []
    used = len(g)
    for p in parts:
        if used + len(p) > budget:
            out.append(f"(… {len(parts) - len(out) + (1 if g else 0)} more rule files cut)")
            break
        out.append(p)
        used += len(p)
    return "\n\n".join(out)


GENERIC = {"index", "main", "utils", "util", "__init__", "mod", "lib", "types", "test", "tests", "config", "readme", "package", "app", "base", "common"}


def blast_candidates(root, paths, limit=15):
    """Files that name a changed file's module (git grep on its stem), outside the diff: real upstream candidates for
    the blast radius, so the model need not guess. [(file, stem)]."""
    if not root or not pathlib.Path(root).is_dir():
        return []
    changed, out = set(paths), []
    for path in paths:
        stem = pathlib.PurePath(path).stem
        if len(stem) < 4 or stem.lower() in GENERIC:
            continue
        r = subprocess.run(["git", "grep", "-l", "-F", "-w", stem], cwd=root, capture_output=True, text=True, timeout=30)
        for f in [x for x in r.stdout.splitlines() if x not in changed][:5]:
            if (f, stem) not in out:
                out.append((f, stem))
        if len(out) >= limit:
            break
    return out[:limit]


def previous_digest(prev):
    """The analysis shown so far, compact: title, summary, each step's title and why."""
    a = prev.get("answer") or {}
    return "\n".join([f"Title: {a.get('title', '')}", f"Summary: {a.get('summary', '')}",
                      *(f"- {s.get('title', '')}: {s.get('why_it_matters', '')}" for s in a.get("steps") or [])])[:6000]


def prompt(hunks, cut, task_text, tools, rules="", candidates=(), previous=None, lang="English"):
    text = ("Analyze the diff below thoroughly." + (" You are in a checkout of the PR head and may read (Read, Grep, Glob, "
            "git log/show/blame/diff/grep): check callers, types and surrounding code before you name a suspicious spot, and "
            "name only what you confirmed in the code." if tools else "") +
            f" Write every text field in {lang}." +
            "\n\nsteps: Put all hunks into steps (each hunk in exactly one, related ones together, rather few). Per step: "
            "title (short); risk (high: security, data loss/migrations, auth, concurrency; medium: core logic, API/contract changes; "
            "low: configuration, small things; skim: tests, renames, formatting, generated code, docs); why_it_matters (one sentence); "
            "explanation (2-4 sentences: what changes and why); reading_order (1, 2, …: the order in which the PR is best "
            "understood); hunks (aliases like h1); check_questions (1-3 concrete questions on what to check in exactly these lines; "
            "at most one for skim); suggestions (concrete suspicious lines in these hunks: hunk, line (the number before the line), "
            "side (new for + and context, old for removed lines), severity (high|medium|low), text (one sentence that works as a "
            "review comment); empty when nothing is confirmed); flows (at most 3, only where it helps: changed or new functions with "
            "function, at (file:line in the new version), inputs (name, type, example), output (type, example), side_effects, calls; "
            "examples concrete and realistic, derived from the code (types, structs, JSON bodies, DTOs, SQL rows, events), at most "
            "12 lines, invent nothing; trace: ONE example input followed through the function like in a debugger: per line path, "
            "line (new side, only lines in the diff), values (\"name = value, name2 = value2\": what parameters, locals and the "
            "return value hold there for the example), at most 12 lines); visuals (optional, only when pictures explain more than "
            "text: pick every view that explains something the others don't, usually 1-3, never the same kind twice for the same "
            "thing: kind architecture (components and what changes between them), flow (data/control flow, edges with payload), "
            "sequence (who calls whom in which order; edges in order), state_machine or steps (an ordered procedure); at most 12 "
            "nodes (id, label, changed, note: what changes at this node, at: file:line in the new version), edges (from, to, label, "
            "changed)). state_machine is drawn top to bottom and covers two cases. A state diagram: pick it when the PR changes "
            "how an entity's status or state field evolves (enum statuses, status columns, workflow states); title names the "
            "entity (e.g. \"Loan\"); nodes are its states, transitions (from, to, event, guard, action, changed) are what moves it "
            "between them, back edges and self-transitions allowed; mark the transitions the PR adds or changes. An orchestration: "
            "pick it for a Step Functions or workflow definition; nodes are its states with type (task, choice, parallel, map, "
            "wait, pass, fail, succeed), states inside a Parallel or Map state have parent (its id) and branch (0, 1, …); "
            "transitions in execution order, a choice's ways labelled with their condition, Catch and Retry as transitions with "
            "error catch or retry (label e.g. \"Retry ×3\"). The steps are layers: group by intent "
            "(e.g. data model, API, emails, UI), reading_order with the foundation first.\n\nSources: every node, edge, "
            "state and transition in architecture and visuals, and every intent and behavior statement, gets a source: "
            "implemented (in this PR's diff; evidence: file:line in the new version, required), existing (already in the "
            "codebase and unchanged; evidence where known), spec (only described in the PR description, the linked ticket, "
            "ADRs or spec docs, and NOT found in the diff: planned or missing). Never present a spec-only item as implemented: "
            "when you can't point at the diff, use spec.\n\ntitle/summary: the PR in one line and "
            "in 2-3 sentences. behavior: 2-3 sentences on how the application's behavior changes, also for users (no code). "
            "intent and behavior_points: the PR's intent and its behavior change as single statements (at most 6 each), each "
            "with source and evidence (see Sources). "
            "merge_risk: level (minimal, low, medium, high, critical) and why (one sentence). effort: score 1-5 (1: minutes, 5: hours "
            "of focused work) and why. architecture: the picture of the whole PR: groups (systems, e.g. label \"Web application\", "
            "kind \"Client\"), nodes (id, group, label, description in 1-2 lines, type such as component, api·service, data, "
            "service, orchestration, status new/changed/unchanged/removed, at: file:line; an orchestrator such as a Step Functions "
            "state machine may list its states in order (name, type task/choice/parallel/map/wait/pass/fail/succeed, calls: the id "
            "of the node a task state invokes, status), each call is then drawn from that state's row), edges (from, to, label: "
            "what happens, e.g. \"Creates invitation\"; draw them in call direction, caller to callee); at most 12 nodes, empty "
            "lists when the PR touches no architecture. visuals (optional, at most 3): pictures of the whole PR the architecture "
            "doesn't show, same form as a layer's (e.g. the state diagram of an entity whose lifecycle changed). blast_radius: units (the changed "
            "units: id, label, type, status added/changed/removed, files, spots = number of changed places) and context (unchanged "
            "files that call the change (upstream) or are called by it (downstream): file as an existing path, relation one "
            "sentence, links_to the unit's id); only checked paths, at most 8.")
    if candidates:
        text += ("\n\nUpstream candidates (found by git grep, they name the module; check them):\n"
                 + "\n".join(f"- {f} (names {stem})" for f, stem in candidates))
    text += ("\n\nrule_checks: Check the PR against the rules below (the ones relevant to this change, at most 20): rule (short), "
             "source (file), status (pass, fail, n/a), where (file:line in the new version, for fail when possible), why (one "
             "sentence). The PR title is in the task.\n\nRules:\n" + (rules or "(none)"))
    if previous:
        text += ("\n\nThis is a FOLLOW-UP ANALYSIS: the diff below holds only the changes since the last review (aliases n1, n2, …). "
                 "steps only for these new changes; summary: what changed since the last review; asks: empty list. "
                 "The analysis so far:\n" + previous)
    if task_text and not previous:
        text += ("\n\nasks: Break the task below into its requirements. Per requirement: text (short), coverage (seen: done; "
                 "partly: partly; absent: missing), hunks, elements (ids of the architecture or visual nodes with source spec that "
                 "this requirement describes, if any). Plus one entry with coverage extra for each change the task "
                 "doesn't ask for (text: what, hunks: where).\n\nTask:\n" + task_text[:8000])
    else:
        text += "\n\nasks: empty list."
    if cut:
        text += f"\n\nCut: {len(cut)} more hunks ({', '.join(cut[:40])}) were too large and are missing here."
    return (text + "\n\nDiff (lines: prefix + new, - removed, space context; then the line number):\n"
            + "\n\n".join(f"### {h['alias']} {h['path']}\n" + "\n".join(numbered(h["lines"])) for h in hunks))


def span(header):
    """A hunk header's new-side lines [first, last] (an only-removing hunk: the line it sits after)."""
    m = re.match(r"@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))?", header or "")
    if not m:
        return 0, -1
    first, n = int(m[1]), 1 if m[2] is None else int(m[2])
    return first, first + max(n, 1) - 1


def merge_incremental(prev, answer, inc, full):
    """An analysis of only the changes since the last review merged into the one shown so far, for today's whole diff.
    prev: that saved analysis; answer: the model's on the new hunks inc [{alias n1.., path, lines}]; full: today's PR
    diff hunks [{alias, id, path, head}]. Previous steps point at the same hunk ids (gone ones keep their id under an
    alias o<k>, so they show as outdated); new steps point at today's hunks overlapping their new lines, are marked
    new and go first in reading order. Suggestions follow their hunk (new-side lines only). Returns (hunks, answer).
    ponytail: merge risk, effort, rules and pictures stay the previous ones (they judged the whole PR)."""
    alias_of = {h["id"]: h["alias"] for h in full}
    hunks = [{"alias": h["alias"], "id": h["id"]} for h in full]
    old = {}
    for k, h in enumerate(prev.get("hunks") or [], 1):
        if h["id"] in alias_of:
            old[h["alias"]] = alias_of[h["id"]]
        else:
            old[h["alias"]] = f"o{k}"
            hunks.append({"alias": f"o{k}", "id": h["id"]})
    spans = [(h["alias"], h["path"], *span(h["head"])) for h in full]
    inc_by = {h["alias"]: (h["path"], *span(h["lines"][0] if h.get("lines") else "")) for h in inc}

    def overlapping(alias):
        if alias not in inc_by:
            return []
        path, a, b = inc_by[alias]
        return [fa for fa, fp, x, y in spans if fp == path and x <= max(a, b) and a <= y]

    def at_line(alias, line):
        path = inc_by.get(alias, (None,))[0]
        return next((fa for fa, fp, x, y in spans if fp == path and x <= line <= y), None)

    def remap_old(step):
        sugs = [{**g, "hunk": old[g["hunk"]]} for g in step.get("suggestions") or [] if g.get("hunk") in old]
        return {**step, "hunks": [old[a] for a in step.get("hunks") or [] if a in old], "suggestions": sugs}

    def remap_new(step):
        hs = list(dict.fromkeys(fa for a in step.get("hunks") or [] for fa in overlapping(a)))
        sugs = [{**g, "hunk": at_line(g["hunk"], g["line"])} for g in step.get("suggestions") or [] if g.get("side") != "old"]
        return {**step, "hunks": hs, "suggestions": [g for g in sugs if g["hunk"]], "new": True,
                "reading_order": int(step.get("reading_order") or 1) - 1000}

    a = prev.get("answer") or {}
    merged = {**a, "steps": [remap_new(x) for x in answer.get("steps") or []] + [remap_old(x) for x in a.get("steps") or []],
              "asks": [{**x, "hunks": [old[h] for h in x.get("hunks") or [] if h in old]} for x in a.get("asks") or []],
              "summary": f"{a.get('summary', '')}\n\n**Since the last review:** {answer.get('summary', '')}".strip()}
    return hunks, merged


# ---- Refresh diagrams: only the pictures again (architecture, the PR's and each layer's visuals, with sources), for
# today's diff, with the shown analysis' layers as context. The text analysis stays as it is.

DIAGRAMS_SCHEMA = {"type": "object", "required": ["architecture", "layers"], "properties": {
    "architecture": ARCHITECTURE, "visuals": VISUALS,
    "layers": {"type": "array", "items": {"type": "object", "required": ["layer", "visuals"], "properties": {
        "layer": {"type": "integer"}, "visuals": VISUALS}}}}}


def picture_guide(lang):
    """The full prompt's guidance on pictures and sources (sliced out of it, so both prompts say the same)."""
    full = prompt([], [], None, False, lang=lang)
    cut = lambda a, b: full[full.index(a):full.index(b, full.index(a))]  # noqa: E731
    return "\n\n".join([cut("visuals (optional", " The steps are layers"), cut("Sources:", "\n\ntitle/summary"),
                         cut("architecture: the picture", " blast_radius:")])


def diagrams_prompt(hunks, prev, task_text, tools, lang="English"):
    a = prev.get("answer") or {}
    layers = "\n".join(f"{k}. {x.get('title', '')}: {x.get('explanation', '')} (hunks {', '.join(x.get('hunks') or [])})"
                       for k, x in enumerate(a.get("steps") or []))
    return ("Draw the pictures of this pull request again from the diff below: architecture, visuals for the whole PR, and "
            "per layer (by its number) its visuals. Only the pictures: the layers and texts stay as they are." +
            (" You are in a checkout of the PR head and may read it to check what exists." if tools else "") +
            f" Write every text field in {lang}.\n\n" + picture_guide(lang) +
            f"\n\nTitle: {a.get('title', '')}\nSummary: {a.get('summary', '')}\n\nLayers:\n{layers}" +
            ("\n\nTask (PR description and ticket; what is only here is spec):\n" + task_text[:8000] if task_text else "") +
            "\n\nDiff:\n" + "\n\n".join(f"### {h['alias']} {h['path']}\n" + "\n".join(numbered(h["lines"])) for h in hunks))


def merge_diagrams(prev, answer, head, meta):
    """The saved analysis with only its pictures replaced: architecture, the PR's visuals, each layer's visuals (by
    number; a layer the answer leaves out keeps none). Text, layers, asks stay. diagrams: when, for which head."""
    a = dict(prev.get("answer") or {})
    per = {int(x.get("layer", -1)): x.get("visuals") or [] for x in answer.get("layers") or []}
    a["architecture"] = answer.get("architecture") or {"groups": [], "nodes": [], "edges": []}
    a["visuals"] = answer.get("visuals") or []
    a["steps"] = [{**{k: v for k, v in x.items() if k != "visual"}, "visuals": per.get(k, [])} for k, x in enumerate(a.get("steps") or [])]
    return {**prev, "answer": a, "diagrams": {"generated": dt.datetime.now().astimezone().isoformat(), "head": head,
                                              "model": meta.get("model_id"), "cost": meta.get("cost")}}


def main_diagrams(req):
    """req: {diagrams: the analysis file to refresh, also: other files holding the same analysis, head, model, context,
    pr, worktree, hunks, status}."""
    model, ctx, wt, lang = req["model"], req.get("context"), req.get("worktree"), llm.language()
    prev = json.loads(pathlib.Path(req["diagrams"]).read_text())
    t = task(req.get("pr"), (ctx or {}).get("tickets", True))
    tools = bool(wt and pathlib.Path(wt).is_dir())
    extra = ("--allowedTools", *READ_ONLY, "--disallowedTools", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch") if tools else ()
    meta = {}
    answer = llm.claude(FEATURE_DIAGRAMS, diagrams_prompt(req["hunks"], prev, t and t["text"], tools, lang), context=ctx, model=model,
                        schema=DIAGRAMS_SCHEMA, system=SYSTEM.format(lang=lang), budget=BUDGET_DIAGRAMS[model], timeout=TIMEOUT,
                        cwd=wt if tools else pathlib.Path.home(), tools="Read,Grep,Glob,Bash" if tools else "", meta=meta, extra=extra)
    if not answer:
        raise RuntimeError(f"{FEATURE_DIAGRAMS}: no answer")
    result = merge_diagrams(prev, answer, req.get("head"), meta)
    for path in [req["diagrams"], *(req.get("also") or [])]:  # only files that still hold this analysis
        try:
            same = json.loads(pathlib.Path(path).read_text()).get("generated") == prev.get("generated")
        except (OSError, ValueError):
            same = False
        if same:
            save(path, result)
    return {"cost": meta.get("cost"), "ms": meta.get("ms"), "model_id": meta.get("model_id", model)}


# ---- Ask about this: one question on the architecture (or a layer's pictures), with a short thread. The answer is text
# plus the picture's node and edge ids it is about and the places that back it. Sync: prints the answer as JSON.

FEATURE_ASK = "Review: architecture question"
BUDGET_ASK = {"haiku": 0.3, "sonnet": 1.0, "opus": 3.0}
ASK_SCHEMA = {"type": "object", "required": ["text", "highlights", "evidence"], "properties": {
    "text": S, "highlights": {"type": "object", "required": ["nodes", "edges"], "properties": {"nodes": STRINGS, "edges": STRINGS}},
    "evidence": {"type": "array", "maxItems": 8, "items": {"type": "object", "required": ["at"], "properties": {"at": S, "why": S}}}}}


def deep_context(req):
    """What the ask and drill calls share: the analysis in short, the picture (nodes, edges e0.. with evidence), the
    focus (a node with its edges, a layer, or the whole picture) and the relevant diff hunks."""
    a = req.get("analysis") or {}
    layers = "\n".join(f"- {x.get('title', '')}: {x.get('why', '')}" for x in a.get("layers") or [])
    hunks = "\n\n".join(f"### {h['path']}\n" + "\n".join(numbered(h["lines"])) for h in req.get("hunks") or [])
    what = "the existing code (no PR)" if req.get("explore") else "a pull request"
    return (f"This is about {what}.\nAnalysis: {a.get('title', '')}\n{a.get('summary', '')}\nLayers:\n{layers or '(none)'}\n\n"
            f"Picture (architecture; edges by id):\n{json.dumps(req.get('picture') or {}, ensure_ascii=False)}\n\n"
            f"Focus:\n{json.dumps(req.get('scope') or {'kind': 'picture'}, ensure_ascii=False)}"
            + (f"\n\nDiff hunks (lines: prefix + new, - removed; then the line number):\n{hunks}" if hunks else ""))


def ask_prompt(req, tools, lang="English"):
    turns = "\n\n".join(f"Q: {t.get('q', '')}\nA: {t.get('a', '')}" for t in req.get("history") or [])
    return (f"Answer the question below in {lang}, briefly (at most 8 sentences, markdown allowed), about the focus when "
            "there is one." + (" You may read the code (Read, Grep, Glob) to check before you answer; claim only what you "
            "confirmed." if tools else "") +
            " highlights: the ids of the picture's nodes and edges (e0, e1, …) your answer is about (empty when none). "
            "evidence: file:line places that back the answer, each with why (one short phrase).\n\n" + deep_context(req)
            + (f"\n\nEarlier in this thread:\n{turns}" if turns else "") + f"\n\nQuestion: {req['ask']}")


def read_tools(root):
    """Read-only tools in root (the PR head checkout or the explored repo), or none."""
    if not (root and pathlib.Path(root).is_dir()):
        return {"tools": "", "cwd": pathlib.Path.home(), "extra": ()}
    return {"tools": "Read,Grep,Glob", "cwd": root, "extra": ("--allowedTools", "Read", "Grep", "Glob", "--disallowedTools", "Edit", "Write",
                                                              "NotebookEdit", "WebFetch", "WebSearch", "Bash")}


def main_ask(req):
    model, lang, rt = req["model"], llm.language(), read_tools(req.get("root"))
    meta = {}
    answer = llm.claude(FEATURE_ASK, ask_prompt(req, bool(rt["tools"]), lang), context=req.get("context"), model=model, schema=ASK_SCHEMA,
                        system=SYSTEM.format(lang=lang), budget=BUDGET_ASK[model], timeout=TIMEOUT, cwd=rt["cwd"], tools=rt["tools"],
                        meta=meta, extra=rt["extra"])
    if not answer:
        raise RuntimeError(f"{FEATURE_ASK}: no answer")
    return {"answer": answer, "cost": meta.get("cost"), "ms": meta.get("ms"), "model_id": meta.get("model_id", model)}


def save(path, value):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=1))
    tmp.replace(path)


def main(req):
    model, ctx, wt, lang = req["model"], req.get("context"), req.get("worktree"), llm.language()
    t = task(req.get("pr"), (ctx or {}).get("tickets", True))
    tools = bool(wt and pathlib.Path(wt).is_dir())
    prev = json.loads(pathlib.Path(req["previous"]).read_text()) if req.get("previous") else None
    paths = list(dict.fromkeys(h["path"] for h in req["hunks"]))
    candidates = blast_candidates(wt, paths) if tools else []
    meta = {}
    extra = ("--effort", "high")
    if tools:
        extra += ("--allowedTools", *READ_ONLY, "--disallowedTools", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch")
    text = prompt(req["hunks"], req.get("cut") or [], t and t["text"], tools, rules=repo_rules(wt), candidates=candidates,
                  previous=prev and previous_digest(prev), lang=lang)
    answer = llm.claude(FEATURE_INC if prev else FEATURE, text, context=ctx, model=model,
                        schema=SCHEMA, system=SYSTEM.format(lang=lang), budget=BUDGET[model], timeout=TIMEOUT, cwd=wt if tools else pathlib.Path.home(),
                        tools="Read,Grep,Glob,Bash" if tools else "", meta=meta, extra=extra)
    if not answer:
        raise RuntimeError(f"{FEATURE}: no answer")
    if tools:  # only context files that exist: no invented callers
        blast = answer.get("blast_radius") or {}
        blast["context"] = [c for c in blast.get("context") or [] if (pathlib.Path(wt) / c.get("file", "")).is_file()]
    hunks = [{"alias": h["alias"], "id": h["id"]} for h in req["hunks"]]
    if prev:
        hunks, answer = merge_incremental(prev, answer, req["hunks"], req["full"])
    result = {"source": req.get("source") or req.get("pr"), "model": model, "model_id": meta.get("model_id", model),
              "hunks": hunks, "answer": answer, "incremental": req.get("since") if prev else None,
              "cut": [] if prev else req.get("cut") or [], "cost": meta.get("cost"), "ms": meta.get("ms"), "budget": BUDGET[model],
              "task": {k: t[k] for k in ("title", "jira", "note")} if t else {},
              "generated": dt.datetime.now().astimezone().isoformat()}
    save(req["out"], result)
    save(req["latest"], result)
    return result


if __name__ == "__main__":
    req = json.loads(sys.argv[1])
    status = req.get("status")
    if status:
        save(status, {"busy": True, "pid": os.getpid(), "started": dt.datetime.now().astimezone().isoformat(), "model": req["model"]})
    try:
        if req.get("ask"):  # sync calls: the answer on stdout
            print(json.dumps(main_ask(req), ensure_ascii=False))
            sys.exit(0)
        r = main_diagrams(req) if req.get("diagrams") else main(req)
        if status:
            save(status, {"done": True, "cost": r["cost"], "ms": r["ms"]})
        print(json.dumps({"cost": r["cost"], "model": r["model_id"], "ms": r["ms"]}))
    except Exception as e:  # noqa: BLE001 - the panel shows the reason
        if status:
            save(status, {"error": str(e)[:500]})
        print(str(e), file=sys.stderr)
        sys.exit(1)
