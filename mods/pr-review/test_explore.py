"""Run: python3 test_explore.py  (no network, no claude: llm.claude is stubbed)."""
import json
import pathlib
import tempfile

import explore

d = pathlib.Path(tempfile.mkdtemp())
seen = {}


def stub(feature, text, **kw):
    seen.update(feature=feature, text=text, **{k: kw[k] for k in ("schema", "model", "budget", "tools", "cwd", "extra")})
    kw["meta"].update(cost=0.4, ms=1000, model_id="claude-s")
    return {"title": "Reminders", "summary": "A job …", "question": [{"text": "When?", "source": "implemented"}],
            "how_it_works": [{"text": "Cron", "source": "spec", "evidence": "infra/main.tf:3"}],
            "architecture": {"groups": [{"id": "g", "label": "G", "kind": "k"}], "nodes": [{"id": "a", "group": "g", "label": "A", "description": "", "type": "job", "status": "new", "source": "implemented"}],
                             "edges": [{"from": "a", "to": "a", "label": "x", "status": "changed"}]},
            "steps": [{"title": "S", "why_it_matters": "w", "explanation": "e", "reading_order": 1, "evidence": ["jobs/run.py:3"],
                       "visuals": [{"kind": "flow", "title": "f", "nodes": [{"id": "n", "label": "N", "changed": True}], "edges": []}]}]}


real, explore.llm.claude = explore.llm.claude, stub
try:
    r = explore.main({"root": str(d), "repo": "acme/bookshelf", "topic": "How does the reminder job get scheduled?", "model": "sonnet", "out": str(d / "x.json")})
finally:
    explore.llm.claude = real
assert seen["feature"] == "Explore: walkthrough" and seen["schema"] is explore.SCHEMA and seen["budget"] == explore.review.BUDGET["sonnet"]
assert seen["tools"] == "Read,Grep,Glob" and seen["cwd"] == str(d) and "Bash" in seen["extra"] and "Edit" in seen["extra"], "read-only, in the repo"
assert "How does the reminder job get scheduled?" in seen["text"] and "acme/bookshelf" in seen["text"]
a = json.loads((d / "x.json").read_text())["answer"]
assert a["question"][0]["source"] == "existing" and a["how_it_works"][0]["source"] == "existing"
assert a["architecture"]["nodes"][0]["source"] == "existing" and a["architecture"]["nodes"][0]["status"] == "unchanged"
assert a["architecture"]["edges"][0]["status"] == "unchanged" and "changed" not in a["steps"][0]["visuals"][0]["nodes"][0]
assert r["cost"] == 0.4 and r["topic"].startswith("How")
try:
    explore.main({"root": str(d / "missing"), "topic": "x", "model": "haiku", "out": str(d / "y.json")})
    raise AssertionError("a missing folder must fail")
except RuntimeError as e:
    assert "not a folder" in str(e)
print("ok explore")
