"""Run: python3 test_worktree.py  (a throwaway git repo, no network)."""
import pathlib
import subprocess
import tempfile

import worktree

with tempfile.TemporaryDirectory() as d:
    git = lambda *a: subprocess.run(["git", *a], cwd=d, check=True, capture_output=True, text=True).stdout.strip()
    git("init", "-q", "-b", "main")
    git("config", "user.email", "t@t"); git("config", "user.name", "t")
    f = pathlib.Path(d, "a.py")
    f.write_text("x = 1\n"); git("add", "."); git("commit", "-qm", "base")
    base = git("rev-parse", "HEAD")
    f.write_text("x = 2\n"); git("commit", "-qam", "pr v1")
    v1 = git("rev-parse", "HEAD")
    pathlib.Path(d, "b.py").write_text("y = 1\n"); git("add", "."); git("commit", "-qm", "pr v2")
    v2 = git("rev-parse", "HEAD")
    # A plain push: exactly the new commit.
    r = worktree.since_diff(d, v1, v2, ["a.py", "b.py"])
    assert r["mode"] == "ancestor" and "b.py" in r["patch"] and "a.py" not in r["patch"], r
    # A force push (v1 rewritten): both states of the PR's files compared.
    git("checkout", "-q", base); f.write_text("x = 3\n"); git("commit", "-qam", "pr v1 rewritten")
    v3 = git("rev-parse", "HEAD")
    r = worktree.since_diff(d, v1, v3, ["a.py"])
    assert r["mode"] == "interdiff" and "-x = 2" in r["patch"] and "+x = 3" in r["patch"] and r["note"], r
    # The old head is gone (no origin to fetch it from): the full PR.
    r = worktree.since_diff(d, "1" * 40, v3, ["a.py"])
    assert r["mode"] == "full" and r["patch"] == "", r
    # Fix verification's evidence: the finding's file diff since it went to Fix, else the file around the line now.
    import verify
    req = {"worktree": d, "head": v2, "items": [{"id": "f1", "file": "b.py", "line": 1, "title": "t", "since": v1}, {"id": "f2", "file": "a.py", "line": 1, "title": "u", "since": v1}]}
    p = verify.prompt(req)
    assert "[f1]" in p and "+y = 1" in p and "No change to the file" in p and "The file now, from line 1:" in p, p  # the checkout as it is (here: the rewritten head)

# Clones: a dedicated one first, else the local checkout of that repo; none: NeedClone with the first root's folder.
with tempfile.TemporaryDirectory() as d:
    base = pathlib.Path(d)
    worktree.BASES = [base / "blue", base / "red"]
    def repo_at(path, url):
        path.mkdir(parents=True)
        subprocess.run(["git", "init", "-q"], cwd=path, check=True)
        subprocess.run(["git", "remote", "add", "origin", url], cwd=path, check=True)
    repo_at(base / "space", "git@github.com:acme/api.git")
    assert worktree.find_clone("acme", "api", base / "space").resolve() == (base / "space").resolve()
    assert worktree.find_clone("acme", "web", base / "space") is None  # another repo's checkout is not used
    try:
        worktree.clone_for("acme", "web")
        raise AssertionError("cloned without being asked")
    except worktree.NeedClone as e:
        assert e.dest == base / "blue" / "web"
    repo_at(base / "red" / "api", "https://github.com/other/api")  # taken by another repo: the owner-repo name
    repo_at(base / "red" / "acme-api", "https://github.com/acme/api.git")
    assert worktree.find_clone("acme", "api", base / "space") == base / "red" / "acme-api"  # dedicated beats local
print("ok")
