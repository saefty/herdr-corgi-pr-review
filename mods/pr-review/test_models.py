"""Run: python3 test_models.py  (models.py's parsing and llm.tier, without calling a CLI)."""
import llm
import models

claude = models.claude_list([
    {"value": "default", "resolvedModel": "claude-fable-5-2", "displayName": "Default (recommended)"},
    {"value": "opus", "resolvedModel": "claude-opus-5-5", "displayName": "Opus 5.5", "description": "Complex work"},
    {"value": "claude-haiku-4-5-20251001", "displayName": "Haiku 4.5"},
    {"displayName": "no value"},
])
assert [m["value"] for m in claude] == ["opus", "claude-haiku-4-5-20251001"], claude  # "default" names another entry
assert claude[0] == {"value": "opus", "label": "Opus 5.5", "description": "Complex work", "resolved": "claude-opus-5-5"}
assert claude[1]["resolved"] == "claude-haiku-4-5-20251001" and claude[1]["description"] == ""

codex = models.codex_list({"models": [
    {"slug": "b", "display_name": "B", "visibility": "list", "priority": 3},
    {"slug": "hidden", "visibility": "hide", "priority": 1},
    {"slug": "a", "display_name": "A", "description": "fast", "visibility": "list", "priority": 2},
]})
assert codex == [{"value": "a", "label": "A", "description": "fast"}, {"value": "b", "label": "B", "description": ""}], codex
assert models.codex_list(None) == [] and models.claude_list(None) == []

assert [llm.tier(m) for m in ("haiku", "claude-haiku-4-5", "sonnet", "claude-sonnet-5", "opus", "fable", "claude-fable-5-1", None)] == \
    ["haiku", "haiku", "sonnet", "sonnet", "opus", "opus", "opus", "opus"]
print("ok")
