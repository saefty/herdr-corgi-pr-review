"""Run: python3 test_prs.py  (no network, no transcripts)."""
import json

import prs

use = lambda id_, name, **inp: json.dumps({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": id_, "name": name, "input": inp}]}})
res = lambda id_, content: json.dumps({"type": "user", "timestamp": "2026-11-01T10:00:00Z", "cwd": "/repo",
                                       "message": {"content": [{"type": "tool_result", "tool_use_id": id_, "content": content}]}})

lines = [
    '{"type":"attachment","content":"- skill: ... then runs `gh pr create` https://github.com/a/b/pull/9"}',  # a mention, no call
    use("t1", "Bash", command="git push -u origin x && gh pr create --fill"),
    res("t1", "remote: Create a pull request for 'x' on GitHub by visiting:\nhttps://github.com/acme/api/pull/new/x\nhttps://github.com/acme/api/pull/42\n"),
    use("t2", "Bash", command="gh pr view 7"),  # not a create
    res("t2", "https://github.com/acme/api/pull/7"),
    use("t3", "Bash", command="gh pr create --fill"),
    res("t3", "Error: permission denied"),  # denied/failed: nothing created
    use("t4", "mcp__github__create_pull_request", owner="acme", repo="web"),
    res("t4", [{"type": "text", "text": '{"html_url":"https://github.com/acme/web/pull/3","url":"https://api.github.com/repos/acme/web/pulls/3"}'}]),
]
lines += [  # a shell function with one `gh pr create`, called for several repos: every URL counts, once
    use("t5", "Bash", command='pr() { gh pr create -R "$1" --fill; }; pr acme/a; pr acme/b'),
    res("t5", "https://github.com/acme/a/pull/1\nhttps://github.com/acme/b/pull/2\nhttps://github.com/acme/b/pull/2"),
    use("t6", "Bash", command="grep -rl 'gh pr create' ~/.claude/projects | xargs grep -ho 'https://github.com/[^\"]*'"),  # searching, not creating
    res("t6", "https://github.com/other/repo/pull/9"),
]
got = prs.created(lines)
assert [p["url"] for p in got] == ["https://github.com/acme/api/pull/42", "https://github.com/acme/web/pull/3",
                                   "https://github.com/acme/a/pull/1", "https://github.com/acme/b/pull/2"], got
assert got[0] == {"url": "https://github.com/acme/api/pull/42", "repo": "acme/api", "number": 42, "at": "2026-11-01T10:00:00Z", "cwd": "/repo"}

# Contexts by the plug-in's rules, first rule wins: folder rules on the session cwd, remote rules on the repo URL.
rules = [{"path": "~/code/red", "context": "red"}, {"path": "~/code/blue", "context": "blue"},
         {"remote": "github\\.com[:/]acme/", "context": "blue"}, {"remote": "bookshelf", "context": "blue"}]
H = str(prs.HOME)
assert prs.context_for(H + "/code/red/Widget", "https://github.com/widget/widget", rules) == "red"
assert prs.context_for(H + "/code/RED/widget/", None, rules) == "red"  # case and trailing slash
assert prs.context_for(H + "/.herdr/worktrees/bookshelf/x", "https://github.com/acme/bookshelf", rules) == "blue"
assert prs.context_for(H + "/code/redder", "https://github.com/a/b", rules) is None  # a prefix is not a parent folder
assert prs.context_for(None, "https://github.com/x/bookshelf-thing", rules) == "blue"
assert prs.context_for(None, "https://github.com/x/y", [{"remote": "(", "context": "z"}]) is None  # a bad regex matches nothing
# pr.js hash() in Python, for cache names.
assert prs.fnv("") == "811c9dc5" and prs.fnv("a") == "e40c292c"
print("ok")

# prune: a big diff's index and parts are one unit (counted once, dropped together)
import os, pathlib, tempfile
with tempfile.TemporaryDirectory() as d:
    prs.CACHE, prs.CACHE_FILES = pathlib.Path(d), 2
    for n in ["diff-aa-h1.json", "diff-aa-h1.0.txt", "diff-aa-h1.1.txt", "diff-bb-h2.json", "other.json"]:
        (prs.CACHE / n).write_text("x")
    for n, t in [("diff-bb-h2.json", 1), ("other.json", 2)]:
        os.utime(prs.CACHE / n, (t, t))
    prs.prune_cache()
    assert sorted(p.name for p in prs.CACHE.iterdir()) == ["diff-aa-h1.0.txt", "diff-aa-h1.1.txt", "diff-aa-h1.json", "other.json"]
