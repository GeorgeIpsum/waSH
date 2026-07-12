import type {
  Attrs, BackendCaps, Dirent, NodeId, NodeInfo, NodeKind, WashBackend,
} from "@wash/vfs";
import { CHUNK_SIZE, VfsError, ulid } from "@wash/vfs";
import { STORE_NAMES, SCHEMA_VERSION, openDb, req, txDone } from "./idb.js";

interface DirentRecord {
  name: string;
  childId: NodeId;
  kind: NodeKind;
}

interface InodeRecord extends Attrs {
  target?: string; // symlink target
}

export interface IndexedDBBackendOptions {
  durability?: "relaxed" | "strict";
  factory?: IDBFactory;
  chunkSize?: number;
}

export class IndexedDBBackend implements WashBackend {
  readonly caps: BackendCaps = {
    symlinks: "supported",
    hardlinks: true,
    atomicDirRename: true,
    renameCost: "O1",
  };

  private tx: IDBTransaction | null = null;
  private txCompletion: Promise<void> | null = null;

  private constructor(
    private readonly db: IDBDatabase,
    private readonly rootId: NodeId,
    private readonly durability: "relaxed" | "strict",
    readonly chunkSize: number,
  ) {}

  static async open(dbName: string, opts: IndexedDBBackendOptions = {}): Promise<IndexedDBBackend> {
    const db = await openDb(dbName, opts.factory ?? indexedDB);
    const tx = db.transaction(["inodes", "meta"], "readwrite");
    const meta = tx.objectStore("meta");
    let rootId = (await req(meta.get("rootId"))) as NodeId | undefined;
    if (!rootId) {
      rootId = ulid();
      const now = Date.now();
      const rootAttrs: InodeRecord = { kind: "dir", size: 0, mode: 0o755, mtimeMs: now, ctimeMs: now, nlink: 1 };
      tx.objectStore("inodes").put(rootAttrs, rootId);
      meta.put(rootId, "rootId");
      meta.put(SCHEMA_VERSION, "schemaVersion");
    }
    await txDone(tx);
    return new IndexedDBBackend(db, rootId, opts.durability ?? "relaxed", opts.chunkSize ?? CHUNK_SIZE);
  }

  close(): void {
    this.tx = null;
    this.db.close();
  }

  async root(): Promise<NodeId> {
    return this.rootId;
  }

  /**
   * Lazy shared readwrite transaction (spec §5: one txn per flush batch).
   * IndexedDB auto-commits a transaction only when control returns to the
   * event loop with no pending requests; CachedBackend's flush loop chains
   * ops through microtasks only, so one txn spans the whole batch.
   */
  private currentTx(): IDBTransaction {
    if (this.tx) return this.tx;
    let tx: IDBTransaction;
    try {
      tx = this.db.transaction(
        STORE_NAMES as unknown as string[],
        "readwrite",
        { durability: this.durability } as IDBTransactionOptions,
      );
    } catch {
      tx = this.db.transaction(STORE_NAMES as unknown as string[], "readwrite");
    }
    this.tx = tx;
    const completion = txDone(tx).finally(() => {
      if (this.tx === tx) this.tx = null;
      if (this.txCompletion === completion) this.txCompletion = null;
    });
    completion.catch(() => {}); // observed via flush(); avoid unhandled rejection
    this.txCompletion = completion;
    return tx;
  }

  /**
   * Run one contract op against the shared transaction. If the cached txn
   * already auto-committed (batch boundary), the op's first request throws
   * TransactionInactiveError/InvalidStateError — reset and retry the WHOLE
   * op once on a fresh txn. Ops must be restartable and must never await
   * anything but IDB requests (see plan Global Constraints).
   */
  private async withTx<T>(fn: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const tx = this.currentTx();
      try {
        return await fn(tx);
      } catch (e) {
        const errName = (e as { name?: string } | null)?.name;
        if (attempt === 0 && (errName === "TransactionInactiveError" || errName === "InvalidStateError")) {
          if (this.tx === tx) this.tx = null;
          continue;
        }
        throw e;
      }
    }
  }

  async flush(): Promise<void> {
    const completion = this.txCompletion;
    this.tx = null; // stop reusing; the pending txn auto-commits
    if (completion) await completion;
  }

  private async getInode(tx: IDBTransaction, id: NodeId): Promise<InodeRecord> {
    const rec = (await req(tx.objectStore("inodes").get(id))) as InodeRecord | undefined;
    if (!rec) throw new VfsError("ENOENT");
    return rec;
  }

  private async requireDir(tx: IDBTransaction, id: NodeId): Promise<InodeRecord> {
    const rec = await this.getInode(tx, id);
    if (rec.kind !== "dir") throw new VfsError("ENOTDIR");
    return rec;
  }

  private defaultMode(kind: NodeKind): number {
    return kind === "dir" ? 0o755 : kind === "symlink" ? 0o777 : 0o644;
  }

  private stripTarget(rec: InodeRecord): Attrs {
    const { target: _target, ...attrs } = rec;
    return attrs;
  }

  async getattr(id: NodeId): Promise<Attrs> {
    return this.withTx(async (tx) => this.stripTarget(await this.getInode(tx, id)));
  }

  async setattr(id: NodeId, attrs: Partial<Pick<Attrs, "mode" | "mtimeMs" | "ctimeMs">>): Promise<void> {
    return this.withTx(async (tx) => {
      const rec = await this.getInode(tx, id);
      Object.assign(rec, attrs);
      await req(tx.objectStore("inodes").put(rec, id));
    });
  }

  // Remaining contract ops land in Tasks 3–5.
  async lookup(): Promise<NodeInfo | null> { throw new VfsError("ENOSYS"); }
  async readdir(): Promise<Dirent[]> { throw new VfsError("ENOSYS"); }
  async read(): Promise<Uint8Array> { throw new VfsError("ENOSYS"); }
  async write(): Promise<void> { throw new VfsError("ENOSYS"); }
  async truncate(): Promise<void> { throw new VfsError("ENOSYS"); }
  async create(): Promise<void> { throw new VfsError("ENOSYS"); }
  async unlink(): Promise<void> { throw new VfsError("ENOSYS"); }
  async rename(): Promise<void> { throw new VfsError("ENOSYS"); }
}
