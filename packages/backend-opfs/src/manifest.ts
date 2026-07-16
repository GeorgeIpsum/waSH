import type { NodeId, NodeKind } from "@wash/vfs";

export interface InodeRecord {
  kind: NodeKind;
  size: number;
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
  nlink: number;
  target?: string;
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
  const a = slotA ? parseManifest(slotA) : null;
  const b = slotB ? parseManifest(slotB) : null;
  if (!a && !b) {
    if (!slotA && !slotB) return { state: "empty" };
    return { state: "corrupt" }; // ≥1 present but none valid
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
