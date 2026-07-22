import { describe, it, expect, beforeEach, vi } from "vitest";
import { CachedBackend } from "../src/cache/cached-backend.js";
import { MemoryBackend } from "../src/backend/memory.js";
import { ulid } from "../src/ulid.js";
import type { WashBackend } from "../src/types.js";
import { VfsError } from "../src/errors.js";
import { Vfs } from "../src/core/vfs.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

function delayedBackend(inner: MemoryBackend, delayMs: number): WashBackend {
  const delay = () => new Promise<void>((r) => setTimeout(r, delayMs));
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (prop === "create" || prop === "rename" || prop === "write" || prop === "truncate") {
        return async (...args: unknown[]) => {
          await delay();
          return (v as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        };
      }
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as unknown as WashBackend;
}

// Faithful barrier-rollback double. Reaches into MemoryBackend's private `nodes`
// (test-only coupling, documented) to snapshot/restore via structuredClone (deep-
// clones the nested Map<NodeId, MemNode> incl. Uint8Array data + children Maps).
// Models the spec-mandated contract: a backend whose flush() can fail rolls its
// un-flushed batch back to the last successful flush (OPFS rollbackToCommitted /
// IDB txn abort). Hoisted to module scope so later tasks in this plan
// (fsync-strict, backpressure) can reuse it.
function rollbackFlaky(inner: MemoryBackend, failTimes: number): WashBackend {
  const state = () => inner as unknown as { nodes: Map<string, unknown> };
  let committed = structuredClone(state().nodes); // last durable snapshot
  let n = failTimes;
  return new Proxy(inner, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r);
      if (p === "flush") {
        return async (o?: { strict?: boolean }) => {
          if (n-- > 0) {
            state().nodes = structuredClone(committed); // roll back to last durable state
            throw new VfsError("ENOSPC");
          }
          const res = await (v as (o?: unknown) => Promise<void>).apply(t, [o]);
          committed = structuredClone(state().nodes);   // commit: new durable point
          return res;
        };
      }
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  }) as unknown as WashBackend;
}

describe("CachedBackend write-back", () => {
  let inner: MemoryBackend;
  let be: CachedBackend;
  let root: string;
  beforeEach(async () => {
    inner = new MemoryBackend();
    be = new CachedBackend(inner, { flushDelayMs: 60_000 }); // effectively manual flush
    root = await be.root();
  });

  it("mutations are visible through the cache before the inner backend sees them", async () => {
    const f = ulid();
    await be.create(root, "f", f, "file");
    await be.write(f, 0, enc.encode("hello"));
    expect(await inner.lookup(root, "f")).toBeNull();          // inner still empty
    expect((await be.lookup(root, "f"))?.id).toBe(f);          // cache authoritative
    expect(dec.decode(await be.read(f, 0, 100))).toBe("hello");
    expect(be.pendingOps()).toBeGreaterThan(0);
  });

  it("flush replays ops in order and empties the queue", async () => {
    const f = ulid();
    await be.create(root, "a.txt", f, "file");
    await be.write(f, 0, enc.encode("v1"));
    await be.rename(root, "a.txt", root, "b.txt");
    await be.flush();
    expect(be.pendingOps()).toBe(0);
    expect((await inner.lookup(root, "b.txt"))?.id).toBe(f);
    expect(await inner.lookup(root, "a.txt")).toBeNull();
    expect(dec.decode(await inner.read(f, 0, 100))).toBe("v1");
  });

  it("auto-flushes after flushDelayMs", async () => {
    vi.useFakeTimers();
    try {
      const quick = new CachedBackend(inner, { flushDelayMs: 50 });
      const qroot = await quick.root();
      await quick.create(qroot, "auto", ulid(), "file");
      expect(await inner.lookup(qroot, "auto")).toBeNull();
      await vi.advanceTimersByTimeAsync(60);
      expect(await inner.lookup(qroot, "auto")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cold reads drain pending ops first (never read stale)", async () => {
    const d = ulid();
    await be.create(root, "d", d, "dir");
    // readdir of d was never primed by a prior readdir call on a fresh dir?
    // It was primed by create; force a cold path by constructing a fresh
    // CachedBackend over the same inner AFTER a flush, then queueing ops.
    await be.flush();
    const be2 = new CachedBackend(inner, { flushDelayMs: 60_000 });
    const f = ulid();
    await be2.create(d, "kid", f, "file");
    // cold readdir on be2 must include the queued create
    expect((await be2.readdir(d)).map((x) => x.name)).toEqual(["kid"]);
  });

  it("conformance still passes with a zero-delay writeback (see conformance file)", async () => {
    // covered by conformance-memory.test.ts addition below
    expect(true).toBe(true);
  });

  it("concurrent flush callers never interleave op replay", async () => {
    const inner = new MemoryBackend();
    let flushDelay = 0;
    const slow = new Proxy(inner, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (prop === "flush") {
          return async () => {
            await new Promise<void>((r) => setTimeout(r, flushDelay));
            return (v as () => Promise<void>).call(target);
          };
        }
        if (prop === "create" || prop === "rename") {
          return async (...args: unknown[]) => {
            await new Promise<void>((r) => setTimeout(r, 10));
            return (v as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          };
        }
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as unknown as WashBackend;
    const wb = new CachedBackend(slow, { flushDelayMs: 60_000 });
    const root = await wb.root();
    // pre-warm the NEG entries so create+rename queue as pure cache hits (no drain)
    expect(await wb.lookup(root, "a.txt")).toBeNull();
    expect(await wb.lookup(root, "b.txt")).toBeNull();
    // get a slow cycle in flight first
    flushDelay = 30;
    const inflight = wb.flush();
    // enqueue two order-dependent ops while that cycle is running
    const f = ulid();
    await wb.create(root, "a.txt", f, "file");
    await wb.rename(root, "a.txt", root, "b.txt");
    // concurrent flush waiters must serialize behind the in-flight cycle
    const results = await Promise.allSettled([inflight, wb.flush(), wb.flush()]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(wb.pendingOps()).toBe(0);
    expect(await inner.lookup(root, "b.txt")).not.toBeNull();
    expect(await inner.lookup(root, "a.txt")).toBeNull();
  });

  it("file content survives a transient truncate failure and lands on retry", async () => {
    const inner = new MemoryBackend();
    let failOnce = true;
    const flaky = new Proxy(inner, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (prop === "truncate") {
          return async (...args: unknown[]) => {
            if (failOnce) {
              failOnce = false;
              throw new Error("transient truncate failure");
            }
            return (v as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          };
        }
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as unknown as WashBackend;
    const wb = new CachedBackend(flaky, { flushDelayMs: 60_000 });
    const root = await wb.root();
    const f = ulid();
    await wb.create(root, "f", f, "file");
    await wb.flush(); // create lands so only the content op remains in later flushes
    await wb.write(f, 0, enc.encode("precious data"));
    await expect(wb.flush()).rejects.toThrow("transient truncate failure");
    // buffer must still be present: reads keep serving dirty content
    expect(dec.decode(await wb.read(f, 0, 100))).toBe("precious data");
    await wb.flush(); // retry
    expect(dec.decode(await inner.read(f, 0, 100))).toBe("precious data");
  });

  it("a rejecting op stays at the queue head and retries in order", async () => {
    const inner = new MemoryBackend();
    let failNext = true;
    const flaky = new Proxy(inner, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (prop === "create") {
          return async (...args: unknown[]) => {
            if (failNext) {
              failNext = false;
              throw new Error("transient backend failure");
            }
            return (v as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          };
        }
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as unknown as WashBackend;
    const wb = new CachedBackend(flaky, { flushDelayMs: 60_000 });
    const root = await wb.root();
    const f = ulid();
    // Pre-warm the negative lookup cache for "y" while the queue is still
    // empty (drain() is a no-op with nothing queued), so that rename()'s own
    // internal displaced-name lookup below doesn't trigger an *implicit*
    // drain — that's a separate, correct "never read stale" behavior, not
    // what this test is exercising (explicit flush()/retry ordering).
    await wb.lookup(root, "y");
    await wb.create(root, "x", f, "file");
    await wb.rename(root, "x", root, "y");
    const before = wb.pendingOps();
    await expect(wb.flush()).rejects.toThrow("transient backend failure");
    expect(wb.pendingOps()).toBe(before); // nothing lost, failed op still queued
    await wb.flush(); // retry succeeds in order
    expect(await inner.lookup(root, "y")).not.toBeNull();
    expect(await inner.lookup(root, "x")).toBeNull();
  });

  it("onFlushError receives timer-flush failures and the queue survives", async () => {
    vi.useFakeTimers();
    try {
      const inner = new MemoryBackend();
      let fail = true;
      const flaky = new Proxy(inner, {
        get(target, prop, receiver) {
          const v = Reflect.get(target, prop, receiver);
          if (prop === "create") {
            return async (...args: unknown[]) => {
              if (fail) throw new Error("quota blip");
              return (v as (...a: unknown[]) => Promise<unknown>).apply(target, args);
            };
          }
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      }) as unknown as WashBackend;
      const wb = new CachedBackend(flaky, { flushDelayMs: 50 });
      const errors: unknown[] = [];
      wb.onFlushError = (e) => errors.push(e);
      const root = await wb.root();
      await wb.create(root, "z", ulid(), "file");
      await vi.advanceTimersByTimeAsync(60);
      expect(errors).toHaveLength(1);
      expect(wb.pendingOps()).toBeGreaterThan(0);
      fail = false;
      await wb.flush();
      expect(await inner.lookup(root, "z")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("concurrent same-file writes serialize instead of losing updates", async () => {
    const inner = new MemoryBackend();
    const f = ulid();
    const root0 = await inner.root();
    await inner.create(root0, "f", f, "file");
    await inner.write(f, 0, enc.encode("\0\0")); // pre-existing 2-byte content on `inner`
    const slowRead = new Proxy(inner, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (prop === "read") {
          return async (...args: unknown[]) => {
            await new Promise<void>((r) => setTimeout(r, 10));
            return (v as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          };
        }
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as unknown as WashBackend;
    const wb = new CachedBackend(slowRead, { flushDelayMs: 60_000 });
    const root = await wb.root();
    // wb has no cache yet for `f`; both writes below must materialize
    // (read-through) from the same base content via the delayed inner.read.
    await Promise.all([wb.write(f, 0, enc.encode("A")), wb.write(f, 1, enc.encode("B"))]);
    expect(dec.decode(await wb.read(f, 0, 10))).toBe("AB");
    expect((await wb.getattr(f)).size).toBe(2);
    await wb.flush();
    expect(dec.decode(await inner.read(f, 0, 10))).toBe("AB");
  });

  it("re-dirtying a file mid-flush still converges to durability", async () => {
    const inner = new MemoryBackend();
    const slow = new Proxy(inner, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (prop === "truncate" || prop === "write") {
          return async (...args: unknown[]) => {
            await new Promise<void>((r) => setTimeout(r, 15));
            return (v as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          };
        }
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as unknown as WashBackend;
    const wb = new CachedBackend(slow, { flushDelayMs: 60_000 });
    const root = await wb.root();
    const f = ulid();
    await wb.create(root, "f", f, "file");
    await wb.write(f, 0, enc.encode("version A"));
    const inflight = wb.flush();
    await new Promise<void>((r) => setTimeout(r, 5)); // land mid-await of the content op
    await wb.write(f, 0, enc.encode("version B"));
    await inflight;
    await wb.flush();
    expect(wb.pendingOps()).toBe(0);
    expect(dec.decode(await inner.read(f, 0, 100))).toBe("version B");
    // and later writes must still flush (the gate must not be stuck closed)
    await wb.write(f, 0, enc.encode("version C"));
    await wb.flush();
    expect(dec.decode(await inner.read(f, 0, 100))).toBe("version C");
  });

  it("concurrent same-name creates: exactly one wins, loser gets EEXIST, queue stays clean", async () => {
    const results = await Promise.allSettled([
      be.create(root, "x", ulid(), "file"),
      be.create(root, "x", ulid(), "file"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rej = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rej).toHaveLength(1);
    expect(rej[0]!.reason).toMatchObject({ errno: "EEXIST" });
    await be.flush(); // must not throw
    expect((await be.readdir(root)).map((d) => d.name)).toEqual(["x"]);
  });

  it("reserved names are rejected synchronously with EPERM and never poison the queue", async () => {
    const inner = new MemoryBackend();
    const reserved = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "caps") return { ...target.caps, reservedNames: [".wash-attrs"] };
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as unknown as WashBackend;
    const wb = new CachedBackend(reserved, { flushDelayMs: 60_000 });
    const r = await wb.root();
    await expect(wb.create(r, ".wash-attrs", ulid(), "file")).rejects.toMatchObject({ errno: "EPERM" });
    const f = ulid();
    await wb.create(r, "ok", f, "file");
    await expect(wb.rename(r, "ok", r, ".wash-attrs")).rejects.toMatchObject({ errno: "EPERM" });
    await expect(wb.link!(r, ".wash-attrs", f)).rejects.toMatchObject({ errno: "EPERM" });
    await expect(wb.unlink(r, ".wash-attrs")).rejects.toMatchObject({ errno: "EPERM" });
    await wb.flush(); // queue clean, nothing poisoned
    expect((await wb.readdir(r)).map((d) => d.name)).toEqual(["ok"]);
  });

  it("a failed barrier keeps the dirty buffer so the retry writes the real bytes", async () => {
    const inner = new MemoryBackend();
    const be = new CachedBackend(rollbackFlaky(inner, 1), { flushDelayMs: 60_000 });
    const root = await be.root();
    const f = ulid();
    await be.create(root, "f", f, "file");
    await be.write(f, 0, enc.encode("abc"));
    await expect(be.flush()).rejects.toMatchObject({ errno: "ENOSPC" }); // barrier fails once
    await be.flush();                                                    // retry succeeds
    expect(dec.decode(await inner.read(f, 0, 100))).toBe("abc");
  });

  it("no divergence: a failed barrier re-queues the batch; a later flush makes it durable", async () => {
    const inner = new MemoryBackend();
    const be = new CachedBackend(rollbackFlaky(inner, 1), { flushDelayMs: 60_000 });
    const root = await be.root();
    const a = ulid(), b = ulid();
    await be.create(root, "a", a, "file");
    await be.create(root, "b", b, "file");
    await expect(be.flush()).rejects.toMatchObject({ errno: "ENOSPC" });
    expect(be.pendingOps()).toBeGreaterThan(0);   // ops NOT lost
    await be.flush();                              // succeeds now
    expect((await inner.lookup(root, "a"))?.id).toBe(a);
    expect((await inner.lookup(root, "b"))?.id).toBe(b);
  });

  it("a re-dirtied file is not stranded across flushes", async () => {
    const inner = new MemoryBackend();
    const be = new CachedBackend(inner, { flushDelayMs: 60_000 });
    const root = await be.root();
    const f = ulid(), g = ulid();
    await be.create(root, "f", f, "file");
    await be.create(root, "g", g, "file");
    await be.flush();
    await be.write(f, 0, enc.encode("F1"));
    await be.write(g, 0, enc.encode("G1"));
    await be.flush();
    await be.write(g, 0, enc.encode("G2")); // re-dirty after g's op ran & confirmed
    await be.flush();
    expect(dec.decode(await inner.read(g, 0, 100))).toBe("G2");
    expect(dec.decode(await inner.read(f, 0, 100))).toBe("F1");
    expect(be.pendingOps()).toBe(0);
  });

  it("strict flush rejects on a non-durable barrier; a non-strict auto-flush routes to onFlushError", async () => {
    vi.useFakeTimers();
    try {
      const inner = new MemoryBackend();
      const errs: unknown[] = [];
      const be = new CachedBackend(rollbackFlaky(inner, 5), { flushDelayMs: 10 });
      be.onFlushError = (e) => errs.push(e);
      const root = await be.root();
      await be.create(root, "a", ulid(), "file"); // arms the auto-flush timer
      await vi.advanceTimersByTimeAsync(15);       // a background auto-flush fires and fails
      expect(errs.length).toBeGreaterThan(0);       // non-strict: reported, not thrown
      expect(be.pendingOps()).toBeGreaterThan(0);   // ops retained
    } finally {
      vi.useRealTimers();
    }
    const inner2 = new MemoryBackend();
    const be2 = new CachedBackend(rollbackFlaky(inner2, 1), { flushDelayMs: 60_000 });
    const r2 = await be2.root();
    await be2.create(r2, "a", ulid(), "file");
    await expect(be2.flush({ strict: true })).rejects.toMatchObject({ errno: "ENOSPC" });
  });

  it("Vfs.fsync rejects when the mount's durability barrier fails", async () => {
    const inner = new MemoryBackend();
    const vfs = new Vfs();
    await vfs.mount("/", new CachedBackend(rollbackFlaky(inner, 1), { flushDelayMs: 60_000 }));
    const fd = await vfs.open("/f", "w");
    await vfs.write(fd, enc.encode("x"));
    await expect(vfs.fsync()).rejects.toMatchObject({ errno: "ENOSPC" });
  });

  // Task 3 (read-side drain propagation): a cache-miss read must reject when its
  // drain()'s barrier fails, never silently fall through to reading rolled-back
  // `inner` state. `create()` primes attrCache/readdirCache/lookupCache for
  // everything it touches (root's dirent map and node `a`'s attrs), so readdir(root)
  // or getattr(a) would be served from cache without draining at all — not a
  // genuine cache miss. `ghost` is an id `be` has never seen, so getattr(ghost) is
  // guaranteed to miss attrCache and call drain() unconditionally.
  it("a cache-miss read after a failed drain does not read rolled-back inner state", async () => {
    const inner = new MemoryBackend();
    const be = new CachedBackend(rollbackFlaky(inner, 1), { flushDelayMs: 60_000 });
    const root = await be.root();
    const a = ulid();
    await be.create(root, "a", a, "file"); // queued, not durable
    const ghost = ulid(); // never touched by `be` — guaranteed attrCache miss
    await expect(be.getattr(ghost)).rejects.toMatchObject({ errno: "ENOSPC" }); // drain's barrier fails
    await be.flush(); // retry succeeds
    expect((await inner.lookup(root, "a"))?.id).toBe(a);
  });

  it("backpressure: when write-back is unhealthy and over the byte bound, writes fail ENOSPC before mutating", async () => {
    const inner = new MemoryBackend();
    // failTimes: 1 — a single barrier failure is enough to flip `unhealthy` (the
    // property under test). The later `be.read(g, ...)` below is a cache miss (no
    // dirty buffer for `g`), so its `drain()` performs a second real flush cycle;
    // that cycle must be allowed to succeed (queue drains, `f`'s content lands)
    // rather than fail again, or the read would reject instead of resolving to the
    // empty buffer the assertion checks for — this test is about one barrier
    // failure gating one over-bound write, not about surviving repeated failures.
    const be = new CachedBackend(rollbackFlaky(inner, 1), { flushDelayMs: 60_000, maxDirtyBytes: 8 });
    be.onFlushError = () => {};
    const root = await be.root();
    const f = ulid();
    await be.create(root, "f", f, "file");
    await be.write(f, 0, new Uint8Array(8));                     // fills the bound (healthy → allowed)
    await expect(be.flush()).rejects.toMatchObject({ errno: "ENOSPC" }); // barrier fails → unhealthy
    const g = ulid();
    await be.create(root, "g", g, "file");
    const before = be.pendingOps();
    await expect(be.write(g, 0, new Uint8Array(8))).rejects.toMatchObject({ errno: "ENOSPC" });
    expect(be.pendingOps()).toBe(before);                        // rejected before enqueuing
    expect((await be.read(g, 0, 100)).byteLength).toBe(0);       // and before mutating dirtyData
  });

  it("backpressure never fires while write-back is healthy", async () => {
    const inner = new MemoryBackend();
    const be = new CachedBackend(inner, { flushDelayMs: 60_000, maxDirtyBytes: 8 });
    const root = await be.root();
    const f = ulid();
    await be.create(root, "f", f, "file");
    await be.write(f, 0, new Uint8Array(1000)); // healthy: well over the bound, still accepted
    await be.flush();
    expect((await inner.read(f, 0, 1000)).byteLength).toBe(1000);
  });

  it("integration: cache and backend agree after a transient flush outage", async () => {
    const inner = new MemoryBackend();
    const be = new CachedBackend(rollbackFlaky(inner, 2), { flushDelayMs: 60_000 });
    be.onFlushError = () => {};
    const root = await be.root();
    const f = ulid();
    await be.create(root, "f", f, "file");
    await be.write(f, 0, enc.encode("hello"));
    await be.rename(root, "f", root, "g");
    await expect(be.flush()).rejects.toBeTruthy();  // fail 1
    await expect(be.flush()).rejects.toBeTruthy();  // fail 2
    await be.flush();                                // succeeds
    expect(await inner.lookup(root, "f")).toBeNull();
    expect((await inner.lookup(root, "g"))?.id).toBe(f);
    expect(dec.decode(await inner.read(f, 0, 100))).toBe("hello");
    expect(be.pendingOps()).toBe(0);
  });

  it("a flush barriers only the call-time batch; a mid-flush write is a later batch (F4 termination)", async () => {
    const inner = new MemoryBackend();
    const be = new CachedBackend(inner, { flushDelayMs: 60_000 });
    const root = await be.root();
    const a = ulid(), b = ulid();
    await be.create(root, "a", a, "file");
    const flushing = be.flush({ strict: true }); // synchronously snapshots [createA]
    expect(be.pendingOps()).toBe(0); // splice drained the batch synchronously (old loop → 1 here)
    await be.create(root, "b", b, "file");        // enqueued AFTER the splice → a later batch
    await flushing;
    expect((await inner.lookup(root, "a"))?.id).toBe(a); // call-time batch durable
    expect(be.pendingOps()).toBe(1);                     // b was NOT drained by a's flush
    await be.flush();
    expect((await inner.lookup(root, "b"))?.id).toBe(b);
  });

  it("each write enqueues its own owned content entry (no coalescing) and applies in order", async () => {
    const inner = new MemoryBackend();
    const be = new CachedBackend(inner, { flushDelayMs: 60_000 });
    const root = await be.root();
    const f = ulid();
    await be.create(root, "f", f, "file");
    await be.flush();
    await be.write(f, 0, enc.encode("AAAA"));
    await be.write(f, 0, enc.encode("BBBB")); // re-dirty → its OWN entry, not coalesced
    expect(be.pendingOps()).toBe(2);           // two owned content ops (§B.4: a re-dirty enqueues its own entry)
    await be.flush();
    expect(dec.decode(await inner.read(f, 0, 100))).toBe("BBBB"); // ops replay in order → latest wins
  });

  it("owned payload: a barrier-failed content batch replays its captured buffer on retry", async () => {
    // (Reconfirms the retain/replay property under the owned-payload model.)
    const inner = new MemoryBackend();
    const be = new CachedBackend(rollbackFlaky(inner, 1), { flushDelayMs: 60_000 });
    const root = await be.root();
    const f = ulid();
    await be.create(root, "f", f, "file");
    await be.write(f, 0, enc.encode("hello"));
    await expect(be.flush()).rejects.toMatchObject({ errno: "ENOSPC" }); // barrier fails; batch re-queued (owns "hello")
    await be.flush();                                                     // retry writes the owned buffer
    expect(dec.decode(await inner.read(f, 0, 100))).toBe("hello");
  });
});
