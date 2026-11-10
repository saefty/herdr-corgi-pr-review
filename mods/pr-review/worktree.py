#!/usr/bin/env python3
"""The PR head as files for the review layout: reviewers, the AI analysis and the LSP bridge work there.

argv[1]: PR url (https://github.com/<owner>/<repo>/pull/<n>); options --local <dir> (the active space's checkout of
that repo), --root <dir> (repeatable: the clone folders to look in, the first one is where a new clone goes;
default ~/code), --clone.
Uses an existing clone: a dedicated one under a root (<repo> or <owner>-<repo>), else the --local checkout when its
origin is that repo. Without one it clones only with --clone (an explicit click; into the first root,
--filter=blob:none); otherwise exit 3 with {"need_clone": <folder>}.
ONE reusable throwaway worktree per repo, <clone>/.worktrees/review: it fetches pull/<n>/head
and checks that commit out detached (forced, cleaned). One path per repo keeps one warm LSP index per repo.
Old per-PR worktrees (review-<n>) go, and a repo's review worktree goes after MAX_AGE unused, together with the
LSP bridge's index for it (`lsp_bridge.py forget <root>`).
ponytail: one tree per repo, so two review copies of different PRs of one repo at once take turns; a second tree
(LRU) when that happens for real.
Prints {"path", "head", "clone"}; exit 1 with the reason on stderr.
`worktree.py since <checkout> <old> <head> [<path>…]`: what changed from old to head (since_diff), as JSON.
"""
import json
import pathlib
import re
import shutil
import subprocess
import sys
import time

BASES = [pathlib.Path.home() / "code"]  # --root replaces it
MAX_AGE = 7 * 86400
BRIDGE = pathlib.Path(__file__).with_name("lsp_bridge.py")


def git(*args, cwd=None, timeout=300):
    r = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(f"git {args[0]}: {(r.stderr or r.stdout).strip()[:300]}")
    return r.stdout.strip()


class NeedClone(Exception):
    """No local clone of the repo; `dest` is where --clone would put it."""
    def __init__(self, dest):
        super().__init__(f"No local clone: {dest}")
        self.dest = dest


def is_repo(path, owner, repo):
    r = subprocess.run(["git", "remote", "get-url", "origin"], cwd=path, capture_output=True, text=True, timeout=30)
    return r.returncode == 0 and bool(re.search(rf"[/:]{re.escape(owner)}/{re.escape(repo)}(\.git)?/?$", r.stdout.strip(), re.I))


def find_clone(owner, repo, local=None):
    """An existing clone of owner/repo: a dedicated one (any root), else the local checkout when it is that repo."""
    for base in BASES:
        for path in (base / repo, base / f"{owner}-{repo}"):
            if (path / ".git").exists() and is_repo(path, owner, repo):
                return path
    if local and pathlib.Path(local).is_dir() and is_repo(local, owner, repo):
        return pathlib.Path(subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=local, capture_output=True, text=True).stdout.strip() or local)
    return None


def clone_for(owner, repo, clone=False, local=None):
    """The clone to work in (find_clone); none: a new one under the first root with clone=True, else NeedClone."""
    found = find_clone(owner, repo, local)
    if found:
        return found
    base = BASES[0]
    dest = next((p for p in (base / repo, base / f"{owner}-{repo}") if not p.exists()), None)
    if dest is None:
        raise RuntimeError(f"No free folder for {owner}/{repo} under {base}")
    if not clone:
        raise NeedClone(dest)
    base.mkdir(parents=True, exist_ok=True)
    r = subprocess.run(["gh", "repo", "clone", f"{owner}/{repo}", str(dest), "--", "--filter=blob:none", "--no-checkout"],
                       capture_output=True, text=True, timeout=600)
    if r.returncode != 0:
        raise RuntimeError(f"gh repo clone: {r.stderr.strip()[:300]}")
    return dest


def remove(clone, tree):
    subprocess.run(["git", "worktree", "remove", "--force", str(tree)], cwd=clone, capture_output=True, timeout=120)
    shutil.rmtree(tree, ignore_errors=True)
    if BRIDGE.exists():
        subprocess.run([sys.executable, str(BRIDGE), "forget", str(tree)], capture_output=True, timeout=60)


def prune(keep):
    """Per-PR trees of the old layout, and review trees unused for MAX_AGE, in every clone under the bases.
    ponytail: a review tree inside a --local checkout is not pruned; it is one folder, reused per repo."""
    for wt in [w for base in BASES for w in base.glob("*/.worktrees/review*")]:
        clone = wt.parent.parent
        if wt != keep and (wt.name != "review" or time.time() - wt.stat().st_mtime > MAX_AGE):
            remove(clone, wt)
    for clone in {p.parent.parent for base in BASES for p in base.glob("*/.worktrees")}:
        subprocess.run(["git", "worktree", "prune"], cwd=clone, capture_output=True, timeout=60)


def since_diff(cwd, old, head, paths=()):
    """The diff from `old` (the head last reviewed) to `head` in the checkout `cwd`, fetching old when missing.
    mode "ancestor": old..head, exactly what was pushed since; "interdiff": old is no ancestor (force push, rebase):
    old..head limited to `paths` (the PR's files), which also shows what a rebase brought into them; "full": old is
    gone, the caller shows the whole PR. Returns {mode, patch, note}."""
    def run(*args, timeout=120):
        return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, timeout=timeout)
    if run("cat-file", "-e", f"{old}^{{commit}}").returncode != 0:
        run("fetch", "--quiet", "origin", old, timeout=300)  # GitHub serves a SHA it still has, even after a force push
        if run("cat-file", "-e", f"{old}^{{commit}}").returncode != 0:
            return {"mode": "full", "patch": "", "note": f"{old[:7]} is gone (force push?): showing the full PR"}
    ancestor = run("merge-base", "--is-ancestor", old, head).returncode == 0
    if not ancestor and not paths:
        return {"mode": "full", "patch": "", "note": f"{old[:7]} is not in the new history: showing the full PR"}
    r = run("diff", "--no-color", "--no-ext-diff", old, head, "--", *(() if ancestor else paths))
    if r.returncode != 0:
        return {"mode": "full", "patch": "", "note": f"git diff: {r.stderr.strip()[:160]}"}
    return {"mode": "ancestor" if ancestor else "interdiff", "patch": r.stdout,
            "note": None if ancestor else f"Force push: {old[:7]} is not an ancestor, so this compares both states of the PR's files (rebased base changes included)"}


def main(url, clone=False, local=None):
    m = re.match(r"https://github\.com/([\w.-]+)/([\w.-]+)/pull/(\d+)", url)
    if not m:
        raise RuntimeError(f"Not a PR url: {url}")
    owner, repo, n = m.groups()
    clone = clone_for(owner, repo, clone, local)
    exclude = pathlib.Path(clone, git("rev-parse", "--git-path", "info/exclude", cwd=clone))  # a linked worktree has a .git file
    if ".worktrees/" not in (exclude.read_text() if exclude.exists() else ""):
        exclude.parent.mkdir(exist_ok=True)
        with exclude.open("a") as f:
            f.write("\n.worktrees/\n")
    git("fetch", "--quiet", "origin", f"+pull/{n}/head:refs/review/{n}", cwd=clone)
    head = git("rev-parse", f"refs/review/{n}", cwd=clone)
    path = clone / ".worktrees" / "review"
    if (path / ".git").exists():
        git("checkout", "--quiet", "--detach", "--force", head, cwd=path)
        git("clean", "-fdq", cwd=path)
    else:
        git("worktree", "add", "--quiet", "--detach", "--force", str(path), head, cwd=clone)
    path.touch()
    prune(path)
    print(json.dumps({"path": str(path), "head": head, "clone": str(clone)}))


if __name__ == "__main__":
    try:
        if sys.argv[1] == "since":
            print(json.dumps(since_diff(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5:])))
        else:
            args = sys.argv[2:]
            opt = lambda name: args[args.index(name) + 1] if name in args else None  # noqa: E731
            roots = [pathlib.Path(a).expanduser() for o, a in zip(args, args[1:]) if o == "--root"]
            BASES = roots or BASES
            main(sys.argv[1], "--clone" in args, opt("--local"))
    except NeedClone as e:
        print(json.dumps({"need_clone": str(e.dest)}))
        sys.exit(3)
    except Exception as e:  # noqa: BLE001 - the panel shows the reason
        print(str(e), file=sys.stderr)
        sys.exit(1)
