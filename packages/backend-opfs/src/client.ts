import type {
  Attrs, BackendCaps, BackendDump, Dirent, NodeId, NodeInfo, NodeKind, WashBackend,
} from "@wash/vfs";
import { VfsError } from "@wash/vfs";
import type { RpcRequest, RpcResponse } from "./rpc.js";

export const SIDECAR_NAME = ".wash-attrs";

export interface OpfsBackendOptions {
  handlePoolSize?: number;
  /** Test-only: registers the `__injectFault` op in the worker. Never set this in production. */
  testHooks?: boolean;
}

export class OpfsBackend implements WashBackend {
  readonly caps: BackendCaps = {
    symlinks: "supported",
    hardlinks: false,
    atomicDirRename: false,
    renameCost: "subtree",
    reservedNames: [SIDECAR_NAME],
  };

  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private rootId: NodeId = "";
  private closed = false;

  private constructor(private readonly worker: Worker) {
    worker.onmessage = (ev: MessageEvent<RpcResponse>) => this.dispatch(ev.data);
    worker.onerror = (ev: ErrorEvent) => {
      this.failAllPending(new Error(`OPFS worker error: ${ev.message || "unknown"}`));
    };
    worker.onmessageerror = () => {
      this.failAllPending(new Error("OPFS worker message deserialization failed"));
    };
  }

  static async open(rootDirName: string, opts: OpfsBackendOptions = {}): Promise<OpfsBackend> {
    const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    const be = new OpfsBackend(worker);
    be.rootId = (await be.call("open", [rootDirName, opts.handlePoolSize ?? 64, opts.testHooks ?? false])) as NodeId;
    return be;
  }

  private failAllPending(err: Error): void {
    this.closed = true;
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  private dispatch(res: RpcResponse): void {
    const entry = this.pending.get(res.id);
    if (!entry) return;
    this.pending.delete(res.id);
    if (res.ok) entry.resolve(res.value);
    else entry.reject(res.errno ? new VfsError(res.errno, res.path) : new Error(res.message));
  }

  private call(op: string, args: unknown[], transfer: Transferable[] = []): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("OpfsBackend is closed"));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, op, args } satisfies RpcRequest, transfer);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.call("close", []);
    this.closed = true;
    this.worker.terminate();
    this.failAllPending(new Error("OpfsBackend closed"));
  }

  async root(): Promise<NodeId> {
    return this.rootId;
  }

  async getattr(id: NodeId): Promise<Attrs> {
    return (await this.call("getattr", [id])) as Attrs;
  }

  async lookup(parent: NodeId, name: string): Promise<NodeInfo | null> {
    return (await this.call("lookup", [parent, name])) as NodeInfo | null;
  }

  async readdir(id: NodeId): Promise<Dirent[]> {
    return (await this.call("readdir", [id])) as Dirent[];
  }

  async setattr(id: NodeId, attrs: Partial<Pick<Attrs, "mode" | "mtimeMs" | "ctimeMs">>): Promise<void> {
    await this.call("setattr", [id, attrs]);
  }

  async create(parent: NodeId, name: string, id: NodeId, kind: NodeKind, attrs?: Partial<Attrs>): Promise<void> {
    await this.call("create", [parent, name, id, kind, attrs]);
  }

  async unlink(parent: NodeId, name: string): Promise<void> {
    await this.call("unlink", [parent, name]);
  }

  async rename(fromParent: NodeId, fromName: string, toParent: NodeId, toName: string): Promise<void> {
    await this.call("rename", [fromParent, fromName, toParent, toName]);
  }

  async read(id: NodeId, offset: number, length: number): Promise<Uint8Array> {
    const buf = (await this.call("read", [id, offset, length])) as ArrayBuffer;
    return new Uint8Array(buf);
  }

  async write(id: NodeId, offset: number, data: Uint8Array): Promise<void> {
    const copy = data.slice(); // caller may reuse its buffer; transfer a private copy
    await this.call("write", [id, offset, copy.buffer], [copy.buffer]);
  }

  async truncate(id: NodeId, size: number): Promise<void> {
    await this.call("truncate", [id, size]);
  }

  async symlink(parent: NodeId, name: string, id: NodeId, target: string): Promise<void> {
    await this.call("symlink", [parent, name, id, target]);
  }

  async readlink(id: NodeId): Promise<string> {
    return (await this.call("readlink", [id])) as string;
  }

  async dump(): Promise<BackendDump> {
    return (await this.call("dump", [])) as BackendDump;
  }

  async flush(): Promise<void> {
    await this.call("flush", []);
  }
}
