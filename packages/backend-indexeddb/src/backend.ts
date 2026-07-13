import type {
  Attrs, BackendCaps, BackendDump, Dirent, NodeId, NodeInfo, NodeKind, WashBackend,
} from "@wash/vfs";
import { CHUNK_SIZE, VfsError, ulid } from "@wash/vfs";
import { STORE_NAMES, SCHEMA_VERSION, openDb, req, reqTolerateConstraint, txDone } from "./idb.js";

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

/**
 * Per-attempt request wrapper handed to every op body by `withTx`. Op bodies
 * call `r(request)` instead of a shared instance method so the "did this
 * attempt issue any requests yet" count `withTx` uses for its stale-handle
 * retry gate is scoped exactly to the attempt in flight — concurrent ops
 * (e.g. a cache-miss read racing a flush batch) each get their own closure
 * over an independent counter, so one op's requests can never be miscounted
 * against another's attempt.
 */
type ReqFn = <T>(request: IDBRequest<T>, opts?: { tolerateConstraint?: boolean }) => Promise<T>;

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

  /**
   * Per-inode mutation serialization for `write`/`truncate` (Codex finding
   * C). The blessed stack (Vfs + CachedBackend) already serializes mutations
   * above this layer, but the raw backend is legal to use directly, and two
   * overlapping same-chunk writes can otherwise both read-modify-write the
   * same chunk with the last `put` silently winning. Same gate-pattern
   * promise-chain lock as CachedBackend.
   */
  private nodeLocks = new Map<NodeId, Promise<unknown>>();

  private withNodeLock<T>(id: NodeId, fn: () => Promise<T>): Promise<T> {
    const prev = this.nodeLocks.get(id) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const gate = run.then(
      () => undefined,
      () => undefined,
    );
    this.nodeLocks.set(id, gate);
    void gate.then(() => {
      if (this.nodeLocks.get(id) === gate) this.nodeLocks.delete(id);
    });
    return run;
  }

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
   * already auto-committed (batch boundary) and the op's very FIRST request
   * throws TransactionInactiveError/InvalidStateError, that attempt issued
   * zero IDB requests — nothing could have persisted — so it is trivially
   * safe to reset and retry once on a fresh txn. Multi-mutation ops are NOT
   * restartable in general: a failure that strikes mid-op (after some of the
   * op's requests already succeeded) must surface as an error, never be
   * partially re-executed, because a retry would re-run mutations like
   * unlink's nlink decrement or rename's dirent move a second time. The
   * whole batch's fate in that case is governed by the abort-poisoning path
   * (lastAbort / flush()), not by a body replay. This relaxes the
   * restartability requirement to: ops need no side effects before their
   * first request (trivially true), not full restartability.
   *
   * The "did this attempt issue a request yet" count is a closure-local
   * `issued` counter captured by the per-attempt `r` passed into `fn`, NOT
   * an instance field — this makes the gate exact even when ops overlap
   * (e.g. a cache-miss read's own `withTx` attempt interleaves with a
   * flush batch's), since each attempt owns its own counter regardless of
   * how requests from unrelated attempts interleave on the microtask queue.
   */
  private async withTx<T>(fn: (tx: IDBTransaction, r: ReqFn) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      if (this.lastAbort) throw this.lastAbort;
      const tx = this.currentTx();
      let issued = 0;
      const r: ReqFn = (request, opts) => {
        issued++;
        return opts?.tolerateConstraint ? reqTolerateConstraint(request) : req(request);
      };
      try {
        return await fn(tx, r);
      } catch (e) {
        const errName = (e as { name?: string } | null)?.name;
        const staleHandle =
          attempt === 0 &&
          issued === 0 &&
          (errName === "TransactionInactiveError" || errName === "InvalidStateError");
        if (staleHandle) {
          if (this.tx === tx) this.tx = null;
          // The old txn may be mid-abort: its abort event (which records
          // lastAbort) dispatches asynchronously. Settle the old generation
          // before retrying so the loop-top poison check can't be raced.
          const completion = this.txCompletion;
          if (completion) await completion.catch(() => {});
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
   * Residual gap (accepted, tracked): an abort that rolled back
   * already-dequeued ops leaves the cache ahead of inner permanently until
   * CachedBackend journaling lands (tracked pre-Plan-4) — those ops were
   * shifted off the write-back queue before the batch aborted, so they are
   * never replayed. With the settle-on-failure fix in
   * `CachedBackend.flush()` (it calls `inner.flush()` on a drain failure
   * too, not only after a clean drain), fsync itself recovers after
   * reporting the abort once: the poison clears here, so the *next*
   * fsync succeeds again instead of throwing forever. Full recovery of the
   * dequeued-prefix divergence still needs journal-until-flush-confirmed in
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

  private async getInode(tx: IDBTransaction, r: ReqFn, id: NodeId): Promise<InodeRecord> {
    const rec = (await r(tx.objectStore("inodes").get(id))) as InodeRecord | undefined;
    if (!rec) throw new VfsError("ENOENT");
    return rec;
  }

  private async requireDir(tx: IDBTransaction, r: ReqFn, id: NodeId): Promise<InodeRecord> {
    const rec = await this.getInode(tx, r, id);
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

  /**
   * Codex finding D: two overlapping ops racing to create the same
   * (parent, name) dirent can both pass the get-based pre-check, then both
   * `put`, with the second silently clobbering the first (orphaning its
   * inode). `add` makes IDB itself enforce key uniqueness as the atomic
   * backstop; the loser's `add` throws ConstraintError, which callers map to
   * EEXIST after undoing their own earlier writes within the same txn.
   */
  private isConstraintError(e: unknown): boolean {
    return (e as { name?: string } | null)?.name === "ConstraintError";
  }

  /** All dirent keys of one directory. IDB array-key ordering: [parent] sorts
   * before every [parent, <string>], and [parent, []] sorts after (arrays sort
   * after strings), so this range brackets exactly the directory's entries. */
  private direntRange(parent: NodeId): IDBKeyRange {
    return IDBKeyRange.bound([parent], [parent, []]);
  }

  async getattr(id: NodeId): Promise<Attrs> {
    return this.withTx(async (tx, r) => this.stripTarget(await this.getInode(tx, r, id)));
  }

  async setattr(id: NodeId, attrs: Partial<Pick<Attrs, "mode" | "mtimeMs" | "ctimeMs">>): Promise<void> {
    return this.withTx(async (tx, r) => {
      const rec = await this.getInode(tx, r, id);
      Object.assign(rec, attrs);
      await r(tx.objectStore("inodes").put(rec, id));
    });
  }

  async lookup(parent: NodeId, name: string): Promise<NodeInfo | null> {
    return this.withTx(async (tx, r) => {
      await this.requireDir(tx, r, parent);
      const d = (await r(tx.objectStore("dirents").get(this.direntKey(parent, name)))) as DirentRecord | undefined;
      if (!d) return null;
      return { id: d.childId, attrs: this.stripTarget(await this.getInode(tx, r, d.childId)) };
    });
  }

  async readdir(id: NodeId): Promise<Dirent[]> {
    return this.withTx(async (tx, r) => {
      await this.requireDir(tx, r, id);
      const vals = (await r(tx.objectStore("dirents").getAll(this.direntRange(id)))) as DirentRecord[];
      return vals.map((v) => ({ name: v.name, childId: v.childId, kind: v.kind }));
    });
  }

  async readdirPlus(id: NodeId): Promise<(Dirent & { attrs: Attrs })[]> {
    return this.withTx(async (tx, r) => {
      await this.requireDir(tx, r, id);
      const vals = (await r(tx.objectStore("dirents").getAll(this.direntRange(id)))) as DirentRecord[];
      const out: (Dirent & { attrs: Attrs })[] = [];
      for (const v of vals) {
        out.push({ name: v.name, childId: v.childId, kind: v.kind, attrs: this.stripTarget(await this.getInode(tx, r, v.childId)) });
      }
      return out;
    });
  }

  /**
   * Bulk namespace export for mount-time cache warming (spec §5): two
   * `getAll` + two `getAllKeys` reads, all issued synchronously (pipelined
   * in one shared txn) before any of them is awaited — `Promise.all` (not
   * sequential awaits) so that if the txn aborts after issuance, every
   * pre-issued request is observed here rather than a later one becoming an
   * unhandled rejection.
   */
  async dump(): Promise<BackendDump> {
    return this.withTx(async (tx, r) => {
      const inodeStore = tx.objectStore("inodes");
      const direntStore = tx.objectStore("dirents");
      const [inodeKeys, inodeVals, direntKeys, direntVals] = await Promise.all([
        r(inodeStore.getAllKeys()) as Promise<NodeId[]>,
        r(inodeStore.getAll()) as Promise<InodeRecord[]>,
        r(direntStore.getAllKeys()) as Promise<[NodeId, string][]>,
        r(direntStore.getAll()) as Promise<DirentRecord[]>,
      ]);
      return {
        inodes: inodeKeys.map((id, i) => ({ id, attrs: this.stripTarget(inodeVals[i]!) })),
        dirents: direntKeys.map((k, i) => ({
          parentId: k[0], name: k[1], childId: direntVals[i]!.childId, kind: direntVals[i]!.kind,
        })),
      };
    });
  }

  async create(parent: NodeId, name: string, id: NodeId, kind: NodeKind, attrs?: Partial<Attrs>): Promise<void> {
    return this.withTx(async (tx, r) => {
      await this.requireDir(tx, r, parent);
      const existing = await r(tx.objectStore("dirents").get(this.direntKey(parent, name)));
      if (existing) throw new VfsError("EEXIST", name);
      const now = Date.now();
      // Spread caller-supplied `attrs` (e.g. an explicit mode) BEFORE the
      // invariants that must always win: `kind` is the parameter, not
      // whatever the caller's attrs object happens to carry, and every
      // fresh node starts at nlink 1 regardless of caller input.
      const rec: InodeRecord = {
        size: 0, mode: this.defaultMode(kind), mtimeMs: now, ctimeMs: now, ...attrs, kind, nlink: 1,
      };
      await r(tx.objectStore("inodes").put(rec, id));
      const dirent: DirentRecord = { name, childId: id, kind };
      try {
        await r(tx.objectStore("dirents").add(dirent, this.direntKey(parent, name)), { tolerateConstraint: true });
      } catch (e) {
        if (!this.isConstraintError(e)) throw e;
        await r(tx.objectStore("inodes").delete(id));
        throw new VfsError("EEXIST", name);
      }
    });
  }

  private chunkRange(id: NodeId, first = 0, last: number = Infinity): IDBKeyRange {
    return IDBKeyRange.bound([id, first], [id, last]);
  }

  private async requireFile(tx: IDBTransaction, r: ReqFn, id: NodeId): Promise<InodeRecord> {
    const rec = await this.getInode(tx, r, id);
    if (rec.kind === "dir") throw new VfsError("EISDIR");
    return rec;
  }

  async read(id: NodeId, offset: number, length: number): Promise<Uint8Array> {
    return this.withTx(async (tx, r) => {
      const rec = await this.requireFile(tx, r, id);
      if (offset >= rec.size || length === 0) return new Uint8Array(0);
      const end = Math.min(offset + length, rec.size);
      const out = new Uint8Array(end - offset); // zero-initialized: sparse chunks stay zeros
      const first = Math.floor(offset / this.chunkSize);
      const last = Math.floor((end - 1) / this.chunkSize);
      const store = tx.objectStore("data");
      const range = this.chunkRange(id, first, last);
      const keysReq = store.getAllKeys(range);
      const valsReq = store.getAll(range);
      const keys = (await r(keysReq)) as [NodeId, number][];
      const vals = (await r(valsReq)) as Uint8Array[];
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
    return this.withNodeLock(id, () => this.withTx(async (tx, r) => {
      const rec = await this.requireFile(tx, r, id);
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
          const existing = (await r(store.get([id, idx]))) as Uint8Array | undefined;
          const size = Math.max(existing?.byteLength ?? 0, to - chunkStart);
          chunk = new Uint8Array(size);
          if (existing) chunk.set(existing, 0);
          chunk.set(slice, from - chunkStart);
        }
        await r(store.put(chunk, [id, idx]));
      }
      if (end > rec.size) rec.size = end;
      rec.mtimeMs = Date.now();
      await r(tx.objectStore("inodes").put(rec, id));
    }));
  }

  async truncate(id: NodeId, size: number): Promise<void> {
    return this.withNodeLock(id, () => this.withTx(async (tx, r) => {
      const rec = await this.requireFile(tx, r, id);
      const store = tx.objectStore("data");
      if (size < rec.size) {
        const lastKeep = size === 0 ? -1 : Math.floor((size - 1) / this.chunkSize);
        await r(store.delete(this.chunkRange(id, lastKeep + 1)));
        if (lastKeep >= 0) {
          const boundary = (await r(store.get([id, lastKeep]))) as Uint8Array | undefined;
          const keep = size - lastKeep * this.chunkSize;
          if (boundary && boundary.byteLength > keep) {
            await r(store.put(boundary.slice(0, keep), [id, lastKeep]));
          }
        }
      }
      rec.size = size; // extend is sparse: missing chunks read as zeros
      rec.mtimeMs = Date.now();
      await r(tx.objectStore("inodes").put(rec, id));
    }));
  }

  private async dirHasChildren(tx: IDBTransaction, r: ReqFn, id: NodeId): Promise<boolean> {
    const keys = await r(tx.objectStore("dirents").getAllKeys(this.direntRange(id), 1));
    return keys.length > 0;
  }

  private async gcInode(tx: IDBTransaction, r: ReqFn, id: NodeId, rec: InodeRecord): Promise<void> {
    rec.nlink -= 1;
    if (rec.nlink <= 0) {
      await r(tx.objectStore("inodes").delete(id));
      await r(tx.objectStore("data").delete(this.chunkRange(id)));
    } else {
      await r(tx.objectStore("inodes").put(rec, id));
    }
  }

  async unlink(parent: NodeId, name: string): Promise<void> {
    return this.withTx(async (tx, r) => {
      await this.requireDir(tx, r, parent);
      const d = (await r(tx.objectStore("dirents").get(this.direntKey(parent, name)))) as DirentRecord | undefined;
      if (!d) throw new VfsError("ENOENT", name);
      const child = await this.getInode(tx, r, d.childId);
      if (child.kind === "dir") {
        if (await this.dirHasChildren(tx, r, d.childId)) throw new VfsError("ENOTEMPTY", name);
        await r(tx.objectStore("inodes").delete(d.childId));
      } else {
        await this.gcInode(tx, r, d.childId, child);
      }
      await r(tx.objectStore("dirents").delete(this.direntKey(parent, name)));
    });
  }

  async rename(fromParent: NodeId, fromName: string, toParent: NodeId, toName: string): Promise<void> {
    return this.withTx(async (tx, r) => {
      await this.requireDir(tx, r, fromParent);
      await this.requireDir(tx, r, toParent);
      const dirents = tx.objectStore("dirents");
      const moving = (await r(dirents.get(this.direntKey(fromParent, fromName)))) as DirentRecord | undefined;
      if (!moving) throw new VfsError("ENOENT", fromName);
      const displaced = (await r(dirents.get(this.direntKey(toParent, toName)))) as DirentRecord | undefined;
      if (displaced) {
        if (displaced.childId === moving.childId) return; // POSIX same-inode no-op
        const exNode = await this.getInode(tx, r, displaced.childId);
        const mvNode = await this.getInode(tx, r, moving.childId);
        if (exNode.kind === "dir") {
          if (mvNode.kind !== "dir") throw new VfsError("EISDIR", toName);
          if (await this.dirHasChildren(tx, r, displaced.childId)) throw new VfsError("ENOTEMPTY", toName);
          await r(tx.objectStore("inodes").delete(displaced.childId));
        } else {
          if (mvNode.kind === "dir") throw new VfsError("ENOTDIR", toName);
          await this.gcInode(tx, r, displaced.childId, exNode);
        }
      }
      await r(dirents.delete(this.direntKey(fromParent, fromName)));
      const next: DirentRecord = { ...moving, name: toName };
      await r(dirents.put(next, this.direntKey(toParent, toName)));
    });
  }

  async symlink(parent: NodeId, name: string, id: NodeId, target: string): Promise<void> {
    return this.withTx(async (tx, r) => {
      await this.requireDir(tx, r, parent);
      const existing = await r(tx.objectStore("dirents").get(this.direntKey(parent, name)));
      if (existing) throw new VfsError("EEXIST", name);
      const now = Date.now();
      const rec: InodeRecord = {
        kind: "symlink", size: target.length, mode: 0o777, mtimeMs: now, ctimeMs: now, nlink: 1, target,
      };
      await r(tx.objectStore("inodes").put(rec, id));
      const dirent: DirentRecord = { name, childId: id, kind: "symlink" };
      try {
        await r(tx.objectStore("dirents").add(dirent, this.direntKey(parent, name)), { tolerateConstraint: true });
      } catch (e) {
        if (!this.isConstraintError(e)) throw e;
        await r(tx.objectStore("inodes").delete(id));
        throw new VfsError("EEXIST", name);
      }
    });
  }

  async readlink(id: NodeId): Promise<string> {
    return this.withTx(async (tx, r) => {
      const rec = await this.getInode(tx, r, id);
      if (rec.kind !== "symlink" || rec.target === undefined) throw new VfsError("EINVAL");
      return rec.target;
    });
  }

  async link(parent: NodeId, name: string, id: NodeId): Promise<void> {
    return this.withTx(async (tx, r) => {
      await this.requireDir(tx, r, parent);
      const existing = await r(tx.objectStore("dirents").get(this.direntKey(parent, name)));
      if (existing) throw new VfsError("EEXIST", name); // EEXIST before EPERM (contract precedence)
      const rec = await this.getInode(tx, r, id);
      if (rec.kind === "dir") throw new VfsError("EPERM", name);
      rec.nlink += 1;
      await r(tx.objectStore("inodes").put(rec, id));
      const dirent: DirentRecord = { name, childId: id, kind: rec.kind };
      try {
        await r(tx.objectStore("dirents").add(dirent, this.direntKey(parent, name)), { tolerateConstraint: true });
      } catch (e) {
        if (!this.isConstraintError(e)) throw e;
        rec.nlink -= 1;
        await r(tx.objectStore("inodes").put(rec, id));
        throw new VfsError("EEXIST", name);
      }
    });
  }
}
