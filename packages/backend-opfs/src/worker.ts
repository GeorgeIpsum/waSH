/// <reference lib="webworker" />
import type { Attrs, NodeId, NodeKind } from "@wash/vfs";
import { VfsError, ulid } from "@wash/vfs";
import type { RpcRequest, RpcResponse } from "./rpc.js";

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
  children?: Map<string, { id: NodeId; kind: NodeKind }>; // dirs (excludes the sidecar)
  childrenComplete?: boolean;
  sidecar?: Record<string, { mode?: number; symlink?: string }>; // dirs, lazy
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

type OpResult = { value: unknown; transfer?: Transferable[] };
type OpFn = (...args: never[]) => Promise<OpResult>;

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

  async flush(): Promise<OpResult> {
    return { value: undefined }; // pooled-handle flushing arrives in Task 5
  },

  async close(): Promise<OpResult> {
    return { value: undefined }; // pool teardown arrives in Task 5
  },
};

async function attrsOf(rec: NodeRec): Promise<Attrs> {
  let size = 0;
  let mtimeMs = rec.mtimeMs;
  if (rec.kind === "file" && rec.file) {
    const f = await rec.file.getFile();
    size = f.size;
    mtimeMs = rec.mtimeMs > f.lastModified ? rec.mtimeMs : f.lastModified;
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
