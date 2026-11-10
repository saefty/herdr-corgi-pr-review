// Seeds a Herdr home's pr-review data from demo/fixtures for the demo repo: the diff, the AI analysis (hunk
// placeholders "@<path>" become that file's hunk aliases), reviewer findings, related PRs and CI checks, the PR
// lists and triage, and the shared state that opens PR #7. node seed.mjs <herdr home> <repo> <head sha>
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
const [home, repo, head] = process.argv.slice(2);
const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const { hash, splitPatch, reviewRequest, ghTarget } = await import(`${home}/mods/pr-review/pr.js`);
const data = `${home}/pr-data`, cache = `${data}/cache`, url = "https://github.com/acme/bookshelf/pull/7";
for (const d of [cache, `${data}/findings`]) mkdirSync(d, { recursive: true });
const write = (path, value) => writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 1));
const now = Date.now(), iso = (ms) => new Date(ms).toISOString();

const text = execFileSync("git", ["diff", "--no-color", "main...feat/due-reminders"], { cwd: repo }).toString();
const files = splitPatch(text);
const pr = { url, repo: "acme/bookshelf", number: 7, title: "feat(loans): add due-date reminders", author: "ada", state: "open", head: "feat/due-reminders",
  headSha: head, base: "main", updatedAt: iso(now - 3 * 3600e3), add: files.reduce((n, f) => n + f.add, 0), del: files.reduce((n, f) => n + f.del, 0),
  review: "REVIEW_REQUIRED", session: null, cwd: repo, source: "repo" };
write(`${cache}/diff-${hash(url)}-${head}.json`, { url, head, text });

// The analysis, cached as review.py writes it.
const job = reviewRequest({ url, files, model: "sonnet", context: { id: "default", env: null }, dir: cache }).req;
const aliases = (p) => job.hunks.filter((h) => h.path === p).map((h) => h.alias);
const resolve = (v) => Array.isArray(v) ? v.flatMap((x) => (typeof x === "string" && x.startsWith("@") ? aliases(x.slice(1)) : [resolve(x)]))
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "hunk" && typeof x === "string" && x.startsWith("@") ? aliases(x.slice(1))[0] : resolve(x)]))
  : v;
const saved = { source: url, model: "sonnet", model_id: "claude-sonnet", hunks: job.hunks.map((h) => ({ alias: h.alias, id: h.id })), answer: resolve(fx("analysis.json")),
  cut: [], cost: 0.418, ms: 251000, budget: 3, task: { title: pr.title, jira: null, note: null }, generated: iso(now - 2 * 3600e3) };
write(job.out, saved); write(job.latest, saved);

// Reviewer findings, related PRs and checks, PR lists, triage.
const findings = fx("findings.json");
write(`${data}/findings/${hash(url)}.json`, { findings: findings.findings.map((f) => ({ ...f, head, code: "" })),
  runs: { claude: { at: iso(now - 3600e3), count: 1, cost: 0.92, ms: 318000, head }, security: { at: iso(now - 3500e3), count: 1, cost: 0.64, ms: 274000, head } } });
write(`${cache}/ctx-${hash(url)}-${head}.json`, { ...fx("related.json"), at: iso(now), head });
const mine = fx("prs.json").prs.map((p, k) => ({ ...p, at: iso(now - (k + 1) * 86400e3), cwd: repo, context: "default", sessionContext: "default",
  headSha: p.number === 7 ? head : null, updatedAt: iso(now - (k + 1) * 7200e3) }));
write(`${data}/prs.json`, { generated: "2100-01-01T00:00:00Z", prs: mine, errors: [] }); // far future: no transcript scan
const src = fx("sources.json"), stamp = (p, k) => ({ ...p, updatedAt: iso(now - (k + 2) * 3600e3), headRefOid: p.number === 7 ? head : undefined });
write(`${data}/sources.json`, {
  "repo:acme/bookshelf": { at: now, prs: src.repo.map((p, k) => ghTarget(stamp(p, k), { repo: "acme/bookshelf", cwd: repo, source: "repo", context: "default" })) },
  review: { at: now, prs: src.review.map((p, k) => ghTarget(stamp(p, k), { source: "review", context: "default" })) } });
write(`${data}/triage.json`, Object.fromEntries(Object.entries(fx("triage.json")).map(([u, t]) => [u, { ...t, at: iso(now) }])));
write(`${data}/review-progress.json`, { [url]: { visited: [], checked: {}, handled: {}, seen: [], ui: { tab: "steps", page: "overview", cur: 0, order: "reading" } } });

write(`${home}/shared.json`, { "review.target": pr, "review.model": "sonnet", "review.back": "demo-panel", "review.values": true,
  "pr.selected": { all: url }, "pr.picked": { [url]: pr }, "pr.source": "repo" });
console.log(`seeded ${files.length} files, ${job.hunks.length} hunks`);
