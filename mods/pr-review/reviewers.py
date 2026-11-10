#!/usr/bin/env python3
"""Automated reviewers for the review layout: Claude's /code-review, Claude's /security-review, `codex review`.

argv[1]: JSON {kind: "claude"|"security"|"codex", url, number, context ({id, env}: the PR's), model
(haiku|sonnet|opus), worktree (a detached checkout of the PR head, worktree.py), base (the PR's base branch),
head (sha), level (code-review effort: low|medium|high), file (pr-data/findings/<url hash>.json)}.
Runs the reviewer read-only in the worktree (Claude: Read/Grep/Glob/Agent and read-only git/gh Bash only, no edits;
Codex: sandbox_mode=read-only), turns its answer into findings {id, reviewer, file, line, end, severity, title,
detail, suggestion, code} and merges them into `file` under that reviewer (other reviewers' findings and every
status stay). Codex's free text goes through a cheap Haiku pass in the PR's context. Every call goes to the optional
ledger (llm.py). The slash-command reviewers need those commands in the Claude setup (/security-review ships with
Claude Code; /code-review comes from a plugin): when one is missing, the same review runs as a plain prompt. Codex
is optional (`codex` on PATH). Prints {count, cost, ms}; exit 1 with the reason on stderr.
"""
import fcntl
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time

import llm  # noqa: E402  (this folder)

FEATURE = {"claude": "Claude code review", "security": "Security review", "codex": "Codex review"}
BUDGET = {"haiku": 0.5, "sonnet": 3.0, "opus": 8.0}
TIMEOUT = 1500
READ_ONLY = ["Read", "Grep", "Glob", "Agent",
             "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash(git status:*)", "Bash(git blame:*)",
             "Bash(git merge-base:*)", "Bash(git rev-parse:*)", "Bash(git ls-files:*)", "Bash(gh pr diff:*)", "Bash(gh pr view:*)"]
FINDINGS = {"type": "object", "required": ["findings"], "properties": {"findings": {"type": "array", "items": {
    "type": "object", "required": ["file", "line", "severity", "title", "detail"], "properties": {
        "file": {"type": "string"}, "line": {"type": "integer"}, "end": {"type": "integer"},
        "severity": {"enum": ["high", "medium", "low"]}, "title": {"type": "string"}, "detail": {"type": "string"},
        "suggestion": {"type": "string"}}}}}}
ASK_JSON = ("\n\nWhen you are done, answer with the findings in the requested JSON: file (path in the repo), line "
            "(line number on the new side, as in the PR head), end (last line, optional), severity (high|medium|low), "
            "title (one line), detail (why it is a problem), suggestion (the fix, optional). Only real problems; an "
            "empty list is fine.")
MISSING = re.compile(r"unknown (slash )?(command|skill)|no such (command|skill)|not a (known|valid) (command|skill)", re.I)
PLAIN = {"claude": "Review the changes of this checkout against origin/{base} (git diff origin/{base}...HEAD), which are "
                   "PR #{number}, for bugs and correctness problems: read the surrounding code before you report anything.",
         "security": "Do a security review of the changes of this checkout against origin/{base} (git diff "
                     "origin/{base}...HEAD), which are PR #{number}: injection, auth, secrets, unsafe input handling, "
                     "data exposure. Report only real, exploitable problems."}


def git(*args, cwd):
    r = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        raise RuntimeError(f"git {args[0]}: {(r.stderr or r.stdout).strip()[:200]}")
    return r.stdout


def normalize(raw, reviewer, worktree):
    """Reviewer findings with a stable id and the code line they point at (to notice when a push changes it)."""
    out = []
    for f in raw or []:
        path = str(f.get("file") or "").strip().lstrip("./")
        if path.startswith(str(worktree)):
            path = path[len(str(worktree)):].lstrip("/")
        line = int(f.get("line") or 0)
        title = str(f.get("title") or "").strip()
        if not path or not title:
            continue
        code = ""
        try:
            lines = (pathlib.Path(worktree) / path).read_text(errors="replace").splitlines()
            code = lines[line - 1] if 0 < line <= len(lines) else ""
        except OSError:
            pass
        fid = hashlib.sha1(f"{reviewer}|{path}|{line}|{title}".encode()).hexdigest()[:12]
        out.append({"id": fid, "reviewer": reviewer, "file": path, "line": line, "end": int(f.get("end") or line),
                    "severity": f.get("severity") if f.get("severity") in ("high", "medium", "low") else "medium",
                    "title": title, "detail": str(f.get("detail") or ""), "suggestion": str(f.get("suggestion") or ""),
                    "code": code})
    return out


def merge(file, reviewer, head, findings, run):
    """Replace this reviewer's findings (None: keep them, only the run changes) in the PR's file, under a lock;
    statuses (set by the panel) stay. ponytail: the panel writes statuses without this lock (compare-and-swap on the
    whole file), so a status set in the very moment a reviewer finishes can be lost."""
    file.parent.mkdir(parents=True, exist_ok=True)
    with open(file.with_suffix(".lock"), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        doc = json.loads(file.read_text()) if file.exists() else {}
        if findings is not None:
            doc["findings"] = [f for f in doc.get("findings", []) if f["reviewer"] != reviewer] + [{**f, "head": head} for f in findings]
        doc.setdefault("runs", {})[reviewer] = run
        tmp = file.with_name(f".{file.name}.{os.getpid()}.tmp")
        tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=1))
        tmp.replace(file)


def missing_command(text):
    return bool(MISSING.search(str(text or "")))


def claude_review(req, command):
    """The slash command; when the Claude setup doesn't have it, the same review as a plain prompt."""
    def ask(text, skills):
        meta = {}
        answer = llm.claude(FEATURE[req["kind"]], text + ASK_JSON, context=req.get("context"), model=req["model"],
                            schema=FINDINGS, budget=BUDGET[req["model"]], timeout=TIMEOUT, tools="Read,Grep,Glob,Agent,Bash",
                            cwd=req["worktree"], skills=skills, meta=meta,
                            extra=("--allowedTools", *READ_ONLY, "--disallowedTools", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"))
        return answer, meta
    try:
        answer, meta = ask(command, True)
        if answer is None and missing_command(meta.get("result")):
            raise RuntimeError(meta.get("result"))
    except RuntimeError as e:
        if not missing_command(e):
            raise
        answer, meta = ask(PLAIN[req["kind"]].format(base=req["base"], number=req["number"]), False)
        meta["fallback"] = True
    return (answer or {}).get("findings", []), meta


def codex_review(req):
    started = time.monotonic()
    codex = shutil.which("codex")
    if not codex:
        raise RuntimeError("codex is not installed (optional): see Setup")
    r = subprocess.run([codex, "review", "--base", f"origin/{req['base']}",
                        "-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"'],
                       cwd=req["worktree"], capture_output=True, text=True, timeout=TIMEOUT)
    ms = int((time.monotonic() - started) * 1000)
    text = (r.stdout or "") + ("\n" + r.stderr if r.returncode != 0 else "")
    used = re.search(r"tokens used[:\s]*([\d,.]+)", text, re.I)
    tokens = int(re.sub(r"[^\d]", "", used[1])) if used else 0
    llm.log(FEATURE["codex"], (req.get("context") or {}).get("id") or "default", "codex", 0, tokens, ms, r.returncode == 0, tool="codex")  # Codex reports no price
    if r.returncode != 0:
        raise RuntimeError(f"codex review: {(r.stderr or r.stdout).strip()[-300:]}")
    meta = {}
    answer = llm.claude(FEATURE["codex"], "Turn this code review into findings. Keep its wording; do not add findings.\n\n"
                        + text[-60000:] + ASK_JSON, context=req.get("context"), model="haiku", schema=FINDINGS, budget=0.3,
                        timeout=300, meta=meta)
    meta["ms"] = ms + (meta.get("ms") or 0)
    meta["tokens"] = tokens
    return (answer or {}).get("findings", []), meta


def main(arg):
    req = json.loads(arg)
    wt = req["worktree"]
    git("fetch", "--quiet", "origin", req["base"], cwd=wt)  # the base for "what changed"
    started = time.monotonic()
    if req["kind"] == "claude":
        raw, meta = claude_review(req, f"/code-review {req.get('level') or 'medium'} {req['number']}")
    elif req["kind"] == "security":
        raw, meta = claude_review(req, f"/security-review\n\nReview the changes of this checkout against origin/{req['base']} "
                                       f"(git diff origin/{req['base']}...HEAD), which are PR #{req['number']}.")
    else:
        raw, meta = codex_review(req)
    findings = normalize(raw, req["kind"], wt)
    run = {"cost": meta.get("cost"), "ms": int((time.monotonic() - started) * 1000), "model": meta.get("model_id"),
           "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "count": len(findings), "head": req["head"],
           **({"note": f"/{'code-review' if req['kind'] == 'claude' else 'security-review'} not available: ran as a plain prompt"} if meta.get("fallback") else {})}
    merge(pathlib.Path(req["file"]), req["kind"], req["head"], findings, run)
    print(json.dumps(run))


if __name__ == "__main__":
    # The panel starts this detached and follows the file: runs[kind] says busy, done or the error.
    req = json.loads(sys.argv[1])
    merge(pathlib.Path(req["file"]), req["kind"], req["head"], None, {"busy": True, "started": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "pid": os.getpid()})
    try:
        main(sys.argv[1])
    except Exception as e:  # noqa: BLE001 - the panel shows the reason
        merge(pathlib.Path(req["file"]), req["kind"], req["head"], None, {"error": str(e)[:400], "at": time.strftime("%Y-%m-%dT%H:%M:%S%z")})
        print(str(e), file=sys.stderr)
        sys.exit(1)
