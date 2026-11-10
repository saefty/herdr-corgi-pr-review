"""How pr-review calls an LLM headless (`claude -p`), its settings, and an optional usage ledger.

    import llm
    data = llm.claude("Review analysis", prompt, context={"id": "default", "env": None}, model="sonnet", schema=SCHEMA)

Settings come from pr-review.config.json in the Herdr app home (HERDR_APP_HOME, else ~/.config/herdr-app); every
key is optional (see PROVIDERS.md):
  language      the language the AI answers in (default "English")
  ledger        a folder: each call appends one JSON line to usage-YYYY-MM.jsonl there; unset: no ledger
  globalRules   conventions every PR is checked against, besides the repo's own rules files
A context ({id, env}) comes from the panel: env vars for the call (null unsets one); id is recorded in the ledger.
"""
import datetime as dt
import json
import os
import pathlib
import subprocess
import time

APP = pathlib.Path(os.environ.get("HERDR_APP_HOME") or pathlib.Path.home() / ".config/herdr-app")
CONFIG = APP / "pr-review.config.json"
KEEP_MONTHS = 24
LEAN = ["--no-session-persistence", "--output-format", "json",
        "--settings", '{"disableAllHooks":true}', "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
        "--disable-slash-commands"]


def config():
    try:
        return json.loads(CONFIG.read_text()) or {}
    except (OSError, ValueError):
        return {}


def language():
    return config().get("language") or "English"


def ledger_dir():
    path = config().get("ledger")
    return pathlib.Path(os.path.expanduser(path)) if path else None


def env_for(context):
    """The process env with the context's vars applied (None unsets)."""
    env = dict(os.environ)
    for k, v in ((context or {}).get("env") or {}).items():
        if v is None:
            env.pop(k, None)
        else:
            env[k] = os.path.expanduser(str(v))
    return env


def log(feature, context_id, model, cost, tokens=0, ms=0, ok=True, tool="claude"):
    """One ledger line, only when a ledger folder is configured. `account` holds the context id."""
    folder = ledger_dir()
    if not folder:
        return
    folder.mkdir(parents=True, exist_ok=True)
    now = dt.datetime.now().astimezone()
    line = json.dumps({"at": now.isoformat(timespec="seconds"), "feature": feature, "account": context_id, "model": model,
                       "cost": round(float(cost or 0), 6), "tokens": int(tokens or 0), "ms": int(ms), "ok": ok, "tool": tool})
    with open(folder / f"usage-{now:%Y-%m}.jsonl", "a", encoding="utf-8") as f:  # one short O_APPEND write per call
        f.write(line + "\n")
    for old in sorted(folder.glob("usage-*.jsonl"))[:-KEEP_MONTHS]:
        old.unlink(missing_ok=True)


def claude(feature, prompt, *, context=None, model="haiku", schema=None, system=None, budget=0.2,
           timeout=180, tools="", cwd=None, extra=(), meta=None, skills=False):
    """Runs `claude -p`, records the call, returns structured_output (with a schema) or the result text.
    meta: a dict that gets {cost, tokens, ms, model_id} of the call, for callers that show them.
    skills: keep skills and slash commands (a prompt like "/code-review medium 12"); everything else stays lean."""
    lean = [a for a in LEAN if not (skills and a == "--disable-slash-commands")]
    args = ["claude", "-p", "--model", model, *lean, "--max-budget-usd", str(budget)]
    if tools is not None:
        args += ["--tools", tools]
    if schema is not None:
        args += ["--json-schema", json.dumps(schema)]
    if system:
        args += ["--system-prompt", system]
    started = time.monotonic()
    out = subprocess.run([*args, *extra], input=prompt, capture_output=True, text=True, timeout=timeout,
                         env=env_for(context), cwd=str(cwd or APP))
    ms = (time.monotonic() - started) * 1000
    try:
        data = json.loads(out.stdout)
    except ValueError:
        data = {}
    usage = data.get("usage") or {}
    tokens = sum(usage.get(k) or 0 for k in ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
    ok = out.returncode == 0 and not data.get("is_error")
    log(feature, (context or {}).get("id") or "default", model, data.get("total_cost_usd") or 0, tokens, int(ms), ok)
    if meta is not None:
        meta.update(cost=data.get("total_cost_usd"), tokens=tokens, ms=int(ms), model_id=next(iter(data.get("modelUsage") or {}), model),
                    result=data.get("result"))
    if not ok:
        raise RuntimeError(f"{feature}: {(out.stderr or out.stdout).strip()[:300]}")
    return data.get("structured_output") if schema is not None else data.get("result")
