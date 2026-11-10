#!/usr/bin/env python3
"""Explore: a walkthrough of existing code for a topic, without a PR ("How does the reminder job get scheduled and sent?").

argv[1]: JSON (or @file) {root, repo, topic, model (haiku|sonnet|opus), context ({id, env}), out, status}. One call
("Explore: walkthrough") with read-only tools (Read, Grep, Glob) in the repo, the review's budget for the model. It answers
in the shape of a PR analysis: the question, how it works, layers in reading order with evidence (file:line), an
architecture picture, pictures per layer and example values, every element marked existing. Writes {topic, root, repo,
model, model_id, cost, ms, budget, answer, generated} to `out`; `status` holds {busy, pid, started} while it runs, then
{done} or {error}. Texts are in the configured language. Exit 1 with the reason on stderr.
"""
import datetime as dt
import json
import os
import pathlib
import sys

import llm  # noqa: E402  (this folder)
import review  # the schemas and the picture guide the PR analysis uses

FEATURE = "Explore: walkthrough"
S = review.S
STRINGS = review.STRINGS
SCHEMA = {"type": "object", "required": ["title", "summary", "question", "how_it_works", "architecture", "steps"], "properties": {
    "title": S, "summary": S,
    "question": {"type": "array", "maxItems": 4, "items": review.STATEMENT},
    "how_it_works": {"type": "array", "maxItems": 8, "items": review.STATEMENT},
    "architecture": review.ARCHITECTURE, "visuals": review.VISUALS,
    "steps": {"type": "array", "maxItems": 10, "items": {"type": "object", "required": ["title", "why_it_matters", "explanation", "reading_order", "evidence"], "properties": {
        "title": S, "why_it_matters": S, "explanation": S, "reading_order": {"type": "integer"}, "evidence": STRINGS,
        "flows": {"type": "array", "maxItems": 3, "items": review.FLOW}, "visuals": review.VISUALS}}}}}
SYSTEM = ("You are an experienced engineer who explains an unfamiliar codebase to a colleague in {lang}: you read the code first "
          "and claim only what you found, with file:line for everything. At the end, answer only in the requested JSON.")


def prompt(topic, repo, lang="English"):
    return (f"Explain this to me from the code in this repository{f' ({repo})' if repo else ''}: {topic}\n\n"
            "Read the code with Read, Grep and Glob first (entry points, callers, configuration, jobs, infrastructure files). "
            f"Write every text field in {lang}. title: the topic in a few words. summary: the answer in 2-4 sentences. "
            "question: the question broken into what has to be understood (statements). how_it_works: how it works, step by "
            "step, as statements with evidence (file:line). steps: the layers of the answer in reading order (the foundation "
            "first, at most 10): title, why_it_matters (one sentence), explanation (2-5 sentences), reading_order (1, 2, …), "
            "evidence (file:line places to read, the most important first), flows (where it helps: a function with an "
            "example input followed through it, as in a debugger: function, at, inputs, output, trace of values per line, "
            "examples derived from the code), visuals (optional pictures of the layer). Everything here already exists: every "
            "node, edge, state, transition and statement has source existing and its evidence.\n\n" + review.picture_guide(lang))


def existing(x):
    """Marks every element of the answer existing (nothing here is a change)."""
    if isinstance(x, dict):
        out = {k: existing(v) for k, v in x.items()}
        if "source" in out or any(k in out for k in ("evidence", "label", "text")):
            out["source"] = "existing"
        if out.get("status") in ("new", "changed", "removed"):
            out["status"] = "unchanged"
        out.pop("changed", None)
        return out
    if isinstance(x, list):
        return [existing(v) for v in x]
    return x


def main(req):
    model, root, lang = req["model"], req["root"], llm.language()
    if not pathlib.Path(root).is_dir():
        raise RuntimeError(f"{root} is not a folder")
    meta = {}
    answer = llm.claude(FEATURE, prompt(req["topic"], req.get("repo"), lang), context=req.get("context"), model=model, schema=SCHEMA,
                        system=SYSTEM.format(lang=lang), budget=review.BUDGET[model], timeout=review.TIMEOUT, cwd=root, tools="Read,Grep,Glob",
                        meta=meta, extra=("--effort", "high", "--allowedTools", "Read", "Grep", "Glob",
                                          "--disallowedTools", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Bash"))
    if not answer:
        raise RuntimeError(f"{FEATURE}: no answer")
    result = {"topic": req["topic"], "root": root, "repo": req.get("repo"), "model": model, "model_id": meta.get("model_id", model),
              "cost": meta.get("cost"), "ms": meta.get("ms"), "budget": review.BUDGET[model], "answer": existing(answer),
              "generated": dt.datetime.now().astimezone().isoformat()}
    review.save(req["out"], result)
    return result


if __name__ == "__main__":
    req = json.loads(pathlib.Path(sys.argv[1][1:]).read_text() if sys.argv[1].startswith("@") else sys.argv[1])
    status = req.get("status")
    if status:
        review.save(status, {"busy": True, "pid": os.getpid(), "started": dt.datetime.now().astimezone().isoformat(), "model": req["model"]})
    try:
        r = main(req)
        if status:
            review.save(status, {"done": True, "cost": r["cost"], "ms": r["ms"]})
        print(json.dumps({"cost": r["cost"], "model": r["model_id"], "ms": r["ms"]}))
    except Exception as e:  # noqa: BLE001 - the layout shows the reason
        if status:
            review.save(status, {"error": str(e)[:500]})
        print(str(e), file=sys.stderr)
        sys.exit(1)
