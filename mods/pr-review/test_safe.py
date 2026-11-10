"""Untrusted checkouts: language servers start without anything that runs the repo's code. python3 test_safe.py"""
import os
import sys
import tempfile
import types

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lsp_bridge as b  # noqa: E402

started = []
b.subprocess = types.SimpleNamespace(**{**vars(b.subprocess), "Popen": lambda cmd, **kw: started.append((cmd, kw)) or
                                         types.SimpleNamespace(pid=1, stderr=None, stdin=None, stdout=None, poll=lambda: None)})
b.shutil.which = lambda name, path=None: f"/bin/{name}"
b.CappedLog = lambda *_a: types.SimpleNamespace(pump=lambda *_: None)
b.threading.Thread = lambda **_kw: types.SimpleNamespace(start=lambda: None)
b.data_dir = lambda *_a: tempfile.mkdtemp()

root = tempfile.mkdtemp()
os.makedirs(os.path.join(root, "node_modules", "typescript", "lib"))
open(os.path.join(root, "node_modules", "typescript", "lib", "tsserver.js"), "w").close()

try:  # rust-analyzer never starts on untrusted code
    b.Server(root, "rust", safe=True)
    raise AssertionError("rust-analyzer started in safe mode")
except RuntimeError as e:
    assert "Restricted Mode" in str(e)
assert b.Server(root, "rust", safe=False).options["cargo"]["buildScripts"] == {"enable": True}

java = b.Server(root, "java", safe=True).options["settings"]["java"]
assert java["import"]["gradle"] == {"enabled": False} and java["import"]["maven"] == {"enabled": False}
assert java["autobuild"] == {"enabled": False}

b.Server(root, "typescript", safe=True)
assert started[-1][0][:2] == ["/bin/tsc", "--lsp"], started[-1][0]  # never the checkout's own TypeScript
b.Server(root, "go", safe=True)
assert started[-1][1]["env"]["GOPROXY"] == "off" and started[-1][1]["env"]["GOFLAGS"] == "-mod=readonly" and started[-1][1]["env"]["CGO_ENABLED"] == "0"
assert b.Server(root, "go", safe=False) and started[-1][1]["env"] is None
print("ok")
