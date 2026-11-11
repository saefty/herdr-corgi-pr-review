// Big PR diffs are cached in parts: readTextFile reads at most 1 MiB, so one file can't hold them.
// <base>.json is the index {url, head, parts, source}, <base>.<i>.txt the parts; the index is written last,
// so a set with a missing part or index is a cache miss. An old single file {url, head, text} still reads.
export const PART = 300000; // UTF-16 units; at most 3 bytes each in UTF-8, so under 1 MiB

export function splitParts(text, size = PART) {
  const parts = [];
  for (let i = 0; i < text.length;) {
    let end = Math.min(i + size, text.length);
    const c = text.charCodeAt(end - 1);
    if (end < text.length && end - 1 > i && c >= 0xd800 && c <= 0xdbff) end--; // never inside a surrogate pair
    parts.push(text.slice(i, end));
    i = end;
  }
  return parts;
}

// The index's text (old format), or the part count to read, or null when it isn't this PR's / head's.
export function readIndex(raw, url, head) {
  let j;
  try { j = JSON.parse(raw); } catch { return null; }
  if (!j || j.url !== url || j.head !== head) return null;
  if (typeof j.text === "string") return { text: j.text };
  return Number.isInteger(j.parts) && j.parts >= 0 && j.parts < 1000 ? { parts: j.parts } : null;
}

export const partPath = (base, i) => `${base}.${i}.txt`;

export async function loadDiff(base, url, head, readTextFile) {
  const raw = await readTextFile(`${base}.json`).catch(() => null);
  const ix = raw && readIndex(raw, url, head);
  if (!ix) return null;
  if (ix.text !== undefined) return ix.text;
  const got = await Promise.all(Array.from({ length: ix.parts }, (_, i) => readTextFile(partPath(base, i)).catch(() => null)));
  return got.some((p) => p === null) ? null : got.join("");
}

export async function saveDiff(base, url, head, source, text, writeTextFile) {
  const parts = splitParts(text);
  for (let i = 0; i < parts.length; i++) await writeTextFile(partPath(base, i), parts[i], null);
  await writeTextFile(`${base}.json`, JSON.stringify({ url, head, parts: parts.length, source }), null);
}
