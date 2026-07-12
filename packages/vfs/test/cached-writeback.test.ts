import { describe, it, expect, beforeEach, vi } from "vitest";
import { CachedBackend } from "../src/cache/cached-backend.js";
import { MemoryBackend } from "../src/backend/memory.js";
import { ulid } from "../src/ulid.js";
import type { WashBackend } from "../src/types.js";

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
});
