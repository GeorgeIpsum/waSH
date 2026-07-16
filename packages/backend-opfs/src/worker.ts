/// <reference lib="webworker" />
import type { Attrs, NodeId, NodeKind } from "@wash/vfs";
import { VfsError, ulid } from "@wash/vfs";
import type { RpcRequest, RpcResponse } from "./rpc.js";
import {
  type Manifest, type InodeRecord,
  serializeManifest, parseManifest, selectGeneration, emptyManifest, liveIds,
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

/** Read both manifest slots as raw bytes (null if absent/unreadable). */
async function readSlot(s: "a" | "b"): Promise<Uint8Array | null> {
  try {
    const fh = await rootDir.getFileHandle(slotName(s));
    return new Uint8Array(await (await fh.getFile()).arrayBuffer());
  } catch {
    return null;
  }
}

/** Write the current in-memory manifest as the next generation into the non-current slot. */
async function writeGeneration(): Promise<void> {
  const nextGen = generation + 1;
  const bytes = serializeManifest(mani, nextGen);
  const target = otherSlot();
  const fh = await rootDir.getFileHandle(slotName(target), { create: true });
  const h = await fh.createSyncAccessHandle();
  try {
    maybeFault("slotWrite");
    h.truncate(0);
    h.write(bytes, { at: 0 });
    h.flush();
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
    rollbackToCommitted();
    throw toVfs(e); // QuotaExceededError → ENOSPC
  }
  const blobErr = blobs.flushAll();
  if (blobErr) {
    rollbackToCommitted();
    throw blobErr;
  }
  if (!dirty) return;
  try {
    await writeGeneration();
  } catch (e) {
    rollbackToCommitted();
    throw toVfs(e);
  }
}

function rollbackToCommitted(): void {
  const parsed = parseManifest(committedBytes);
  mani = parsed ? parsed.manifest : emptyManifest(mani.rootId);
  dirty = false;
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
    blobs = new BlobStore(blobDir, poolSize);
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
    }
    await blobs.gc(liveIds(mani)); // open-time GC over the committed (loaded) manifest
    return { value: mani.rootId };
  },

  async root(): Promise<OpResult> {
    return { value: mani.rootId };
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
