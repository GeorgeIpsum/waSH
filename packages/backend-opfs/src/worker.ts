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
}

function registerChild(
  parentId: NodeId,
  name: string,
  kind: NodeKind,
  handles: { dir?: FileSystemDirectoryHandle; file?: FileSystemFileHandle },
  opts: { id?: NodeId; mode?: number; target?: string } = {},
): NodeId {
  const id = opts.id ?? ulid();
  const now = Date.now();
  nodes.set(id, {
    kind, parentId, name,
    dir: handles.dir, file: handles.file,
    target: opts.target,
    mode: opts.mode ?? defaultMode(kind),
    mtimeMs: now, ctimeMs: now,
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
      registerChild(id, name, "file", { file: handle as FileSystemFileHandle }, { mode: meta?.mode });
    }
  }
  rec.childrenComplete = true;
  return rec.children;
}

type OpResult = { value: unknown; transfer?: Transferable[] };
type OpFn = (...args: never[]) => Promise<OpResult>;

function closePooled(_id: NodeId): void {
  // sync-handle pool arrives in Task 5
}

const ops: Record<string, OpFn> = {
  async open(rootDirName: string, poolSizeOpt: number): Promise<OpResult> {
    poolSize = poolSizeOpt;
    const origin = await navigator.storage.getDirectory();
    const dir = await origin.getDirectoryHandle(rootDirName, { create: true });
    rootId = ulid();
    const now = Date.now();
    nodes.set(rootId, {
      kind: "dir", parentId: null, name: "", dir,
      mode: 0o755, mtimeMs: now, ctimeMs: now,
    });
    return { value: rootId };
  },

  async getattr(id: NodeId): Promise<OpResult> {
    const rec = node(id);
    const attrs = await attrsOf(rec);
    return { value: attrs };
  },

  async lookup(parent: NodeId, name: string): Promise<OpResult> {
    const rec = node(parent);
    requireDir(rec);
    if (name === SIDECAR_NAME) return { value: null };
    const children = await ensureChildren(parent, rec);
    const entry = children.get(name);
    if (!entry) return { value: null };
    const info: NodeInfo = { id: entry.id, attrs: await attrsOf(node(entry.id)) };
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

  async flush(): Promise<OpResult> {
    return { value: undefined }; // pooled-handle flushing arrives in Task 5
  },

  async close(): Promise<OpResult> {
    return { value: undefined }; // pool teardown arrives in Task 5
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
};

async function attrsOf(rec: NodeRec): Promise<Attrs> {
  let size = 0;
  let mtimeMs = rec.mtimeMs;
  if (rec.kind === "file" && rec.file) {
    const f = await rec.file.getFile();
    size = f.size;
    mtimeMs = rec.mtimeExplicit || rec.mtimeMs > f.lastModified ? rec.mtimeMs : f.lastModified;
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
