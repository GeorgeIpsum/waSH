import type { Attrs, BackendCaps, Dirent, NodeId, NodeInfo, NodeKind, WashBackend } from "../types.js";
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

  private queue: Array<() => Promise<void>> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;

  /** Invoked (fire-and-forget) when an auto-triggered flush rejects. */
  onFlushError?: (err: unknown) => void;

  // Optional per WashBackend — only present on the instance when `inner` has them
  // (conditional assignment in the constructor below).
  symlink?: (parent: NodeId, name: string, id: NodeId, target: string) => Promise<void> = async (
    parent,
    name,
    id,
    target,
  ): Promise<void> => {
    if (!this.inner.symlink) throw new Error("unsupported");
    if ((await this.lookup(parent, name)) !== null) throw new VfsError("EEXIST", name);
    await this.readdir(parent); // ensure parent dir cache is primed (drains if cold)
    this.primeEntry(parent, name, id, "symlink", mkAttrs("symlink", { size: target.length }));
    this.enqueue(() => this.inner.symlink!(parent, name, id, target));
  };

  readlink?: (id: NodeId) => Promise<string> = async (id): Promise<string> => {
    if (!this.inner.readlink) throw new Error("unsupported");
    await this.drain(); // cache-miss read: never read stale (CachedBackend never caches targets)
    return this.inner.readlink(id);
  };

  link?: (parent: NodeId, name: string, id: NodeId) => Promise<void> = async (parent, name, id): Promise<void> => {
    if (!this.inner.link) throw new Error("unsupported");
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
  };

  constructor(protected inner: WashBackend, protected opts: { flushDelayMs?: number } = {}) {
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

  async flush(): Promise<void> {
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
      while (this.queue.length > 0) {
        const op = this.queue[0]!;
        await op(); // rejection leaves the op at the head for retry — see dropVictim/enqueue docs
        this.queue.shift();
      }
      await this.inner.flush();
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
    await this.drain(); // cache-miss read: never read stale
    const list = await this.inner.readdir(id);
    this.readdirCache.set(id, new Map(list.map((d) => [d.name, d])));
    return list.map((d) => ({ ...d }));
  }

  async create(parent: NodeId, name: string, id: NodeId, kind: NodeKind, attrs?: Partial<Attrs>): Promise<void> {
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
  }

  async unlink(parent: NodeId, name: string): Promise<void> {
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
  }

  async rename(fromParent: NodeId, fromName: string, toParent: NodeId, toName: string): Promise<void> {
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

  /** Queues the single write-back op for `id`'s content, once per dirty session. */
  private queueContentFlush(id: NodeId): void {
    if (this.dirtyData.has(id)) return; // already queued; the op re-reads dirtyData lazily at flush time
    this.enqueue(async () => {
      const buf = this.dirtyData.get(id);
      if (!buf) return; // evicted (unlinked) or already flushed before this op ran
      // Only delete the buffer after the inner ops succeed. A rejection here
      // must leave dirtyData intact — the queue's failed-op-at-head retry
      // policy re-runs this same closure, and reads must keep serving the
      // dirty buffer (not stale inner content) until that retry lands. The
      // identity check guards against a concurrent re-dirty (write/truncate
      // always installs a fresh Uint8Array) clobbering the newer buffer.
      await this.inner.truncate(id, buf.byteLength);
      if (buf.byteLength > 0) await this.inner.write(id, 0, buf);
      if (this.dirtyData.get(id) === buf) this.dirtyData.delete(id);
    });
  }

  async write(id: NodeId, offset: number, data: Uint8Array): Promise<void> {
    const attrs = await this.getattr(id);
    if (attrs.kind === "dir") throw new VfsError("EISDIR");
    const cur = await this.materialize(id, attrs);
    const end = Math.max(cur.byteLength, offset + data.byteLength);
    const next = new Uint8Array(end);
    next.set(cur, 0);
    next.set(data, offset);
    this.queueContentFlush(id);
    this.dirtyData.set(id, next);
    const hit = this.attrCache.get(id);
    if (hit) {
      hit.size = end;
      hit.mtimeMs = Date.now();
    }
  }

  async truncate(id: NodeId, size: number): Promise<void> {
    const attrs = await this.getattr(id);
    if (attrs.kind === "dir") throw new VfsError("EISDIR");
    const cur = await this.materialize(id, attrs);
    const next = new Uint8Array(size);
    next.set(cur.slice(0, Math.min(size, cur.byteLength)), 0);
    this.queueContentFlush(id);
    this.dirtyData.set(id, next);
    const hit = this.attrCache.get(id);
    if (hit) {
      hit.size = size;
      hit.mtimeMs = Date.now();
    }
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
}
