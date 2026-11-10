# Run: python3 test_lsp_bridge.py   (pure helpers, then a throwaway bridge in a temp HERDR_APP_HOME: token, paths, idle exit)
import json, os, subprocess, sys, tempfile, time, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import lsp_bridge as b

root = os.path.realpath(HERE)
assert b.inside(root, "main.js") == os.path.join(root, "main.js")
assert b.inside(root, "../x") is None and b.inside(root, "/etc/passwd") is None
assert b.preview("a\nb\nc\nd\ne", 2, 1, 1) == (2, ["b", "c", "d"])
assert b.preview("a\nb", 0, 3, 8) == (1, ["a", "b"])
assert b.hover_text({"kind": "markdown", "value": "**x**"}) == "**x**"
assert b.hover_text([{"language": "go", "value": "func F()"}, "doc"]) == "```go\nfunc F()\n```\n\ndoc"
assert b.hover_text(None) == ""
assert b.ext_of("/a/b.TSX") == "tsx" and b.ext_of("/a/Makefile") == ""
assert b.jdt_name("jdt://contents/rt.jar/java.util/List.class?=x") == "java.util.List"

# Bounded storage: LRU by last use, count and byte caps, 14-day expiry, unknown dirs dropped, in-use dirs kept.
data = tempfile.mkdtemp()
b.DATA, b.INDEX = data, os.path.join(data, "lsp-index.json")
b.LIMITS = {"jdtls": (2, 3000)}
now = time.time()
idx = {}
for name, age_days, size in [("a", 1, 1000), ("b", 2, 1000), ("c", 3, 1000), ("old", 20, 10), ("big", 0.5, 5000)]:
    os.makedirs(os.path.join(data, "jdtls", name))
    open(os.path.join(data, "jdtls", name, "f"), "wb").write(b"x" * size)
    idx[f"jdtls/{name}"] = {"root": f"/r/{name}", "last": now - age_days * 86400}
os.makedirs(os.path.join(data, "jdtls", "legacy"))
json.dump(idx, open(b.INDEX, "w"))
removed = b.prune(keep={"jdtls/c"})
assert sorted(os.listdir(os.path.join(data, "jdtls"))) == ["a", "c"], os.listdir(os.path.join(data, "jdtls"))
assert sorted(removed) == ["jdtls/b", "jdtls/big", "jdtls/legacy", "jdtls/old"], removed
assert set(b.load_index()) == {"jdtls/a", "jdtls/c"}
assert b.forget_dirs("/r/a") == ["jdtls/a"] and not os.path.exists(os.path.join(data, "jdtls", "a"))

# Logs rotate: at most LOG_CAP plus one backup.
b.LOG_CAP = 1000
lg = b.CappedLog(os.path.join(data, "x.log"))
for _ in range(100):
    lg.write("y" * 99 + "\n")
assert os.path.getsize(os.path.join(data, "x.log")) <= 1100 and os.path.getsize(os.path.join(data, "x.log.1")) <= 1100

# Repo identity: same repo id for a checkout's worktrees (slot "wt"), stable across paths.
repo = tempfile.mkdtemp()
git = lambda *a, cwd=repo: subprocess.run(["git", *a], cwd=cwd, capture_output=True, check=True)
git("init", "-q"); git("-c", "user.email=x@y", "-c", "user.name=x", "commit", "-q", "--allow-empty", "-m", "x")
git("worktree", "add", "-q", ".worktrees/review")
main_id, wt_id = b.repo_id(repo), b.repo_id(os.path.join(repo, ".worktrees", "review"))
assert main_id.endswith("-main") and wt_id.endswith("-wt") and main_id[:-5] == wt_id[:-3], (main_id, wt_id)
assert b.throwaway(os.path.join(repo, ".worktrees", "review")) and not b.throwaway(repo)

home = tempfile.mkdtemp()
env = {**os.environ, "HERDR_APP_HOME": home, "LSP_BRIDGE_IDLE": "4"}
st = json.loads(subprocess.run([sys.executable, os.path.join(HERE, "lsp_bridge.py"), "start"], env=env, capture_output=True, text=True).stdout)
state = os.path.join(home, "pr-data", "lsp-bridge.json")
assert oct(os.stat(state).st_mode & 0o777) == "0o600"


def post(path, body, headers):
    req = urllib.request.Request(f"http://127.0.0.1:{st['port']}{path}", data=json.dumps(body).encode(), method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


ok = {"X-Bridge-Token": st["token"]}
assert post("/status", {}, {})[0] == 403
assert post("/status", {}, {"X-Bridge-Token": "x"})[0] == 403
assert post("/status", {}, {**ok, "Origin": "http://evil"})[0] == 403
assert post("/status", {}, ok) == (200, post("/status", {}, ok)[1]) and post("/status", {}, ok)[1]["servers"] == []
assert post("/hover", {"root": root, "path": "../../../.ssh/config", "line": 1}, ok)[1]["message"] == "path is not a file inside root"
assert post("/hover", {"root": "relative", "path": "main.js"}, ok)[1]["message"] == "root is not a local folder"
assert post("/definition", {"root": root, "path": "AGENTS.md" if os.path.exists(os.path.join(root, "AGENTS.md")) else "mod.json", "line": 1}, ok)[1]["status"] == "unsupported"
assert post("/contents", {"root": root, "uri": "file:///etc/hosts"}, ok)[0] == 400
time.sleep(10)
assert not os.path.exists(state), "bridge should exit after idling"
print("lsp_bridge ok")
