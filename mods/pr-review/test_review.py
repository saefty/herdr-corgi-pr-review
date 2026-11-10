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

# Ask about this: one call ("Review: architecture question") with the picture, the focus, the hunks and the thread;
# read-only tools only in an existing checkout.
seen = {}
def stub(feature, text, **kw):  # noqa: E302
    seen.update(feature=feature, text=text, **{k: kw[k] for k in ("schema", "model", "budget", "tools", "context")})
    kw["meta"].update(cost=0.05, ms=900, model_id="claude-y")
    return {"text": "Weil …", "highlights": {"nodes": ["api"], "edges": ["e0"]}, "evidence": [{"at": "src/api.py:3", "why": "hier"}]}
real, review.llm.claude = review.llm.claude, stub
try:
    r = review.main_ask({"ask": "Warum ruft die API den Worker?", "model": "haiku", "context": {"id": "work", "env": None}, "root": str(d / "missing"),
                         "analysis": {"title": "T", "summary": "S", "layers": [{"title": "L1", "why": "w"}]},
                         "picture": {"nodes": [{"id": "api", "label": "API"}], "edges": [{"id": "e0", "from": "api", "to": "w"}]},
                         "scope": {"kind": "node", "node": {"id": "api"}}, "hunks": [{"path": "src/api.py", "lines": ["@@ -1 +1,2 @@", "+call()"]}],
                         "history": [{"q": "Was ist das?", "a": "Ein Job."}]})
finally:
    review.llm.claude = real
assert seen["feature"] == "Review: architecture question" and seen["schema"] is review.ASK_SCHEMA and seen["model"] == "haiku"
assert seen["budget"] == review.BUDGET_ASK["haiku"] and seen["tools"] == "" and seen["context"]["id"] == "work"
for part in ("Warum ruft die API den Worker?", '"e0"', "L1: w", "call()", "Q: Was ist das?", "A: Ein Job.", '"kind": "node"'):
    assert part in seen["text"], part
assert r["answer"]["highlights"]["edges"] == ["e0"] and r["cost"] == 0.05
assert review.read_tools(str(d))["tools"] == "Read,Grep,Glob" and "Bash" in review.read_tools(str(d))["extra"]
print("ok ask")

# Show details: one call ("Review: drill down") with what to open, the path and the context.
seen = {}
def stub(feature, text, **kw):  # noqa: E302
    seen.update(feature=feature, text=text, schema=kw["schema"], budget=kw["budget"])
    kw["meta"].update(cost=0.07)
    return {"summary": "s", "visual": {"kind": "flow", "title": "t", "nodes": [{"id": "a", "label": "run()", "values": "x = 1"}], "edges": []}}
real, review.llm.claude = review.llm.claude, stub
try:
    r = review.main_drill({"drill": {"label": "Stages handler", "path": ["Architecture", "Workers", "Stages handler"], "subject": {"kind": "node", "id": "stages"}},
                           "model": "sonnet", "context": None, "root": None, "picture": {"nodes": [], "edges": []}, "hunks": []})
finally:
    review.llm.claude = real
assert seen["feature"] == "Review: drill down" and seen["schema"] is review.DRILL_SCHEMA and seen["budget"] == review.BUDGET_DRILL["sonnet"]
assert "Architecture › Workers › Stages handler" in seen["text"] and "debugger" in seen["text"] and r["answer"]["visual"]["nodes"][0]["values"] == "x = 1"
print("ok drill")

# The analysis' own scope: every hunk as a patch with an index, what fits inlined (never lockfiles), every alias in a
# layer (missing ones in "Skimmed (low value)"), and big PRs in cohort passes plus a merge pass, all under the cap.
import tempfile as _tf  # noqa: E402
d2 = pathlib.Path(_tf.mkdtemp())
hs = [{"alias": "h1", "id": "i1", "path": "src/a/x.ts", "lines": ["@@ -1 +1,2 @@", "+a", " b"]}, {"alias": "h2", "id": "i2", "path": "yarn.lock", "lines": ["@@ -1 +1 @@", "+v2"]}]
ix = review.write_run(d2 / "run", hs)
assert (d2 / "run/patches/h1.patch").read_text().startswith("src/a/x.ts\n@@") and json.loads((d2 / "run/index.json").read_text())[1]["low"] is True
assert [i["add"] for i in ix] == [1, 1] and "h2 yarn.lock +1 -0 low" in review.index_text(ix)
assert [h["alias"] for h in review.pick_inline(hs, 10_000)] == ["h1"], "lockfiles are never inlined"
ans = review.account({"steps": [{"title": "A", "hunks": ["h1", "h1", "zz"]}]}, ["h1", "h2"], ix)
assert ans["steps"][0]["hunks"] == ["h1"] and ans["steps"][1]["title"] == "Skimmed (low value)" and ans["steps"][1]["hunks"] == ["h2"]
assert "yarn.lock" in ans["steps"][1]["why_it_matters"]
assert review.scope_of(ans, ix) == {"files": 2, "detailed": 1, "skimmed": 1, "why": "lockfiles", "passes": 1}
cb, mb = review.pass_budgets(3.0, 4)
assert sum(cb) + mb <= 3.0 + 1e-9 and len(cb) == 4

big = [{"alias": f"h{k}", "id": f"i{k}", "path": f"{['api', 'web', 'jobs'][k % 3]}/m{k}/f{k}.ts", "lines": ["@@ -1 +1,400 @@"] + ["+" + "x" * 150] * 400} for k in range(1, 10)]
big.append({"alias": "h10", "id": "i10", "path": "package-lock.json", "lines": ["@@ -1 +1 @@", "+lock"]})
co = review.cohorts_of(big, review.INLINE["haiku"])
assert co and len(co) >= 2 and all(not review.low_value(h["path"]) for c in co for h in c)
assert sorted(h["alias"] for c in co for h in c) == sorted(f"h{k}" for k in range(1, 10)), "each high-value hunk in one cohort"
assert review.cohorts_of(hs, review.INLINE["haiku"]) is None, "a small PR: one pass"
calls, statuses = [], []
real_save = review.save
def stub2(feature, text, **kw):  # noqa: E302
    calls.append((feature, kw["budget"], kw["schema"]))
    kw["meta"].update(cost=0.1, ms=10, model_id="claude-z")
    if kw["schema"] is review.COHORT_SCHEMA:
        mine = [a for a in (f"h{k}" for k in range(1, 10)) if f"\n{a} " in "\n" + text.split("Index:")[-1]]
        return {"summary": "c", "steps": [{"title": f"L{mine[0]}", "risk": "low", "why_it_matters": "w", "explanation": "e", "reading_order": 1, "hunks": mine, "check_questions": []}]}
    return {"title": "T", "summary": "S", "behavior": "B", "merge_risk": {"level": "low", "why": "w"}, "effort": {"score": 2, "why": "w"},
            "rule_checks": [], "architecture": {"groups": [], "nodes": [], "edges": []}, "blast_radius": {"units": [], "context": []}, "asks": [], "reading_order": [1, 0]}
real, review.llm.claude = review.llm.claude, stub2
review.save = lambda path, value: (statuses.append(value) if str(path).endswith(".status") else None, real_save(path, value))[1]
try:
    r = review.main({"model": "haiku", "context": None, "worktree": None, "pr": None, "hunks": big, "out": str(d2 / "o.json"), "latest": str(d2 / "l.json"), "status": str(d2 / "o.json.status")})
finally:
    review.llm.claude, review.save = real, real_save
merge = [c for c in calls if c[2] is review.MERGE_SCHEMA]
assert len(merge) == 1 and len(calls) == len(co) + 1, "one pass per cohort, then the merge"
assert sum(b for _, b, _ in calls) <= review.BUDGET["haiku"] + 1e-9, "all under the cap"
assert any(c[0].startswith("Review analysis (pass") for c in calls)
placed = [a for st in r["answer"]["steps"] for a in st["hunks"]]
assert sorted(placed) == sorted(h["alias"] for h in big), "every alias accounted for"
assert r["answer"]["steps"][-1]["skimmed"] and r["answer"]["steps"][-1]["hunks"] == ["h10"]
assert r["scope"]["passes"] == len(co) + 1 and r["scope"]["skimmed"] == 1 and r["cut"] == []
assert [x["pass"] for x in statuses if "pass" in x][0] == 1 and statuses[-1]["passes"] == len(co) + 1, "progress: Pass k of n"
assert r["answer"]["title"] == "T" and r["cost"] == round(0.1 * (len(co) + 1), 10) or abs(r["cost"] - 0.1 * (len(co) + 1)) < 1e-9
print("ok scope")
