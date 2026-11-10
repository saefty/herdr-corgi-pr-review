#!/usr/bin/env python3
"""LSP bridge for the pr-review mod: one small HTTP server per user that keeps language servers warm.

  lsp_bridge.py start              start the bridge unless one runs; prints {"port", "token"}
  lsp_bridge.py serve              run in the foreground (what `start` launches)
  lsp_bridge.py call /hover JSON   one request through the bridge (fallback for clients without HTTP)
  lsp_bridge.py stop
  lsp_bridge.py forget ROOT        stop ROOT's language servers and delete their index dirs (worktree removal)
  lsp_bridge.py du                 disk footprint under pr-data

HTTP on 127.0.0.1 only; every request needs the header X-Bridge-Token (the token is in pr-data/lsp-bridge.json,
mode 0600). POST /definition, /hover {root, path, line (1-based), character (UTF-16), before?, after?};
POST /contents {root, uri}: text of a file or jdt:// class a definition pointed at; POST /status; GET /health.
Language servers start per (root, language) on demand, over stdio, with the user's environment; they read the real
files under `root`, so `root` must be a checkout at the reviewed revision. No command or path comes from the client:
servers are a fixed table, and request paths must resolve inside `root`. Exits after IDLE seconds without requests.
"""
import fcntl, hashlib, hmac, json, os, secrets, shutil, subprocess, sys, threading, time, urllib.parse, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOME = os.environ.get("HERDR_APP_HOME") or os.path.expanduser("~/.config/herdr-app")
DATA = os.path.join(HOME, "pr-data")
STATE = os.path.join(DATA, "lsp-bridge.json")
LOCK = os.path.join(DATA, "lsp-bridge.lock")
LOG = os.path.join(DATA, "lsp-bridge.log")
IDLE = float(os.environ.get("LSP_BRIDGE_IDLE", 20 * 60))
TIMEOUT = float(os.environ.get("LSP_BRIDGE_TIMEOUT", 5))
PATH_EXTRA = ["/opt/homebrew/bin", "/usr/local/bin", os.path.expanduser("~/.cargo/bin"), os.path.expanduser("~/go/bin")]

# ext -> (server, LSP languageId)
EXT = {"ts": ("typescript", "typescript"), "mts": ("typescript", "typescript"), "cts": ("typescript", "typescript"),
       "tsx": ("typescript", "typescriptreact"), "js": ("typescript", "javascript"), "mjs": ("typescript", "javascript"),
       "cjs": ("typescript", "javascript"), "jsx": ("typescript", "javascriptreact"), "py": ("python", "python"),
       "pyi": ("python", "python"), "go": ("go", "go"), "rs": ("rust", "rust"), "tf": ("terraform", "terraform"),
       "tfvars": ("terraform", "terraform-vars"), "java": ("java", "java"), "c": ("cpp", "c"), "h": ("cpp", "cpp"),
       "cc": ("cpp", "cpp"), "cpp": ("cpp", "cpp"), "cxx": ("cpp", "cpp"), "hpp": ("cpp", "cpp"), "hh": ("cpp", "cpp"),
       "hxx": ("cpp", "cpp"), "ino": ("cpp", "cpp")}
SERVERS = {"typescript": ["typescript-language-server", "--stdio"], "python": ["pyright-langserver", "--stdio"],
           "go": ["gopls"], "rust": ["rust-analyzer"], "terraform": ["terraform-ls", "serve"], "java": ["jdtls"],
           "cpp": ["clangd", "--log=error", "--header-insertion=never"]}
LABEL = {"typescript": "TypeScript", "python": "Python", "go": "Go", "rust": "Rust", "terraform": "Terraform", "java": "Java", "cpp": "C/C++"}
SLOW = {"java", "rust"}  # ready only when the server says its index is loaded; until then requests answer "starting"
LIMITED_CPP = "_Limited C++ info (no compile_commands.json)_"


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, file=sys.stderr, flush=True)


def uri_of(path):
    return "file://" + urllib.parse.quote(path)


def path_of(uri):
    return urllib.parse.unquote(urllib.parse.urlparse(uri).path) if uri.startswith("file://") else None


def inside(root, path):
    """Absolute real path of `path` (relative to root) if it stays inside root, else None."""
    full = os.path.realpath(os.path.join(root, path))
    return full if full == root or full.startswith(root + os.sep) else None


def under(root, path):
    return bool(path) and os.path.realpath(path).startswith(root + os.sep)


def preview(text, line, before, after):
    lines = text.split("\n")
    lo = max(0, line - before)
    return lo + 1, lines[lo:line + after + 1]


def hover_text(contents):
    if contents is None:
        return ""
    if isinstance(contents, str):
        return contents
    if isinstance(contents, list):
        return "\n\n".join(t for t in (hover_text(c) for c in contents) if t)
    if "language" in contents:
        return f"```{contents['language']}\n{contents.get('value', '')}\n```"
    return contents.get("value", "")


# --- What the bridge keeps on disk: bounded --------------------------------------------------------------------
# Index/build dirs live in pr-data/<kind>/<repo id>, keyed by repo (git common dir) and slot (main checkout or a
# worktree), never inside the repo. pr-data/lsp-index.json records each one's root and last use; prune() keeps at
# most LIMITS[kind] of them (count, bytes), drops any unused for 14 days and any not in the index.
INDEX = os.path.join(DATA, "lsp-index.json")
LIMITS = {"jdtls": (3, 1 << 30), "rust-target": (3, 1 << 30)}
MAX_AGE = 14 * 86400
LOG_CAP = 256 * 1024
index_lock = threading.Lock()


class CappedLog:
    """Append-only log that rotates to <path>.1 past LOG_CAP: at most 2 x 256 KB per file."""

    def __init__(self, path):
        self.path, self.lock, self.f = path, threading.Lock(), None

    def write(self, data):
        if isinstance(data, str):
            data = data.encode(errors="replace")
        with self.lock:
            if self.f is None or self.f.tell() > LOG_CAP:
                if self.f:
                    self.f.close()
                if os.path.exists(self.path) and os.path.getsize(self.path) > LOG_CAP:
                    os.replace(self.path, self.path + ".1")
                self.f = open(self.path, "ab")
            self.f.write(data)
            self.f.flush()
        return len(data)

    def flush(self):
        pass

    def pump(self, stream):
        """Copies a child's stderr into the log on a thread."""
        def run():
            for line in iter(stream.readline, b""):
                self.write(line)
        threading.Thread(target=run, daemon=True).start()


def repo_id(root):
    """<name>-<hash of git common dir>-<main|wt>; the same for every checkout of one repo in the same slot."""
    try:
        out = subprocess.run(["git", "-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"],
                             capture_output=True, text=True, timeout=5).stdout.split("\n")
        common, top = os.path.realpath(out[0]), os.path.realpath(out[1])
        main = os.path.dirname(common) if os.path.basename(common) == ".git" else common
        return f"{os.path.basename(main)}-{hashlib.sha1(common.encode()).hexdigest()[:8]}-{'main' if top == main else 'wt'}"
    except Exception:
        return f"{os.path.basename(root)}-{hashlib.sha1(root.encode()).hexdigest()[:8]}-dir"


def load_index():
    try:
        return json.load(open(INDEX))
    except Exception:
        return {}


def size_of(path):
    total = 0
    for d, _, files in os.walk(path):
        for f in files:
            try:
                total += os.lstat(os.path.join(d, f)).st_size
            except OSError:
                pass
    return total


def data_dir(kind, root, active=()):
    """The dir for (kind, root), recorded as used now; prunes the others first."""
    key = f"{kind}/{repo_id(root)}"
    with index_lock:
        idx = load_index()
        idx[key] = {"root": root, "last": time.time()}
        write_private(INDEX, json.dumps(idx, indent=1))
    prune(keep={key, *active})
    path = os.path.join(DATA, key)
    os.makedirs(path, exist_ok=True)
    return path


def prune(keep=(), now=None):
    """Deletes data dirs past the limits (LRU), unused for MAX_AGE, or unknown to the index. `keep`: in use."""
    now = now or time.time()
    removed = []
    with index_lock:
        idx = load_index()
        for kind, (max_n, max_bytes) in LIMITS.items():
            base = os.path.join(DATA, kind)
            on_disk = {f"{kind}/{n}" for n in (os.listdir(base) if os.path.isdir(base) else [])}
            for key in list(idx):
                if key.startswith(kind + "/") and key not in on_disk and key not in keep:
                    del idx[key]  # deleted by hand
            entries = sorted((k for k in on_disk if k in idx), key=lambda k: -idx[k]["last"])
            drop = {k for k in on_disk if k not in idx and k not in keep}
            kept = [k for k in entries if k in keep]  # in use: always stays, and counts against the limits first
            n, total = len(kept), sum(size_of(os.path.join(DATA, k)) for k in kept)
            for k in entries:
                if k in keep:
                    continue
                size = size_of(os.path.join(DATA, k))
                if now - idx[k]["last"] > MAX_AGE or n >= max_n or total + size > max_bytes:
                    drop.add(k)
                else:
                    n += 1
                    total += size
            for k in drop:
                shutil.rmtree(os.path.join(DATA, k), ignore_errors=True)
                idx.pop(k, None)
                removed.append(k)
        write_private(INDEX, json.dumps(idx, indent=1))
    if removed:
        log("pruned", *removed)
    return removed


def forget_dirs(root):
    """Deletes every data dir recorded for root."""
    root = os.path.realpath(root)
    with index_lock:
        idx = load_index()
        gone = [k for k, v in idx.items() if os.path.realpath(v.get("root", "")) == root]
        for k in gone:
            shutil.rmtree(os.path.join(DATA, k), ignore_errors=True)
            del idx[k]
        write_private(INDEX, json.dumps(idx, indent=1))
    return gone


def walk(root, depth):
    """os.walk to `depth` levels, skipping dot dirs, build output and node_modules."""
    base = root.rstrip(os.sep).count(os.sep)
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if not x.startswith(".") and x not in ("build", "bin", "node_modules", "target")]
        if d.count(os.sep) - base >= depth:
            dirs[:] = []
        yield d, dirs, files


def throwaway(root):
    # ponytail: the pr-review agent's review worktree lives at <clone>/.worktrees/review; caches may go inside it.
    return f"{os.sep}.worktrees{os.sep}" in root + os.sep


class Server:
    """One language server process over stdio JSON-RPC."""

    def __init__(self, root, lang, active=()):
        self.root, self.lang, self.dirs, self.new_bins = root, lang, [], []
        self.pending, self.opened, self.known = {}, {}, set()
        self.lock, self.next_id = threading.Lock(), 0
        self.ready = threading.Event()
        self.state, self.message, self.error = "starting", f"{LABEL[lang]} server is starting…", None
        cmd = list(SERVERS[lang])
        if lang == "typescript" and not os.path.isfile(os.path.join(root, "node_modules", "typescript", "lib", "tsserver.js")):
            cmd = ["tsc", "--lsp", "--stdio"]  # no project TypeScript: the global TypeScript 7 (native) has its own LSP
        cmd[0] = shutil.which(name := cmd[0], path=os.environ.get("PATH", "") + os.pathsep + os.pathsep.join(PATH_EXTRA))
        if not cmd[0]:
            raise RuntimeError(f"{name} is not installed")
        self.options = {}
        if lang == "java":  # index in pr-data; .project/.classpath/.settings/bin in the data dir, not the repo
            self.dirs.append(data := data_dir("jdtls", root, active))
            if not throwaway(root):  # Buildship still creates empty <module>/bin folders: remember which were new
                self.new_bins = [b for b in (os.path.join(d, "bin") for d, _, fs in walk(root, 3) if {"build.gradle", "build.gradle.kts", "pom.xml"} & set(fs))
                                 if not os.path.exists(b)]
            cmd += ["-data", data, "--jvm-arg=-Djava.import.generatesMetadataFilesAtProjectRoot=false"]
            self.message = "Java index is building…"
            self.options = {"settings": {"java": {"import": {"gradle": {"enabled": True}, "maven": {"enabled": True},
                                                             "generatesMetadataFilesAtProjectRoot": False},
                                                  # Compiling writes <module>/bin (and runs annotation processors):
                                                  # only in a throwaway review worktree, not in the user's repo.
                                                  "autobuild": {"enabled": throwaway(root)}}},
                            "extendedClientCapabilities": {"classFileContentsSupport": True}}
        if lang == "rust":  # build scripts and proc macros compile into pr-data, never <repo>/target; no cargo check
            self.dirs.append(target := data_dir("rust-target", root, active))
            self.message = "Rust analyzer is indexing…"
            self.options = {"cargo": {"targetDir": target}, "checkOnSave": False}
        self.limited = False
        if lang == "cpp":  # clangd: a compilation database if there is one, else C++20 fallback flags (Arduino .ino too)
            db = next((d for d in (root, os.path.join(root, "build"), os.path.join(root, ".pio", "build")) if os.path.isfile(os.path.join(d, "compile_commands.json"))), None)
            if db:
                cmd.append(f"--compile-commands-dir={db}")
            self.limited = db is None
            # The background index writes <db dir>/.cache/clangd: only in a throwaway review worktree.
            cmd.append(f"--background-index={'true' if throwaway(root) else 'false'}")
            self.options = {"fallbackFlags": ["-xc++", "-std=c++20"]}
        self.proc = subprocess.Popen(cmd, cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     start_new_session=True)
        CappedLog(os.path.join(DATA, f"lsp-{lang}.log")).pump(self.proc.stderr)
        self.started = time.time()
        threading.Thread(target=self.read_loop, daemon=True).start()
        threading.Thread(target=self.initialize, daemon=True).start()

    # JSON-RPC plumbing
    def send(self, msg):
        body = json.dumps(msg).encode()
        with self.lock:
            self.proc.stdin.write(b"Content-Length: %d\r\n\r\n" % len(body) + body)
            self.proc.stdin.flush()

    def request(self, method, params, timeout=TIMEOUT):
        with self.lock:
            self.next_id += 1
            rid = self.next_id
        slot = self.pending[rid] = [threading.Event(), None, None]
        try:
            self.send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
            if not slot[0].wait(timeout):
                self.send({"jsonrpc": "2.0", "method": "$/cancelRequest", "params": {"id": rid}})
                raise TimeoutError(f"{LABEL[self.lang]} server did not answer within {timeout:g} s")
        finally:
            self.pending.pop(rid, None)
        if slot[2]:
            raise RuntimeError(slot[2].get("message", "language server error"))
        return slot[1]

    def notify(self, method, params):
        self.send({"jsonrpc": "2.0", "method": method, "params": params})

    def read_loop(self):
        out = self.proc.stdout
        try:
            while True:
                length = 0
                while True:
                    line = out.readline()
                    if not line:
                        raise EOFError
                    if line in (b"\r\n", b"\n"):
                        break
                    if line.lower().startswith(b"content-length:"):
                        length = int(line.split(b":")[1])
                self.dispatch(json.loads(out.read(length)))
        except Exception as e:  # EOF or garbage: the server is gone
            self.state, self.message = "dead", f"{LABEL[self.lang]} server exited"
            if not isinstance(e, EOFError):
                log(self.lang, "read error", repr(e))
            for slot in list(self.pending.values()):
                slot[2] = {"message": self.message}
                slot[0].set()

    def dispatch(self, msg):
        method = msg.get("method")
        if method is None:  # a response
            slot = self.pending.get(msg.get("id"))
            if slot:
                slot[1], slot[2] = msg.get("result"), msg.get("error")
                slot[0].set()
            return
        params = msg.get("params") or {}
        if "id" in msg:  # a request from the server: answer the few that matter, null for the rest
            result = None
            if method == "workspace/configuration":
                result = [None] * len(params.get("items", []))
            elif method == "workspace/workspaceFolders":
                result = [{"uri": uri_of(self.root), "name": os.path.basename(self.root)}]
            self.send({"jsonrpc": "2.0", "id": msg["id"], "result": result})
        elif method == "experimental/serverStatus" and params.get("quiescent"):  # rust-analyzer finished loading
            self.mark_ready()
        elif method == "language/status" and self.lang == "java":  # jdtls: Starting… / Started / ServiceReady
            if params.get("type") in ("Started", "ServiceReady"):
                self.mark_ready()
            elif self.state != "ready":
                self.message = f"Java index is building… {params.get('message', '')}".strip()

    def mark_ready(self):
        if self.state != "ready":
            log(self.lang, self.root, f"ready after {time.time() - self.started:.1f}s")
        self.state, self.message = "ready", ""
        self.ready.set()

    def initialize(self):
        try:
            self.request("initialize", {
                "processId": os.getpid(), "rootUri": uri_of(self.root), "rootPath": self.root,
                "workspaceFolders": [{"uri": uri_of(self.root), "name": os.path.basename(self.root)}],
                "initializationOptions": self.options,
                "capabilities": {
                    "general": {"positionEncodings": ["utf-16"]},
                    "textDocument": {"definition": {"linkSupport": True}, "hover": {"contentFormat": ["markdown", "plaintext"]},
                                     "synchronization": {"didSave": False}},
                    "workspace": {"configuration": True, "workspaceFolders": True},
                    "window": {"workDoneProgress": False},
                    **({"experimental": {"serverStatusNotification": True}} if self.lang == "rust" else {})}}, timeout=300)
            self.notify("initialized", {})
            if self.lang not in SLOW:
                self.mark_ready()
        except Exception as e:
            self.state, self.message, self.error = "dead", f"{LABEL[self.lang]} server failed to start: {e}", str(e)
            self.ready.set()  # settled, not ready: callers check state
            log(self.lang, "initialize failed", repr(e))

    def sync(self, full):
        """didOpen / didChange so the server sees the file as it is on disk now."""
        with open(full, encoding="utf-8", errors="replace") as f:
            text = f.read()
        uri = uri_of(full)
        cur = self.opened.get(uri)
        if cur is None:
            self.notify("textDocument/didOpen", {"textDocument": {"uri": uri, "languageId": EXT[ext_of(full)][1], "version": 1, "text": text}})
        elif cur[1] != text:
            self.notify("textDocument/didChange", {"textDocument": {"uri": uri, "version": cur[0] + 1}, "contentChanges": [{"text": text}]})
        else:
            return uri
        self.opened[uri] = ((cur or (0,))[0] + 1, text)
        return uri

    def text(self, uri):
        """Text behind a definition target: a file on disk, or a class inside a jar (jdtls)."""
        p = path_of(uri)
        if p:
            with open(p, encoding="utf-8", errors="replace") as f:
                return f.read()
        if uri.startswith("jdt://"):
            return self.request("java/classFileContents", {"uri": uri}) or ""
        raise ValueError("unsupported uri")

    def stop(self):
        try:
            if self.proc.poll() is None and self.state == "ready":
                self.request("shutdown", None, timeout=1)
                self.notify("exit", None)
                self.proc.wait(1)
        except Exception:
            pass
        if self.proc.poll() is None:
            self.proc.kill()
        for b in self.new_bins:  # remove the bin folders jdtls created, if they hold no files
            if os.path.isdir(b) and not any(fs for _, _, fs in os.walk(b)):
                shutil.rmtree(b, ignore_errors=True)


def ext_of(path):
    return path.rsplit(".", 1)[-1].lower() if "." in os.path.basename(path) else ""


class Bridge:
    def __init__(self):
        self.servers, self.crashes, self.lock = {}, {}, threading.Lock()
        self.last = time.time()

    def server(self, root, lang):
        key = (root, lang)
        with self.lock:
            s = self.servers.get(key)
            if s and s.proc.poll() is None and s.state != "dead":
                return s
            if s:  # crashed or failed: restart, at most 3 times in 10 minutes
                s.stop()
                hist = [t for t in self.crashes.get(key, []) if time.time() - t < 600] + [time.time()]
                self.crashes[key] = hist
                if len(hist) > 3:
                    raise RuntimeError(s.message or f"{LABEL[lang]} server keeps crashing")
            s = self.servers[key] = Server(root, lang, self.active())
            return s

    def active(self):
        """Data dirs of running servers ("jdtls/<id>"), never pruned."""
        return {os.path.relpath(d, DATA) for s in self.servers.values() if s.proc.poll() is None for d in s.dirs}

    def target(self, req):
        root = os.path.realpath(req.get("root") or "")
        if not os.path.isabs(req.get("root") or "") or not os.path.isdir(root):
            raise PermissionError("root is not a local folder")
        full = inside(root, req.get("path") or "")
        if not full or not os.path.isfile(full):
            raise PermissionError("path is not a file inside root")
        lang = EXT.get(ext_of(full), (None,))[0]
        if not lang:
            return root, full, None
        return root, full, self.server(root, lang)

    def wait_ready(self, s):
        """Never blocks long: a cold Java/Rust index answers 'starting' at once; others get up to TIMEOUT to come up."""
        if not s.ready.wait(0 if s.lang in SLOW else TIMEOUT):
            return {"status": "starting", "message": s.message}
        if s.state == "dead":
            raise RuntimeError(s.message)
        return None

    def position(self, req):
        return {"line": max(0, int(req.get("line", 1)) - 1), "character": max(0, int(req.get("character", 0)))}

    def definition(self, req):
        root, full, s = self.target(req)
        if not s:
            return {"status": "unsupported", "message": f"No language server for .{ext_of(full)} files"}
        busy = self.wait_ready(s)
        if busy:
            return busy
        uri = s.sync(full)
        res = s.request("textDocument/definition", {"textDocument": {"uri": uri}, "position": self.position(req)})
        before, after = int(req.get("before", 2)), int(req.get("after", 8))
        out = []
        for loc in (res if isinstance(res, list) else [res] if res else []):
            u = loc.get("targetUri") or loc.get("uri")
            rng = loc.get("targetSelectionRange") or loc.get("targetRange") or loc.get("range") or {}
            start = rng.get("start", {"line": 0, "character": 0})
            p = path_of(u)
            item = {"uri": u, "line": start["line"] + 1, "character": start["character"], "inRoot": under(root, p)}
            item["path"] = os.path.relpath(os.path.realpath(p), root) if item["inRoot"] else (p or jdt_name(u))
            s.known.add(u)
            try:
                item["previewStart"], item["preview"] = preview(s.text(u), start["line"], before, after)
            except Exception as e:
                item["previewStart"], item["preview"] = item["line"], []
                log("preview failed", u, repr(e))
            out.append(item)
        return {"status": "ok" if out else "none", "definitions": out, "message": "" if out else "No definition found"}

    def hover(self, req):
        root, full, s = self.target(req)
        if not s:
            return {"status": "unsupported", "message": f"No language server for .{ext_of(full)} files"}
        busy = self.wait_ready(s)
        if busy:
            return busy
        uri = s.sync(full)
        res = s.request("textDocument/hover", {"textDocument": {"uri": uri}, "position": self.position(req)})
        text = hover_text((res or {}).get("contents")).strip()
        if text and s.limited:
            text += "\n\n" + LIMITED_CPP
        return {"status": "ok" if text else "none", "markdown": text}

    def contents(self, req):
        root = os.path.realpath(req.get("root") or "")
        uri = req.get("uri") or ""
        p = path_of(uri)
        for s in list(self.servers.values()):
            if s.root == root and (uri in s.known or under(root, p)):
                return {"status": "ok", "text": s.text(uri)}
        raise PermissionError("uri was not returned by a definition in this root")

    def status(self, _req):
        return {"status": "ok", "pid": os.getpid(), "servers": [
            {"root": r, "lang": l, "state": s.state, "message": s.message, "pid": s.proc.pid} for (r, l), s in self.servers.items()]}

    def forget(self, req):
        """Stops root's servers and deletes its data dirs (called when a review worktree is removed)."""
        root = os.path.realpath(req.get("root") or "")
        with self.lock:
            for key in [k for k in self.servers if k[0] == root]:
                self.servers.pop(key).stop()
        return {"status": "ok", "removed": forget_dirs(root)}

    def stop_all(self):
        for s in list(self.servers.values()):
            s.stop()
        with index_lock:  # record last use for the LRU
            idx = load_index()
            for d in {os.path.relpath(d, DATA) for s in self.servers.values() for d in s.dirs}:
                if d in idx:
                    idx[d]["last"] = time.time()
            write_private(INDEX, json.dumps(idx, indent=1))


def make_handler(bridge, token, httpd_ref):
    routes = {"/definition": bridge.definition, "/hover": bridge.hover, "/contents": bridge.contents, "/status": bridge.status,
              "/forget": bridge.forget}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def reply(self, code, obj):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def authorized(self):
            # Browsers send Origin; the mod and the CLI don't. Token compared in constant time.
            if self.headers.get("Origin") or not hmac.compare_digest(self.headers.get("X-Bridge-Token", ""), token):
                self.reply(403, {"status": "error", "message": "forbidden"})
                return False
            bridge.last = time.time()
            return True

        def do_GET(self):
            if self.authorized():
                ok = self.path == "/health"
                self.reply(200 if ok else 404, {"status": "ok", "pid": os.getpid()} if ok else {"status": "error", "message": "not found"})

        def do_POST(self):
            if not self.authorized():
                return
            if self.path == "/shutdown":
                self.reply(200, {"status": "ok"})
                threading.Thread(target=httpd_ref[0].shutdown, daemon=True).start()
                return
            fn = routes.get(self.path)
            if not fn:
                return self.reply(404, {"status": "error", "message": "not found"})
            try:
                req = json.loads(self.rfile.read(min(int(self.headers.get("Content-Length", 0)), 1 << 20)) or b"{}")
                t0 = time.time()
                res = fn(req)
                res["ms"] = round((time.time() - t0) * 1000)
                self.reply(200, res)
            except PermissionError as e:
                self.reply(400, {"status": "error", "message": str(e)})
            except TimeoutError as e:
                self.reply(200, {"status": "timeout", "message": str(e)})
            except Exception as e:
                log(self.path, repr(e))
                self.reply(200, {"status": "error", "message": str(e)})

    return Handler


def write_private(path, text):
    fd = os.open(path + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.chmod(path + ".tmp", 0o600)
    os.replace(path + ".tmp", path)


def serve():
    os.makedirs(DATA, exist_ok=True)
    sys.stderr = CappedLog(LOG)
    lock = open(LOCK, "a")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        log("another bridge holds the lock")
        return 0
    token = secrets.token_urlsafe(32)
    bridge, ref = Bridge(), [None]
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(bridge, token, ref))
    httpd.daemon_threads = True
    ref[0] = httpd
    write_private(STATE, json.dumps({"port": httpd.server_address[1], "token": token, "pid": os.getpid()}))
    log("listening on", httpd.server_address[1])
    threading.Thread(target=prune, daemon=True).start()

    def idle():
        while True:
            time.sleep(min(30, IDLE / 4))
            if time.time() - bridge.last > IDLE:
                log("idle, shutting down")
                httpd.shutdown()
                return
    threading.Thread(target=idle, daemon=True).start()
    try:
        httpd.serve_forever()
    finally:
        bridge.stop_all()
        try:
            if json.load(open(STATE)).get("pid") == os.getpid():
                os.remove(STATE)
        except Exception:
            pass
    return 0


def http(st, method, path, body=None, timeout=10):
    req = urllib.request.Request(f"http://127.0.0.1:{st['port']}{path}", method=method, headers={"X-Bridge-Token": st["token"], "Content-Type": "application/json"},
                                 data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def running():
    try:
        st = json.load(open(STATE))
        http(st, "GET", "/health", timeout=1)
        return st
    except Exception:
        return None


def start():
    st = running()
    if not st:
        os.makedirs(DATA, exist_ok=True)
        old = os.path.getmtime(STATE) if os.path.exists(STATE) else 0
        subprocess.Popen([sys.executable, os.path.abspath(__file__), "serve"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)
        for _ in range(100):
            time.sleep(0.05)
            if os.path.exists(STATE) and os.path.getmtime(STATE) != old and (st := running()):
                break
    if not st:
        print(json.dumps({"status": "error", "message": f"LSP bridge did not start (see {LOG})"}))
        return 1
    print(json.dumps({"port": st["port"], "token": st["token"]}))
    return 0


def main(argv):
    cmd = argv[1] if len(argv) > 1 else "start"
    if cmd == "serve":
        return serve()
    if cmd == "start":
        return start()
    if cmd == "stop":
        st = running()
        if st:
            http(st, "POST", "/shutdown", {})
        return 0
    if cmd == "forget" and len(argv) == 3:  # stop root's servers, delete its data dirs; works with the bridge down too
        st = running()
        res = http(st, "POST", "/forget", {"root": argv[2]}) if st else {"status": "ok", "removed": forget_dirs(argv[2])}
        print(json.dumps(res))
        return 0
    if cmd == "du":
        return du()
    if cmd == "call" and len(argv) == 4:
        if start_quiet() != 0:
            return 1
        print(json.dumps(http(running(), "POST", argv[2], json.loads(argv[3]), timeout=TIMEOUT + 5)))
        return 0
    print(__doc__, file=sys.stderr)
    return 2


def du():
    """Footprint of everything the bridge keeps under pr-data."""
    idx, rows = load_index(), []
    for kind in LIMITS:
        base = os.path.join(DATA, kind)
        for n in sorted(os.listdir(base)) if os.path.isdir(base) else []:
            key = f"{kind}/{n}"
            last = idx.get(key, {}).get("last")
            rows.append((size_of(os.path.join(base, n)), key, f"{(time.time() - last) / 86400:.1f}d ago" if last else "not indexed", idx.get(key, {}).get("root", "")))
    for f in sorted(os.listdir(DATA)) if os.path.isdir(DATA) else []:
        if f.startswith("lsp-") and f.endswith((".log", ".log.1", ".json")):
            rows.append((os.path.getsize(os.path.join(DATA, f)), f, "", ""))
    for size, name, age, root in rows:
        print(f"{size / 1e6:9.1f} MB  {name}  {age}  {root}".rstrip())
    print(f"{sum(r[0] for r in rows) / 1e6:9.1f} MB  total")
    return 0


def start_quiet():
    import io, contextlib
    with contextlib.redirect_stdout(io.StringIO()):
        return start()


def jdt_name(uri):
    # jdt://contents/rt.jar/java.util/List.class?=... -> java.util.List
    m = urllib.parse.unquote(uri).split("?")[0].split("/")
    return ".".join(x for x in m[-2:]).removesuffix(".class") if len(m) >= 2 else uri


if __name__ == "__main__":
    sys.exit(main(sys.argv))
