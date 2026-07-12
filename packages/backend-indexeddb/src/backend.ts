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
  private lastAbort: unknown = null;

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
    const completion = txDone(tx)
      .catch((e) => {
        this.lastAbort = e;
        throw e;
      })
      .finally(() => {
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
    if (this.lastAbort) throw this.lastAbort;
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

  /**
   * Durability point. If the shared batch transaction aborted, flush()
   * rejects with the abort reason (spec §10: flush failures fail the next
   * fsync) and clears the poison so the caller can retry.
   *
   * Residual gap (accepted, tracked): ops that already resolved into an
   * aborted batch were dequeued by the write-back layer and are not
   * replayed — the cache stays ahead of inner until those paths are
   * rewritten again. Full recovery needs journal-until-flush-confirmed in
   * CachedBackend, tracked alongside the fsync-strict contract work
   * (pre-Plan-4).
   */
  async flush(): Promise<void> {
    const completion = this.txCompletion;
    this.tx = null; // stop reusing; the pending txn auto-commits
    try {
      if (completion) await completion;
    } catch (e) {
      this.lastAbort = null;
      throw e;
    }
    if (this.lastAbort) {
      const e = this.lastAbort;
      this.lastAbort = null;
      throw e;
    }
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

  private direntKey(parent: NodeId, name: string): [NodeId, string] {
    return [parent, name];
  }

  /** All dirent keys of one directory. IDB array-key ordering: [parent] sorts
   * before every [parent, <string>], and [parent, []] sorts after (arrays sort
   * after strings), so this range brackets exactly the directory's entries. */
  private direntRange(parent: NodeId): IDBKeyRange {
    return IDBKeyRange.bound([parent], [parent, []]);
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

  async lookup(parent: NodeId, name: string): Promise<NodeInfo | null> {
    return this.withTx(async (tx) => {
      await this.requireDir(tx, parent);
      const d = (await req(tx.objectStore("dirents").get(this.direntKey(parent, name)))) as DirentRecord | undefined;
      if (!d) return null;
      return { id: d.childId, attrs: this.stripTarget(await this.getInode(tx, d.childId)) };
    });
  }

  async readdir(id: NodeId): Promise<Dirent[]> {
    return this.withTx(async (tx) => {
      await this.requireDir(tx, id);
      const vals = (await req(tx.objectStore("dirents").getAll(this.direntRange(id)))) as DirentRecord[];
      return vals.map((v) => ({ name: v.name, childId: v.childId, kind: v.kind }));
    });
  }

  async readdirPlus(id: NodeId): Promise<(Dirent & { attrs: Attrs })[]> {
    return this.withTx(async (tx) => {
      await this.requireDir(tx, id);
      const vals = (await req(tx.objectStore("dirents").getAll(this.direntRange(id)))) as DirentRecord[];
      const out: (Dirent & { attrs: Attrs })[] = [];
      for (const v of vals) {
        out.push({ name: v.name, childId: v.childId, kind: v.kind, attrs: this.stripTarget(await this.getInode(tx, v.childId)) });
      }
      return out;
    });
  }

  async create(parent: NodeId, name: string, id: NodeId, kind: NodeKind, attrs?: Partial<Attrs>): Promise<void> {
    return this.withTx(async (tx) => {
      await this.requireDir(tx, parent);
      const existing = await req(tx.objectStore("dirents").get(this.direntKey(parent, name)));
      if (existing) throw new VfsError("EEXIST", name);
      const now = Date.now();
      const rec: InodeRecord = {
        kind, size: 0, mode: this.defaultMode(kind), mtimeMs: now, ctimeMs: now, nlink: 1, ...attrs,
      };
      await req(tx.objectStore("inodes").put(rec, id));
      const dirent: DirentRecord = { name, childId: id, kind };
      await req(tx.objectStore("dirents").put(dirent, this.direntKey(parent, name)));
    });
  }

  private chunkRange(id: NodeId, first = 0, last: number = Infinity): IDBKeyRange {
    return IDBKeyRange.bound([id, first], [id, last]);
  }

  private async requireFile(tx: IDBTransaction, id: NodeId): Promise<InodeRecord> {
    const rec = await this.getInode(tx, id);
    if (rec.kind === "dir") throw new VfsError("EISDIR");
    return rec;
  }

  async read(id: NodeId, offset: number, length: number): Promise<Uint8Array> {
    return this.withTx(async (tx) => {
      const rec = await this.requireFile(tx, id);
      if (offset >= rec.size || length === 0) return new Uint8Array(0);
      const end = Math.min(offset + length, rec.size);
      const out = new Uint8Array(end - offset); // zero-initialized: sparse chunks stay zeros
      const first = Math.floor(offset / this.chunkSize);
      const last = Math.floor((end - 1) / this.chunkSize);
      const store = tx.objectStore("data");
      const range = this.chunkRange(id, first, last);
      const keysReq = store.getAllKeys(range);
      const valsReq = store.getAll(range);
      const keys = (await req(keysReq)) as [NodeId, number][];
      const vals = (await req(valsReq)) as Uint8Array[];
      for (let i = 0; i < keys.length; i++) {
        const idx = keys[i]![1];
        const chunk = vals[i]!;
        const chunkStart = idx * this.chunkSize;
        const from = Math.max(offset, chunkStart);
        const to = Math.min(end, chunkStart + chunk.byteLength);
        if (to > from) out.set(chunk.subarray(from - chunkStart, to - chunkStart), from - offset);
      }
      return out;
    });
  }

  async write(id: NodeId, offset: number, data: Uint8Array): Promise<void> {
    return this.withTx(async (tx) => {
      const rec = await this.requireFile(tx, id);
      if (data.byteLength === 0) return;
      const store = tx.objectStore("data");
      const end = offset + data.byteLength;
      const first = Math.floor(offset / this.chunkSize);
      const last = Math.floor((end - 1) / this.chunkSize);
      for (let idx = first; idx <= last; idx++) {
        const chunkStart = idx * this.chunkSize;
        const from = Math.max(offset, chunkStart);
        const to = Math.min(end, chunkStart + this.chunkSize);
        const slice = data.subarray(from - offset, to - offset);
        let chunk: Uint8Array;
        if (slice.byteLength === this.chunkSize) {
          chunk = slice.slice(); // full-chunk overwrite: skip the read
        } else {
          const existing = (await req(store.get([id, idx]))) as Uint8Array | undefined;
          const size = Math.max(existing?.byteLength ?? 0, to - chunkStart);
          chunk = new Uint8Array(size);
          if (existing) chunk.set(existing, 0);
          chunk.set(slice, from - chunkStart);
        }
        await req(store.put(chunk, [id, idx]));
      }
      if (end > rec.size) rec.size = end;
      rec.mtimeMs = Date.now();
      await req(tx.objectStore("inodes").put(rec, id));
    });
  }

  async truncate(id: NodeId, size: number): Promise<void> {
    return this.withTx(async (tx) => {
      const rec = await this.requireFile(tx, id);
      const store = tx.objectStore("data");
      if (size < rec.size) {
        const lastKeep = size === 0 ? -1 : Math.floor((size - 1) / this.chunkSize);
        await req(store.delete(this.chunkRange(id, lastKeep + 1)));
        if (lastKeep >= 0) {
          const boundary = (await req(store.get([id, lastKeep]))) as Uint8Array | undefined;
          const keep = size - lastKeep * this.chunkSize;
          if (boundary && boundary.byteLength > keep) {
            await req(store.put(boundary.slice(0, keep), [id, lastKeep]));
          }
        }
      }
      rec.size = size; // extend is sparse: missing chunks read as zeros
      rec.mtimeMs = Date.now();
      await req(tx.objectStore("inodes").put(rec, id));
    });
  }

  // Remaining contract ops land in Tasks 4–5.
  async unlink(): Promise<void> { throw new VfsError("ENOSYS"); }
  async rename(): Promise<void> { throw new VfsError("ENOSYS"); }
}
