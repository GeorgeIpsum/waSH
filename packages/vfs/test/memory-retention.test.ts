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

  it("retain on an unknown id throws ENOENT; release on an unknown id does not throw", async () => {
    const be = new MemoryBackend();
    const unknown = ulid();
    expect(() => be.retain!(unknown)).toThrow(               // retain validates existence (§A.2)
      expect.objectContaining({ errno: "ENOENT" }),
    );
    expect(() => be.release!(unknown)).not.toThrow();        // release is best-effort/lenient (§A.5)
  });

  it("caps.fdRetention is true", () => {
    expect(new MemoryBackend().caps.fdRetention).toBe(true);
  });
});
