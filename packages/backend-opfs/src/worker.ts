/// <reference lib="webworker" />
import type { Attrs, Dirent, NodeId, NodeInfo, NodeKind } from "@wash/vfs";
import { VfsError, ulid } from "@wash/vfs";
import type { RpcRequest, RpcResponse } from "./rpc.js";
import {
  parseSidecar,
  serializeSidecar,
  setSidecarEntry,
  renameSidecarEntry,
  isEmptySidecar,
  type Sidecar,
} from "./sidecar.js";
import { Lru } from "./lru.js";

export const SIDECAR_NAME = ".wash-attrs";

interface NodeRec {
  kind: NodeKind;
  parentId: NodeId | null; // null only for the mount root
  name: string; // "" for the root
  dir?: FileSystemDirectoryHandle; // dirs
  file?: FileSystemFileHandle; // files and symlink marker files
  target?: string; // symlinks
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
  /** Set by setattr: an explicit utimes wins over File.lastModified in attrsOf. */
  mtimeExplicit?: boolean;
  children?: Map<string, { id: NodeId; kind: NodeKind }>; // dirs (excludes the sidecar)
  childrenComplete?: boolean;
  sidecar?: Sidecar; // dirs, lazy
}

const nodes = new Map<NodeId, NodeRec>();
let rootId: NodeId = "";
let poolSize = 64;

// Test-gated fault injection (never reachable unless `open` was called with
// `testHooks: true`): `armed === null` is the fast path that makes every
// `maybeFault` call a no-op in production, with zero allocation. Only when a
// test opts in does `open` allocate the map and register `__injectFault`.
// Each site is armed with a skip count and a times count: a site armed with
// `skip` N lets the first N triggers through untouched (decrementing), then
// fires on each of the next `times` consecutive triggers (decrementing that
// counter instead) before disarming — this lets a test single out which of
// several call sites for the same named site (e.g. a shadow-rename's aside
// move vs. its primary move) actually fails, and, when `times > 1`, fail more
// than one consecutive trigger of the same site (e.g. two evictions in a row).
let armed: Map<string, { skip: number; times: number }> | null = null;

function maybeFault(site: string): void {
  if (armed === null) return;
  const state = armed.get(site);
  if (state === undefined) return;
  if (state.skip > 0) {
    state.skip--;
    return;
  }
  state.times--;
  if (state.times <= 0) armed.delete(site);
  throw new DOMException("injected quota failure", "QuotaExceededError");
}

// Sticky durability poison: an evicted handle that failed to flush is gone for good
// (close() below always runs regardless), so there is no handle left for a later
// `fsync` to flush or report on. Recording the failure here and surfacing it on the
// NEXT `flush` op (see below) ensures that loss is reported rather than silently
// dropped. List-based (not a single slot): every poisoning site pushes unconditionally,
// so two independent eviction failures (e.g. rename's displaced-close AND the moved
// source's own close, in one overwrite) are BOTH recorded rather than the second being
// dropped because a single slot was already occupied. `flush`/`close` still only ever
// report the first entry and then clear the whole list (see their comments) — the list
// exists so that rename's successful-overwrite discard path can splice out exactly the
// entries ITS OWN displaced-close introduced, without erasing an unrelated entry queued
// before or after it.
let pendingFlushErrors: VfsError[] = [];

function makePool(capacity: number): Lru<NodeId, FileSystemSyncAccessHandle> {
  return new Lru(capacity, (_id, h) => {
    let flushFailed = false;
    let flushError: unknown;
    try {
      try {
        maybeFault("evictFlush");
        h.flush();
      } catch (e) {
        flushFailed = true;
        flushError = e;
      } finally {
        h.close(); // must run even when flush throws: a leaked handle holds the file's exclusive lock
      }
    } catch {
      // close() itself failed (e.g. already closed) — nothing more we can do beyond the
      // flush-failure poisoning below, which already captured the real durability loss.
    }
    if (flushFailed) pendingFlushErrors.push(toVfs(flushError));
  });
}

// Used ONLY where the pooled handle's content is being destroyed outright (unlink's
// file branch; rename's displaced-entry teardown) — as opposed to closePooled, used
// where the entry is merely being moved and must survive. A flush failure here is
// moot (the bytes are going away either way) and must NOT poison a later fsync: the
// data being discarded was never going to be read back, so its flush failing carries
// no durability implication for anything the caller still cares about.
function discardPooled(id: NodeId): void {
  const h = pool.peek(id);
  pool.delete(id, false);
  if (!h) return;
  try {
    try {
      maybeFault("evictFlush");
      h.flush();
    } finally {
      h.close();
    }
  } catch {
    // swallowed — see comment above.
  }
}

let pool: Lru<NodeId, FileSystemSyncAccessHandle> = makePool(poolSize);

function defaultMode(kind: NodeKind): number {
  return kind === "dir" ? 0o755 : kind === "symlink" ? 0o777 : 0o644;
}

function node(id: NodeId): NodeRec {
  const rec = nodes.get(id);
  if (!rec) throw new VfsError("ENOENT");
  return rec;
}

// Shared DOMException → VfsError mapping table. Returns `undefined` (rather than
// throwing) for names it doesn't recognize, so callers can decide what to do with an
// unmapped error: errnoFromDom rethrows the raw error (its long-standing contract);
// toVfs (below) falls back to a generic VfsError for callers that need one no matter
// what, because they can only ever surface a VfsError to a later, unrelated caller.
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
  throw domToVfs(e, path) ?? e;
}

// Like domToVfs, but always returns a VfsError — for callers (the eviction-path flush
// below) that record a failure to report to a LATER, unrelated caller rather than
// throwing it to the current one. An unmapped DOM error still needs *some* errno to
// carry across that gap, so it falls back to EBUSY (closest fit: the resource — an
// evicted, already-closed sync handle — is no longer usable right now).
function toVfs(e: unknown, path?: string): VfsError {
  return domToVfs(e, path) ?? new VfsError("EBUSY", path);
}

function requireDir(rec: NodeRec): asserts rec is NodeRec & { dir: FileSystemDirectoryHandle } {
  if (rec.kind !== "dir" || !rec.dir) throw new VfsError("ENOTDIR");
}

async function ensureSidecar(rec: NodeRec & { dir: FileSystemDirectoryHandle }): Promise<Sidecar> {
  if (rec.sidecar) return rec.sidecar;
  try {
    const fh = await rec.dir.getFileHandle(SIDECAR_NAME);
    rec.sidecar = parseSidecar(await (await fh.getFile()).text());
  } catch {
    rec.sidecar = {};
  }
  return rec.sidecar;
}

async function writeSidecarFile(rec: NodeRec & { dir: FileSystemDirectoryHandle }): Promise<void> {
  try {
    maybeFault("sidecarWrite");
    const sidecar = rec.sidecar ?? {};
    if (isEmptySidecar(sidecar)) {
      // Unlike other best-effort sidecar cleanups in this file (which tolerate a
      // stale-but-harmless record left behind), THIS delete is the write path for
      // a legitimate mutation (e.g. chmod-back-to-default) that the caller is
      // depending on to actually land — silently swallowing a real failure here
      // would let that mutation "succeed" while the stale record persists on disk
      // and gets re-applied on the next reopen. Tolerate only the file already
      // being gone (NotFoundError); anything else must surface so callers (which
      // already treat writeSidecarFile as fallible-with-rollback) can roll back.
      maybeFault("sidecarDelete");
      try {
        await rec.dir.removeEntry(SIDECAR_NAME);
      } catch (e) {
        if ((e as { name?: string } | null)?.name !== "NotFoundError") throw e;
      }
      return;
    }
    const fh = await rec.dir.getFileHandle(SIDECAR_NAME, { create: true });
    const handle = await fh.createSyncAccessHandle();
    try {
      const bytes = new TextEncoder().encode(serializeSidecar(sidecar));
      handle.truncate(0);
      handle.write(bytes, { at: 0 });
      handle.flush();
    } finally {
      handle.close();
    }
  } catch (e) {
    errnoFromDom(e, rec.name);
  }
}

function registerChild(
  parentId: NodeId,
  name: string,
  kind: NodeKind,
  handles: { dir?: FileSystemDirectoryHandle; file?: FileSystemFileHandle },
  opts: { id?: NodeId; mode?: number; target?: string; mtimeMs?: number } = {},
): NodeId {
  const id = opts.id ?? ulid();
  const now = Date.now();
  nodes.set(id, {
    kind, parentId, name,
    dir: handles.dir, file: handles.file,
    target: opts.target,
    mode: opts.mode ?? defaultMode(kind),
    mtimeMs: opts.mtimeMs ?? now, ctimeMs: now,
  });
  const parent = node(parentId);
  parent.children ??= new Map();
  parent.children.set(name, { id, kind });
  return id;
}

async function ensureChildren(
  id: NodeId,
  rec: NodeRec & { dir: FileSystemDirectoryHandle },
): Promise<Map<string, { id: NodeId; kind: NodeKind }>> {
  if (rec.childrenComplete && rec.children) return rec.children;
  const sidecar = await ensureSidecar(rec);
  rec.children ??= new Map();
  for await (const [name, handle] of rec.dir.entries()) {
    if (name === SIDECAR_NAME) continue;
    if (rec.children.has(name)) continue;
    const meta = sidecar[name];
    if (handle.kind === "directory") {
      registerChild(id, name, "dir", { dir: handle as FileSystemDirectoryHandle }, { mode: meta?.mode });
    } else if (meta?.symlink !== undefined) {
      registerChild(id, name, "symlink", { file: handle as FileSystemFileHandle }, { mode: meta.mode, target: meta.symlink });
    } else {
      // mtimeMs: 0 lets attrsOf's max-style comparison fall through to File.lastModified
      // for a freshly-discovered file (this rec was never written-to in this session, so
      // there's no in-session mtime to preserve) — see README's mtime section.
      registerChild(id, name, "file", { file: handle as FileSystemFileHandle }, { mode: meta?.mode, mtimeMs: 0 });
    }
  }
  rec.childrenComplete = true;
  return rec.children;
}

type OpResult = { value: unknown; transfer?: Transferable[] };
type OpFn = (...args: never[]) => Promise<OpResult>;

function requireFile(rec: NodeRec): asserts rec is NodeRec & { file: FileSystemFileHandle } {
  if (rec.kind === "dir") throw new VfsError("EISDIR");
  if (!rec.file) throw new VfsError("ENOENT");
}

async function acquireHandle(
  id: NodeId,
  rec: NodeRec & { file: FileSystemFileHandle },
): Promise<FileSystemSyncAccessHandle> {
  const existing = pool.get(id);
  if (existing) return existing;
  // Once pooled, attrsOf's getSize()-based fast path never re-reads File.lastModified
  // (an open sync-access handle's own state is authoritative for size, but OPFS doesn't
  // expose a live mtime through it) — so a freshly-discovered file's mtimeMs:0 placeholder
  // (see ensureChildren) must be resolved to its real File.lastModified now, before the
  // handle goes in the pool, or it would be stuck reporting 0 for the rest of the session.
  if (rec.mtimeMs === 0 && !rec.mtimeExplicit) {
    rec.mtimeMs = (await rec.file.getFile()).lastModified;
  }
  let handle: FileSystemSyncAccessHandle;
  try {
    handle = await rec.file.createSyncAccessHandle();
  } catch (e) {
    errnoFromDom(e, rec.name);
  }
  pool.set(id, handle);
  return handle;
}

function closePooled(id: NodeId): void {
  pool.delete(id, true);
}

type MovableFileHandle = FileSystemFileHandle & {
  move?: (dest: FileSystemDirectoryHandle, name: string) => Promise<void>;
};

// Both move helpers below own the full rebind (handles + parentId + name); callers
// manage only dentry maps. Each captures the pre-move identity (oldParent/oldName)
// FIRST and uses that captured identity for source-side cleanup, so a NodeRec's
// name/parentId always describe its last successfully-committed physical location —
// re-invoking a move helper on the same rec after a failure is safe (e.g. the rename
// restore path below, which re-targets a rec whose primary move already failed).
// moveFileEntry overwrites rec.parentId/rec.name as its unconditional LAST statements:
// every fallible step precedes them, so a throw always means they never ran and the
// rec still names the source. moveTree's rebind instead lands as soon as every
// physical piece (sidecar + descendants) is relocated, followed by one more fallible,
// best-effort step (removing the emptied source directory entry) that can still throw
// AFTER the rebind — that failure is surfaced truthfully rather than un-committing
// the rebind, since disk already agrees with it.
async function moveFileEntry(
  rec: NodeRec & { file: FileSystemFileHandle },
  id: NodeId,
  destParentId: NodeId,
  destDir: FileSystemDirectoryHandle,
  newName: string,
): Promise<void> {
  const oldParent = rec.parentId !== null ? node(rec.parentId) : null;
  const oldName = rec.name;
  try {
    maybeFault("moveStep");
    closePooled(id); // sync handles lock the file
    const movable = rec.file as MovableFileHandle;
    if (typeof movable.move === "function") {
      await movable.move(destDir, newName);
      rec.file = await destDir.getFileHandle(newName);
    } else {
      // copy+delete fallback for engines without FileSystemFileHandle.move
      const data = new Uint8Array(await (await rec.file.getFile()).arrayBuffer());
      const destHandle = await destDir.getFileHandle(newName, { create: true });
      const h = await destHandle.createSyncAccessHandle();
      try {
        h.truncate(0);
        if (data.byteLength > 0) h.write(data, { at: 0 });
        h.flush();
      } finally {
        h.close();
      }
      if (oldParent?.dir) {
        try {
          await oldParent.dir.removeEntry(oldName);
        } catch (e) {
          if ((e as { name?: string } | null)?.name !== "NotFoundError") errnoFromDom(e, oldName);
        }
      }
      rec.file = destHandle;
    }
  } catch (e) {
    errnoFromDom(e, newName);
  }
  rec.parentId = destParentId;
  rec.name = newName;
}

async function moveTree(
  rec: NodeRec & { dir: FileSystemDirectoryHandle },
  id: NodeId,
  destParentId: NodeId,
  destDir: FileSystemDirectoryHandle,
  newName: string,
): Promise<void> {
  const oldParent = rec.parentId !== null ? node(rec.parentId) : null;
  const oldName = rec.name;
  const srcDirOld = rec.dir;
  let newDir: FileSystemDirectoryHandle;
  try {
    newDir = await destDir.getDirectoryHandle(newName, { create: true });
  } catch (e) {
    errnoFromDom(e, newName);
  }

  // Cache the sidecar content BEFORE it is physically relocated below: once cached,
  // ensureChildren's own ensureSidecar call (inside the child loop, still reading via
  // rec.dir === srcDirOld) returns this cached copy rather than re-reading disk —
  // which would otherwise race the physical move and find the file already gone.
  await ensureSidecar(rec);

  // Physically transport the sidecar file itself, as the FIRST fallible step of the
  // whole move and BEFORE the child loop: `rec` is still fully untouched here (dir,
  // parentId, and name all still describe the source), so a failure here is a clean
  // abort — nothing has moved yet, and the (possibly-just-created, still-empty) dest
  // dir handle is removed best-effort before rethrowing so it doesn't linger as an
  // empty phantom. rec.sidecar stays valid either way: its contents are unchanged,
  // only its physical location moves. This replaces the old "write dest sidecar, then
  // remove old sidecar" logic entirely — that pair could throw with rec.dir already
  // pointed at the destination but parentId/name still naming the source, a chimera
  // NodeRec that later readdirs/retries would silently operate on.
  try {
    maybeFault("sidecarMove");
    let sidecarHandle: FileSystemFileHandle | undefined;
    try {
      sidecarHandle = await srcDirOld.getFileHandle(SIDECAR_NAME);
    } catch (e) {
      if ((e as { name?: string } | null)?.name !== "NotFoundError") errnoFromDom(e, oldName);
    }
    if (sidecarHandle) {
      const movable = sidecarHandle as MovableFileHandle;
      if (typeof movable.move === "function") {
        await movable.move(newDir, SIDECAR_NAME);
      } else {
        // copy+delete fallback for engines without FileSystemFileHandle.move — same
        // shape as moveFileEntry's fallback below.
        const data = new Uint8Array(await (await sidecarHandle.getFile()).arrayBuffer());
        const destHandle = await newDir.getFileHandle(SIDECAR_NAME, { create: true });
        const h = await destHandle.createSyncAccessHandle();
        try {
          h.truncate(0);
          if (data.byteLength > 0) h.write(data, { at: 0 });
          h.flush();
        } finally {
          h.close();
        }
        await srcDirOld.removeEntry(SIDECAR_NAME);
      }
    }
  } catch (e) {
    await destDir.removeEntry(newName, { recursive: true }).catch(() => {});
    errnoFromDom(e, oldName);
  }

  const children = await ensureChildren(id, rec);
  for (const [childName, entry] of children) {
    maybeFault("moveStep");
    const child = node(entry.id);
    if (child.kind === "dir") {
      requireDir(child);
      await moveTree(child, entry.id, id, newDir, childName);
    } else {
      requireFile(child);
      await moveFileEntry(child, entry.id, id, newDir, childName);
    }
  }

  // The subtree HAS now fully moved (non-atomic by design, per
  // BackendCaps.renameCost === "subtree": sidecar + every child are physically
  // relocated). rec.dir must never be reassigned any earlier than this — a partial
  // rebind (dir already pointing at dest while parentId/name still say source) is
  // exactly the chimera state a fallible step between them used to create. Commit the
  // FULL rebind in one place, all at once, now that physical truth backs it.
  rec.dir = newDir;
  rec.parentId = destParentId;
  rec.name = newName;

  // Remove the emptied source directory — the only remaining fallible step, and it
  // runs AFTER the rebind above: if it throws, rec already truthfully describes the
  // new location (sidecar + children are physically there), so a caller retry, a
  // plain lookup/readdir, or the rename op's own truth-preserving catch (below) all
  // observe state that matches disk, even though this op ultimately reports failure.
  if (oldParent?.dir) {
    try {
      maybeFault("moveCleanup");
      await oldParent.dir.removeEntry(oldName);
    } catch (e) {
      errnoFromDom(e, oldName);
    }
  }
}

const ops: Record<string, OpFn> = {
  async open(rootDirName: string, poolSizeOpt: number, testHooks?: boolean): Promise<OpResult> {
    poolSize = poolSizeOpt;
    pool = makePool(poolSize);
    const origin = await navigator.storage.getDirectory();
    const dir = await origin.getDirectoryHandle(rootDirName, { create: true });
    rootId = ulid();
    const now = Date.now();
    nodes.set(rootId, {
      kind: "dir", parentId: null, name: "", dir,
      mode: 0o755, mtimeMs: now, ctimeMs: now,
    });
    if (testHooks) {
      armed = new Map();
      // Only ever present when a test opted in. `skip` (default 0) lets that
      // many earlier triggers of `site` through before the first one that
      // fires; `times` (default 1) is how many consecutive triggers after the
      // skip fire before the site disarms.
      ops.__injectFault = async (site: string, skip = 0, times = 1): Promise<OpResult> => {
        armed!.set(site, { skip, times });
        return { value: undefined };
      };
    }
    return { value: rootId };
  },

  async getattr(id: NodeId): Promise<OpResult> {
    const rec = node(id);
    const attrs = await attrsOf(id, rec);
    return { value: attrs };
  },

  async lookup(parent: NodeId, name: string): Promise<OpResult> {
    const rec = node(parent);
    requireDir(rec);
    if (name === SIDECAR_NAME) return { value: null };
    const children = await ensureChildren(parent, rec);
    const entry = children.get(name);
    if (!entry) return { value: null };
    const info: NodeInfo = { id: entry.id, attrs: await attrsOf(entry.id, node(entry.id)) };
    return { value: info };
  },

  async readdir(id: NodeId): Promise<OpResult> {
    const rec = node(id);
    requireDir(rec);
    const children = await ensureChildren(id, rec);
    const out: Dirent[] = [];
    for (const [name, e] of children) out.push({ name, childId: e.id, kind: e.kind });
    return { value: out };
  },

  // Failure-ordering invariant (same as create/unlink/rename above): the in-memory
  // commit is the final step. rec.mode and the parent's sidecar are snapshotted before
  // the write and rolled back together if writeSidecarFile fails, so a failed chmod
  // never leaves rec.mode reporting a value the sidecar never durably recorded — a
  // caller retry (or a plain getattr) must observe pre-op state, not a memory/disk split.
  async setattr(id: NodeId, attrs: Partial<Pick<Attrs, "mode" | "mtimeMs" | "ctimeMs">>): Promise<OpResult> {
    const rec = node(id);
    if (attrs.mode !== undefined) {
      const newMode = attrs.mode & 0o777;
      if (rec.parentId !== null) {
        const parent = node(rec.parentId);
        requireDir(parent);
        const prevMode = rec.mode;
        const prevSidecar = parent.sidecar;
        try {
          await ensureSidecar(parent);
          rec.mode = newMode;
          parent.sidecar = setSidecarEntry(parent.sidecar!, rec.name, {
            mode: rec.mode === defaultMode(rec.kind) ? undefined : rec.mode,
          });
          await writeSidecarFile(parent);
        } catch (e) {
          rec.mode = prevMode;
          parent.sidecar = prevSidecar;
          if (e instanceof VfsError) throw e;
          errnoFromDom(e, rec.name);
        }
      } else {
        rec.mode = newMode; // root has no parent to persist a sidecar entry into
      }
    }
    if (attrs.mtimeMs !== undefined) {
      rec.mtimeMs = attrs.mtimeMs;
      rec.mtimeExplicit = true;
    }
    if (attrs.ctimeMs !== undefined) rec.ctimeMs = attrs.ctimeMs;
    return { value: undefined };
  },

  async read(id: NodeId, offset: number, length: number): Promise<OpResult> {
    const rec = node(id);
    requireFile(rec);
    const handle = await acquireHandle(id, rec);
    const size = handle.getSize();
    if (offset >= size || length === 0) return { value: new ArrayBuffer(0) };
    const end = Math.min(offset + length, size);
    const buf = new Uint8Array(end - offset);
    handle.read(buf, { at: offset });
    return { value: buf.buffer, transfer: [buf.buffer] };
  },

  async write(id: NodeId, offset: number, data: ArrayBuffer): Promise<OpResult> {
    const rec = node(id);
    requireFile(rec);
    const bytes = new Uint8Array(data);
    if (bytes.byteLength === 0) return { value: undefined }; // POSIX no-op
    const handle = await acquireHandle(id, rec);
    try {
      handle.write(bytes, { at: offset }); // OPFS zero-fills any gap past EOF
    } catch (e) {
      errnoFromDom(e, rec.name);
    }
    rec.mtimeMs = Date.now();
    rec.mtimeExplicit = false;
    return { value: undefined };
  },

  async truncate(id: NodeId, size: number): Promise<OpResult> {
    const rec = node(id);
    requireFile(rec);
    const handle = await acquireHandle(id, rec);
    try {
      handle.truncate(size);
    } catch (e) {
      errnoFromDom(e, rec.name);
    }
    rec.mtimeMs = Date.now();
    rec.mtimeExplicit = false;
    return { value: undefined };
  },

  async flush(): Promise<OpResult> {
    // A poisoned eviction flush (see pendingFlushErrors above) takes priority: it
    // describes data that is ALREADY unrecoverably lost, from a handle that no longer
    // exists to retry against, so it must be reported before this flush even looks at
    // the handles it currently holds. Reports only the first queued entry and clears
    // the WHOLE list — matching the pre-list "one-shot" behavior (a caller that retries
    // after seeing the failure gets a clean flush next time), now extended to however
    // many entries accumulated. Any entries beyond the first are dropped on report,
    // same as the old single-slot's "first wins" — the list exists so that unrelated
    // entries survive rename's own targeted splice, not so every entry is eventually
    // surfaced one by one.
    if (pendingFlushErrors.length > 0) {
      const e = pendingFlushErrors[0];
      pendingFlushErrors = [];
      throw e;
    }
    // Ops run strictly sequentially through `chain` (see bottom of file) and nothing
    // in this loop mutates the pool, so there is no benign "handle closed under us"
    // case here: a thrown flush is a REAL durability failure (e.g. quota) and must be
    // surfaced, not swallowed — silently continuing would let fsync report success
    // while OPFS actually rejected the write. Flush every pooled handle regardless (one
    // bad handle must not leave the rest unflushed) and remember only the first error.
    let firstError: unknown;
    let failed = false;
    for (const id of [...pool.keys()]) {
      const h = pool.peek(id);
      try {
        maybeFault("handleFlush");
        h?.flush();
      } catch (e) {
        if (!failed) {
          failed = true;
          firstError = e;
        }
      }
    }
    if (failed) errnoFromDom(firstError);
    return { value: undefined };
  },

  async close(): Promise<OpResult> {
    pool.clear(true);
    // close() is often the LAST durability checkpoint a caller will ever see for this
    // worker — the client tears the worker down right after this resolves/rejects, so
    // any eviction-flush failure queued by the clear() above must be surfaced NOW.
    // Left unreported here it would vanish for good (the worker that could have
    // reported it on a later flush no longer exists). Reports the first queued entry
    // and clears the whole list, same as flush() above.
    if (pendingFlushErrors.length > 0) {
      const e = pendingFlushErrors[0];
      pendingFlushErrors = [];
      throw e;
    }
    return { value: undefined };
  },

  // Failure-ordering invariant: the in-memory dentry/node commit is the final step of
  // every namespace mutation; fallible I/O (disk entry + sidecar) happens first with
  // rollback (create) or is deferred-and-swallowed (unlink), so a failed op never
  // leaves memory ahead of disk — write-back retries must observe pre-op state.
  async create(parent: NodeId, name: string, id: NodeId, kind: NodeKind, attrs?: Partial<Attrs>): Promise<OpResult> {
    const rec = node(parent);
    requireDir(rec);
    if (name === SIDECAR_NAME) throw new VfsError("EPERM", name);
    const children = await ensureChildren(parent, rec);
    if (children.has(name)) throw new VfsError("EEXIST", name);
    let handles: { dir?: FileSystemDirectoryHandle; file?: FileSystemFileHandle };
    try {
      handles = kind === "dir"
        ? { dir: await rec.dir.getDirectoryHandle(name, { create: true }) }
        : { file: await rec.dir.getFileHandle(name, { create: true }) };
    } catch (e) {
      errnoFromDom(e, name);
    }
    const mode = attrs?.mode !== undefined ? attrs.mode & 0o777 : defaultMode(kind);
    // A stale sidecar record can already be sitting at `name` — e.g. left behind by an
    // unlink whose best-effort cleanup write itself failed under quota pressure (that
    // failure is swallowed by design; see unlink below). A default-mode create used to
    // skip the sidecar entirely, silently inheriting that stale record on the next
    // reopen (ensureChildren applies sidecar metadata to whatever disk entry currently
    // occupies the name). Always check for one. A non-default create must also write
    // an explicit `symlink: undefined` alongside `mode`, not just `{ mode }`:
    // setSidecarEntry MERGES onto the existing entry rather than replacing it, so a
    // stale `symlink` field from an old record would otherwise survive untouched.
    await ensureSidecar(rec);
    if (rec.sidecar![name] || mode !== defaultMode(kind)) {
      const prevSidecar = rec.sidecar;
      try {
        rec.sidecar = setSidecarEntry(rec.sidecar!, name, {
          mode: mode !== defaultMode(kind) ? mode : undefined,
          symlink: undefined,
        });
        await writeSidecarFile(rec);
      } catch (e) {
        // Roll back the disk create so a failed op leaves no residue: the in-memory
        // dentry map is not yet touched (registerChild runs after this block), so
        // undoing the disk side keeps memory and disk in lockstep on the failure path.
        rec.sidecar = prevSidecar;
        await rec.dir.removeEntry(name).catch(() => {});
        throw e;
      }
    }
    registerChild(parent, name, kind, handles, { id, mode });
    if (attrs?.mtimeMs !== undefined) node(id).mtimeMs = attrs.mtimeMs;
    if (attrs?.ctimeMs !== undefined) node(id).ctimeMs = attrs.ctimeMs;
    rec.mtimeMs = Date.now();
    return { value: undefined };
  },

  // Failure-ordering invariant: the in-memory dentry/node commit is the final step of
  // every namespace mutation; fallible I/O (disk entry + sidecar) happens first with
  // rollback (create) or is deferred-and-swallowed (unlink), so a failed op never
  // leaves memory ahead of disk — write-back retries must observe pre-op state.
  async unlink(parent: NodeId, name: string): Promise<OpResult> {
    const rec = node(parent);
    requireDir(rec);
    if (name === SIDECAR_NAME) throw new VfsError("EPERM", name);
    const children = await ensureChildren(parent, rec);
    const entry = children.get(name);
    if (!entry) throw new VfsError("ENOENT", name);
    const child = node(entry.id);
    // poisonStart/poisonCount capture the slice of pendingFlushErrors (if any)
    // introduced by the file branch's closePooled call below — see its comment for
    // why the swallow-vs-surface decision can't be made until AFTER removeEntry
    // confirms the delete actually happened.
    let poisonStart = -1;
    let poisonCount = 0;
    if (child.kind === "dir") {
      requireDir(child);
      const grand = await ensureChildren(entry.id, child);
      if (grand.size > 0) throw new VfsError("ENOTEMPTY", name);
      await child.dir.removeEntry(SIDECAR_NAME).catch(() => {}); // sidecar-only dir is empty
    } else {
      // The pooled sync-access handle must be closed before removeEntry below can
      // succeed (an open handle holds the file's exclusive lock) — but whether a
      // flush failure here is truly "moot" depends on removeEntry actually
      // succeeding. Using closePooled (not discardPooled) queues any flush failure
      // into pendingFlushErrors like a normal eviction would, rather than swallowing
      // it up front; only once removeEntry below CONFIRMS the bytes are gone do we
      // splice that entry back out as moot (same pattern as rename's displaced-entry
      // discard). If removeEntry instead fails, the file survives and a lost flush
      // is a real durability loss that must stay reported, not be discarded before
      // its outcome was even known.
      poisonStart = pendingFlushErrors.length;
      closePooled(entry.id);
      poisonCount = pendingFlushErrors.length - poisonStart;
    }
    try {
      maybeFault("removeEntry");
      await rec.dir.removeEntry(name);
    } catch (e) {
      errnoFromDom(e, name);
    }
    // removeEntry succeeded — the bytes really are gone, so any flush failure
    // closePooled captured above is now moot.
    if (poisonCount > 0) pendingFlushErrors.splice(poisonStart, poisonCount);
    children.delete(name);
    nodes.delete(entry.id);
    rec.mtimeMs = Date.now();
    try {
      // Best-effort: a stale sidecar entry for a deleted name is harmless garbage while
      // the name stays deleted — ensureChildren only overlays sidecar metadata onto
      // names that still exist on disk. It stops being harmless the moment a NEW entry
      // is created at this same name (create's own stale-record check, above, is what
      // clears it then) — which is exactly why, unlike the swallow below, a FAILED
      // write here must not optimistically update rec.sidecar in memory: if the write
      // never reached disk, memory has to keep reporting the record as present so a
      // later create at this name still sees it and clears it for real, rather than
      // wrongly believing (from an in-memory-only clear) that there is nothing left to
      // clear while the stale record silently persists on disk.
      await ensureSidecar(rec);
      if (rec.sidecar![name]) {
        const prevSidecar = rec.sidecar;
        rec.sidecar = setSidecarEntry(rec.sidecar!, name, { mode: undefined, symlink: undefined });
        try {
          await writeSidecarFile(rec);
        } catch (e) {
          rec.sidecar = prevSidecar;
          throw e;
        }
      }
    } catch {
      // swallowed — see comment above.
    }
    return { value: undefined };
  },

  // Failure-ordering invariant: the in-memory dentry/node commit is the final step of
  // every namespace mutation; fallible I/O (disk entry + sidecar) happens first with
  // rollback, so a failed op never leaves memory ahead of disk — write-back retries
  // must observe pre-op state.
  async symlink(parent: NodeId, name: string, id: NodeId, target: string): Promise<OpResult> {
    const rec = node(parent);
    requireDir(rec);
    if (name === SIDECAR_NAME) throw new VfsError("EPERM", name);
    const children = await ensureChildren(parent, rec);
    if (children.has(name)) throw new VfsError("EEXIST", name);
    let file: FileSystemFileHandle;
    try {
      file = await rec.dir.getFileHandle(name, { create: true }); // zero-byte marker
    } catch (e) {
      errnoFromDom(e, name);
    }
    const prevSidecar = rec.sidecar;
    try {
      await ensureSidecar(rec);
      // Explicit `mode: undefined` clears any stale mode field a leftover record for
      // `name` might carry — setSidecarEntry merges onto the existing entry rather
      // than replacing it, so a bare `{ symlink: target }` patch would otherwise let
      // that stale field survive (see create's own audit above for the mirror case).
      rec.sidecar = setSidecarEntry(rec.sidecar!, name, { symlink: target, mode: undefined });
      await writeSidecarFile(rec);
    } catch (e) {
      rec.sidecar = prevSidecar;
      await rec.dir.removeEntry(name).catch(() => {});
      throw e;
    }
    registerChild(parent, name, "symlink", { file }, { id, target });
    rec.mtimeMs = Date.now();
    return { value: undefined };
  },

  async readlink(id: NodeId): Promise<OpResult> {
    const rec = node(id);
    if (rec.kind !== "symlink" || rec.target === undefined) throw new VfsError("EINVAL");
    return { value: rec.target };
  },

  async dump(): Promise<OpResult> {
    const inodes: { id: NodeId; attrs: Attrs }[] = [];
    const dirents: { parentId: NodeId; name: string; childId: NodeId; kind: NodeKind }[] = [];
    async function walk(id: NodeId): Promise<void> {
      const rec = node(id);
      inodes.push({ id, attrs: await attrsOf(id, rec) });
      if (rec.kind !== "dir") return;
      requireDir(rec);
      const children = await ensureChildren(id, rec);
      for (const [name, entry] of children) {
        dirents.push({ parentId: id, name, childId: entry.id, kind: entry.kind });
        await walk(entry.id);
      }
    }
    await walk(rootId);
    return { value: { inodes, dirents } };
  },

  // Non-atomic by design (BackendCaps.renameCost === "subtree"): a file move is a
  // single OPFS move/copy step, but a directory move recreates the dest subtree and
  // walks every descendant, rebinding each NodeRec's handles while keeping ids stable.
  // A failure partway through a directory move can leave the source and dest subtrees
  // each holding part of the tree — accepted for v1 and documented, not rolled back.
  async rename(fromParent: NodeId, fromName: string, toParent: NodeId, toName: string): Promise<OpResult> {
    const fp = node(fromParent);
    requireDir(fp);
    const tp = node(toParent);
    requireDir(tp);
    if (fromName === SIDECAR_NAME || toName === SIDECAR_NAME) {
      throw new VfsError("EPERM", fromName === SIDECAR_NAME ? fromName : toName);
    }
    const fromChildren = await ensureChildren(fromParent, fp);
    const moving = fromChildren.get(fromName);
    if (!moving) throw new VfsError("ENOENT", fromName);
    const toChildren = await ensureChildren(toParent, tp);
    const displaced = toChildren.get(toName);
    // POSIX no-op: renaming an entry onto another name that already resolves to the
    // very same node (e.g. a symlinked-parent alias: fromParent/fromName and
    // toParent/toName both reach one dentry) must not touch anything. Hardlinks are
    // unsupported on this backend (caps.hardlinks === false), so id-equality here can
    // only mean "the same dentry, reached two ways" — never two distinct links to one
    // inode — which makes this check exact rather than a heuristic. Without this,
    // the shadow-rename dance below would shadow-alias a rec to itself: the aside move
    // rebinds it to a throwaway name, the "primary" move (the very same rec) rebinds
    // it right back, and the subsequent shadow discard then fails (nothing left under
    // the shadow name) with the whole op wedged mid-mutation.
    if (displaced && displaced.id === moving.id) return { value: undefined };
    const movingRec = node(moving.id);

    // Shadow-rename pattern: never destroy a displaced entry up front (a failed move
    // must not lose data). It is first moved ASIDE to a collision-free shadow name in
    // the same destination directory; only after the source has been confirmed moved
    // into `toName` (below) is the shadow irreversibly discarded. If that source move
    // instead throws, the shadow is restored back to `toName`. Ops in this worker run
    // strictly sequentially through the `chain` (see bottom of file), so no
    // interleaved readdir can ever observe a `.wash-shadow-*` name.
    let shadowName: string | undefined;
    // Captures the slice of pendingFlushErrors (if any) introduced by the closePooled
    // call just below (displaced-entry teardown) — as opposed to entries already
    // queued beforehand (from some earlier, unrelated failure) or appended AFTER (e.g.
    // the moved source's own close, during the primary move further down), both of
    // which must stay reported. Used by the discard phase to splice out ONLY the
    // poison this op introduced for bytes it is about to intentionally destroy anyway,
    // leaving any unrelated entry — before or after it — untouched.
    let displacedPoisonStart = -1;
    let displacedPoisonCount = 0;
    if (displaced) {
      const dispRec = node(displaced.id);
      if (dispRec.kind === "dir") {
        if (movingRec.kind !== "dir") throw new VfsError("EISDIR", toName);
        requireDir(dispRec);
        const grand = await ensureChildren(displaced.id, dispRec);
        if (grand.size > 0) throw new VfsError("ENOTEMPTY", toName);
      } else {
        if (movingRec.kind === "dir") throw new VfsError("ENOTDIR", toName);
        displacedPoisonStart = pendingFlushErrors.length;
        closePooled(displaced.id);
        displacedPoisonCount = pendingFlushErrors.length - displacedPoisonStart;
      }
      shadowName = `.wash-shadow-${ulid()}`;

      // The displaced entry's OWN sidecar record (mode/symlink) still lives under
      // `toName`. Move it to `shadowName` FIRST, before any physical change below — a
      // failure here is then a CLEAN ABORT: nothing has moved yet (physically or in
      // the dentry maps), so a caller retry safely re-observes pre-op state. The old
      // order ran this step LAST (after the physical aside-move and the toChildren
      // delete below), so a failure here used to leave the displaced entry already
      // relocated on disk to `shadowName` and dropped from `toChildren` — stranded and
      // invisible to a cached retry. See finding 1 write-up.
      await ensureSidecar(tp);
      const prevTpSidecarAside = tp.sidecar;
      let hadAsideRecord = false;
      if (tp.sidecar![toName]) {
        hadAsideRecord = true;
        try {
          tp.sidecar = renameSidecarEntry(tp.sidecar!, toName, shadowName);
          await writeSidecarFile(tp);
        } catch (e) {
          // Clean abort: nothing has moved yet, so roll the in-memory sidecar back to
          // its pre-write snapshot — disk never received the write (writeSidecarFile's
          // maybeFault check/handle-open failure happens before any bytes are
          // written), so memory must not disagree with it.
          tp.sidecar = prevTpSidecarAside;
          throw e;
        }
      }

      // THEN the physical aside-move. If THIS throws, the sidecar record just moved
      // above must be moved back — the physical entry never left `toName`, so its
      // record shouldn't claim otherwise. Memory is authoritative; the disk write is
      // best-effort (a stale shadow-named record for a name that was never created is
      // tolerated garbage, same convention as elsewhere in this file).
      try {
        if (dispRec.kind === "dir") {
          requireDir(dispRec);
          await moveTree(dispRec, displaced.id, toParent, tp.dir, shadowName);
        } else {
          requireFile(dispRec);
          await moveFileEntry(dispRec, displaced.id, toParent, tp.dir, shadowName);
        }
      } catch (e) {
        if (hadAsideRecord) {
          tp.sidecar = renameSidecarEntry(tp.sidecar!, shadowName, toName);
          await writeSidecarFile(tp).catch(() => {});
        }
        throw e;
      }
      // dispRec.name is now shadowName (rebound by the move helper above) — the
      // dentry map must be updated in lockstep so it never lists a name the disk
      // doesn't have. Ops are sequential; nothing observes this mid-op.
      toChildren.delete(toName);
    } else {
      // No displaced entry, but a stale sidecar record can still be sitting at
      // `toName` (e.g. left behind by an unlink whose best-effort sidecar cleanup
      // itself failed under quota pressure). setSidecarEntry merges rather than
      // replaces, so leaving this in place would let the sidecar-transport step
      // below merge stale fields (like a leftover `symlink` target) into the
      // freshly-moved-in entry's own metadata. Clear it unconditionally up front.
      await ensureSidecar(tp);
      if (tp.sidecar![toName]) {
        tp.sidecar = setSidecarEntry(tp.sidecar!, toName, { mode: undefined, symlink: undefined });
        await writeSidecarFile(tp);
      }
    }

    // Transport the moving entry's OWN sidecar record (mode/symlink) to the
    // destination BEFORE the primary move — the point of no return. Doing this here,
    // rather than as a trailing step after the move, means a failure aborts cleanly:
    // nothing has moved yet, so the dentry maps (still keyed on `fromName`) and disk
    // (still holding the entry under `fromName`) stay in lockstep, and a caller retry
    // (e.g. CachedBackend's) safely re-observes pre-op state. Were this deferred until
    // after the primary move instead, an ENOSPC here would reject the op while
    // movingRec/disk already say `toName` but the dentry maps still say `fromName` —
    // exactly the stale-map divergence this ordering exists to prevent.
    await ensureSidecar(fp);
    const entryMeta = fp.sidecar![fromName];
    if (entryMeta) {
      await ensureSidecar(tp);
      const prevTpSidecar = tp.sidecar;
      try {
        tp.sidecar = setSidecarEntry(tp.sidecar!, toName, entryMeta);
        await writeSidecarFile(tp);
      } catch (e) {
        // Clean abort: nothing has moved yet, so roll the in-memory sidecar back to
        // its pre-write snapshot to keep memory in lockstep with disk — disk never
        // received the write (writeSidecarFile's maybeFault check/handle-open failure
        // happens before any bytes are written), so memory must not disagree with it.
        tp.sidecar = prevTpSidecar;
        throw e;
      }
    }

    // PHASE A (primary move) and PHASE B (displaced-shadow resolution) share a single
    // try/catch whose catch inspects committed state, rather than each having its own
    // separate handling — see the finding-1/finding-2 write-up. The two P1s this
    // replaces were the same root problem: failure handling here didn't distinguish
    // "failed BEFORE committing anything at toName" from "failed AFTER the source is
    // physically+logically at toName," and the displaced shadow needs deterministic
    // handling in BOTH shapes.
    let deferredError: unknown;
    try {
      if (movingRec.kind === "dir") {
        requireDir(movingRec);
        await moveTree(movingRec, moving.id, toParent, tp.dir, toName);
      } else {
        requireFile(movingRec);
        await moveFileEntry(movingRec, moving.id, toParent, tp.dir, toName);
      }
      // movingRec.parentId/name are now rebound to toParent/toName (the move helper's
      // final act above).
    } catch (e) {
      // Truth-preserving check: a move helper's own parentId/name rebind is its final
      // act (moveFileEntry) — or is committed once every physical piece is relocated
      // (moveTree), independently of any later fallible step such as moveTree's
      // post-rebind old-dir cleanup. sourceCommitted distinguishes the two failure
      // shapes this op must handle differently.
      const sourceCommitted = movingRec.parentId === toParent && movingRec.name === toName;
      if (!sourceCommitted) {
        // PHASE A never landed (the far more common case): fromName still
        // truthfully holds the source (disk and memory agree) — this is a clean
        // abort. Resolve the displaced shadow (if any) back onto `toName` before
        // rethrowing.
        if (displaced && shadowName !== undefined) {
          const dispRec = node(displaced.id);
          if (dispRec.kind === "dir") {
            // Directory moves are non-atomic (BackendCaps.renameCost === "subtree"):
            // moveTree's FIRST fallible step (getDirectoryHandle(toName, {create:
            // true})) may already have created `toName`, and its child loop rebinds
            // each child NodeRec as it recurses — independently of the parent's OWN
            // rebind, which lands only once every child has moved. So "source not
            // committed" here does NOT mean `toName` is disk-only debris: some
            // descendant NodeRecs may already be truthfully rebound to live
            // physically under it. Recursive-deleting or shadow-rebinding on top of
            // a partial `toName` would destroy or shadow those already-relocated
            // children. Detect the partial case precisely rather than assume either
            // way: does `toName` exist on disk at all right now?
            let strayExists = true;
            try {
              await tp.dir.getDirectoryHandle(toName);
            } catch (probeErr) {
              if ((probeErr as { name?: string } | null)?.name === "NotFoundError") strayExists = false;
            }
            // Absent: safe to move the shadow straight back under its original name.
            // Present (a genuine partial left by THIS failed attempt): do not touch
            // it — recover the displaced entry under a fresh, discoverable name
            // instead, and leave the partial `toName` as documented
            // non-atomic-failure debris (accepted for v1: renameCost === "subtree").
            const restoreName = strayExists ? `${toName}.wash-recovered-${ulid()}` : toName;
            try {
              requireDir(dispRec);
              await moveTree(dispRec, displaced.id, toParent, tp.dir, restoreName);
              // dispRec.name is now restoreName (rebound by the move helper above).
              toChildren.set(restoreName, displaced);
              if (tp.sidecar![shadowName]) {
                tp.sidecar = renameSidecarEntry(tp.sidecar!, shadowName, restoreName);
                await writeSidecarFile(tp);
              }
            } catch {
              // Double failure: the data still survives on disk under the
              // discoverable shadow name. A move helper's rebind is unconditionally
              // its last act, so a thrown restore never reached it — read
              // dispRec.name fresh (rather than assuming shadowName) so in-memory
              // maps always match the rec's last successfully-committed rebind.
              toChildren.set(dispRec.name, displaced);
            }
          } else {
            // File (and symlink) moves are atomic: native FileSystemFileHandle.move()
            // either fully lands or doesn't, and the copy+delete fallback commits
            // rec.parentId/name as its unconditional last act (see moveFileEntry's
            // header comment) — so "source not committed" here really does mean
            // nothing of this failed attempt reached `toName`. Any stray entry there
            // is disk-only debris from that same attempt, safe to clear before
            // restoring the shadow on top of it.
            await tp.dir.removeEntry(toName).catch(() => {});
            try {
              requireFile(dispRec);
              await moveFileEntry(dispRec, displaced.id, toParent, tp.dir, toName);
              // dispRec.name is now toName (rebound by the move helper above).
              toChildren.set(toName, displaced);
              // The shadow's sidecar record travels back with it, overwriting
              // whatever the pre-move transport above wrote to `toName` (that
              // annotation described the entry that just failed to move in, not the
              // restored displaced entry).
              if (tp.sidecar![shadowName]) {
                tp.sidecar = renameSidecarEntry(tp.sidecar!, shadowName, toName);
                await writeSidecarFile(tp);
              }
            } catch {
              toChildren.set(dispRec.name, displaced);
            }
          }
        }
        throw e;
      }
      // PHASE A committed but a later step threw (moveTree's post-rebind-cleanup —
      // its best-effort old-dir removeEntry, the only fallible step after the
      // rebind). Defer the error and fall through to the shared post-commit path
      // below, so the displaced shadow is resolved on THIS path too (finding 2)
      // before rethrowing — this used to run only on the happy path, leaving a
      // post-commit-cleanup failure's displaced shadow stranded and invisible to
      // toChildren.
      deferredError = e;
    }

    // PHASE A committed — either cleanly, or via the deferred post-rebind-cleanup
    // failure above. This is the point of no return either way: commit the dentry
    // maps and parent mtimes now, before any further (best-effort) cleanup below, so
    // a later failure in that cleanup can never leave the maps stale. movingRec's
    // parentId/name were already rebound to toParent/toName by the move helper
    // above; only the dentry maps need updating here.
    fromChildren.delete(fromName);
    toChildren.set(toName, moving);
    fp.mtimeMs = Date.now();
    tp.mtimeMs = Date.now();

    // The source is confirmed at `toName` — the destination is truly replaced, so it
    // is finally safe to irreversibly discard the shadowed, displaced entry. Runs on
    // BOTH commit paths above (clean success and the deferred post-rebind-cleanup
    // failure alike) — see finding 2.
    if (displaced && shadowName !== undefined) {
      try {
        const dispRec = node(displaced.id);
        if (dispRec.kind === "dir") {
          requireDir(dispRec);
          await dispRec.dir.removeEntry(SIDECAR_NAME).catch(() => {});
        } else {
          discardPooled(displaced.id); // content is being destroyed — must not poison fsync
          // The source move succeeded, so the displaced entry's bytes really are being
          // intentionally destroyed now — if the closePooled teardown above queued any
          // entries into pendingFlushErrors, those entries describe bytes nobody will
          // ever read again and must not fail a later, unrelated fsync. Splice out only
          // the slice THIS op introduced (by index range, not by value) — an
          // already-queued entry from some earlier, unrelated failure sits BEFORE that
          // range, and the moved source's own close (during the primary move above, if
          // ITS flush also failed) sits AFTER it; both stay reported. On the restore
          // path (primary move failed, shadow moved back to `toName`) this block is
          // never reached, so that poison correctly stays live — the file survives the
          // failed rename, so a real flush failure against it still matters.
          if (displacedPoisonCount > 0) pendingFlushErrors.splice(displacedPoisonStart, displacedPoisonCount);
        }
        // Defense-in-depth: the shadow name is our own throwaway, never exposed to a
        // caller, so it can never legitimately be "already gone" except via a prior
        // partial failure in this very op — tolerate only that.
        try {
          await tp.dir.removeEntry(shadowName);
        } catch (e) {
          if ((e as { name?: string } | null)?.name !== "NotFoundError") errnoFromDom(e, shadowName);
        }
        nodes.delete(displaced.id);
        // The shadow name never existed before this rename and is gone now — drop its
        // (moved-aside) sidecar record so it doesn't linger as unreachable garbage.
        if (tp.sidecar![shadowName]) {
          tp.sidecar = setSidecarEntry(tp.sidecar!, shadowName, { mode: undefined, symlink: undefined });
          await writeSidecarFile(tp);
        }
      } catch (discardErr) {
        // A deferred post-rebind-cleanup failure (finding 2's path) is already
        // pending: that original error — not this best-effort discard's own failure —
        // is what the op reports. The dentry maps are already truth-preserving
        // regardless (committed above), so any residual shadow debris here is
        // discoverable garbage, same tolerance as other best-effort cleanups in this
        // file. On the pure happy path (no deferred error) this rethrows exactly as
        // before.
        if (deferredError === undefined) throw discardErr;
      }
    }

    // Source-side sidecar cleanup: drop the entry's OWN record from its old parent,
    // now that it lives at the destination (written above, before the primary move).
    // Best-effort and swallowed, same convention as unlink: a stale annotation left
    // behind under a name this entry no longer occupies is tolerated garbage —
    // ensureChildren only overlays sidecar metadata onto names that still exist on
    // disk — and the primary move plus the dentry commit above are already durable
    // regardless of whether this last cleanup step succeeds.
    if (entryMeta) {
      try {
        fp.sidecar = setSidecarEntry(fp.sidecar!, fromName, { mode: undefined, symlink: undefined });
        await writeSidecarFile(fp);
      } catch {
        // swallowed — see comment above.
      }
    }

    if (deferredError !== undefined) throw deferredError;
    return { value: undefined };
  },
};

async function attrsOf(id: NodeId, rec: NodeRec): Promise<Attrs> {
  let size = 0;
  let mtimeMs = rec.mtimeMs;
  if (rec.kind === "file" && rec.file) {
    const pooled = pool.peek(id);
    if (pooled) {
      // A pooled sync-access handle is authoritative over getFile(): unflushed
      // writes/truncates are invisible to getFile() until flush(), but getSize()
      // always reflects them.
      size = pooled.getSize();
    } else {
      const f = await rec.file.getFile();
      size = f.size;
      mtimeMs = rec.mtimeExplicit || rec.mtimeMs > f.lastModified ? rec.mtimeMs : f.lastModified;
    }
  } else if (rec.kind === "symlink") {
    size = rec.target?.length ?? 0;
  }
  return { kind: rec.kind, size, mode: rec.mode, mtimeMs, ctimeMs: rec.ctimeMs, nlink: 1 };
}

function ensure(op: string): OpFn {
  const fn = ops[op];
  if (fn) return fn;
  return async () => {
    throw new VfsError("ENOSYS", op);
  };
}

// Design note (not a TODO): ops run strictly sequentially through this chain, by
// design, and unbounded — no per-op timeout is imposed. A hung OPFS operation (e.g.
// a stuck file lock) blocks every queued op behind it. This is intentional: large
// I/O (big file reads/writes, deep directory walks) has no safe universal time bound,
// so an artificial timeout would either fire on legitimate slow operations or be set
// so high it's useless. Client-side failure hygiene (client.ts: onerror/onmessageerror
// handlers, close()'s failAllPending) is what protects callers if the worker itself
// crashes or emits a malformed message — it does not un-stick this queue, it only ensures
// callers aren't left hanging forever.
let chain: Promise<void> = Promise.resolve();

self.onmessage = (ev: MessageEvent<RpcRequest>) => {
  const req = ev.data;
  chain = chain
    .then(async () => {
      try {
        const result = await ensure(req.op)(...(req.args as never[]));
        const res: RpcResponse = { id: req.id, ok: true, value: result.value };
        (self as unknown as Worker).postMessage(res, { transfer: result.transfer ?? [] });
      } catch (e) {
        const res: RpcResponse = {
          id: req.id,
          ok: false,
          errno: e instanceof VfsError ? e.errno : undefined,
          path: e instanceof VfsError ? e.path : undefined,
          message: e instanceof Error ? e.message : String(e),
        };
        (self as unknown as Worker).postMessage(res);
      }
    })
    .catch(() => {});
};

export { nodes, node, attrsOf, ops, defaultMode };
