#!/usr/bin/env python3
"""PRs created from Claude Code sessions (`gh pr create` or an MCP create_pull_request call whose
result holds the pull URL), with their GitHub state. A subagent's PR belongs to its parent session.

Writes pr-data/prs.json (in the Herdr app home) for the pr-review panel. argv[1] (optional): JSON {dirs: [{id, dir}]
(the Claude config folders to scan, one per context; default: the default context's ~/.claude), rules (the contexts'
rules: first match wins, path rules on the session folder, remote rules on the repo URL), titles (optional: a JSON
file {session id: {title}} with better session titles)}. Each PR's `context` follows the rules, else the folder its
transcript is in; `sessionContext` is the context whose config folder holds the session, which `claude --resume`
needs. Also prunes pr-data/cache (prune_cache; `prs.py --prune` does only that).
Exit 0: complete. Exit 2: written, but some PR states could not be read (report["errors"]).
"""
import concurrent.futures
import datetime as dt
import json
import os
import pathlib
import re
import subprocess
import sys
import time

HOME = pathlib.Path.home()
APP = pathlib.Path(os.environ.get("HERDR_APP_HOME") or HOME / ".config/herdr-app")
DATA = APP / "pr-data"
URL = re.compile(r"https://github\.com/([\w.-]+/[\w.-]+)/pull/(\d+)")
CREATE = re.compile(r"""(?<!['"])gh pr create""")  # run, not quoted (a grep or a script that searches for it)
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
CLOSED_RECHECK = 7 * 86400  # merged/closed PRs barely change
CACHE = DATA / "cache"
CACHE_FILES, CACHE_BYTES, CLOSED_KEEP = 200, 50 << 20, 14 * 86400


def context_for(folder, remote, rules):
    """context.js ruleContext: the first matching rule's context, else None."""
    norm = lambda p: re.sub(r"^~(?=/|$)", str(HOME), p or "").rstrip("/").lower()
    f = norm(folder)
    for r in rules:
        if r.get("path"):
            p = norm(r["path"])
            if p and (f == p or f.startswith(p + "/")):
                return r.get("context")
        elif r.get("remote") and remote:
            try:
                if re.search(r["remote"], remote, re.I):
                    return r.get("context")
            except re.error:
                pass
    return None


def prune_cache(closed_urls=()):
    """pr-data/cache holds only content-addressed results: at most CACHE_FILES files and CACHE_BYTES, oldest first
    out; files of PRs merged/closed for CLOSED_KEEP go (their names carry hash(url), see hashes())."""
    CACHE.mkdir(parents=True, exist_ok=True)
    gone = {fnv(u) for u in closed_urls}
    # A big diff is an index diff-<h>-<head>.json plus parts diff-<h>-<head>.<i>.txt: one unit, kept or dropped together.
    units = {}
    for p in CACHE.iterdir():
        if p.is_file():
            units.setdefault(re.sub(r"\.\d+\.txt$", ".json", p.name), []).append(p)
    total = 0
    for i, (name, ps) in enumerate(sorted(units.items(), key=lambda u: max(p.stat().st_mtime for p in u[1]), reverse=True)):
        total += sum(p.stat().st_size for p in ps)
        if i >= CACHE_FILES or total > CACHE_BYTES or any(h in name for h in gone):
            for p in ps:
                p.unlink(missing_ok=True)


def fnv(text):
    """pr.js hash(): FNV-1a 32 bit over UTF-16 code units, hex."""
    h = 0x811c9dc5
    for unit in text.encode("utf-16-le")[::2]:  # ponytail: low bytes only, right for the ASCII URLs it is used on
        h = ((h ^ unit) * 0x01000193) & 0xFFFFFFFF
    return f"{h:08x}"


def load(name, default):
    try:
        return json.loads((DATA / name).read_text())
    except FileNotFoundError:
        return default


def titles(path):
    try:
        return json.loads(pathlib.Path(path).expanduser().read_text()) if path else {}
    except (OSError, ValueError):
        return {}


def save(name, value):
    tmp = DATA / f".{name}.{os.getpid()}.tmp"  # the panel and a manual run may write at once
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=1))
    tmp.replace(DATA / name)


def first_prompt(entry):
    if entry.get("type") != "user" or entry.get("isMeta"):
        return None
    content = (entry.get("message") or {}).get("content")
    texts = [content] if isinstance(content, str) else [
        c.get("text", "") for c in content or [] if isinstance(c, dict) and c.get("type") == "text"]
    for text in texts:
        text = text.strip()
        if text and not text.startswith("<"):
            return text
    return None


def created(lines):
    """PRs one transcript created, with the time and folder of the creating call's result."""
    calls, out = set(), []
    for line in lines:
        if "gh pr create" not in line and "create_pull_request" not in line and "/pull/" not in line:
            continue
        try:
            e = json.loads(line)
        except ValueError:
            continue
        content = (e.get("message") or {}).get("content")
        for c in content if isinstance(content, list) else []:
            if not isinstance(c, dict):
                continue
            if c.get("type") == "tool_use":
                name, args = c.get("name", ""), c.get("input") or {}
                if (name == "Bash" and CREATE.search(str(args.get("command")))) or name.endswith("create_pull_request"):
                    calls.add(c.get("id"))
            elif c.get("type") == "tool_result" and c.get("tool_use_id") in calls:
                # Every pull URL: one call can create several (a loop, a shell function, chained creates).
                for repo, n in dict.fromkeys(URL.findall(json.dumps(c.get("content"), ensure_ascii=False))):
                    out.append({"url": f"https://github.com/{repo}/pull/{n}", "repo": repo, "number": int(n),
                                "at": e.get("timestamp"), "cwd": e.get("cwd")})
    return out


def title(path):
    custom = ai = prompt = None
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            if '"customTitle"' in line or '"aiTitle"' in line or (prompt is None and '"type":"user"' in line):
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                custom = e.get("customTitle") or custom
                ai = e.get("aiTitle") or ai
                prompt = prompt or first_prompt(e)
    return custom or ai or (prompt or "")[:120] or None


def agent_name(path):
    """A subagent transcript's description (agent-x.meta.json), else None."""
    try:
        return (json.loads(path.with_name(path.name.removesuffix(".jsonl") + ".meta.json").read_text()).get("description") or "").strip() or None
    except (OSError, ValueError):
        return None


def transcripts(dirs):
    """(context, session id, path, is the session's own transcript) for every transcript."""
    for d in dirs:
        ctx, root = d["id"], pathlib.Path(d["dir"]).expanduser()
        for path in (root / "projects").glob("*/**/*.jsonl"):
            rel = path.relative_to(root / "projects").parts[1:]
            sid = next((p.removesuffix(".jsonl") for p in rel if UUID.fullmatch(p.removesuffix(".jsonl"))), None)
            if sid:
                yield ctx, sid, path, len(rel) == 1


def gh_state(url):
    r = subprocess.run(["gh", "pr", "view", url, "--json", "number,title,state,isDraft,headRefName,headRefOid,baseRefName,updatedAt"],
                       capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip()[:200])
    return json.loads(r.stdout)


def run(req=None):
    req = req or {}
    dirs = req.get("dirs") or [{"id": "default", "dir": str(HOME / ".claude")}]
    DATA.mkdir(parents=True, exist_ok=True)
    cache, gh, classify = load("prs-cache.json", {}), load("prs-gh.json", {}), titles(req.get("titles"))
    files, prs, mains, errors = {}, {}, {}, []
    for ctx, sid, path, main in transcripts(dirs):
        st = path.stat()
        stamp = f"v3:{st.st_mtime_ns}:{st.st_size}"  # bump v when created() changes
        hit = cache.get(str(path))
        if not hit or hit["stamp"] != stamp:
            with open(path, encoding="utf-8", errors="replace") as f:
                hit = {"stamp": stamp, "prs": created(f)}
            if not main and hit["prs"]:
                hit["agent"] = agent_name(path)
        files[str(path)] = hit
        if main:
            mains[sid] = (path, hit)
        for p in hit["prs"]:
            if p["url"] not in prs or (p["at"] or "") < (prs[p["url"]]["at"] or ""):  # the first creation wins
                prs[p["url"]] = {**p, "context": ctx, "sessionContext": ctx, "session": sid,
                                 "agent": None if main else hit.get("agent") or "Subagent"}
    rules = req.get("rules") or []
    for p in prs.values():
        p["context"] = context_for(p.get("cwd"), f"https://github.com/{p['repo']}", rules) or p["sessionContext"]
        entry = mains.get(p["session"])
        if entry and "title" not in entry[1]:
            entry[1]["title"] = title(entry[0])
        p["sessionTitle"] = (classify.get(p["session"]) or {}).get("title") or (entry[1].get("title") if entry else None)
    save("prs-cache.json", files)

    now = time.time()
    due = [u for u in prs if u not in gh or gh[u]["state"] == "OPEN" or now - gh[u]["checked"] > CLOSED_RECHECK]
    with concurrent.futures.ThreadPoolExecutor(8) as pool:
        for url, fut in [(u, pool.submit(gh_state, u)) for u in due]:
            try:
                gh[url] = {**fut.result(), "checked": now}
            except Exception as e:  # noqa: BLE001 - one unreadable PR must not hide the rest
                errors.append(f"{url}: {e}")
    gh = {u: s for u, s in gh.items() if u in prs}  # PRs whose transcripts are gone drop out
    save("prs-gh.json", gh)

    out = []
    for url, p in prs.items():
        s = gh.get(url) or {}
        state = s.get("state", "UNKNOWN").lower()
        out.append({**p, "title": s.get("title"), "state": "draft" if state == "open" and s.get("isDraft") else state,
                    "head": s.get("headRefName"), "headSha": s.get("headRefOid"), "base": s.get("baseRefName"),
                    "updatedAt": s.get("updatedAt")})
    out.sort(key=lambda p: p["at"] or "", reverse=True)
    report = {"generated": dt.datetime.now().astimezone().isoformat(), "prs": out, "errors": errors}
    save("prs.json", report)
    old = [u for u, s in gh.items() if s.get("state") in ("MERGED", "CLOSED") and now - (time.mktime(time.strptime(s["updatedAt"][:19], "%Y-%m-%dT%H:%M:%S")) if s.get("updatedAt") else now) > CLOSED_KEEP]
    prune_cache(old)
    return report


if __name__ == "__main__":
    if sys.argv[1:] == ["--prune"]:
        prune_cache()
        sys.exit(0)
    r = run(json.loads(sys.argv[1]) if sys.argv[1:] else None)
    print(f"{len(r['prs'])} PRs, {len(r['errors'])} errors", file=sys.stderr)
    sys.exit(2 if r["errors"] else 0)
