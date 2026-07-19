import type { NodeId, NodeKind } from "@wash/vfs";

export interface InodeRecord {
  kind: NodeKind;
  size: number;
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
  nlink: number;
  target?: string;
  /**
   * Range-encoded, sorted, non-overlapping, half-open [startChunk, endChunkExclusive)
   * ranges of chunk indices that are all-zero HOLES (never-written or truncated-away).
   * Authoritative: the reader returns zeros for a hole chunk and NEVER guesses its
   * content from a lingering on-disk version (closes the truncated-tail resurfacing
   * bug class — see holesHas/holesAdd/holesRemove/holesClamp below). Omitted (not an
   * empty array) when the file has no holes, so a normal contiguous file adds zero
   * manifest bytes.
   */
  holes?: Array<[number, number]>;
}

export interface Manifest {
  rootId: NodeId;
  inodes: Record<NodeId, InodeRecord>;
  dirents: Record<NodeId, Record<string, { id: NodeId; kind: NodeKind }>>;
}

const HEADER_PREFIX = "wash-manifest-v1";

/** FNV-1a 32-bit over the bytes, as 8-char lowercase hex. Corruption detection, not security. */
export function fnv1a(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.byteLength; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function serializeManifest(m: Manifest, generation: number): Uint8Array {
  const body = new TextEncoder().encode(
    JSON.stringify({ rootId: m.rootId, inodes: m.inodes, dirents: m.dirents }),
  );
  const header = new TextEncoder().encode(`${HEADER_PREFIX} ${generation} ${fnv1a(body)}\n`);
  const out = new Uint8Array(header.byteLength + body.byteLength);
  out.set(header, 0);
  out.set(body, header.byteLength);
  return out;
}

export function parseManifest(bytes: Uint8Array): { generation: number; manifest: Manifest } | null {
  const nl = bytes.indexOf(0x0a); // "\n"
  if (nl < 0) return null;
  const header = new TextDecoder().decode(bytes.subarray(0, nl));
  const parts = header.split(" ");
  if (parts.length !== 3 || parts[0] !== HEADER_PREFIX) return null;
  const generation = Number(parts[1]);
  const checksum = parts[2]!;
  if (!Number.isInteger(generation)) return null;
  const body = bytes.subarray(nl + 1);
  if (fnv1a(body) !== checksum) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as Manifest;
    if (!parsed || typeof parsed !== "object" || !parsed.rootId || !parsed.inodes || !parsed.dirents) {
      return null;
    }
    return { generation, manifest: parsed };
  } catch {
    return null;
  }
}

export type SelectResult =
  | { manifest: Manifest; generation: number; currentSlot: "a" | "b" }
  | { state: "empty" }
  | { state: "corrupt" };

export function selectGeneration(slotA: Uint8Array | null, slotB: Uint8Array | null): SelectResult {
  const aPresent = slotA != null && slotA.byteLength > 0;
  const bPresent = slotB != null && slotB.byteLength > 0;
  const a = aPresent ? parseManifest(slotA!) : null;
  const b = bPresent ? parseManifest(slotB!) : null;
  if (!a && !b) {
    if (!aPresent && !bPresent) return { state: "empty" };
    return { state: "corrupt" };
  }
  if (a && (!b || a.generation >= b.generation)) {
    return { manifest: a.manifest, generation: a.generation, currentSlot: "a" };
  }
  return { manifest: b!.manifest, generation: b!.generation, currentSlot: "b" };
}

export function emptyManifest(rootId: NodeId): Manifest {
  const now = Date.now();
  return {
    rootId,
    inodes: { [rootId]: { kind: "dir", size: 0, mode: 0o755, mtimeMs: now, ctimeMs: now, nlink: 1 } },
    dirents: {},
  };
}

export function liveIds(m: Manifest): Set<NodeId> {
  return new Set(Object.keys(m.inodes));
}

// ---- Pure interval helpers over holes ranges: sorted, non-overlapping, half-open
// [start, end) chunk-index ranges. These gate correctness (a hole chunk is
// authoritative for zeros — see InodeRecord.holes), so they are exact and
// thoroughly Node-unit-tested rather than approximated. ----

/** Is chunk index `idx` inside any range? Ranges are sorted ascending by start, so
 *  scanning can stop as soon as a range starts after `idx`. */
export function holesHas(ranges: ReadonlyArray<[number, number]>, idx: number): boolean {
  for (const [start, end] of ranges) {
    if (idx < start) return false;
    if (idx < end) return true;
  }
  return false;
}

/** Union `[start, end)` into `ranges`, merging adjacent (touching) or overlapping
 *  ranges. Returns a new normalized (sorted, non-overlapping) list; `ranges` is untouched. */
export function holesAdd(
  ranges: ReadonlyArray<[number, number]>,
  start: number,
  end: number,
): Array<[number, number]> {
  if (start >= end) return ranges.map(([s, e]): [number, number] => [s, e]);
  const out: Array<[number, number]> = [];
  let s = start;
  let e = end;
  let i = 0;
  const n = ranges.length;
  // Ranges strictly before the new one (a real gap, not touching) pass through unchanged.
  while (i < n && ranges[i]![1] < s) {
    out.push(ranges[i]!);
    i++;
  }
  // Ranges overlapping OR touching (`start <= e`) the growing union get absorbed.
  while (i < n && ranges[i]![0] <= e) {
    s = Math.min(s, ranges[i]![0]);
    e = Math.max(e, ranges[i]![1]);
    i++;
  }
  out.push([s, e]);
  while (i < n) {
    out.push(ranges[i]!);
    i++;
  }
  return out;
}

/** Subtract `[start, end)` from `ranges`, splitting any range that straddles a
 *  boundary. Returns a new normalized list; `ranges` is untouched. */
export function holesRemove(
  ranges: ReadonlyArray<[number, number]>,
  start: number,
  end: number,
): Array<[number, number]> {
  if (start >= end) return ranges.map(([s, e]): [number, number] => [s, e]);
  const out: Array<[number, number]> = [];
  for (const [s, e] of ranges) {
    if (e <= start || s >= end) {
      out.push([s, e]); // no overlap
      continue;
    }
    if (s < start) out.push([s, start]); // left remainder
    if (e > end) out.push([end, e]); // right remainder
  }
  return out;
}

/** Drop/trim everything `>= count` (used on shrink so out-of-range chunks are not
 *  holes). Returns a new normalized list; `ranges` is untouched. */
export function holesClamp(ranges: ReadonlyArray<[number, number]>, count: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [s, e] of ranges) {
    if (s >= count) continue; // entirely out of range: dropped
    if (e <= count) { out.push([s, e]); continue; } // entirely in range: kept
    out.push([s, count]); // straddles the boundary: trimmed
  }
  return out;
}
