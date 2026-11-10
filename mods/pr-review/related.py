#!/usr/bin/env python3
"""Context around one PR for the review layout, no LLM: related PRs, CI checks, mergeability.

argv[1]: JSON {url, head, base, worktree (a checkout of the repo, or null), files: [paths the PR changes], out}.
Related: the 30 most recently updated other OPEN PRs of the repo that change the same files (gh pr list), and PRs
MERGED into the base in the last 90 days that touched them (git log on the files, PR numbers from merge and squash
subjects). Checks: `gh pr checks`; mergeability: `gh pr view`. Writes {at, head, open, merged, checks, mergeable,
merge_state} to `out` (pr-data/cache, keyed by PR and head; prs.py --prune bounds that folder) and prints it.
"""
import datetime as dt
import json
import pathlib
import re
import subprocess
import sys

OPEN_LIMIT, MERGED_DAYS, KEEP = 30, 90, 10
PR_NUMBER = re.compile(r"Merge pull request #(\d+)|\(#(\d+)\)\s*$")


def overlap(files, prs):
    """prs [{number, title, files}] that share files with `files`, most shared first: {…, overlap, files: shared}."""
    mine = set(files)
    out = [{**p, "files": sorted(mine & set(p["files"])), "overlap": len(mine & set(p["files"]))} for p in prs]
    return sorted((p for p in out if p["overlap"]), key=lambda p: (-p["overlap"], -p["number"]))[:KEEP]


def merged_from_log(text):
    """`git log --format=%x1e%s%x1f%b%x1d --name-only` → [{number, title, files}]: a merge commit's title is its
    body's first line, a squash's its subject without " (#n)"."""
    out = {}
    for chunk in text.split("\x1e")[1:]:
        subject, _, rest = chunk.partition("\x1f")
        body, _, names = rest.partition("\x1d")
        m = PR_NUMBER.search(subject)
        if not m:
            continue
        n = int(m[1] or m[2])
        title = (body.strip().splitlines() or [subject])[0] if m[1] else PR_NUMBER.sub("", subject).strip()
        files = [x for x in names.split("\n") if x.strip()]
        p = out.setdefault(n, {"number": n, "title": title, "files": []})
        p["files"] = sorted(set(p["files"]) | set(files))
    return list(out.values())


def run(cmd, cwd=None, timeout=120):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    return r.stdout if r.returncode in (0, 8) else None  # gh pr checks exits 8 while checks are pending


def main(req):
    m = re.match(r"https://github\.com/([\w.-]+/[\w.-]+)/pull/(\d+)", req["url"])
    repo, number, files, wt = m[1], int(m[2]), req.get("files") or [], req.get("worktree")
    raw = run(["gh", "pr", "list", "--repo", repo, "--state", "open", "--limit", str(OPEN_LIMIT), "--json", "number,title,url,files"])
    others = [{"number": p["number"], "title": p["title"], "url": p["url"], "files": [f["path"] for f in p.get("files") or []]}
              for p in json.loads(raw or "[]") if p["number"] != number]
    merged = []
    if wt and files and pathlib.Path(wt).is_dir():
        base = req.get("base") or "main"
        run(["git", "fetch", "--quiet", "origin", base], cwd=wt, timeout=300)
        log = run(["git", "log", f"origin/{base}", f"--since={MERGED_DAYS}.days.ago", "--format=%x1e%s%x1f%b%x1d", "--name-only", "--", *files[:200]], cwd=wt)
        merged = [{**p, "url": f"https://github.com/{repo}/pull/{p['number']}"} for p in overlap(files, merged_from_log(log or "")) if p["number"] != number]
    checks = json.loads(run(["gh", "pr", "checks", req["url"], "--json", "name,bucket,link"]) or "[]")
    view = json.loads(run(["gh", "pr", "view", req["url"], "--json", "mergeable,mergeStateStatus"]) or "{}")
    result = {"at": dt.datetime.now().astimezone().isoformat(), "head": req.get("head"), "open": overlap(files, others), "merged": merged,
              "checks": [{"name": c["name"], "bucket": c.get("bucket") or "pending", "link": c.get("link")} for c in checks],
              "mergeable": view.get("mergeable"), "merge_state": view.get("mergeStateStatus")}
    out = pathlib.Path(req["out"])
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False))
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main(json.loads(sys.argv[1]))
    except Exception as e:  # noqa: BLE001 - the panel shows the reason
        print(str(e), file=sys.stderr)
        sys.exit(1)
