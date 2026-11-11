// Run: node test_arch.mjs  (the architecture / blast radius layout: columns, lanes, ports, fans, stubs, hops, badges,
// card sizes, focus, orchestrator states)
import assert from "node:assert/strict";
import { archLayout, archFocus, stateLayout, sourceStyle, hasSources, crossings, clampText, wrapLines, ARCH } from "./arch.js";
import { blastArch } from "./pr.js";

const inside = (s, r) => (s.y1 === s.y2
  ? s.y1 > r.y + 1 && s.y1 < r.y + r.h - 1 && Math.max(s.x1, s.x2) > r.x + 1 && Math.min(s.x1, s.x2) < r.x + r.w - 1
  : s.x1 > r.x + 1 && s.x1 < r.x + r.w - 1 && Math.max(s.y1, s.y2) > r.y + 1 && Math.min(s.y1, s.y2) < r.y + r.h - 1);
const over = (a, b) => Math.abs(a.x - b.x) < 18 && Math.abs(a.y - b.y) < 18;
const boxOver = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function sane(L, what) {
  const node = new Map(L.nodes.map((n) => [n.id, n])), bottom = Math.max(...L.nodes.map((n) => n.y + n.h));
  for (const p of L.paths) for (const s of p.segments) for (const n of L.nodes) assert.ok(!inside(s, n), `${what}: path ${p.mark} runs through ${n.id}`);
  // Every call points left to right; nothing runs under the cards.
  for (const p of L.paths) {
    assert.equal(p.arrow.left, false, `${what}: ${p.mark} points left`);
    if (p.kind !== "stub") for (const f of p.from) assert.equal(node.get(p.to).col, node.get(f).col + 1, `${what}: ${p.mark} is a line but not to the next column`);
    for (const s of p.segments) assert.ok(Math.max(s.y1, s.y2) <= bottom + 4, `${what}: ${p.mark} runs below the cards`);
  }
  const badges = L.paths.filter((p) => p.badge);
  badges.forEach((p, i) => badges.slice(i + 1).forEach((q) => assert.ok(!over(p.badge, q.badge), `${what}: badges ${p.mark} ${q.mark} overlap`)));
  for (const p of badges) for (const n of L.nodes) assert.ok(!(Math.abs(p.badge.x - n.x - n.w / 2) < n.w / 2 + 9 && Math.abs(p.badge.y - n.y - n.h / 2) < n.h / 2 + 9), `${what}: badge ${p.mark} on ${n.id}`);
  for (const p of L.paths.filter((q) => q.chip)) for (const n of L.nodes) assert.ok(!boxOver(p.chip, n), `${what}: chip ${p.mark} on ${n.id}`);
  const vs = L.paths.flatMap((p) => p.segments.filter((s) => s.x1 === s.x2 && s.y1 !== s.y2).map((s) => ({ p: p.trunk ?? p.key, s })));
  vs.forEach((a, i) => vs.slice(i + 1).forEach((b) => {
    if (a.p === b.p || a.s.x1 !== b.s.x1) return;
    const lo = Math.max(Math.min(a.s.y1, a.s.y2), Math.min(b.s.y1, b.s.y2)), hi = Math.min(Math.max(a.s.y1, a.s.y2), Math.max(b.s.y1, b.s.y2));
    assert.ok(lo >= hi, `${what}: two paths share a lane`);
  }));
  assert.equal(L.hops.length, crossings([...L.paths.filter((p) => p.kind === "next"), ...L.trunks]).length, `${what}: every crossing that stays has its hop`);
}

// A chain inside one group: each call goes one column right (the group spans the columns); a call that would skip
// columns is a stub; groups whose columns overlap stack.
{
  const arch = { groups: [{ id: "app", label: "App" }, { id: "ops", label: "Ops" }],
    nodes: [...["runner", "props", "health", "intercept", "config", "main"].map((id) => ({ id, group: "app", label: id, description: "A component that does a thing in the service and has a long description that wraps over several lines and then goes on for a good while longer", status: "changed" })),
      { id: "probe", group: "ops", label: "Health probe" }, { id: "k8s", group: "ops", label: "Deployment" }],
    edges: [{ from: "runner", to: "health", label: "creates bean" }, { from: "runner", to: "intercept", label: "intercept()" }, { from: "props", to: "runner", label: "configures" },
      { from: "config", to: "props", label: "binds" }, { from: "main", to: "config", label: "scans" },
      { from: "health", to: "probe", label: "reports NOT_SERVING" }, { from: "k8s", to: "probe", label: "polls" }, { from: "config", to: "k8s", label: "env vars" }] };
  const L = archLayout(arch);
  assert.equal(L.paths.length, 8);
  sane(L, "chain");
  assert.ok(L.nodes.every((n) => n.descLines <= 3 && n.titleLines <= 2));
  assert.ok(L.nodes.filter((n) => n.group === "app").every((n) => n.cut)); // long descriptions are cut, with the tooltip
  const col = (id) => L.nodes.find((n) => n.id === id).col;
  assert.deepEqual(["main", "config", "props", "runner", "health", "intercept"].map(col), [0, 1, 2, 3, 4, 4]);
  assert.deepEqual(L.paths.filter((p) => p.kind === "stub").map((p) => `${p.from[0]}>${p.to}`), ["config>k8s"]);
  const [app, ops] = L.groups;
  assert.deepEqual(app.cols, [0, 4]);
  assert.ok(ops.y >= app.y + app.h, "ops shares column 4 with app: stacked under it");
  assert.equal(L.hops.length, 0);
}

// Ordering removes avoidable crossings: given crosswise, barycentre ordering makes them parallel. Zero hops.
{
  const arch = { groups: [{ id: "a" }, { id: "b" }], nodes: [{ id: "a1", group: "a" }, { id: "a2", group: "a" }, { id: "b1", group: "b" }, { id: "b2", group: "b" }],
    edges: [{ from: "a1", to: "b2", label: "x" }, { from: "a2", to: "b1", label: "y" }] };
  const L = archLayout(arch);
  const order = L.nodes.map((n) => `${n.id}:${n.y}`), y = (id) => L.nodes.find((n) => n.id === id).y;
  assert.equal(y("a1") < y("a2"), y("b2") < y("b1"), order.join(" ")); // one column reordered
  assert.equal(L.hops.length, 0);
  sane(L, "parallel");
}

// A crossing that can't be ordered away gets exactly one hop, on the horizontal line.
{
  const arch = { groups: [{ id: "a" }, { id: "b" }], nodes: ["n1", "n2", "n3"].map((id) => ({ id, group: "a" })).concat(["m1", "m2", "m3"].map((id) => ({ id, group: "b" }))),
    edges: [{ from: "n1", to: "m3", label: "p" }, { from: "n2", to: "m2", label: "q" }, { from: "n3", to: "m1", label: "r" }, { from: "n1", to: "m1", label: "s" }, { from: "n3", to: "m3", label: "t" }] };
  const L = archLayout(arch);
  assert.ok(L.hops.length >= 1);
  for (const h of L.hops) assert.equal(h.h.y1, h.h.y2); // the hop sits on the horizontal segment
  sane(L, "crossing");
}

// Same target and same meaning: one path, one lane, one entry port (a bus). Different meaning: separate.
{
  const arch = { groups: [{ id: "a" }, { id: "b" }], nodes: [{ id: "x", group: "a" }, { id: "y", group: "a" }, { id: "z", group: "a" }, { id: "t", group: "b" }],
    edges: [{ from: "x", to: "t", label: "Reads" }, { from: "y", to: "t", label: "reads " }, { from: "z", to: "t", label: "Writes" }] };
  const L = archLayout(arch);
  assert.equal(L.paths.length, 2);
  const bus = L.paths.find((p) => p.edges.length === 2), other = L.paths.find((p) => p.edges.length === 1);
  assert.deepEqual(bus.from, ["x", "y"]);
  const entry = (p) => p.segments.at(-1); // the last segment enters the target
  assert.equal(new Set(bus.segments.filter((s) => s.x1 === s.x2).map((s) => s.x1)).size, 1); // one shared lane
  assert.notEqual(entry(bus).y1, entry(other).y1); // separate entry ports
  assert.notEqual(bus.segments.find((s) => s.x1 === s.x2).x1, other.segments.find((s) => s.x1 === s.x2)?.x1 ?? -1);
  assert.equal(L.hops.length, 0);
  sane(L, "bus");
}

// A call that skips a column is a stub: a short line out of the source and a chip naming the target with the number.
{
  const arch = { groups: [{ id: "a" }, { id: "b" }, { id: "c" }], nodes: [{ id: "a1", group: "a" }, { id: "b1", group: "b" }, { id: "b2", group: "b" }, { id: "c1", group: "c", label: "Store" }],
    edges: [{ from: "a1", to: "c1", label: "skips" }, { from: "a1", to: "b1", label: "next" }, { from: "b2", to: "c1", label: "writes" }] };
  const L = archLayout(arch);
  sane(L, "skip");
  const skip = L.paths.find((p) => p.label === "skips"), a1 = L.nodes.find((n) => n.id === "a1");
  assert.equal(skip.kind, "stub");
  assert.equal(skip.segments.length, 1);
  assert.deepEqual([skip.segments[0].x1, skip.segments[0].x2 - skip.segments[0].x1], [a1.x + a1.w, ARCH.STUB]);
  assert.equal(skip.chip.text, "→ Store"); assert.ok(skip.num > 0); // the number is a badge in the chip
  assert.equal(skip.badge, null);
  assert.ok(skip.chip.x + skip.chip.w < L.nodes.find((n) => n.id === "b1").x, "the chip fits in the gutter");
}

// A cycle between groups: the call that closes it is a stub, nothing points right to left.
{
  const arch = { groups: [{ id: "a" }, { id: "b" }], nodes: [{ id: "p", group: "a" }, { id: "q", group: "b" }, { id: "r", group: "b" }],
    edges: [{ from: "p", to: "q", label: "asks" }, { from: "q", to: "r", label: "passes" }, { from: "r", to: "p", label: "calls back" }] };
  const L = archLayout(arch);
  sane(L, "cycle");
  assert.deepEqual(L.paths.map((p) => p.kind), ["next", "next", "stub"]);
}

// The shape of a real PR: Step Functions → Lambdas → AWS data and external services, one Lambda calling 6 things.
const sync = {
  groups: [{ id: "flow", label: "Orchestration", kind: "Step Functions" }, { id: "work", label: "Workers", kind: "Lambdas" },
    { id: "store", label: "Cloud data & security", kind: "AWS" }, { id: "ext", label: "External services", kind: "SaaS" }],
  nodes: [
    { id: "sm", group: "flow", label: "Nightly sync state machine", description: "Runs the stages once a night.", type: "service", status: "changed" },
    { id: "retry", group: "flow", label: "Retry state machine", description: "Re-runs failed stages.", type: "service", status: "unchanged" },
    { id: "fetch", group: "work", label: "Fetch worker", description: "Pulls repositories.", type: "component", status: "unchanged" },
    { id: "stages", group: "work", label: "Stages index, rank, lookup, tickets, mirror", description: "One handler per stage of the sync.", type: "component", status: "new" },
    { id: "notify", group: "work", label: "Notifier worker", description: "Posts results.", type: "component", status: "changed" },
    { id: "table", group: "store", label: "Jobs table", type: "data", status: "unchanged" },
    { id: "bucket", group: "store", label: "Raw bucket", type: "data", status: "unchanged" },
    { id: "vault", group: "store", label: "Secrets vault", type: "data", status: "unchanged" },
    { id: "host", group: "ext", label: "Code host API", type: "api", status: "unchanged" },
    { id: "search", group: "ext", label: "Search API", type: "api", status: "unchanged" },
    { id: "model", group: "ext", label: "Model API", type: "api", status: "unchanged" },
    { id: "mirror", group: "ext", label: "Mirror host", type: "api", status: "new" }],
  edges: [
    { from: "sm", to: "fetch", label: "invokes" }, { from: "sm", to: "stages", label: "invokes per stage", status: "new" }, { from: "retry", to: "notify", label: "invokes on failure" },
    { from: "stages", to: "host", label: "lists tickets", status: "new" }, { from: "stages", to: "search", label: "queries", status: "new" },
    { from: "stages", to: "model", label: "ranks candidates", status: "new" }, { from: "stages", to: "mirror", label: "pushes the mirror", status: "new" },
    { from: "fetch", to: "host", label: "fetches repositories" }, { from: "notify", to: "host", label: "posts a comment", status: "changed" },
    { from: "stages", to: "table", label: "writes candidates", status: "new" }, { from: "stages", to: "vault", label: "reads the token", status: "new" },
    { from: "fetch", to: "bucket", label: "stores raw data" }, { from: "notify", to: "table", label: "reads results" },
    { from: "sm", to: "vault", label: "reads the config" }] };
{
  const L = archLayout(sync), g = (id) => L.groups.find((x) => x.id === id);
  sane(L, "sync");
  assert.equal(L.paths.length, 14);
  // Groups by depth: three columns, the AWS group and the external services stacked in the third.
  assert.deepEqual(["flow", "work", "store", "ext"].map((id) => g(id).cols[0]), [0, 1, 2, 2]);
  assert.equal(new Set(L.groups.map((x) => x.x)).size, 3);
  const [top, low] = [g("store"), g("ext")].sort((a, b) => a.y - b.y);
  assert.ok(low.y >= top.y + top.h);
  // Nothing below the lowest card.
  const bottom = Math.max(...L.nodes.map((n) => n.y + n.h));
  assert.ok(L.paths.every((p) => p.segments.every((s) => Math.max(s.y1, s.y2) <= bottom + 8)));
  assert.ok(L.height <= bottom + ARCH.PAD + 1);
  // The call that skips the Lambdas: a stub with its chip.
  const skip = L.paths.find((p) => p.label === "reads the config");
  assert.equal(skip.kind, "stub");
  assert.equal(skip.chip.text, "→ Secrets vault");
  // Numbers in reading order: by the source's column, then top to bottom.
  const colOf = (p) => L.nodes.find((n) => n.id === p.from[0]).col;
  assert.deepEqual(L.paths.map((p) => p.num), L.paths.map((_, k) => k + 1));
  assert.ok(L.paths.every((p, k) => k === 0 || colOf(L.paths[k - 1]) <= colOf(p)), "numbers go column by column");
  // Fan-out: the four calls from the stages into the external services share one trunk into the group's frame.
  const fan = L.paths.filter((p) => p.from[0] === "stages" && L.nodes.find((n) => n.id === p.to).group === "ext");
  assert.equal(fan.length, 4);
  assert.equal(new Set(fan.map((p) => p.trunk)).size, 1);
  assert.equal(L.trunks.length, 1);
  const ext = g("ext"), entering = new Set(fan.flatMap((p) => p.segments).filter((s) => s.y1 === s.y2 && Math.min(s.x1, s.x2) < ext.x && Math.max(s.x1, s.x2) > ext.x).map((s) => JSON.stringify(s)));
  assert.equal(entering.size, 1, "one line enters the group's frame");
  const spineX = fan[0].segments.at(-1).x1;
  assert.ok(fan.every((p) => p.segments.at(-1).x1 === spineX && spineX > ext.x && spineX < p.arrow.x), "branches leave one spine inside the frame's left inset");
  assert.equal(new Set(fan.map((p) => p.num)).size, 4); // the legend lists each call
  // Focus on the stages: its six calls and the call into it stay, with the cards at their other ends.
  const F = archFocus(L, "stages"), num = (label) => L.paths.find((p) => p.label === label).num;
  assert.deepEqual([...F.nodes].sort(), ["host", "mirror", "model", "search", "sm", "stages", "table", "vault"]);
  assert.deepEqual([...F.paths].sort((a, b) => a - b), ["invokes per stage", "lists tickets", "queries", "ranks candidates", "pushes the mirror", "writes candidates", "reads the token"].map(num).sort((a, b) => a - b));
  assert.deepEqual(L.nodes.filter((n) => !F.nodes.has(n.id)).map((n) => n.id).sort(), ["bucket", "fetch", "notify", "retry"]);
  assert.equal(archFocus(L, null), null);
  assert.equal(archFocus(archLayout(sync, "before"), "mirror"), null); // not in this view: no focus
}

// An orchestrator's states: a lane in the card, top to bottom; each state's call leaves the card at its row (an
// edge the analysis gave, or one made from the state).
{
  const arch = { groups: [{ id: "flow", label: "Step Functions" }, { id: "work", label: "Lambdas" }],
    nodes: [{ id: "sm", group: "flow", label: "Sync state machine", type: "orchestration", states: [{ name: "Index", type: "task", calls: "w1" }, { name: "Has work?", type: "choice" }, { name: "Rank", type: "task", calls: "w2" }, { name: "Done", type: "succeed" }] },
      { id: "w1", group: "work", label: "Indexer" }, { id: "w2", group: "work", label: "Ranker" }],
    edges: [{ from: "sm", to: "w1", label: "invokes the indexer" }] };
  const L = archLayout(arch), sm = L.nodes.find((n) => n.id === "sm");
  sane(L, "states");
  assert.equal(L.paths.length, 2);
  const row = (k) => sm.y + sm.stateTop + k * ARCH.ROW + ARCH.ROW / 2;
  const [p1, p2] = L.paths;
  assert.deepEqual([p1.label, p2.label], ["invokes the indexer", "Rank"]);
  assert.equal(p1.segments[0].y1, row(0)); // leaves at "Index"
  assert.equal(p2.segments[0].y1, row(2)); // leaves at "Rank", below
  assert.ok(sm.y + sm.stateTop + 4 * ARCH.ROW <= sm.y + sm.h - 24, "the states fit above the card's footer");
  assert.ok(archLayout({ ...arch, nodes: arch.nodes.map((n) => ({ ...n, states: undefined })) }).nodes[0].stateTop === null); // old analyses: no lane
}

// Many state rows calling a few targets: one path per target (a line from each row into one trunk), each target its
// own channel, badges at the start of the lines next to the rows, numbered top to bottom.
{
  const st = (name, calls) => ({ name, type: "task", calls });
  const arch = { groups: [{ id: "flow", label: "Step Functions" }, { id: "work", label: "Lambdas" }],
    nodes: [{ id: "sm", group: "flow", label: "State machine intel", type: "orchestration",
      states: [st("Validate", "read"), st("Planned"), st("Partitions", "phase"), st("Research", "phase"), st("search", "phase"), st("lockfiles", "read"), st("prs", "phase"), st("Assemble", "asm")] },
    { id: "phase", group: "work", label: "Phase Lambdas" }, { id: "read", group: "work", label: "Read Lambdas" }, { id: "asm", group: "work", label: "Assemble" }],
    edges: [] };
  const L = archLayout(arch), sm = L.nodes.find((n) => n.id === "sm");
  sane(L, "rows");
  assert.equal(L.paths.length, 3, "one path per target");
  const phase = L.paths.find((p) => p.to === "phase");
  assert.equal(phase.label, "Partitions, Research, search, prs");
  assert.equal(phase.edges.length, 4);
  const lanes = L.paths.map((p) => p.segments.find((s) => s.x1 === s.x2)?.x1).filter((x) => x !== undefined);
  assert.equal(new Set(lanes).size, lanes.length, "each target its own channel");
  for (const p of L.paths) assert.ok(p.badge.x < sm.x + sm.w + 60, `badge ${p.mark} sits next to the rows, not in the channel`);
  assert.deepEqual(L.paths.map((p) => p.to), ["read", "phase", "asm"], "numbered by their first row, top to bottom");
}

// External services called from the middle of a group that spans further right: their own column beside it, not a
// frame stacked below with lines running down past the picture.
{
  const arch = { groups: [{ id: "aws", label: "AWS" }, { id: "ext", label: "External", kind: "SaaS" }],
    nodes: [{ id: "sm", group: "aws", label: "State machine" }, { id: "phase", group: "aws", label: "Phase Lambdas" }, { id: "read", group: "aws", label: "Read Lambdas" },
      { id: "hosted", group: "aws", label: "Lambda hosted" }, { id: "scan", group: "ext", label: "Scanner API" }, { id: "gh", group: "ext", label: "GitHub API" }, { id: "nvd", group: "ext", label: "NVD" }],
    edges: [{ from: "sm", to: "phase", label: "a" }, { from: "sm", to: "read", label: "b" }, { from: "phase", to: "hosted", label: "c" },
      { from: "phase", to: "scan", label: "d" }, { from: "phase", to: "gh", label: "e" }, { from: "read", to: "scan", label: "f" }, { from: "phase", to: "nvd", label: "g" }] };
  const L = archLayout(arch), g = (id) => L.groups.find((x) => x.id === id);
  sane(L, "external");
  assert.ok(g("ext").x >= g("aws").x + g("aws").w, "the external services sit right of the AWS frame");
  assert.ok(g("ext").y < g("aws").y + g("aws").h, "not stacked below it");
  const bottom = Math.max(...L.nodes.map((n) => n.y + n.h));
  assert.ok(L.paths.every((p) => p.segments.every((s) => Math.max(s.y1, s.y2) <= bottom + 8)), "no line runs below the picture");
}

// Fit: the same picture with narrow cards is narrower, its cards 160 px with at most two lines of description.
{
  const arch = { groups: [{ id: "a", label: "A" }], nodes: ["x", "y", "z"].map((id) => ({ id, group: "a", label: `Node ${id}`, description: "A long description that needs several lines in a card of any width at all, really" })),
    edges: [{ from: "x", to: "y", label: "1" }, { from: "y", to: "z", label: "2" }] };
  const wide = archLayout(arch), fit = archLayout(arch, "diff", () => 0, true);
  sane(fit, "fit");
  assert.ok(fit.width < wide.width * 0.8, "narrower");
  assert.ok(fit.nodes.every((n) => n.w === 160 && n.descLines <= 2));
}

// The blast radius: each context file's relation is its own path (no merged lanes), titles wrap to two lines.
{
  const b = blastArch({ units: [{ id: "u1", label: "GrpcServerRunner (Shutdown hook and health)", status: "changed", files: ["a.java"] }, { id: "u2", label: "GrpcProperties and application config", status: "changed", files: ["b.java"] }],
    context: [{ id: "c1", file: "src/App.java", direction: "upstream", relation: "@ConfigurationPropertiesScan registers the properties", links_to: "u2" },
      { id: "c2", file: "src/Env.java", direction: "upstream", relation: "reads the env variables GRPC_DEADLINE", links_to: "u2" },
      { id: "c3", file: "src/RunnerTest.java", direction: "upstream", relation: "test: the record gets a new field", links_to: "u1" },
      { id: "c4", file: "src/Other.java", direction: "upstream", relation: "next to which the new interceptor sits", links_to: "u1" }] });
  const L = archLayout(b, "diff", (n) => Math.min(2, n.findings?.length ?? 0));
  assert.equal(L.paths.length, 4);
  sane(L, "blast");
  const u1 = L.nodes.find((n) => n.id === "u:u1");
  assert.equal(u1.titleLines, 2);
  assert.equal(u1.title, "GrpcServerRunner (Shutdown hook and health)");
}

// State diagrams, top to bottom. A lifecycle that goes back (a return lane on the left) and stays (a self-loop):
// no crossings, nothing through a card, the start dot on top and the end ring at the bottom, changed ones marked.
{
  const v = { kind: "state_machine", title: "Loan", nodes: [{ id: "open", label: "Open" }, { id: "rem", label: "Reminded", changed: true }, { id: "over", label: "Overdue" }, { id: "ret", label: "Returned" }],
    transitions: [{ from: "open", to: "rem", event: "due soon", guard: "2 days left", action: "send reminder", changed: true }, { from: "rem", to: "ret", event: "return" },
      { from: "rem", to: "over", event: "due date passed" }, { from: "over", to: "ret", event: "return", guard: "fee paid" },
      { from: "over", to: "open", event: "extend", changed: true }, { from: "rem", to: "rem", event: "remind again", changed: true }, { from: "open", to: "ret", event: "return" }] };
  const L = stateLayout(v), at = (id) => L.nodes.find((n) => n.id === id);
  const lines = [...L.edges, ...L.backs];
  assert.equal(crossings(lines).length, 0);
  for (const e of lines) for (const sg of e.segments) for (const n of L.nodes.filter((x) => x.kind === "state")) assert.ok(!inside(sg, n), `${e.key} runs through ${n.id}`);
  assert.ok(at("\0start").y < at("open").y && at("open").y < at("rem").y && at("rem").y < at("over").y && at("over").y < at("ret").y && at("ret").y < at("\0end").y);
  for (const e of L.edges) for (const sg of e.segments) assert.ok(sg.y2 >= sg.y1, `${e.key} goes up`); // forward transitions only run down
  assert.deepEqual(L.backs.map((b) => [b.from, b.to, b.text, b.changed]), [["over", "open", "extend", true]]);
  assert.ok(L.backs[0].laneX < Math.min(...L.nodes.map((n) => n.x)), "the return lane is left of every card");
  assert.deepEqual(L.loops.map((l) => [l.id, l.text, l.changed]), [["rem", "remind again", true]]);
  const due = L.edges.find((e) => e.from === "open" && e.to === "rem");
  assert.deepEqual([due.text, due.changed], ["due soon [2 days left] / send reminder", true]);
  assert.deepEqual(L.edges.filter((e) => e.changed).map((e) => `${e.from}>${e.to}`), ["open>rem"]);
  // The old shape (edges with labels) still lays out.
  const old = stateLayout({ kind: "state_machine", nodes: v.nodes, edges: [{ from: "open", to: "rem", label: "remind" }, { from: "rem", to: "ret", label: "return", changed: true }] });
  assert.deepEqual(old.edges.filter((e) => e.text).map((e) => [e.text, e.changed]), [["remind", false], ["return", true]]);
}

// Step Functions: a choice forks into columns below it, a Parallel's branches sit side by side in its block, Catch and
// Retry are stubs to the right, the Fail state only reached by Catch is not a card.
{
  const v = { kind: "state_machine", nodes: [{ id: "load", label: "Load batch", type: "task" }, { id: "has", label: "Has items?", type: "choice" },
    { id: "par", label: "Enrich", type: "parallel" }, { id: "a1", label: "Index", parent: "par", branch: 0 }, { id: "a2", label: "Rank", parent: "par", branch: 0 },
    { id: "b1", label: "Lookup", parent: "par", branch: 1 }, { id: "skip", label: "Nothing to do", type: "pass" }, { id: "done", label: "Done", type: "succeed" }, { id: "fail", label: "Failed", type: "fail" }],
    edges: [{ from: "load", to: "has" }, { from: "has", to: "par", label: "items > 0" }, { from: "has", to: "skip", label: "empty" }, { from: "a1", to: "a2" },
      { from: "par", to: "done" }, { from: "skip", to: "done" }, { from: "par", to: "fail", error: "catch", label: "Catch" }, { from: "load", to: "load", error: "retry", label: "Retry ×3" }] };
  const L = stateLayout(v), at = (id) => L.nodes.find((n) => n.id === id);
  assert.equal(at("fail"), undefined);
  assert.equal(at("par").y, at("skip").y); // the choice's two ways side by side, below it
  assert.ok(at("par").y > at("has").y && at("par").x + at("par").w <= at("skip").x);
  const kids = at("par").children, k = (id) => kids.find((c) => c.id === id);
  assert.deepEqual([k("a1").branch, k("a2").branch, k("b1").branch], [0, 0, 1]);
  assert.ok(k("a1").y < k("a2").y && k("a1").x === k("a2").x && k("b1").x > k("a1").x && k("b1").y === k("a1").y);
  assert.deepEqual(L.stubs.map((x) => [x.from, x.text]), [["load", "Retry ×3"], ["par", "Catch → Failed"]]);
  for (const x of L.stubs) for (const n of L.nodes) assert.ok(!boxOver(x.chip, n), `stub chip on ${n.id}`);
  assert.equal(crossings([...L.edges, ...L.backs]).length, 0);
}

// Sources: implemented (solid, status colours), existing (muted), spec (dashed, a "spec" chip); none: as before.
{
  assert.deepEqual(["implemented", "existing", "spec", undefined].map((x) => { const st = sourceStyle(x); return [st.dashed, st.tone, st.chip]; }),
    [[false, "status", null], [false, "muted", null], [true, "status", "spec"], [false, "status", null]]);
  assert.match(sourceStyle("spec").tip, /not found in the diff/);
  const arch = { groups: [{ id: "a" }, { id: "b" }], nodes: [{ id: "x", group: "a", source: "implemented", evidence: "src/x.ts:3" }, { id: "y", group: "a" }, { id: "t", group: "b", source: "spec" }],
    edges: [{ from: "x", to: "t", label: "Reads", source: "implemented", evidence: "src/x.ts:9" }, { from: "y", to: "t", label: "reads", source: "spec" }] };
  const L = archLayout(arch);
  assert.equal(L.paths.length, 2, "a spec-only call never merges with an implemented one");
  assert.deepEqual(L.paths.map((p) => [p.source, p.dashed, p.evidence]), [["implemented", false, "src/x.ts:9"], ["spec", true, null]]);
  assert.equal(L.nodes.find((n) => n.id === "x").at, "src/x.ts:3"); // implemented evidence: the card opens it
  assert.ok(hasSources(arch));
  // Old analyses: no source, nothing dashed, no legend.
  const old = archLayout(sync);
  assert.ok(old.paths.every((p) => p.source === null && !p.dashed) && !hasSources(sync));
  // A spec-only transition in a state diagram is dashed.
  const sm = stateLayout({ nodes: [{ id: "a", label: "A" }, { id: "b", label: "B", source: "spec" }], transitions: [{ from: "a", to: "b", event: "archive", source: "spec" }] });
  const e = sm.edges.find((x) => x.from === "a");
  assert.deepEqual([e.source, e.dashed, sm.nodes.find((n) => n.id === "b").source], ["spec", true, "spec"]);
  assert.ok(sm.edges.filter((x) => x !== e).every((x) => !x.dashed));
}

// Text clamping.
assert.deepEqual(wrapLines("aa bb cc", 5), ["aa bb", "cc"]);
assert.deepEqual(clampText("one two three four five six", 9, 2), { text: "one two three…", lines: 2, cut: true });
assert.deepEqual(clampText("short", 10, 3), { text: "short", lines: 1, cut: false });
console.log("ok");
