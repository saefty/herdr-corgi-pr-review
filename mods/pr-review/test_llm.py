"""Run: python3 test_llm.py  (no network: subprocess.run is stubbed)."""
import json
import pathlib
import subprocess
import tempfile

import llm

calls = []


def fake_run(args, **kw):
    calls.append((args, kw))
    out = {"result": "hi", "structured_output": {"x": 1}, "total_cost_usd": 0.0123, "usage": {"input_tokens": 10, "output_tokens": 5},
           "modelUsage": {"claude-haiku-x": {}}}
    return subprocess.CompletedProcess(args, 0, json.dumps(out), "")


real = subprocess.run
subprocess.run = fake_run
try:
    with tempfile.TemporaryDirectory() as d:
        llm.CONFIG = pathlib.Path(d) / "pr-review.config.json"

        # No settings: no ledger is written, English is the language, the context's env is applied.
        meta = {}
        got = llm.claude("Feature A", "prompt", context={"id": "red", "env": {"CLAUDE_CONFIG_DIR": "/x/.claude-red", "GONE": None}},
                         schema={"type": "object"}, meta=meta)
        assert got == {"x": 1}, got
        args, kw = calls[-1]
        assert args[:4] == ["claude", "-p", "--model", "haiku"] and "--json-schema" in args and kw["input"] == "prompt"
        assert kw["env"]["CLAUDE_CONFIG_DIR"] == "/x/.claude-red" and "GONE" not in kw["env"]
        assert meta["cost"] == 0.0123 and meta["tokens"] == 15 and meta["model_id"] == "claude-haiku-x"
        assert llm.language() == "English" and llm.ledger_dir() is None
        assert not list(pathlib.Path(d).rglob("usage-*.jsonl"))

        # A ledger folder configured: one line per call, with the feature and the context id as `account`.
        ledger = pathlib.Path(d) / "ledger"
        llm.CONFIG.write_text(json.dumps({"ledger": str(ledger), "language": "German"}))
        assert llm.claude("Feature B", "p", context={"id": "blue", "env": None}) == "hi"
        lines = [json.loads(x) for f in ledger.glob("usage-*.jsonl") for x in f.read_text().splitlines()]
        assert [(e["feature"], e["account"], e["cost"], e["tokens"], e["ok"]) for e in lines] == [("Feature B", "blue", 0.0123, 15, True)], lines
        assert llm.language() == "German"
        llm.log("Codex review", "blue", "codex", 0, 100, tool="codex")  # non-Claude tools log the same way
        assert len(next(ledger.glob("usage-*.jsonl")).read_text().splitlines()) == 2

        # No context: the env is inherited untouched, the ledger says "default".
        llm.claude("Feature C", "p")
        assert calls[-1][1]["env"].get("CLAUDE_CONFIG_DIR") == __import__("os").environ.get("CLAUDE_CONFIG_DIR")
        assert json.loads(next(ledger.glob("usage-*.jsonl")).read_text().splitlines()[-1])["account"] == "default"

        # A failed call raises with the reason, and is still in the ledger as not ok.
        subprocess.run = lambda args, **kw: subprocess.CompletedProcess(args, 1, "", "boom")
        try:
            llm.claude("Feature D", "p")
            raise AssertionError("no error")
        except RuntimeError as e:
            assert "boom" in str(e)
        assert json.loads(next(ledger.glob("usage-*.jsonl")).read_text().splitlines()[-1])["ok"] is False

    # reviewers.py: a missing slash command is recognized (the review then runs as a plain prompt).
    import reviewers
    assert reviewers.missing_command("Unknown skill: code-review") and reviewers.missing_command("Unknown slash command /x")
    assert not reviewers.missing_command("3 findings")
finally:
    subprocess.run = real
print("ok")
