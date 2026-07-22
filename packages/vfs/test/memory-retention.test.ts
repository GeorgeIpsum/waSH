import { describe, it, expect } from "vitest";
import { MemoryBackend } from "../src/backend/memory.js";
import { ulid } from "../src/ulid.js";

const enc = new TextEncoder(); const dec = new TextDecoder();

describe("MemoryBackend retain/release", () => {
  it("a retained inode survives unlink and stays readable; the last release reclaims it", async () => {
    const be = new MemoryBackend();
    const root = await be.root();
    const f = ulid();
    await be.create(root, "f", f, "file");
    await be.write(f, 0, enc.encode("data"));
    be.retain!(f);                              // an fd references it
    await be.unlink(root, "f");                 // nlink → 0, but retained
    expect(dec.decode(await be.read(f, 0, 100))).toBe("data"); // anonymous inode still readable
    await expect(be.getattr(f)).resolves.toMatchObject({ nlink: 0 });
    be.release!(f);                             // last reference dropped → reclaimed
    await expect(be.getattr(f)).rejects.toMatchObject({ errno: "ENOENT" });
  });

  it("rename-over a retained target keeps the displaced inode alive until release", async () => {
    const be = new MemoryBackend();
    const root = await be.root();
    const a = ulid(), b = ulid();
    await be.create(root, "a", a, "file");
    await be.create(root, "b", b, "file");
    await be.write(b, 0, enc.encode("bbb"));
    be.retain!(b);                              // fd on b
    await be.rename(root, "a", root, "b");      // b displaced (nlink→0), retained
    expect(dec.decode(await be.read(b, 0, 100))).toBe("bbb");
    be.release!(b);
    await expect(be.getattr(b)).rejects.toMatchObject({ errno: "ENOENT" });
  });

  it("caps.fdRetention is true", () => {
    expect(new MemoryBackend().caps.fdRetention).toBe(true);
  });
});
