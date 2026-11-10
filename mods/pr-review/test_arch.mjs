// Run: node test_arch.mjs  (the architecture / blast radius layout: lanes, ports, hops, badges, card sizes)
import assert from "node:assert/strict";
import { archLayout, crossings, clampText, wrapLines } from "./arch.js";
import { blastArch } from "./pr.js";

const inside = (s, r) => (s.y1 === s.y2
  ? s.y1 > r.y + 1 && s.y1 < r.y + r.h - 1 && Math.max(s.x1, s.x2) > r.x + 1 && Math.min(s.x1, s.x2) < r.x + r.w - 1
  : s.x1 > r.x + 1 && s.x1 < r.x + r.w - 1 && Math.max(s.y1, s.y2) > r.y + 1 && Math.min(s.y1, s.y2) < r.y + r.h - 1);
const over = (a, b) => Math.abs(a.x - b.x) < 18 && Math.abs(a.y - b.y) < 18;

function sane(L, what) {
  for (const p of L.paths) for (const s of p.segments) for (const n of L.nodes) assert.ok(!inside(s, n), `${what}: path ${p.mark} runs through ${n.id}`);
  L.paths.forEach((p, i) => L.paths.slice(i + 1).forEach((q) => assert.ok(!over(p.badge, q.badge), `${what}: badges ${p.mark} ${q.mark} overlap`)));
  for (const p of L.paths) for (const n of L.nodes) assert.ok(!(Math.abs(p.badge.x - n.x - n.w / 2) < n.w / 2 + 9 && Math.abs(p.badge.y - n.y - n.h / 2) < n.h / 2 + 9), `${what}: badge ${p.mark} on ${n.id}`);
  const vs = L.paths.flatMap((p) => p.segments.filter((s) => s.x1 === s.x2 && s.y1 !== s.y2).map((s) => ({ p: p.key, s })));
  vs.forEach((a, i) => vs.slice(i + 1).forEach((b) => {
    if (a.p === b.p || a.s.x1 !== b.s.x1) return;
    const lo = Math.max(Math.min(a.s.y1, a.s.y2), Math.min(b.s.y1, b.s.y2)), hi = Math.min(Math.max(a.s.y1, a.s.y2), Math.max(b.s.y1, b.s.y2));
    assert.ok(lo >= hi, `${what}: two paths share a lane`);
  }));
}

// One column of 6 nodes with 5 edges inside it, plus 3 edges to the next column (the shape from a real PR).
{
  const arch = { groups: [{ id: "app", label: "App" }, { id: "ops", label: "Ops" }],
    nodes: [...["runner", "props", "health", "intercept", "config", "main"].map((id) => ({ id, group: "app", label: id, description: "A component that does a thing in the service and has a long description that wraps over several lines and then goes on for a good while longer", status: "changed" })),
      { id: "probe", group: "ops", label: "Health probe" }, { id: "k8s", group: "ops", label: "Deployment" }],
    edges: [{ from: "runner", to: "health", label: "creates bean" }, { from: "runner", to: "intercept", label: "intercept()" }, { from: "props", to: "runner", label: "configures" },
      { from: "config", to: "props", label: "binds" }, { from: "main", to: "config", label: "scans" },
      { from: "health", to: "probe", label: "reports NOT_SERVING" }, { from: "k8s", to: "probe", label: "polls" }, { from: "config", to: "k8s", label: "env vars" }] };
  const L = archLayout(arch);
  assert.equal(L.paths.length, 8);
  sane(L, "real shape");
  assert.ok(L.nodes.every((n) => n.descLines <= 3 && n.titleLines <= 2));
  assert.ok(L.nodes.filter((n) => n.group === "app").every((n) => n.cut)); // long descriptions are cut, with the tooltip
  assert.equal(L.hops.length, crossings(L.paths).length); // every crossing that stays has its hop
  assert.ok(L.hops.length <= 2, `${L.hops.length} hops`); // ordering keeps them few
  // Inner edges use lanes right of their column, left of the next one.
  const app = L.nodes.find((n) => n.id === "runner"), next = L.nodes.find((n) => n.id === "probe");
  for (const p of L.paths.filter((p) => p.kind === "inner" && L.nodes.find((n) => n.id === p.to).col === 0)) for (const s of p.segments.filter((s) => s.x1 === s.x2)) assert.ok(s.x1 > app.x + app.w && s.x1 < next.x);
}

// Ordering removes avoidable crossings: given crosswise, barycentre ordering makes them parallel. Zero hops.
{
  const arch = { groups: [{ id: "a" }, { id: "b" }], nodes: [{ id: "a1", group: "a" }, { id: "a2", group: "a" }, { id: "b1", group: "b" }, { id: "b2", group: "b" }],
    edges: [{ from: "a1", to: "b2", label: "x" }, { from: "a2", to: "b1", label: "y" }] };
  const L = archLayout(arch);
  const order = L.nodes.map((n) => n.id).join(" ");
  assert.ok(order === "a2 a1 b1 b2" || order === "a1 a2 b2 b1", order); // one column reordered
  assert.equal(L.hops.length, 0);
  sane(L, "parallel");
}

// An unavoidable crossing gets exactly one hop, on the horizontal line.
{
  const arch = { groups: [{ id: "a" }, { id: "b" }], nodes: ["n1", "n2", "n3"].map((id) => ({ id, group: "a" })).concat(["m1", "m2", "m3"].map((id) => ({ id, group: "b" }))),
    edges: [{ from: "n1", to: "m1", label: "p" }, { from: "n2", to: "m2", label: "q" }, { from: "n3", to: "m3", label: "r" }, { from: "n1", to: "n3", label: "inner" }] };
  const L = archLayout(arch);
  assert.equal(L.hops.length, 1);
  assert.equal(L.hops[0].h.y1, L.hops[0].h.y2); // the hop sits on the horizontal segment
  assert.equal(L.paths.find((p) => p.key === L.hops[0].h.p).to, "m2");
  sane(L, "one crossing");
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

// A skipped column: down to the channel under the cards, never through the middle column.
{
  const arch = { groups: [{ id: "a" }, { id: "b" }, { id: "c" }], nodes: [{ id: "a1", group: "a" }, { id: "b1", group: "b" }, { id: "b2", group: "b" }, { id: "c1", group: "c" }],
    edges: [{ from: "a1", to: "c1", label: "skips" }, { from: "a1", to: "b1", label: "next" }] };
  const L = archLayout(arch);
  sane(L, "skip");
  const skip = L.paths.find((p) => p.kind === "skip");
  assert.ok(Math.max(...skip.segments.map((s) => s.y1)) > Math.max(...L.nodes.map((n) => n.y + n.h)));
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

// Text clamping.
assert.deepEqual(wrapLines("aa bb cc", 5), ["aa bb", "cc"]);
assert.deepEqual(clampText("one two three four five six", 9, 2), { text: "one two three…", lines: 2, cut: true });
assert.deepEqual(clampText("short", 10, 3), { text: "short", lines: 1, cut: false });
console.log("ok");
