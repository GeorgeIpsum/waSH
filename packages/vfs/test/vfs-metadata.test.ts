import { describe, it, expect, beforeEach } from "vitest";
import { Vfs } from "../src/core/vfs.js";
import { MemoryBackend } from "../src/backend/memory.js";

describe("Vfs metadata ops", () => {
  let vfs: Vfs;
  beforeEach(async () => {
    vfs = new Vfs();
    await vfs.mount("/", new MemoryBackend());
  });

  it("mkdir + readdir sorted", async () => {
    await vfs.mkdir("/b");
    await vfs.mkdir("/a");
    expect((await vfs.readdir("/")).map((d) => d.name)).toEqual(["a", "b"]);
  });

  it("mkdir recursive creates parents; non-recursive needs them", async () => {
    await expect(vfs.mkdir("/x/y/z")).rejects.toMatchObject({ errno: "ENOENT" });
    await vfs.mkdir("/x/y/z", { recursive: true });
    expect((await vfs.stat("/x/y/z")).kind).toBe("dir");
    await vfs.mkdir("/x/y/z", { recursive: true }); // idempotent
    await expect(vfs.mkdir("/x/y/z")).rejects.toMatchObject({ errno: "EEXIST" });
  });

  it("unlink refuses dirs; rmdir refuses files and non-empty dirs", async () => {
    const be = new MemoryBackend();
    vfs = new Vfs();
    await vfs.mount("/", be);
    const { ulid } = await import("../src/ulid.js");
    const root = await be.root();
    await be.create(root, "f.txt", ulid(), "file"); // writeFile helper arrives in Task 9
    await vfs.mkdir("/d");
    await vfs.mkdir("/d/kid");
    await expect(vfs.unlink("/d")).rejects.toMatchObject({ errno: "EISDIR" });
    await expect(vfs.rmdir("/f.txt")).rejects.toMatchObject({ errno: "ENOTDIR" });
    await expect(vfs.rmdir("/d")).rejects.toMatchObject({ errno: "ENOTEMPTY" });
    await vfs.rmdir("/d/kid");
    await vfs.rmdir("/d");
    await vfs.unlink("/f.txt");
    expect(await vfs.exists("/f.txt")).toBe(false);
  });

  it("rename within a mount; EINVAL into own descendant", async () => {
    await vfs.mkdir("/a");
    await vfs.mkdir("/a/b");
    await vfs.rename("/a/b", "/c");
    expect((await vfs.stat("/c")).kind).toBe("dir");
    await vfs.mkdir("/c/inner");
    await expect(vfs.rename("/c", "/c/inner/c")).rejects.toMatchObject({ errno: "EINVAL" });
  });

  it("rename EINVAL guard is not bypassable via symlinks", async () => {
    await vfs.mkdir("/a");
    await vfs.mkdir("/a/b");
    await vfs.symlink("/a/b", "/link");
    await expect(vfs.rename("/a", "/link/x")).rejects.toMatchObject({ errno: "EINVAL" });
    expect(await vfs.exists("/a")).toBe(true);
    expect((await vfs.stat("/a/b")).kind).toBe("dir");
  });

  it("rename across mounts throws EXDEV", async () => {
    await vfs.mkdir("/mnt");
    await vfs.mount("/mnt", new MemoryBackend());
    await vfs.mkdir("/a");
    await expect(vfs.rename("/a", "/mnt/a")).rejects.toMatchObject({ errno: "EXDEV" });
  });

  it("symlink/readlink and chmod/utimes/exists", async () => {
    await vfs.mkdir("/real");
    await vfs.symlink("/real", "/ln");
    expect(await vfs.readlink("/ln")).toBe("/real");
    expect((await vfs.stat("/ln")).kind).toBe("dir");
    await vfs.chmod("/real", 0o700);
    expect((await vfs.stat("/real")).mode).toBe(0o700);
    await vfs.utimes("/real", 111);
    expect((await vfs.stat("/real")).mtimeMs).toBe(111);
    expect(await vfs.exists("/real")).toBe(true);
    expect(await vfs.exists("/ghost")).toBe(false);
  });

  it("rm recursive removes a tree", async () => {
    await vfs.mkdir("/t/deep/deeper", { recursive: true });
    await vfs.rm("/t", { recursive: true });
    expect(await vfs.exists("/t")).toBe(false);
  });

  it("rename/unlink/rmdir reject active mountpoints with EBUSY", async () => {
    await vfs.mkdir("/mnt");
    await vfs.mount("/mnt", new MemoryBackend());
    await vfs.mkdir("/a");
    await expect(vfs.rename("/a", "/mnt")).rejects.toMatchObject({ errno: "EBUSY" });
    await expect(vfs.rename("/mnt", "/x")).rejects.toMatchObject({ errno: "EBUSY" });
    await expect(vfs.unlink("/mnt")).rejects.toMatchObject({ errno: "EBUSY" });
    await expect(vfs.rmdir("/mnt")).rejects.toMatchObject({ errno: "EBUSY" });
    expect((await vfs.stat("/mnt")).kind).toBe("dir"); // mount still routes
  });

  it("renaming an ancestor of an active mountpoint throws EBUSY", async () => {
    await vfs.mkdir("/d");
    await vfs.mkdir("/d/m");
    await vfs.mount("/d/m", new MemoryBackend());
    await expect(vfs.rename("/d", "/e")).rejects.toMatchObject({ errno: "EBUSY" });
    expect((await vfs.stat("/d/m")).kind).toBe("dir"); // mount still routes
    expect(await vfs.exists("/e")).toBe(false);
  });

  it("recursive mkdir rejects existing non-directory components", async () => {
    await vfs.writeFile("/file", "x");
    await expect(vfs.mkdir("/file", { recursive: true })).rejects.toMatchObject({ errno: "EEXIST" });
    await expect(vfs.mkdir("/file/x/y", { recursive: true })).rejects.toMatchObject({ errno: "ENOTDIR" });
    await vfs.mkdir("/real");
    await vfs.symlink("/real", "/ln");
    await vfs.mkdir("/ln/sub", { recursive: true }); // dir-symlink component is fine
    expect((await vfs.stat("/real/sub")).kind).toBe("dir");
  });
});
