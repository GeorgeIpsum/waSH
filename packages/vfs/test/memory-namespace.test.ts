import { describe, it, expect, beforeEach } from "vitest";
import { MemoryBackend } from "../src/backend/memory.js";
import { ulid } from "../src/ulid.js";
import { VfsError } from "../src/errors.js";

describe("MemoryBackend namespace", () => {
  let be: MemoryBackend;
  let root: string;
  beforeEach(async () => {
    be = new MemoryBackend();
    root = await be.root();
  });

  it("has an empty root directory", async () => {
    expect((await be.getattr(root)).kind).toBe("dir");
    expect(await be.readdir(root)).toEqual([]);
  });

  it("creates and looks up a file", async () => {
    const id = ulid();
    await be.create(root, "a.txt", id, "file");
    const info = await be.lookup(root, "a.txt");
    expect(info?.id).toBe(id);
    expect(info?.attrs.kind).toBe("file");
    expect(info?.attrs.size).toBe(0);
    expect(info?.attrs.mode).toBe(0o644);
    expect(info?.attrs.nlink).toBe(1);
  });

  it("lookup of a missing name returns null", async () => {
    expect(await be.lookup(root, "nope")).toBeNull();
  });

  it("create over an existing name throws EEXIST", async () => {
    await be.create(root, "a", ulid(), "file");
    await expect(be.create(root, "a", ulid(), "file")).rejects.toMatchObject({ errno: "EEXIST" });
  });

  it("creates nested directories and lists them sorted-insensitively", async () => {
    const d = ulid();
    await be.create(root, "dir", d, "dir");
    await be.create(d, "x", ulid(), "file");
    await be.create(d, "y", ulid(), "dir");
    const names = (await be.readdir(d)).map((e) => e.name).sort();
    expect(names).toEqual(["x", "y"]);
  });

  it("getattr of unknown id throws ENOENT", async () => {
    await expect(be.getattr(ulid())).rejects.toMatchObject({ errno: "ENOENT" });
  });

  it("readdir/create on a file throws ENOTDIR", async () => {
    const f = ulid();
    await be.create(root, "f", f, "file");
    await expect(be.readdir(f)).rejects.toMatchObject({ errno: "ENOTDIR" });
    await expect(be.create(f, "child", ulid(), "file")).rejects.toMatchObject({ errno: "ENOTDIR" });
  });

  it("setattr updates mode and mtime", async () => {
    const f = ulid();
    await be.create(root, "f", f, "file");
    await be.setattr(f, { mode: 0o755, mtimeMs: 12345 });
    const a = await be.getattr(f);
    expect(a.mode).toBe(0o755);
    expect(a.mtimeMs).toBe(12345);
  });

  it("readdirPlus returns entries with attrs", async () => {
    await be.create(root, "f", ulid(), "file");
    const plus = await be.readdirPlus!(root);
    expect(plus).toHaveLength(1);
    expect(plus[0]!.name).toBe("f");
    expect(plus[0]!.attrs.kind).toBe("file");
  });
});
