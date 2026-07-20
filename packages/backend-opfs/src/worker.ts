/// <reference lib="webworker" />
import type { Attrs, NodeId, NodeKind } from "@wash/vfs";
import { CHUNK_SIZE, VfsError, ulid } from "@wash/vfs";
import type { RpcRequest, RpcResponse } from "./rpc.js";
import {
  type Manifest, type InodeRecord,
  serializeManifest, parseManifest, selectGeneration, emptyManifest,
  holesHas, holesAdd, holesRemove, holesClamp,
  assertWebLocksAvailable,
} from "./manifest.js";
import { BlobStore } from "./blobs.js";

// ---- test-gated fault injection (unchanged pattern) ----
let faults: Map<string, { skip: number; times: number }> | null = null;
function maybeFault(site: string): void {
  if (!faults) return;
  const f = faults.get(site);
  if (!f) return;
  if (f.skip > 0) { f.skip--; return; }
  if (f.times <= 0) { faults.delete(site); return; }
  f.times--;
  if (f.times <= 0) faults.delete(site);
  throw new DOMException("injected fault", "QuotaExceededError");
}

// ---- DOMException → VfsError (kept) ----
function domToVfs(e: unknown, path?: string): VfsError | undefined {
  const name = (e as { name?: string } | null)?.name;
  if (name === "NotFoundError") return new VfsError("ENOENT", path);
  if (name === "InvalidModificationError") return new VfsError("ENOTEMPTY", path);
  if (name === "NoModificationAllowedError") return new VfsError("EBUSY", path);
  if (name === "TypeMismatchError") return new VfsError("ENOTDIR", path);
  if (name === "QuotaExceededError") return new VfsError("ENOSPC", path);
  return undefined;
}
export function errnoFromDom(e: unknown, path?: string): never {
  const v = domToVfs(e, path);
  if (v) throw v;
  throw e;
}
function toVfs(e: unknown, path?: string): VfsError {
  if (e instanceof VfsError) return e;
  return domToVfs(e, path) ?? new VfsError("EBUSY", path);
}

// ---- module state ----
let rootDir: FileSystemDirectoryHandle;
let blobs: BlobStore;
let mani: Manifest;
let generation = 0;
let currentSlot: "a" | "b" = "a";
let committedBytes: Uint8Array; // last successfully committed serialization
let dirty = false;
let releaseLock: (() => void) | null = null;
let poolSize = 64;

// ---- size-guard advisory (spec §7/§11: v1 writes a whole manifest generation per flush
// batch, so per-flush commit cost is O(manifest size), not O(1) per mutated entry). No
// empirical browser bench exists yet (apps/bench is Node/fake-indexeddb only, and OPFS
// needs a browser worker — see apps/bench/README.md), so this threshold is a reasoned
// default: ~2 MiB of serialized JSON is roughly a 15-20k-entry manifest. Advisory only —
// never throws; fired once per worker lifetime so it doesn't spam on every flush.
let warnedManifestSize = false;
const MANIFEST_SIZE_WARN_BYTES = 2 * 1024 * 1024;

function slotName(s: "a" | "b"): string { return s === "a" ? "manifest.a" : "manifest.b"; }
function otherSlot(): "a" | "b" { return currentSlot === "a" ? "b" : "a"; }

function inode(id: NodeId): InodeRecord {
  const rec = mani.inodes[id];
  if (!rec) throw new VfsError("ENOENT");
  return rec;
}
function requireDir(id: NodeId): InodeRecord {
  const rec = inode(id);
  if (rec.kind !== "dir") throw new VfsError("ENOTDIR");
  return rec;
}
function requireFile(id: NodeId): InodeRecord {
  const rec = inode(id);
  if (rec.kind === "dir") throw new VfsError("EISDIR");
  return rec;
}
function children(id: NodeId): Record<string, { id: NodeId; kind: NodeKind }> {
  return (mani.dirents[id] ??= {});
}
function defaultMode(kind: NodeKind): number {
  return kind === "dir" ? 0o755 : kind === "symlink" ? 0o777 : 0o644;
}
function attrsOf(rec: InodeRecord): Attrs {
  return { kind: rec.kind, size: rec.size, mode: rec.mode, mtimeMs: rec.mtimeMs, ctimeMs: rec.ctimeMs, nlink: rec.nlink };
}

/** Number of chunks a file of `size` bytes spans (0 for an empty file). */
function chunkCountOf(size: number): number {
  return size === 0 ? 0 : Math.ceil(size / CHUNK_SIZE);
}
/** Normalize `rec.holes`: DELETE the key when the range list becomes empty (§1 of the
 *  holes brief — omitted, not `holes: []`, so a normal contiguous file adds zero
 *  manifest bytes), otherwise set it to the new normalized ranges. */
function setHoles(rec: InodeRecord, ranges: Array<[number, number]>): void {
  if (ranges.length === 0) delete rec.holes;
  else rec.holes = ranges;
}

/** Read both manifest slots as raw bytes (null if absent/unreadable). */
async function readSlot(s: "a" | "b"): Promise<Uint8Array | null> {
  try {
    const fh = await rootDir.getFileHandle(slotName(s));
    return new Uint8Array(await (await fh.getFile()).arrayBuffer());
  } catch (e) {
    if ((e as { name?: string } | null)?.name === "NotFoundError") return null; // genuinely absent slot
    throw new VfsError("EIO", slotName(s)); // unreadable/malformed slot storage → fail closed, no GC
  }
}

/** Write the current in-memory manifest as the next generation into the non-current slot. */
async function writeGeneration(): Promise<void> {
  const nextGen = generation + 1;
  const bytes = serializeManifest(mani, nextGen);
  if (bytes.byteLength > MANIFEST_SIZE_WARN_BYTES && !warnedManifestSize) {
    warnedManifestSize = true;
    console.warn(
      `[wash-opfs] manifest is ${bytes.byteLength} bytes; per-flush rewrite cost is ` +
      `O(manifest size). Consider fewer files or a future log+checkpoint manifest.`,
    );
  }
  const target = otherSlot();
  const fh = await rootDir.getFileHandle(slotName(target), { create: true });
  const h = await fh.createSyncAccessHandle();
  try {
    maybeFault("slotWrite");
    h.truncate(0);
    const n = h.write(bytes, { at: 0 });
    // A short manifest write must fail the commit (caught below → slot invalidated → reopen
    // falls back to the prior generation) rather than proceed to flush a truncated slot — it
    // would also fail the checksum on reopen, but failing fast here is cleaner.
    if (n < bytes.byteLength) throw new VfsError("EIO", slotName(target));
    maybeFault("slotFlush");   // test hook: fault AFTER the bytes have landed but at the durability barrier
    h.flush();
  } catch (e) {
    // The slot may hold a fully-written-but-not-durably-flushed generation. Invalidate it
    // (0-length → treated as an absent slot by selectGeneration) so reopen cannot select a
    // non-durable generation whose staged chunks the rollback deletes. Best-effort.
    try { h.truncate(0); h.flush(); } catch { /* pathological double-fault */ }
    throw e;
  } finally {
    h.close();
  }
  generation = nextGen;
  currentSlot = target;
  committedBytes = bytes;
  dirty = false;
}

/**
 * Ordered fail-closed commit (spec §3.1):
 * 1. flush all dirty blob handles; on any failure → poison + roll back + throw.
 * 2. write the new manifest generation into the non-current slot.
 * On a blob-flush failure the working manifest is restored to last-committed (§3.1a).
 */
async function commit(): Promise<void> {
  try {
    maybeFault("blobFlush"); // test hook: simulate a blob-flush failure at the commit boundary
  } catch (e) {
    await rollbackToCommitted();
    throw toVfs(e); // QuotaExceededError → ENOSPC
  }
  const blobErr = blobs.flushAll();
  if (blobErr) {
    await rollbackToCommitted();
    throw blobErr;
  }
  if (!dirty) {
    blobs.commitBatch(); // no content op ran (staged is empty), but never skip the discard
    return;
  }
  try {
    await writeGeneration();
    blobs.commitBatch(); // manifest + content are both durable now — discard staged bookkeeping
  } catch (e) {
    await rollbackToCommitted();
    throw toVfs(e);
  }
}

/**
 * Roll the working manifest back to the last successfully committed generation and discard
 * this batch's staged (COW'd) chunk versions. Because content mutations always COW into
 * `<id>.<chunk>.<stagedGen>` and never touch a committed version in place, there is no content
 * to restore — rollback just deletes the staged-gen files and reverts the chunk-version map.
 * Must complete before commit()'s rejection propagates (all three call sites await it).
 */
async function rollbackToCommitted(): Promise<void> {
  const parsed = parseManifest(committedBytes);
  mani = parsed ? parsed.manifest : emptyManifest(mani.rootId);
  dirty = false;
  await blobs.rollbackBatch();
}

/**
 * GC's live set (spec §3.3, version-aware): the UNION, over the working manifest and BOTH
 * retained on-disk generations, of each view's resolved chunk VERSION FILE for every file
 * inode's chunks within that view's size. A physical `<id>.<chunk>.<v>` file is live iff some
 * retained view resolves to it for a chunk within that inode's size in that view — this drops
 * superseded chunk versions once no retained generation resolves them, not just whole ids.
 */
async function unionLiveChunkFiles(): Promise<Set<string>> {
  const live = new Set<string>();
  addLiveChunkFiles(live, blobs.chunkVersionSnapshot(), mani); // working view
  for (const s of ["a", "b"] as const) {
    const bytes = await readSlot(s);
    if (!bytes) continue;
    const parsed = parseManifest(bytes);
    if (!parsed) continue;
    const versions = await blobs.resolveGenerationVersions(parsed.generation);
    addLiveChunkFiles(live, versions, parsed.manifest);
  }
  return live;
}

/** Add, for every file inode in `m` whose chunk resolves a version in `versions`, that chunk's
 *  FULL versioned filename to `live`. Chunks beyond an inode's size are size-gated out; chunks
 *  that are HOLES per THIS view's own `rec.holes` (P1 deep) reference no live file and are
 *  skipped too — a hole chunk's stale on-disk version becomes collectible once no retained
 *  view marks it non-hole within size. */
function addLiveChunkFiles(live: Set<string>, versions: ReadonlyMap<string, number>, m: Manifest): void {
  for (const [id, rec] of Object.entries(m.inodes)) {
    if (rec.kind !== "file") continue;
    const chunkCount = Math.ceil(rec.size / blobs.chunkSize);
    const holes = rec.holes ?? [];
    for (let idx = 0; idx < chunkCount; idx++) {
      if (holesHas(holes, idx)) continue; // hole: references no live chunk file in this view
      const key = `${id}.${idx}`;
      const v = versions.get(key);
      if (v !== undefined) live.add(`${key}.${v}`);
    }
  }
}

async function acquireLock(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    void navigator.locks.request(`wash-opfs:${name}`, { ifAvailable: true }, (lock) => {
      if (!lock) { resolve(false); return Promise.resolve(); }
      return new Promise<void>((release) => {
        releaseLock = () => release();
        resolve(true);
      });
    });
  });
}

type OpResult = { value: unknown };
type OpFn = (...args: never[]) => Promise<OpResult> | OpResult;
const ops: Record<string, OpFn> = {
  async open(rootDirName: string, poolSizeOpt: number, testHooks: boolean): Promise<OpResult> {
    // Feature-detect BEFORE touching OPFS or the lock: a missing navigator.locks must surface
    // as a clear ENOSYS here, not as a TypeError deep inside acquireLock() below.
    assertWebLocksAvailable(navigator);
    if (testHooks) {
      faults = new Map();
      ops.__injectFault = (site: string, skip = 0, times = 1): OpResult => {
        faults!.set(site, { skip, times });
        return { value: undefined };
      };
    }
    poolSize = poolSizeOpt;
    if (!(await acquireLock(rootDirName))) throw new VfsError("EBUSY", rootDirName);
    const origin = await navigator.storage.getDirectory();
    rootDir = await origin.getDirectoryHandle(rootDirName, { create: true });
    const blobDir = await rootDir.getDirectoryHandle("blobs", { create: true });
    blobs = new BlobStore(blobDir, poolSize, CHUNK_SIZE, maybeFault);
    const sel = selectGeneration(await readSlot("a"), await readSlot("b"));
    if ("state" in sel) {
      if (sel.state === "corrupt") throw new VfsError("EIO", rootDirName); // never empty-init + GC over corruption
      mani = emptyManifest(ulid());
      generation = 0;
      currentSlot = "b"; // so the first writeGeneration()'s otherSlot() is "a" — slot "a" gets gen 1
      committedBytes = serializeManifest(mani, 0);
      dirty = true; // freshly-minted manifest has never been persisted — the next commit() must write it
    } else {
      mani = sel.manifest;
      generation = sel.generation;
      currentSlot = sel.currentSlot;
      committedBytes = (currentSlot === "a" ? await readSlot("a") : await readSlot("b"))!;
      // Resolve the working chunk-version map from disk for the SELECTED generation (not on
      // the EIO/empty-mount paths — EIO threw above, and a fresh empty mount has no chunks yet),
      // size-gated to `mani` so a physically-retained-but-beyond-size tail chunk (e.g. from a
      // shrink+flush, kept around for GC/fallback) cannot resurface in the working view.
      await blobs.buildVersionMap(generation, mani);
    }
    // At open, working == loaded generation, but both slots still contribute to the
    // union live set (the other slot may hold a fallback generation) — see unionLiveChunkFiles().
    await blobs.gc(await unionLiveChunkFiles());
    return { value: mani.rootId };
  },

  async root(): Promise<OpResult> {
    return { value: mani.rootId };
  },

  /** Normal op, callable any time (not testHooks-gated): reclaims chunk-version files unreachable
   *  from the working manifest OR either retained on-disk generation. */
  async gc(): Promise<OpResult> {
    await blobs.gc(await unionLiveChunkFiles());
    return { value: undefined };
  },

  async getattr(id: NodeId): Promise<OpResult> {
    return { value: attrsOf(inode(id)) };
  },

  async flush(): Promise<OpResult> {
    await commit(); // throws (mapped) on any blob-flush or slot-write failure, after rolling back
    return { value: undefined };
  },

  async close(): Promise<OpResult> {
    try { await commit(); } catch { /* best-effort on close */ }
    blobs.closeAll();
    releaseLock?.();
    releaseLock = null;
    return { value: undefined };
  },

  async lookup(parent: NodeId, name: string): Promise<OpResult> {
    requireDir(parent);
    const e = children(parent)[name];
    if (!e) return { value: null };
    return { value: { id: e.id, attrs: attrsOf(inode(e.id)) } };
  },

  async readdir(id: NodeId): Promise<OpResult> {
    requireDir(id);
    const out = Object.entries(children(id)).map(([name, e]) => ({ name, childId: e.id, kind: e.kind }));
    return { value: out };
  },

  async create(parent: NodeId, name: string, id: NodeId, kind: NodeKind, attrs?: Partial<Attrs>): Promise<OpResult> {
    const p = requireDir(parent);
    const dir = children(parent);
    if (dir[name]) throw new VfsError("EEXIST", name);
    const now = Date.now();
    mani.inodes[id] = {
      kind, size: 0, mode: attrs?.mode !== undefined ? attrs.mode & 0o777 : defaultMode(kind),
      mtimeMs: attrs?.mtimeMs ?? now, ctimeMs: attrs?.ctimeMs ?? now, nlink: 1,
    };
    if (kind === "dir") mani.dirents[id] = {};
    dir[name] = { id, kind };
    p.mtimeMs = now;
    dirty = true;
    return { value: undefined };
  },

  async unlink(parent: NodeId, name: string): Promise<OpResult> {
    const p = requireDir(parent);
    const dir = children(parent);
    const e = dir[name];
    if (!e) throw new VfsError("ENOENT", name);
    const child = inode(e.id);
    if (child.kind === "dir") {
      if (Object.keys(children(e.id)).length > 0) throw new VfsError("ENOTEMPTY", name);
      delete mani.dirents[e.id];
      delete mani.inodes[e.id];
    } else {
      child.nlink -= 1;
      if (child.nlink <= 0) {
        delete mani.inodes[e.id]; // blob chunks reclaimed by GC (Task 6); NEVER deleted in-op
      }
    }
    delete dir[name];
    p.mtimeMs = Date.now();
    dirty = true;
    return { value: undefined };
  },

  async setattr(id: NodeId, attrs: Partial<Pick<Attrs, "mode" | "mtimeMs" | "ctimeMs">>): Promise<OpResult> {
    const rec = inode(id);
    if (attrs.mode !== undefined) rec.mode = attrs.mode & 0o777;
    if (attrs.mtimeMs !== undefined) rec.mtimeMs = attrs.mtimeMs;
    if (attrs.ctimeMs !== undefined) rec.ctimeMs = attrs.ctimeMs;
    dirty = true;
    return { value: undefined };
  },

  async read(id: NodeId, offset: number, length: number): Promise<OpResult> {
    const rec = requireFile(id);
    const isHole = (chunk: number): boolean => holesHas(rec.holes ?? [], chunk);
    return { value: await blobs.read(id, offset, length, rec.size, isHole) };
  },

  async write(id: NodeId, offset: number, data: Uint8Array | ArrayBuffer): Promise<OpResult> {
    const rec = requireFile(id);
    // The client transfers `data` as an ArrayBuffer (see client.ts write()), not a Uint8Array.
    // BlobStore.write calls .subarray(...) on it, which ArrayBuffer lacks — wrap first.
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
    if (bytes.byteLength === 0) return { value: undefined }; // POSIX no-op
    const oldSize = rec.size;
    // generation is constant within a batch (advances only on a successful commit), so
    // generation + 1 is a stable staged-gen for every content op in this batch.
    try {
      await blobs.write(id, offset, bytes, generation + 1);
    } catch (e) {
      await rollbackToCommitted(); // abort the whole batch: discard staged chunks + revert manifest to last-committed
      throw e;
    }
    const end = offset + bytes.byteLength;
    if (end > rec.size) rec.size = end;
    rec.mtimeMs = Date.now();
    // holes maintenance (P1 deep — holes brief §2 `write`): touched chunks now have content;
    // a sparse gap opened up by writing past the old EOF becomes new all-zero holes. No chunk
    // above the write's last touched chunk is newly in-range here — `newCount - 1 === lastT`
    // whenever this write grows the file (end defines newSize), so nothing else needs adding.
    const oldCount = chunkCountOf(oldSize);
    const firstT = Math.floor(offset / CHUNK_SIZE);
    const lastT = Math.floor((end - 1) / CHUNK_SIZE);
    let holes = rec.holes ?? [];
    holes = holesRemove(holes, firstT, lastT + 1);
    if (offset > oldSize) holes = holesAdd(holes, oldCount, firstT);
    setHoles(rec, holes);
    dirty = true;
    return { value: undefined };
  },

  async truncate(id: NodeId, size: number): Promise<OpResult> {
    const rec = requireFile(id);
    const oldSize = rec.size;
    try {
      await blobs.truncate(id, size, oldSize, generation + 1);
    } catch (e) {
      await rollbackToCommitted(); // abort the whole batch: discard staged chunks + revert manifest to last-committed
      throw e;
    }
    rec.size = size;
    rec.mtimeMs = Date.now();
    // holes maintenance (P1 deep — holes brief §2 `truncate`): shrink clamps out-of-range
    // chunks out of holes (the boundary chunk stays content via the cow-shorten in blobs.ts);
    // extend opens the newly-in-range chunks as new all-zero holes (the old boundary chunk's
    // intra-chunk tail already reads as zeros via short-read, so it is NOT itself a new hole).
    const oldCount = chunkCountOf(oldSize);
    const newCount = chunkCountOf(size);
    let holes = rec.holes ?? [];
    if (size < oldSize) holes = holesClamp(holes, newCount);
    else if (size > oldSize) holes = holesAdd(holes, oldCount, newCount);
    setHoles(rec, holes);
    dirty = true;
    return { value: undefined };
  },

  async symlink(parent: NodeId, name: string, id: NodeId, target: string): Promise<OpResult> {
    const p = requireDir(parent);
    if (children(parent)[name]) throw new VfsError("EEXIST", name);
    const now = Date.now();
    mani.inodes[id] = { kind: "symlink", size: target.length, mode: 0o777, mtimeMs: now, ctimeMs: now, nlink: 1, target };
    children(parent)[name] = { id, kind: "symlink" };
    p.mtimeMs = now;
    dirty = true;
    return { value: undefined };
  },

  async readlink(id: NodeId): Promise<OpResult> {
    const rec = inode(id);
    if (rec.kind !== "symlink" || rec.target === undefined) throw new VfsError("EINVAL");
    return { value: rec.target };
  },

  async link(parent: NodeId, name: string, id: NodeId): Promise<OpResult> {
    const p = requireDir(parent);
    if (children(parent)[name]) throw new VfsError("EEXIST", name); // EEXIST before EPERM
    const rec = inode(id);
    if (rec.kind === "dir") throw new VfsError("EPERM", name);
    rec.nlink += 1;
    children(parent)[name] = { id, kind: rec.kind };
    p.mtimeMs = Date.now();
    dirty = true;
    return { value: undefined };
  },

  async rename(fromParent: NodeId, fromName: string, toParent: NodeId, toName: string): Promise<OpResult> {
    const fp = requireDir(fromParent);
    const tp = requireDir(toParent);
    const fromDir = children(fromParent);
    const moving = fromDir[fromName];
    if (!moving) throw new VfsError("ENOENT", fromName);
    const toDir = children(toParent);
    const displaced = toDir[toName];
    if (displaced) {
      if (displaced.id === moving.id) return { value: undefined }; // POSIX same-inode no-op
      const ex = inode(displaced.id);
      const mv = inode(moving.id);
      if (ex.kind === "dir") {
        if (mv.kind !== "dir") throw new VfsError("EISDIR", toName);
        if (Object.keys(children(displaced.id)).length > 0) throw new VfsError("ENOTEMPTY", toName);
        delete mani.dirents[displaced.id];
        delete mani.inodes[displaced.id];
      } else {
        if (mv.kind === "dir") throw new VfsError("ENOTDIR", toName);
        ex.nlink -= 1;
        if (ex.nlink <= 0) {
          delete mani.inodes[displaced.id]; // blobs reclaimed by GC (Task 6); NEVER deleted in-op
        }
      }
    }
    delete fromDir[fromName];
    toDir[toName] = moving;
    fp.mtimeMs = Date.now();
    tp.mtimeMs = fp.mtimeMs;
    dirty = true;
    return { value: undefined };
  },

  async dump(): Promise<OpResult> {
    const inodes = Object.entries(mani.inodes).map(([id, rec]) => ({ id, attrs: attrsOf(rec) }));
    const dirents: { parentId: NodeId; name: string; childId: NodeId; kind: NodeKind }[] = [];
    for (const [parentId, entries] of Object.entries(mani.dirents)) {
      for (const [name, e] of Object.entries(entries)) {
        dirents.push({ parentId, name, childId: e.id, kind: e.kind });
      }
    }
    return { value: { inodes, dirents } };
  },
};

function ensure(op: string): OpFn {
  return ops[op] ?? (() => { throw new VfsError("ENOSYS", op); });
}

let chain: Promise<void> = Promise.resolve();
self.onmessage = (ev: MessageEvent<RpcRequest>) => {
  const req = ev.data;
  chain = chain.then(async () => {
    try {
      const result = await ensure(req.op)(...(req.args as never[]));
      (self as unknown as Worker).postMessage({ id: req.id, ok: true, value: result.value } satisfies RpcResponse);
    } catch (e) {
      const v = e instanceof VfsError ? e : undefined;
      (self as unknown as Worker).postMessage({
        id: req.id, ok: false, errno: v?.errno, path: v?.path,
        message: e instanceof Error ? e.message : String(e),
      } satisfies RpcResponse);
    }
  }).catch(() => {});
};
