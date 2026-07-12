import { describe, it, expect, beforeEach } from "vitest";
import { MemoryBackend } from "../src/backend/memory.js";
import { ulid } from "../src/ulid.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("MemoryBackend links", () => {
  let be: MemoryBackend;
  let root: string;
  beforeEach(async () => {
    be = new MemoryBackend();
    root = await be.root();
  });

  it("creates and reads a symlink", async () => {
    const s = ulid();
    await be.symlink!(root, "ln", s, "/target/path");
    const info = await be.lookup(root, "ln");
    expect(info?.attrs.kind).toBe("symlink");
    expect(await be.readlink!(s)).toBe("/target/path");
  });

  it("readlink on a regular file throws EINVAL", async () => {
    const f = ulid();
    await be.create(root, "f", f, "file");
    await expect(be.readlink!(f)).rejects.toMatchObject({ errno: "EINVAL" });
  });

  it("hardlink shares content and bumps nlink; GC only at zero", async () => {
    const f = ulid();
    await be.create(root, "a", f, "file");
    await be.write(f, 0, enc.encode("shared"));
    await be.link!(root, "b", f);
    expect((await be.getattr(f)).nlink).toBe(2);
    expect(dec.decode(await be.read(f, 0, 100))).toBe("shared");
    await be.unlink(root, "a");
    expect((await be.lookup(root, "b"))?.id).toBe(f);
    expect(dec.decode(await be.read(f, 0, 100))).toBe("shared");
    await be.unlink(root, "b");
    await expect(be.getattr(f)).rejects.toMatchObject({ errno: "ENOENT" });
  });

  it("link to a directory throws EPERM", async () => {
    const d = ulid();
    await be.create(root, "d", d, "dir");
    await expect(be.link!(root, "d2", d)).rejects.toMatchObject({ errno: "EPERM" });
  });
});
