"""Run: python3 test_related.py  (no network)."""
import related

# Overlap: shared files only, most shared first, PRs sharing nothing left out.
prs = [{"number": 1, "title": "a", "files": ["x.py", "y.py"]}, {"number": 2, "title": "b", "files": ["z.py"]},
       {"number": 3, "title": "c", "files": ["y.py", "x.py", "w.py"]}, {"number": 4, "title": "d", "files": ["y.py"]}]
out = related.overlap(["x.py", "y.py"], prs)
assert [(p["number"], p["overlap"], p["files"]) for p in out] == [(3, 2, ["x.py", "y.py"]), (1, 2, ["x.py", "y.py"]), (4, 1, ["y.py"])], out

# Merged PRs from git log: merge commits (title from the body), squashes (" (#n)" dropped), others skipped.
log = ("\x1eMerge pull request #12 from o/feat-x\x1ffeat: add x\n\nmore\x1d\n\nsrc/a.py\nsrc/b.py\n"
       "\x1efix: guard null (#15)\x1f\x1d\n\nsrc/a.py\n"
       "\x1echore: local commit\x1f\x1d\n\nsrc/a.py\n")
got = {p["number"]: p for p in related.merged_from_log(log)}
assert sorted(got) == [12, 15]
assert got[12]["title"] == "feat: add x" and got[12]["files"] == ["src/a.py", "src/b.py"]
assert got[15]["title"] == "fix: guard null" and got[15]["files"] == ["src/a.py"]
print("ok")
