"""Run: python3 test_review.py  (no network, no claude)."""
import review

# Jira keys: capitals in title/body, any case in the branch; PR-123, ADR-0043, UTF-8 and friends are not tickets.
assert review.jira_key("feat: SHELF-1234 delete users", None, None) == "SHELF-1234"
assert review.jira_key("fix: thing", "feat/shelf-77-x", None) == "SHELF-77"
assert review.jira_key("fix: thing", "revert/pr-267", "see ADR-0043, UTF-8 and sha-256") is None
assert review.jira_key("shelf-12 lower in title", "main", "Closes LOAN-9") == "LOAN-9"
assert review.jira_key("", "0433-round-a-blob", "") is None
assert review.jira_key("x", None, "https://x.atlassian.net/browse/ABC2-41") == "ABC2-41"

# Jira description: ADF flattened to text, plain strings kept.
adf = {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Do "}, {"type": "text", "text": "it"}]},
                                  {"type": "bulletList", "content": [{"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "a"}]}]}]}]}
assert review.adf_text(adf).split() == ["Do", "it", "a"], review.adf_text(adf)
assert review.adf_text("plain") == "plain"

# Line numbers the model can name: new side for + and context, old side for removed lines.
assert review.numbered(["@@ -10,2 +20,2 @@", " a", "-b", "+c", "\\ No newline at end of file"]) == \
    ["@@ -10,2 +20,2 @@", "    20 a", "-   11 b", "+   21 c", "\\ No newline at end of file"]

# The prompt: aliases, task, cut list; no task means an empty asks list.
p = review.prompt([{"alias": "h1", "path": "a.py", "lines": ["@@ -1 +1 @@", "-x", "+y"]}], ["h2", "h3"], "PR: do it", True)
assert "### h1 a.py" in p and "+    1 y" in p and "Task:\nPR: do it" in p and "h2, h3" in p
assert "asks: empty list." in review.prompt([], [], None, False)
assert "in German." in review.prompt([], [], None, False, lang="German")
assert "checkout" in p and "checkout" not in review.prompt([], [], None, False)  # tools only when there is a worktree
assert review.task("/repo#origin/main") is None  # a branch diff has no PR to compare against
print("ok")

# Repo rules: rule files capped, ADRs as title + status/decision only, the global convention always first.
import json, os, pathlib, tempfile  # noqa: E401,E402
import llm  # noqa: E402
with tempfile.TemporaryDirectory() as d:
    root = pathlib.Path(d)
    (root / "CLAUDE.md").write_text("Use uv.\n" + "x" * 9000)
    (root / ".github").mkdir(); (root / ".github/copilot-instructions.md").write_text("No print().")
    (root / "docs/adr").mkdir(parents=True)
    (root / "docs/adr/0001-db.md").write_text("# 1. Use DynamoDB\n\n## Context\nlong story\n\n## Status\nAccepted\n\n## Decision\nDynamoDB.\n\n## Consequences\nmeh\n")
    cfg = root / "pr-review.config.json"; cfg.write_text(json.dumps({"globalRules": "PR titles follow Conventional Commits."}))
    llm.CONFIG, saved = cfg, llm.CONFIG
    rules = review.repo_rules(d)
    assert rules.startswith("### Global conventions") and "Conventional Commits" in rules
    assert "Use uv." in rules and "x" * 4001 not in rules  # capped per file
    assert "No print()." in rules
    assert "# 1. Use DynamoDB" in rules and "Accepted" in rules and "DynamoDB." in rules and "long story" not in rules and "meh" not in rules
    assert len(review.repo_rules(d, budget=500)) < 1200 and "cut" in review.repo_rules(d, budget=500)
    assert review.repo_rules(None).startswith("### Global conventions")
    llm.CONFIG = saved
assert review.repo_rules(None) == "" or "Global conventions" in review.repo_rules(None)  # the real settings, if any
p = review.prompt([], [], "PR: x", False, rules="### R\nno globals", candidates=[("src/perm.ts", "invite")])
assert "rule_checks" in p and "no globals" in p and "src/perm.ts (names invite)" in p and "FOLLOW-UP" not in p
assert "FOLLOW-UP" in review.prompt([], [], "PR: x", False, previous="Title: t") and "Task:" not in review.prompt([], [], "PR: x", False, previous="Title: t")

# Incremental merge: old steps keep same-id hunks (gone ones become o<k>), new steps point at today's overlapping hunks.
prev = {"hunks": [{"alias": "h1", "id": "a.py:1"}, {"alias": "h2", "id": "b.py:2"}],
        "answer": {"title": "T", "summary": "S", "merge_risk": {"level": "low", "why": ""}, "asks": [{"text": "q", "coverage": "seen", "hunks": ["h1", "h2"]}],
                   "steps": [{"title": "old", "hunks": ["h1", "h2"], "suggestions": [{"hunk": "h1", "line": 3, "side": "new", "severity": "low", "text": "t"}]}]}}
full = [{"alias": "h1", "id": "a.py:1", "path": "a.py", "head": "@@ -1,3 +1,4 @@"}, {"alias": "h2", "id": "b.py:9", "path": "b.py", "head": "@@ -10,2 +10,6 @@"}]
inc = [{"alias": "n1", "path": "b.py", "lines": ["@@ -12,1 +12,3 @@", "+x"]}]
ans = {"summary": "new bits", "steps": [{"title": "new", "reading_order": 1, "hunks": ["n1"], "suggestions": [{"hunk": "n1", "line": 13, "side": "new", "severity": "high", "text": "u"}, {"hunk": "n1", "line": 1, "side": "old", "severity": "low", "text": "v"}]}]}
hunks, merged = review.merge_incremental(prev, ans, inc, full)
assert hunks == [{"alias": "h1", "id": "a.py:1"}, {"alias": "h2", "id": "b.py:9"}, {"alias": "o2", "id": "b.py:2"}], hunks
new, old = merged["steps"]
assert new["new"] and new["hunks"] == ["h2"] and [g["hunk"] for g in new["suggestions"]] == ["h2"] and new["reading_order"] < 1
assert old["hunks"] == ["h1", "o2"] and old["suggestions"][0]["hunk"] == "h1" and not old.get("new")
assert merged["asks"][0]["hunks"] == ["h1", "o2"] and merged["merge_risk"]["level"] == "low" and "new bits" in merged["summary"]
assert review.span("@@ -5 +7 @@") == (7, 7) and review.span("@@ -5,2 +7,0 @@") == (7, 7)
print("ok rules/incremental")

# Refresh diagrams (a stubbed call): only the pictures are replaced, in the files that still hold this analysis.
import json, pathlib, tempfile  # noqa: E401,E402
d = pathlib.Path(tempfile.mkdtemp())
prev = {"generated": "2026-01-01T00:00:00", "hunks": [{"alias": "h1", "id": "x"}], "cost": 0.4, "answer": {
    "title": "T", "summary": "S", "behavior": "B", "asks": [{"text": "a", "coverage": "seen", "hunks": ["h1"]}],
    "architecture": {"groups": [], "nodes": [{"id": "old"}], "edges": []}, "visuals": [],
    "steps": [{"title": "one", "explanation": "e1", "hunks": ["h1"], "visual": {"kind": "flow", "nodes": [{"id": "v"}]}}, {"title": "two", "hunks": []}]}}
(d / "a.json").write_text(json.dumps(prev))
(d / "latest.json").write_text(json.dumps(prev))
(d / "other.json").write_text(json.dumps({**prev, "generated": "2026-02-02T00:00:00"}))
seen = {}
def stub(feature, text, **kw):  # noqa: E302
    seen.update(feature=feature, text=text, schema=kw["schema"], model=kw["model"])
    kw["meta"].update(cost=0.12, model_id="claude-x")
    return {"architecture": {"groups": [{"id": "g", "label": "G", "kind": ""}], "nodes": [{"id": "new", "group": "g", "source": "spec"}], "edges": []},
            "visuals": [{"kind": "state_machine", "title": "Loan", "nodes": [{"id": "s"}], "edges": []}],
            "layers": [{"layer": 1, "visuals": [{"kind": "flow", "title": "f", "nodes": [{"id": "n"}], "edges": []}]}]}
real, review.llm.claude = review.llm.claude, stub
try:
    r = review.main_diagrams({"diagrams": str(d / "a.json"), "also": [str(d / "latest.json"), str(d / "other.json")], "head": "abc1234",
                              "model": "sonnet", "context": None, "pr": None, "worktree": None, "hunks": [{"alias": "h1", "path": "p.ts", "lines": ["@@ -1 +1 @@", "+x"]}]})
finally:
    review.llm.claude = real
out = json.loads((d / "a.json").read_text())
assert seen["feature"] == "Review diagrams" and seen["schema"] is review.DIAGRAMS_SCHEMA and "1. two" in seen["text"] and "Sources:" in seen["text"]
assert out["answer"]["architecture"]["nodes"][0]["id"] == "new" and out["answer"]["visuals"][0]["title"] == "Loan"
assert [s.get("visuals") for s in out["answer"]["steps"]] == [[], [{"kind": "flow", "title": "f", "nodes": [{"id": "n"}], "edges": []}]]
assert "visual" not in out["answer"]["steps"][0]  # the old single picture goes with the rest
for k in ("title", "summary", "behavior", "asks"):
    assert out["answer"][k] == prev["answer"][k], k  # the text stays
assert [s["title"] for s in out["answer"]["steps"]] == ["one", "two"] and out["generated"] == prev["generated"] and out["cost"] == 0.4
assert out["diagrams"]["head"] == "abc1234" and out["diagrams"]["cost"] == 0.12 and r["cost"] == 0.12
assert json.loads((d / "latest.json").read_text())["diagrams"]["head"] == "abc1234"
assert "diagrams" not in json.loads((d / "other.json").read_text())  # a newer analysis there: untouched
print("ok diagrams")
