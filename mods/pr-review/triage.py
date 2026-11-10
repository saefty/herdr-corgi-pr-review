#!/usr/bin/env python3
"""PR triage for the PR panel: one sentence "why review this now" and a priority per PR, on an explicit click.

argv[1]: JSON {items: [{url, context ({id, env}), title, repo, state, chips: [...], hint}], out (pr-data/triage.json)}.
One cheap Haiku call per context (feature "PR triage"), each with that context's env. Merges {url: {priority, why, at}}
into `out`, keeping the newest MAX entries. Prints {count, cost}; exit 1 with the reason on stderr.
"""
import datetime as dt
import json
import os
import pathlib
import sys

import llm  # noqa: E402  (this folder)

FEATURE, MAX = "PR triage", 200
SCHEMA = {"type": "object", "required": ["prs"], "properties": {"prs": {"type": "array", "items": {
    "type": "object", "required": ["url", "priority", "why"], "properties": {
        "url": {"type": "string"}, "priority": {"type": "integer", "minimum": 1, "maximum": 3}, "why": {"type": "string"}}}}}}


def prompt(items):
    return ("Triage these open pull requests for a reviewer. Per PR: priority (1: first, 2: soon, 3: can wait) and why: "
            "ONE sentence in English on why to review it now (or later), e.g. \"Review this early because it can resolve "
            "assumptions that may affect nearby PRs and reduce rework.\" Use only the details below.\n\n"
            + "\n".join(f"- {i['url']} | {i['title']} | {i.get('state', '')} | {', '.join(i.get('chips') or [])} | {i.get('hint') or ''}" for i in items))


def merge(path, results, now):
    doc = json.loads(path.read_text()) if path.exists() else {}
    for r in results:
        doc[r["url"]] = {"priority": r["priority"], "why": r["why"], "at": now}
    keep = dict(sorted(doc.items(), key=lambda kv: kv[1].get("at", ""), reverse=True)[:MAX])
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(keep, ensure_ascii=False, indent=1))
    tmp.replace(path)
    return keep


def main(req):
    by_context, results, cost = {}, [], 0
    for i in req["items"]:
        ctx = i.get("context") or {"id": "default", "env": None}
        by_context.setdefault(json.dumps(ctx, sort_keys=True), (ctx, []))[1].append(i)
    for ctx, items in by_context.values():
        meta = {}
        answer = llm.claude(FEATURE, prompt(items[:40]), context=ctx, model="haiku", schema=SCHEMA, budget=0.2, timeout=180, meta=meta)
        urls = {i["url"] for i in items}
        results += [r for r in (answer or {}).get("prs", []) if r.get("url") in urls]
        cost += meta.get("cost") or 0
    merge(pathlib.Path(req["out"]), results, dt.datetime.now().astimezone().isoformat())
    return {"count": len(results), "cost": cost}


if __name__ == "__main__":
    try:
        print(json.dumps(main(json.loads(sys.argv[1]))))
    except Exception as e:  # noqa: BLE001 - the panel shows the reason
        print(str(e), file=sys.stderr)
        sys.exit(1)
