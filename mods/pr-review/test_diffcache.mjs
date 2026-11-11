// Run: node test_diffcache.mjs
import assert from "node:assert/strict";
import { splitParts, readIndex, loadDiff, saveDiff } from "./diffcache.js";

const text = "ab😀cd😀😀e".repeat(5);
for (const size of [1, 2, 3, 5, 7, 100]) {
  const p = splitParts(text, size);
  assert.equal(p.join(""), text);
  if (size > 1) for (const s of p.slice(0, -1)) assert.ok(!/[\ud800-\udbff]$/.test(s), `split inside a pair at ${size}`);
}
assert.deepEqual(splitParts(""), []);

assert.deepEqual(readIndex('{"url":"u","head":"h","text":"x"}', "u", "h"), { text: "x" }); // old format
assert.deepEqual(readIndex('{"url":"u","head":"h","parts":3}', "u", "h"), { parts: 3 });
assert.equal(readIndex('{"url":"u","head":"h2","parts":3}', "u", "h"), null);
assert.equal(readIndex('{"url":"u","head":"h","parts":-1}', "u", "h"), null);
assert.equal(readIndex("{oops", "u", "h"), null);

const fs = new Map(), read = async (p) => { if (!fs.has(p)) throw new Error("nope"); return fs.get(p); };
const write = async (p, t) => { fs.set(p, t); };
const big = "x".repeat(700000) + "😀" + "y".repeat(10);
await saveDiff("b", "u", "h", "api", big, write);
assert.equal(JSON.parse(fs.get("b.json")).parts, 3);
assert.equal(await loadDiff("b", "u", "h", read), big);
assert.equal(await loadDiff("b", "u", "other", read), null);
fs.delete("b.1.txt");
assert.equal(await loadDiff("b", "u", "h", read), null); // a missing part is a miss
fs.delete("b.json");
assert.equal(await loadDiff("b", "u", "h", read), null); // parts without an index too
console.log("ok");
