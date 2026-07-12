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
});
