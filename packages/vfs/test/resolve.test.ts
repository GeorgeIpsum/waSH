import { describe, it, expect, beforeEach } from "vitest";
import { Vfs } from "../src/core/vfs.js";
import { MemoryBackend } from "../src/backend/memory.js";
import { normalize } from "../src/core/path.js";

describe("normalize", () => {
  it("normalizes dots, slashes, and parent refs", () => {
    expect(normalize("/a/b/../c/./d//")).toBe("/a/c/d");
    expect(normalize("/")).toBe("/");
    expect(normalize("/../..")).toBe("/");
  });
  it("rejects relative paths", () => {
    expect(() => normalize("a/b")).toThrowError(/EINVAL/);
  });
});

describe("Vfs resolution", () => {
  let vfs: Vfs;
  beforeEach(async () => {
    vfs = new Vfs();
    await vfs.mount("/", new MemoryBackend());
  });

  it("stats the root", async () => {
    expect((await vfs.stat("/")).kind).toBe("dir");
  });

  it("throws ENOENT for missing paths and ENOTDIR through files", async () => {
    await expect(vfs.stat("/missing")).rejects.toMatchObject({ errno: "ENOENT", path: "/missing" });
  });

  it("resolves nested paths across a second mount", async () => {
    const mnt = new MemoryBackend();
    const mntRoot = await mnt.root();
    const { ulid } = await import("../src/ulid.js");
    await mnt.create(mntRoot, "inner.txt", ulid(), "file");
    // mountpoint dir must exist on the parent mount
    const rootBe = new MemoryBackend();
    vfs = new Vfs();
    await vfs.mount("/", rootBe);
    const rbRoot = await rootBe.root();
    await rootBe.create(rbRoot, "mnt", ulid(), "dir");
    await vfs.mount("/mnt", mnt);
    expect((await vfs.stat("/mnt/inner.txt")).kind).toBe("file");
  });

  it("follows relative and absolute symlinks; lstat does not follow", async () => {
    const be = new MemoryBackend();
    vfs = new Vfs();
    await vfs.mount("/", be);
    const root = await be.root();
    const { ulid } = await import("../src/ulid.js");
    const dir = ulid();
    await be.create(root, "real", dir, "dir");
    await be.create(dir, "f.txt", ulid(), "file");
    await be.symlink!(root, "abs", ulid(), "/real");
    await be.symlink!(dir, "rel", ulid(), "f.txt");
    expect((await vfs.stat("/abs/f.txt")).kind).toBe("file");
    expect((await vfs.stat("/real/rel")).kind).toBe("file");
    expect((await vfs.lstat("/abs")).kind).toBe("symlink");
    expect(await vfs.realpath("/abs/rel")).toBe("/real/f.txt");
  });

  it("detects symlink loops with ELOOP", async () => {
    const be = new MemoryBackend();
    vfs = new Vfs();
    await vfs.mount("/", be);
    const root = await be.root();
    const { ulid } = await import("../src/ulid.js");
    await be.symlink!(root, "a", ulid(), "/b");
    await be.symlink!(root, "b", ulid(), "/a");
    await expect(vfs.stat("/a")).rejects.toMatchObject({ errno: "ELOOP" });
  });
});
