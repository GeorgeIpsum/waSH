import type { Attrs, BackendCaps, BackendDump, Dirent, NodeId, NodeInfo, NodeKind, WashBackend } from "../types.js";
import { VfsError } from "../errors.js";

const NEG = Symbol("negative");

function defaultMode(kind: NodeKind): number {
  return kind === "dir" ? 0o755 : kind === "symlink" ? 0o777 : 0o644;
}

/**
 * Synthesizes the Attrs a fresh node must have, without round-tripping to
 * `inner.getattr()`. The size/mode/nlink defaults mirror the invariants the
 * shared conformance suite locks in for every WashBackend (spec §4): a
 * freshly created file is mode 0o644, size 0, nlink 1 unless overridden by
 * the caller-supplied `attrs`. This keeps `create()` a single round trip to
 * `inner`, as required for the cache to stay authoritative in place.
 */
function mkAttrs(kind: NodeKind, overrides?: Partial<Attrs>): Attrs {
  const now = Date.now();
  return {
    kind,
    size: 0,
    mode: defaultMode(kind),
    mtimeMs: now,
    ctimeMs: now,
    nlink: 1,
    ...overrides,
  };
}

/** Cached identity of a directory entry — never carries attrs (see class doc). */
interface LookupEntry {
  id: NodeId;
  kind: NodeKind;
}

/**
 * `attrCache` is the single source of truth for a node's Attrs; it is the
 * only map that ever stores an Attrs object, and every entry in it is a
 * live object mutated in place by write/truncate/setattr/link/unlink so
 * that all names aliasing the same node (hardlinks) observe the same
 * state. `lookupCache` therefore stores only `{ id, kind }` — never attrs —
 * so two directory entries for the same node can never hold divergent copies.
 * Callers always get a defensive copy (via `getattr`/`lookup`), so mutating
 * a returned `Attrs` can never corrupt the cache.
 *
 * Mutations are write-back: they update the caches (and `dirtyData` for
 * content) synchronously, then *enqueue* the corresponding `inner` call
 * instead of awaiting it — see `enqueue`/`flush`/`drain` below. Because the
 * inner backend can therefore lag the cache, every mutation that inner would
 * normally validate synchronously (EEXIST, ENOENT, ENOTEMPTY, EISDIR,
 * ENOTDIR, EPERM) must be pre-validated here against the (possibly-drained)
 * cache *before* enqueueing, so callers still see those errors as rejections
 * of the mutating call itself rather than as a later, unobservable `flush()`
 * failure.
 */
export class CachedBackend implements WashBackend {
  readonly caps: BackendCaps;
  private lookupCache = new Map<string, LookupEntry | typeof NEG>();
  private attrCache = new Map<NodeId, Attrs>();
  private readdirCache = new Map<NodeId, Map<string, Dirent>>();

  // Full-content buffer for a file with unflushed writes/truncates. Keyed by
  // id. Whole-file buffering is a deliberate v1 simplification — the spec
  // targets small files; chunk-granular dirty tracking is a Plan 2
  // optimization for backends (e.g. IndexedDB) where it matters.
  private dirtyData = new Map<NodeId, Uint8Array>();

  // Bounded write-back (spec §B.6): `liveDirtyBytes` tracks the summed byteLength
  // of every live owned content payload — every content op currently queued or
  // in-flight owns an immutable buffer (§B.3/§B.4), and this is the sum of those
  // buffers' byteLengths. Charged in `enqueueContentOp` (op enqueued), uncharged
  // in `confirmContent` (op durably confirmed) — NOT touched by `dirtyData`
  // set/delete or by `dropVictim`, since the read-view cache and the owned
  // write-back payload are tracked independently.
  // `unhealthy` records whether the last durability barrier failed (cleared on the
  // next successful barrier); `admit()` only ever rejects while unhealthy.
  private liveDirtyBytes = 0;
  private unhealthy = false;
  private get maxDirtyBytes(): number {
    return this.opts.maxDirtyBytes ?? 64 * 1024 * 1024;
  }

  /** Synchronous reservation (spec §B.6): reject before mutating if write-back is unhealthy
   *  and admitting this new owned payload would exceed the bound. Each write/truncate adds a
   *  full owned buffer to the live set, so charge the full projected size (spec F11/F12). */
  private admit(bytes: number): void {
    if (this.unhealthy && this.liveDirtyBytes + bytes > this.maxDirtyBytes) {
      throw new VfsError("ENOSPC");
    }
  }

  /** content buffers applied to `inner` this flush cycle, awaiting durable-confirm. */
  private pendingContentConfirm: Array<{ id: NodeId; buf: Uint8Array }> = [];

  private queue: Array<() => Promise<void>> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;

  // Per-node mutation serialization: `write`/`truncate` both read-modify-write
  // the dirty buffer (materialize → mutate → dirtyData.set), so two concurrent
  // callers on the same node must not interleave their bodies or the second
  // `dirtyData.set` silently clobbers the first's bytes (lost update).
  private nodeLocks = new Map<NodeId, Promise<unknown>>();

  // Retain-owner (spec §A.2): CachedBackend keeps its own per-id retain-count
  // so `dropVictim` can keep an open fd's `attrCache`/`dirtyData` entries
  // alive across unlink/rename-displace even though the cache itself never
  // sees an fd. `inner.retain`/`inner.release` are forwarded through the
  // write-back queue (not called synchronously) so they stay ordered after
  // this id's already-queued `create`/writes.
  private retains = new Map<NodeId, number>();

  private withNodeLock<T>(id: NodeId, fn: () => Promise<T>): Promise<T> {
    const prev = this.nodeLocks.get(id) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    // `gate` is a fresh settled-tracking promise distinct from `run` — using
    // it (not `run`) as the map value and cleanup key means the identity
    // check below reliably matches only the most recent locker for `id`.
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

  // Namespace mutation mutex: `create`/`unlink`/`rename`/`symlink`/`link`
  // each validate against the cache then mutate it across multiple awaits
  // (lookup → readdir prime → primeEntry/enqueue). Without serialization two
  // concurrent same-name mutations can both pass validation before either
  // mutates the cache, corrupting namespace state and poisoning the flush
  // queue with an op the backend will reject. A single backend-wide mutex
  // (not per-name) is intentionally coarse: namespace ops are rare relative
  // to content ops, and the two lock families never nest, so no deadlock.
  private nsMutex: Promise<unknown> = Promise.resolve();

  private withNsLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.nsMutex.then(fn, fn);
    this.nsMutex = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Reserved names (spec §caps.reservedNames) are rejected synchronously, before any cache mutation or enqueue. */
  private checkReserved(name: string, ...more: string[]): void {
    const reserved = this.inner.caps.reservedNames;
    if (!reserved?.length) return;
    for (const n of [name, ...more]) {
      if (reserved.includes(n)) throw new VfsError("EPERM", n);
    }
  }

  /** Invoked (fire-and-forget) when an auto-triggered flush rejects. */
  onFlushError?: (err: unknown) => void;

  // Optional per WashBackend — only present on the instance when `inner` has them
  // (conditional assignment in the constructor below).
  symlink?: (parent: NodeId, name: string, id: NodeId, target: string) => Promise<void> = (
    parent,
    name,
    id,
    target,
  ): Promise<void> =>
    this.withNsLock(async () => {
      if (!this.inner.symlink) throw new Error("unsupported");
      this.checkReserved(name);
      if ((await this.lookup(parent, name)) !== null) throw new VfsError("EEXIST", name);
      await this.readdir(parent); // ensure parent dir cache is primed (drains if cold)
      this.primeEntry(parent, name, id, "symlink", mkAttrs("symlink", { size: target.length }));
      this.enqueue(() => this.inner.symlink!(parent, name, id, target));
    });

  readlink?: (id: NodeId) => Promise<string> = async (id): Promise<string> => {
    if (!this.inner.readlink) throw new Error("unsupported");
    await this.drain(); // cache-miss read: never read stale (CachedBackend never caches targets)
    return this.inner.readlink(id);
  };

  link?: (parent: NodeId, name: string, id: NodeId) => Promise<void> = (parent, name, id): Promise<void> =>
    this.withNsLock(async () => {
      if (!this.inner.link) throw new Error("unsupported");
      this.checkReserved(name);
      const attrs = await this.getattr(id); // ENOENT if unknown; ensures attrCache is populated
      if ((await this.lookup(parent, name)) !== null) throw new VfsError("EEXIST", name);
      if (attrs.kind === "dir") throw new VfsError("EPERM", name);
      // Never replace the attrCache entry: mutate it in place so every other
      // name aliasing this node (existing hardlinks) observes the same nlink
      // bump instead of going stale. getattr() above guarantees this is set.
      const cached = this.attrCache.get(id)!;
      cached.nlink += 1;
      this.lookupCache.set(this.key(parent, name), { id, kind: cached.kind });
      this.readdirCache.get(parent)?.set(name, { name, childId: id, kind: cached.kind });
      this.enqueue(() => this.inner.link!(parent, name, id));
    });

  constructor(
    protected inner: WashBackend,
    protected opts: { flushDelayMs?: number; maxDirtyBytes?: number } = {},
  ) {
    // Full passthrough — CachedBackend implements retain/release/dropVictim-gating
    // itself, so it advertises exactly whatever `inner.caps.fdRetention` says.
    this.caps = inner.caps;
    if (!inner.symlink) this.symlink = undefined as never;
    if (!inner.readlink) this.readlink = undefined as never;
    if (!inner.link) this.link = undefined as never;
  }

  private key(parent: NodeId, name: string): string {
    return parent + "\0" + name;
  }

  private primeEntry(parent: NodeId, name: string, id: NodeId, kind: NodeKind, attrs: Attrs): void {
    this.lookupCache.set(this.key(parent, name), { id, kind });
    this.attrCache.set(id, attrs);
    this.readdirCache.get(parent)?.set(name, { name, childId: id, kind });
  }

  /**
   * Removes a node from the caches after it loses a name (unlink, or being
   * displaced by rename). Directories can't have hardlinks, so their attr +
   * readdir entries are always dropped outright. Files/symlinks may still be
   * reachable via other names, so their cached attrs are only mutated
   * in-place (nlink decrement) and evicted once nlink drops to zero — mirrors
   * the GC semantics every WashBackend implements.
   *
   * `dirtyData` interplay: eviction only happens on the *last* name for a
   * node (nlink reaching zero from one), so `hit.nlink === 1` immediately
   * before the decrement and `hit.nlink <= 0` immediately after are, given
   * accurate nlink bookkeeping, the same event — there's no scenario where a
   * node is evicted while another hardlink still legitimately references it.
   * We still gate the `dirtyData` purge on `wasOnlyLink || caps.hardlinks
   * === false` (rather than purging unconditionally on eviction) as
   * defense-in-depth per the spec: it costs nothing, keeps the "only purge
   * when we're sure no other alias can still reach this content" invariant
   * explicit in the code, and protects a hypothetical future nlink-tracking
   * bug from silently discarding another alias's unflushed writes. On a
   * non-hardlink backend nlink is always 1 anyway, so that arm is
   * belt-and-suspenders over the same fact.
   */
  private dropVictim(id: NodeId, kind: NodeKind): void {
    if (kind === "dir") {
      this.attrCache.delete(id);
      this.readdirCache.delete(id);
      this.dirtyData.delete(id); // dirs never carry a dirty buffer; defensive no-op
      return;
    }
    const hit = this.attrCache.get(id);
    if (hit) {
      const wasOnlyLink = hit.nlink === 1;
      hit.nlink -= 1;
      if (hit.nlink <= 0) {
        if ((this.retains.get(id) ?? 0) > 0) return; // anonymous but retained — keep cache for open fds (§A.2)
        this.attrCache.delete(id);
        if (wasOnlyLink || this.caps.hardlinks === false) {
          this.dirtyData.delete(id);
        }
      }
    }
  }

  pendingOps(): number {
    return this.queue.length;
  }

  private enqueue(op: () => Promise<void>): void {
    this.queue.push(op);
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush().catch((e) => this.onFlushError?.(e));
      }, this.opts.flushDelayMs ?? 100);
      (this.timer as unknown as { unref?: () => void }).unref?.();
    }
  }

  /** Flush-if-anything-pending: the drain rule cache-miss reads apply before touching `inner`. */
  private async drain(): Promise<void> {
    if (this.queue.length > 0 || this.flushing) await this.flush();
  }

  async flush(opts?: { strict?: boolean }): Promise<void> {
    // Fully serialize concurrent callers: keep waiting (and re-checking)
    // until no flush cycle is in flight, then start our own. This is a loop
    // rather than a single `if` because a waiter can wake up to find another
    // cycle already started in the meantime — a single check would let two
    // callers both fall through and run concurrent drain loops against the
    // same queue, racing `queue.shift()` against each other.
    while (this.flushing) await this.flushing;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const run = (async () => {
      // Snapshot the call-time prefix (F4): the barrier applies to a FINITE batch, so
      // a strict fsync always reaches it — ops enqueued mid-cycle collect in the live
      // queue as a later batch (never chased by this flush → no writer can starve fsync).
      const batch = this.queue.splice(0);
      const applied: Array<() => Promise<void>> = [];
      while (batch.length > 0) {
        const op = batch[0]!;
        try {
          await op();
        } catch (e) {
          // Per-op APPLICATION failure (narrow contract): self-atomic; the failed op
          // and the un-run remainder go back to the FRONT of the live queue, ahead of
          // any mid-cycle ops. Give the backend a durability point for the applied
          // prefix; if THAT flush also rejects the backend rolled the prefix back, so
          // re-queue it too (ahead of the remainder).
          // Prepend via concat, NOT unshift(...batch): a spread passes one argument per
          // op, so a large batch overflows V8's argument-count/stack limit with a
          // RangeError — and since the queue was already spliced empty, that secondary
          // throw would DROP the batch (reintroducing the divergence). concat has no
          // such limit and preserves order: [failedOp, ...remainder, ...midCycle].
          this.queue = batch.concat(this.queue);
          try {
            await this.inner.flush(opts);
            this.confirmContent();
          } catch {
            this.queue = applied.concat(this.queue); // ahead of the remainder (see above)
            this.discardContentConfirm();
            this.unhealthy = true;
          }
          throw e;
        }
        applied.push(batch.shift()!);
      }
      try {
        await this.inner.flush(opts);   // durability BARRIER (finite batch)
        this.confirmContent();
        this.unhealthy = false;
      } catch (e) {
        // concat, not unshift(...applied): the spread would RangeError on a large batch
        // and drop it (the queue is already spliced empty) — see the per-op path above.
        this.queue = applied.concat(this.queue); // backend rolled the batch back → replay next cycle
        this.discardContentConfirm();
        this.unhealthy = true;
        throw e;
      }
    })();
    this.flushing = run;
    try {
      await run;
    } finally {
      this.flushing = null;
    }
  }

  async root(): Promise<NodeId> {
    return this.inner.root();
  }

  async lookup(parent: NodeId, name: string): Promise<NodeInfo | null> {
    const k = this.key(parent, name);
    const hit = this.lookupCache.get(k);
    if (hit === NEG) return null;
    if (hit) {
      const attrs = await this.getattr(hit.id);
      return { id: hit.id, attrs };
    }
    // A complete readdir map for `parent` is authoritative for absences: a
    // name missing from it is a definitive miss, cacheable without asking
    // `inner` (mount-time warming's whole point — see `warm()` — and a small
    // win for any directory that's already been fully readdir()'d).
    const dirMap = this.readdirCache.get(parent);
    if (dirMap && !dirMap.has(name)) {
      this.lookupCache.set(k, NEG);
      return null;
    }
    await this.drain(); // cache-miss read: never read stale
    const info = await this.inner.lookup(parent, name);
    this.lookupCache.set(k, info ? { id: info.id, kind: info.attrs.kind } : NEG);
    if (!info) return null;
    this.attrCache.set(info.id, { ...info.attrs });
    return { id: info.id, attrs: { ...info.attrs } };
  }

  async getattr(id: NodeId): Promise<Attrs> {
    const hit = this.attrCache.get(id);
    if (hit) return { ...hit };
    await this.drain(); // cache-miss read: never read stale
    const attrs = await this.inner.getattr(id);
    this.attrCache.set(id, { ...attrs });
    return { ...attrs };
  }

  async readdir(id: NodeId): Promise<Dirent[]> {
    const hit = this.readdirCache.get(id);
    if (hit) return [...hit.values()].map((d) => ({ ...d }));
    // A cached (non-dir) kind is authoritative: fail fast without asking
    // `inner`, so a warmed file/symlink id's readdir() never touches inner.
    const cachedKind = this.attrCache.get(id);
    if (cachedKind && cachedKind.kind !== "dir") throw new VfsError("ENOTDIR");
    await this.drain(); // cache-miss read: never read stale
    const list = await this.inner.readdir(id);
    this.readdirCache.set(id, new Map(list.map((d) => [d.name, d])));
    return list.map((d) => ({ ...d }));
  }

  /**
   * Bulk-prime all metadata caches from a backend dump (mount-time warming,
   * spec §5). After warming, every lookup/getattr/readdir — including
   * negative lookups in dumped directories — is served from memory.
   */
  warm(dump: BackendDump): void {
    if (this.queue.length > 0 || this.dirtyData.size > 0 || this.flushing !== null) {
      throw new VfsError("EINVAL", "warm() requires a clean cache");
    }
    for (const { id, attrs } of dump.inodes) {
      this.attrCache.set(id, { ...attrs });
      if (attrs.kind === "dir" && !this.readdirCache.has(id)) {
        this.readdirCache.set(id, new Map());
      }
    }
    for (const d of dump.dirents) {
      this.lookupCache.set(this.key(d.parentId, d.name), { id: d.childId, kind: d.kind });
      this.readdirCache.get(d.parentId)?.set(d.name, { name: d.name, childId: d.childId, kind: d.kind });
    }
  }

  async create(parent: NodeId, name: string, id: NodeId, kind: NodeKind, attrs?: Partial<Attrs>): Promise<void> {
    return this.withNsLock(async () => {
      this.checkReserved(name);
      if ((await this.lookup(parent, name)) !== null) throw new VfsError("EEXIST", name);
      // Prime the parent's readdir cache (drains + reads inner if cold) BEFORE
      // registering the new entry below — otherwise a subsequent readdir(parent)
      // on a still-cold cache would go to `inner`, which doesn't have this
      // entry yet (it's only enqueued, not flushed).
      await this.readdir(parent);
      // Snapshot the caller-supplied `attrs` now: both the cache prime below
      // and the enqueued closure must see the object as it was at call time,
      // not whatever the caller mutates it to before the op is flushed.
      const attrsSnapshot = attrs ? { ...attrs } : undefined;
      this.primeEntry(parent, name, id, kind, mkAttrs(kind, attrsSnapshot));
      if (kind === "dir") this.readdirCache.set(id, new Map());
      this.enqueue(() => this.inner.create(parent, name, id, kind, attrsSnapshot));
    });
  }

  async unlink(parent: NodeId, name: string): Promise<void> {
    return this.withNsLock(async () => {
      this.checkReserved(name);
      const victim = await this.lookup(parent, name);
      if (!victim) throw new VfsError("ENOENT", name);
      if (victim.attrs.kind === "dir") {
        const kids = await this.readdir(victim.id);
        if (kids.length > 0) throw new VfsError("ENOTEMPTY", name);
      }
      this.lookupCache.set(this.key(parent, name), NEG);
      this.readdirCache.get(parent)?.delete(name);
      this.dropVictim(victim.id, victim.attrs.kind);
      this.enqueue(() => this.inner.unlink(parent, name));
    });
  }

  async rename(fromParent: NodeId, fromName: string, toParent: NodeId, toName: string): Promise<void> {
    return this.withNsLock(async () => {
      this.checkReserved(fromName, toName);
      const moving = await this.lookup(fromParent, fromName);
      if (!moving) throw new VfsError("ENOENT", fromName);
      const displaced = await this.lookup(toParent, toName);
      if (displaced && displaced.id !== moving.id) {
        if (displaced.attrs.kind === "dir") {
          if (moving.attrs.kind !== "dir") throw new VfsError("EISDIR", toName);
          if ((await this.readdir(displaced.id)).length > 0) throw new VfsError("ENOTEMPTY", toName);
        } else if (moving.attrs.kind === "dir") {
          throw new VfsError("ENOTDIR", toName);
        }
      }
      if (displaced && moving.id === displaced.id) {
        this.enqueue(() => this.inner.rename(fromParent, fromName, toParent, toName)); // POSIX no-op
        return;
      }
      this.enqueue(() => this.inner.rename(fromParent, fromName, toParent, toName));
      this.lookupCache.set(this.key(fromParent, fromName), NEG);
      this.readdirCache.get(fromParent)?.delete(fromName);
      if (displaced) this.dropVictim(displaced.id, displaced.attrs.kind);
      // The moving node keeps its id and its attrCache entry untouched —
      // only the (parent, name) → id mapping moves, so there's no attrs to
      // go stale.
      this.lookupCache.set(this.key(toParent, toName), { id: moving.id, kind: moving.attrs.kind });
      this.readdirCache.get(toParent)?.set(toName, { name: toName, childId: moving.id, kind: moving.attrs.kind });
    });
  }

  async setattr(id: NodeId, attrs: Partial<Pick<Attrs, "mode" | "mtimeMs" | "ctimeMs">>): Promise<void> {
    await this.getattr(id); // ENOENT if unknown; ensures attrCache is populated
    // Snapshot now: the cache mutation and the enqueued closure must both see
    // `attrs` as it was at call time, not a later caller-side mutation.
    const snapshot = { ...attrs };
    Object.assign(this.attrCache.get(id)!, snapshot);
    this.enqueue(() => this.inner.setattr(id, snapshot));
  }

  /** Reads the current bytes for `id`, preferring an unflushed dirty buffer. */
  private async materialize(id: NodeId, attrs: Attrs): Promise<Uint8Array> {
    const buf = this.dirtyData.get(id);
    if (buf) return buf;
    if (attrs.size === 0) return new Uint8Array(0); // nothing to fetch — avoids reading a node inner may not have yet
    await this.drain(); // never read stale
    return this.inner.read(id, 0, attrs.size);
  }

  /** Enqueue a content-flush op that OWNS the immutable buffer `buf` (§B.3): replay
   *  writes exactly `buf`, never re-reading live `dirtyData` (which could apply a newer
   *  version under an fsync that barriered this one). `write`/`truncate` install a fresh
   *  Uint8Array each time, so each call is its own entry; `dirtyData[id]` stays the
   *  optimistic latest for reads. The owned buffer is a live write-back payload
   *  (`liveDirtyBytes`) until its batch is durably confirmed. */
  private enqueueContentOp(id: NodeId, buf: Uint8Array): void {
    this.liveDirtyBytes += buf.byteLength;
    this.enqueue(async () => {
      await this.inner.truncate(id, buf.byteLength);
      if (buf.byteLength > 0) await this.inner.write(id, 0, buf);
      this.pendingContentConfirm.push({ id, buf });
    });
  }

  /** After a successful barrier: each owned content buffer is durable — uncharge it and
   *  drop the read-view `dirtyData[id]` if it is still that buffer (a later write installed
   *  a newer buffer with its own entry — keep that one). */
  private confirmContent(): void {
    for (const { id, buf } of this.pendingContentConfirm) {
      this.liveDirtyBytes -= buf.byteLength;
      if (this.dirtyData.get(id) === buf) this.dirtyData.delete(id);
    }
    this.pendingContentConfirm = [];
  }

  /** After a FAILED barrier: buffers stay in dirtyData for the replay (the flush
   *  re-queue); just clear the confirm list — the next cycle rebuilds it. */
  private discardContentConfirm(): void {
    this.pendingContentConfirm = [];
  }

  async write(id: NodeId, offset: number, data: Uint8Array): Promise<void> {
    return this.withNodeLock(id, async () => {
      const attrs = await this.getattr(id);
      if (attrs.kind === "dir") throw new VfsError("EISDIR");
      if (data.byteLength === 0) return;
      const cur = await this.materialize(id, attrs);
      const end = Math.max(cur.byteLength, offset + data.byteLength);
      const next = new Uint8Array(end);
      next.set(cur, 0);
      next.set(data, offset);
      this.admit(next.byteLength);
      this.enqueueContentOp(id, next);
      this.dirtyData.set(id, next);
      const hit = this.attrCache.get(id);
      if (hit) {
        hit.size = end;
        hit.mtimeMs = Date.now();
      }
    });
  }

  async truncate(id: NodeId, size: number): Promise<void> {
    return this.withNodeLock(id, async () => {
      const attrs = await this.getattr(id);
      if (attrs.kind === "dir") throw new VfsError("EISDIR");
      const cur = await this.materialize(id, attrs);
      const next = new Uint8Array(size);
      next.set(cur.slice(0, Math.min(size, cur.byteLength)), 0);
      this.admit(next.byteLength);
      this.enqueueContentOp(id, next);
      this.dirtyData.set(id, next);
      const hit = this.attrCache.get(id);
      if (hit) {
        hit.size = size;
        hit.mtimeMs = Date.now();
      }
    });
  }

  async read(id: NodeId, offset: number, length: number): Promise<Uint8Array> {
    const dirty = this.dirtyData.get(id);
    if (dirty) {
      if (offset >= dirty.byteLength) return new Uint8Array(0);
      return dirty.slice(offset, Math.min(offset + length, dirty.byteLength));
    }
    await this.drain(); // cache-miss read: never read stale
    return this.inner.read(id, offset, length);
  }

  /** An fd reference was acquired on `id` (spec §A.2): bump our own retain-count so
   *  `dropVictim` keeps this id's `attrCache`/`dirtyData` alive across unlink/rename-
   *  displace, then forward to `inner` — ENQUEUED (not awaited now) so it lands ordered
   *  after this id's already-queued `create`/writes and never races ahead of them. */
  async retain(id: NodeId): Promise<void> {
    // Unlike the raw backends, we deliberately do NOT validate existence here: the
    // `attrCache` is not an authoritative existence oracle (a live id may be uncached),
    // so a cache-based check would risk a false ENOENT. Correctness rests on the caller
    // contract — `Vfs.open` only retains an id it just resolved or created — plus the FIFO
    // ordering above, which guarantees the enqueued `inner.retain` lands after this id's
    // `inner.create`, so it never ENOENTs at the backend.
    this.retains.set(id, (this.retains.get(id) ?? 0) + 1);
    this.enqueue(() => Promise.resolve(this.inner.retain?.(id)));
  }

  /** An fd reference on `id` was dropped: decrement our retain-count; at zero, if the
   *  cached node is anonymous (nlink <= 0 — already unlinked while retained), evict its
   *  `attrCache`/`dirtyData` now that no open fd needs them. `inner.release` is enqueued
   *  the same way `retain` is, to stay ordered with this id's queued ops. */
  async release(id: NodeId): Promise<void> {
    const n = (this.retains.get(id) ?? 0) - 1;
    if (n > 0) this.retains.set(id, n);
    else {
      this.retains.delete(id);
      const a = this.attrCache.get(id);
      if (a && a.nlink <= 0) {
        this.attrCache.delete(id);
        this.dirtyData.delete(id);
      }
    }
    this.enqueue(() => Promise.resolve(this.inner.release?.(id)));
  }
}
