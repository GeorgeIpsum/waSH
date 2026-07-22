import { describe, it, expect } from "vitest";
import { CachedBackend } from "../src/cache/cached-backend.js";
import { MemoryBackend } from "../src/backend/memory.js";
import { ulid } from "../src/ulid.js";
const enc = new TextEncoder(); const dec = new TextDecoder();

describe("CachedBackend retain/release", () => {
  it("a retained inode survives unlink through the cache and reclaims on last release", async () => {
    const be = new CachedBackend(new MemoryBackend(), { flushDelayMs: 60_000 });
    const root = await be.root();
    const f = ulid();
    await be.create(root, "f", f, "file");
    await be.write(f, 0, enc.encode("cached"));
    await be.retain(f);
    await be.unlink(root, "f");                  // cache keeps the entry (retained)
    expect(dec.decode(await be.read(f, 0, 100))).toBe("cached"); // served from dirtyData
    await be.flush();                            // inner retain ordered before inner unlink → inner keeps it
    expect(dec.decode(await be.read(f, 0, 100))).toBe("cached");
    await be.release(f);
    await be.flush();
    await expect(be.getattr(f)).rejects.toMatchObject({ errno: "ENOENT" });
  });

  it("inner retain flushes ordered AFTER the queued create (a synchronous inner.retain would ENOENT)", async () => {
    const be = new CachedBackend(new MemoryBackend(), { flushDelayMs: 60_000 });
    const root = await be.root();
    const f = ulid();
    await be.create(root, "f", f, "file"); // create still queued (not yet in inner)
    await be.retain(f);                     // enqueued AFTER create; a synchronous inner.retain here would ENOENT (f not yet in inner)
    await be.flush();                       // create then retain apply in order (inner.retain now validates existence → no ENOENT)
    expect(be.caps.fdRetention).toBe(true);
  });

  it("a retained rename-displaced target survives through the cache and reclaims on release", async () => {
    const be = new CachedBackend(new MemoryBackend(), { flushDelayMs: 60_000 });
    const root = await be.root();
    const a = ulid(), b = ulid();
    await be.create(root, "a", a, "file");
    await be.create(root, "b", b, "file");
    await be.write(b, 0, enc.encode("bbb"));
    await be.retain(b);                         // fd on b
    await be.rename(root, "a", root, "b");      // b displaced (nlink→0), retained → cache keeps it
    expect(dec.decode(await be.read(b, 0, 100))).toBe("bbb"); // served from dirtyData
    await be.flush();                           // inner retain ordered before inner rename-displace → inner keeps it
    expect(dec.decode(await be.read(b, 0, 100))).toBe("bbb");
    await be.release(b);
    await be.flush();
    await expect(be.getattr(b)).rejects.toMatchObject({ errno: "ENOENT" });
  });
});
