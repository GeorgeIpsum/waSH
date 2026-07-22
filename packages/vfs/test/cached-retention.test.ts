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

  it("inner retain is ordered into the write-back queue (never precedes create)", async () => {
    const be = new CachedBackend(new MemoryBackend(), { flushDelayMs: 60_000 });
    const root = await be.root();
    const f = ulid();
    await be.create(root, "f", f, "file"); // create still queued
    await be.retain(f);                     // must enqueue inner.retain AFTER create, not call inner now
    await be.flush();                       // create then retain apply in order (no ENOENT)
    expect(be.caps.fdRetention).toBe(true);
  });
});
