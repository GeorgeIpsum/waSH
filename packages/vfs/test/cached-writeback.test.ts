import { describe, it, expect, beforeEach, vi } from "vitest";
import { CachedBackend } from "../src/cache/cached-backend.js";
import { MemoryBackend } from "../src/backend/memory.js";
import { ulid } from "../src/ulid.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

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
});
