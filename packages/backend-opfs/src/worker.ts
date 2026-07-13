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
// The value is a skip count: a site armed with N lets the first N triggers
// through untouched (decrementing), then disarms and throws on trigger N+1 —
// this lets a test single out which of several call sites for the same named
// site (e.g. a shadow-rename's aside move vs. its primary move) actually fails.
let armed: Map<string, number> | null = null;

function maybeFault(site: string): void {
  if (armed === null) return;
  const remaining = armed.get(site);
  if (remaining === undefined) return;
  if (remaining > 0) {
    armed.set(site, remaining - 1);
    return;
  }
  armed.delete(site);
  throw new DOMException("injected quota failure", "QuotaExceededError");
}

function makePool(capacity: number): Lru<NodeId, FileSystemSyncAccessHandle> {
  return new Lru(capacity, (_id, h) => {
    try {
      try {
        h.flush();
      } finally {
        h.close(); // must run even when flush throws: a leaked handle holds the file's exclusive lock
      }
    } catch {
      // handle already closed, or close failed after a failed flush — nothing more we can do
    }
  });
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

export function errnoFromDom(e: unknown, path?: string): never {
  const name = (e as { name?: string } | null)?.name;
  if (name === "NotFoundError") throw new VfsError("ENOENT", path);
  if (name === "InvalidModificationError") throw new VfsError("ENOTEMPTY", path);
  if (name === "NoModificationAllowedError") throw new VfsError("EBUSY", path);
  if (name === "TypeMismatchError") throw new VfsError("ENOTDIR", path);
  if (name === "QuotaExceededError") throw new VfsError("ENOSPC", path);
  throw e;
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
      await rec.dir.removeEntry(SIDECAR_NAME).catch(() => {});
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

// Both move helpers below own the full rebind (handles + parentId + name) as their
// final act; callers manage only dentry maps. Each captures the pre-move identity
// (oldParent/oldName) FIRST, uses that captured identity for source-side cleanup, and
// only overwrites rec.parentId/rec.name as its LAST statements, once the physical
// move has committed. A NodeRec's name/parentId therefore always describe its last
// successfully-committed physical location — if the move throws before those final
// statements run, the rec still accurately names wherever the entry remains reachable
// from on disk, so re-invoking a move helper on the same rec after a failure is safe
// (e.g. the rename restore path below, which re-targets a rec whose primary move
// already failed).
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
  let newDir: FileSystemDirectoryHandle;
  try {
    newDir = await destDir.getDirectoryHandle(newName, { create: true });
  } catch (e) {
    errnoFromDom(e, newName);
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
  // transport the sidecar file itself
  await ensureSidecar(rec);
  const srcDirOld = rec.dir;
  rec.dir = newDir;
  if (!isEmptySidecar(rec.sidecar!)) await writeSidecarFile(rec);
  // By this point the subtree HAS already moved (non-atomic by design, per
  // BackendCaps.renameCost === "subtree"): a failure below is surfaced to the caller
  // rather than silently swallowed, so a phantom source directory/sidecar isn't left
  // behind to be silently re-discovered with fresh ids on a later reopen.
  // EXCEPTION: the old sidecar file may legitimately not exist (a directory with no
  // attr overrides never had one) — tolerate only that NotFoundError.
  try {
    await srcDirOld.removeEntry(SIDECAR_NAME);
  } catch (e) {
    if ((e as { name?: string } | null)?.name !== "NotFoundError") errnoFromDom(e, oldName);
  }
  // remove the emptied source directory — must use oldName/oldParent (captured above),
  // NOT rec.name/rec.parentId: those are only overwritten below, as the last statements
  // of this function, so a caller re-invoking this helper on a rec whose previous move
  // attempt failed (e.g. the rename restore path) still finds the entry's true current
  // on-disk name and location here.
  if (oldParent?.dir) {
    try {
      await oldParent.dir.removeEntry(oldName);
    } catch (e) {
      errnoFromDom(e, oldName);
    }
  }
  rec.parentId = destParentId;
  rec.name = newName;
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
      // many earlier triggers of `site` through before the one that fires.
      ops.__injectFault = async (site: string, skip = 0): Promise<OpResult> => {
        armed!.set(site, skip);
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

  async setattr(id: NodeId, attrs: Partial<Pick<Attrs, "mode" | "mtimeMs" | "ctimeMs">>): Promise<OpResult> {
    const rec = node(id);
    if (attrs.mtimeMs !== undefined) {
      rec.mtimeMs = attrs.mtimeMs;
      rec.mtimeExplicit = true;
    }
    if (attrs.ctimeMs !== undefined) rec.ctimeMs = attrs.ctimeMs;
    if (attrs.mode !== undefined) {
      rec.mode = attrs.mode & 0o777;
      if (rec.parentId !== null) {
        const parent = node(rec.parentId);
        requireDir(parent);
        await ensureSidecar(parent);
        parent.sidecar = setSidecarEntry(parent.sidecar!, rec.name, {
          mode: rec.mode === defaultMode(rec.kind) ? undefined : rec.mode,
        });
        await writeSidecarFile(parent);
      }
    }
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
    if (mode !== defaultMode(kind)) {
      const prevSidecar = rec.sidecar;
      try {
        await ensureSidecar(rec);
        rec.sidecar = setSidecarEntry(rec.sidecar!, name, { mode });
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
    if (child.kind === "dir") {
      requireDir(child);
      const grand = await ensureChildren(entry.id, child);
      if (grand.size > 0) throw new VfsError("ENOTEMPTY", name);
      await child.dir.removeEntry(SIDECAR_NAME).catch(() => {}); // sidecar-only dir is empty
    } else {
      closePooled(entry.id);
    }
    try {
      await rec.dir.removeEntry(name);
    } catch (e) {
      errnoFromDom(e, name);
    }
    children.delete(name);
    nodes.delete(entry.id);
    rec.mtimeMs = Date.now();
    try {
      // Best-effort: a stale sidecar entry for a deleted name is harmless garbage —
      // ensureChildren only overlays sidecar metadata onto names that still exist on
      // disk, so the orphaned entry is inert and gets dropped on the next successful
      // sidecar write for this directory. Swallowing here keeps the disk+memory commit
      // (above) authoritative even if this cleanup fails (e.g. quota).
      await ensureSidecar(rec);
      if (rec.sidecar![name]) {
        rec.sidecar = setSidecarEntry(rec.sidecar!, name, { mode: undefined, symlink: undefined });
        await writeSidecarFile(rec);
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
      rec.sidecar = setSidecarEntry(rec.sidecar!, name, { symlink: target });
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
    if (displaced) {
      const dispRec = node(displaced.id);
      if (dispRec.kind === "dir") {
        if (movingRec.kind !== "dir") throw new VfsError("EISDIR", toName);
        requireDir(dispRec);
        const grand = await ensureChildren(displaced.id, dispRec);
        if (grand.size > 0) throw new VfsError("ENOTEMPTY", toName);
      } else {
        if (movingRec.kind === "dir") throw new VfsError("ENOTDIR", toName);
        closePooled(displaced.id);
      }
      shadowName = `.wash-shadow-${ulid()}`;
      if (dispRec.kind === "dir") {
        requireDir(dispRec);
        await moveTree(dispRec, displaced.id, toParent, tp.dir, shadowName);
      } else {
        requireFile(dispRec);
        await moveFileEntry(dispRec, displaced.id, toParent, tp.dir, shadowName);
      }
      // dispRec.name is now shadowName (rebound by the move helper above) — the
      // dentry map must be updated in lockstep so it never lists a name the disk
      // doesn't have. Ops are sequential; nothing observes this mid-op.
      toChildren.delete(toName);

      // The displaced entry's OWN sidecar record (mode/symlink) still lives under
      // `toName` even though the entry itself just physically moved to `shadowName` —
      // MOVE it (not clear it) so it stays correctly attributed to wherever the entry
      // currently lives. If the primary move below fails, the restore path renames
      // this record back to `toName` alongside the physical restore; if it succeeds,
      // the discard phase drops the now-orphaned shadow record for good.
      await ensureSidecar(tp);
      if (tp.sidecar![toName]) {
        tp.sidecar = renameSidecarEntry(tp.sidecar!, toName, shadowName);
        await writeSidecarFile(tp);
      }
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
      // If the pre-move sidecar write above landed, tp.sidecar[toName] now holds an
      // annotation for a name the primary move never reached. On this failure path
      // that's either tolerated garbage (no displaced entry: `toName` never becomes a
      // real disk entry, and ensureChildren only overlays sidecar metadata onto names
      // that exist on disk) or it gets overwritten below when the displaced entry's
      // own record is renamed back from `shadowName` onto `toName`.
      if (displaced && shadowName !== undefined) {
        const dispRec = node(displaced.id);
        // Best-effort restore: move the shadow back to `toName` so the displaced
        // entry survives the failed rename under its original name. Because the move
        // helper reads its own oldName from dispRec at call time (not from a stale
        // caller-held copy), and dispRec.name is currently shadowName (rebound when it
        // was shadowed above), the helper's trailing source-cleanup correctly targets
        // shadowName here — not toName, which the primary move never reached.
        try {
          if (dispRec.kind === "dir") {
            requireDir(dispRec);
            await moveTree(dispRec, displaced.id, toParent, tp.dir, toName);
          } else {
            requireFile(dispRec);
            await moveFileEntry(dispRec, displaced.id, toParent, tp.dir, toName);
          }
          // dispRec.name is now toName (rebound by the move helper above).
          toChildren.set(toName, displaced);
          // The shadow's sidecar record travels back with it, overwriting whatever
          // the pre-move transport above wrote to `toName` (that annotation described
          // the entry that just failed to move in, not the restored displaced entry).
          if (tp.sidecar![shadowName]) {
            tp.sidecar = renameSidecarEntry(tp.sidecar!, shadowName, toName);
            await writeSidecarFile(tp);
          }
        } catch {
          // Double failure: the data still survives on disk under the discoverable
          // shadow name. A move helper's parentId/name rebind is unconditionally its
          // last two statements, so a thrown restore never reached them — dispRec.name
          // is still shadowName here. Read it fresh (rather than assuming shadowName)
          // so in-memory maps always match the rec's last successfully-committed
          // rebind, whatever that was.
          toChildren.set(dispRec.name, displaced);
        }
      }
      throw e;
    }

    // The primary move committed — this is the point of no return. Commit the dentry
    // maps and parent mtimes immediately, before any further (best-effort) cleanup
    // below, so a later failure in that cleanup can never leave the maps stale.
    // movingRec.parentId/name were already rebound to toParent/toName by the move
    // helper above; only the dentry maps need updating here.
    fromChildren.delete(fromName);
    toChildren.set(toName, moving);
    fp.mtimeMs = Date.now();
    tp.mtimeMs = Date.now();

    // The source move succeeded — the destination is now confirmed replaced, so it is
    // finally safe to irreversibly discard the shadowed, displaced entry. This is
    // deliberately the LAST step of the displacement handling.
    if (displaced && shadowName !== undefined) {
      const dispRec = node(displaced.id);
      if (dispRec.kind === "dir") {
        requireDir(dispRec);
        await dispRec.dir.removeEntry(SIDECAR_NAME).catch(() => {});
      } else {
        closePooled(displaced.id);
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
