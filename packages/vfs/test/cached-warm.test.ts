import { describe, it, expect, vi } from "vitest";
import { CachedBackend } from "../src/cache/cached-backend.js";
import { MemoryBackend } from "../src/backend/memory.js";
import { ulid } from "../src/ulid.js";
import type { BackendDump } from "../src/types.js";

describe("CachedBackend.warm", () => {
  it("primes all caches so metadata reads never touch inner", async () => {
    const inner = new MemoryBackend();
    const root = await inner.root();
    const d = ulid();
    const f = ulid();
    await inner.create(root, "dir", d, "dir");
    await inner.create(d, "f.txt", f, "file");
    const dump: BackendDump = {
      inodes: [
        { id: root, attrs: await inner.getattr(root) },
        { id: d, attrs: await inner.getattr(d) },
        { id: f, attrs: await inner.getattr(f) },
      ],
      dirents: [
        { parentId: root, name: "dir", childId: d, kind: "dir" },
        { parentId: d, name: "f.txt", childId: f, kind: "file" },
      ],
    };
    const be = new CachedBackend(inner);
    be.warm(dump);
    const lookupSpy = vi.spyOn(inner, "lookup");
    const getattrSpy = vi.spyOn(inner, "getattr");
    const readdirSpy = vi.spyOn(inner, "readdir");
    expect((await be.lookup(root, "dir"))?.id).toBe(d);
    expect((await be.getattr(f)).kind).toBe("file");
    expect((await be.readdir(d)).map((x) => x.name)).toEqual(["f.txt"]);
    expect(await be.readdir(f).catch((e) => e)).toMatchObject({ errno: "ENOTDIR" });
    expect(await be.lookup(root, "ghost")).toBeNull(); // warmed dirs are complete → negative without inner
    expect(lookupSpy).toHaveBeenCalledTimes(0);
    expect(getattrSpy).toHaveBeenCalledTimes(0);
    expect(readdirSpy).toHaveBeenCalledTimes(0);
  });

  it("refuses to warm a dirty cache", async () => {
    const inner = new MemoryBackend();
    const be = new CachedBackend(inner, { flushDelayMs: 60_000 });
    const root = await be.root();
    await be.create(root, "pending", ulid(), "file");
    expect(() => be.warm({ inodes: [], dirents: [] })).toThrowError(/EINVAL/);
  });
});
