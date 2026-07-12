import { describe, it, expect, beforeEach } from "vitest";
import { IndexedDBBackend } from "../src/backend.js";
import { ulid } from "@wash/vfs";

describe("IndexedDBBackend namespace", () => {
  let be: IndexedDBBackend;
  let root: string;
  beforeEach(async () => {
    be = await IndexedDBBackend.open(`ns-${ulid()}`);
    root = await be.root();
  });

  it("creates and looks up a file with default attrs", async () => {
    const id = ulid();
    await be.create(root, "a.txt", id, "file");
    const info = await be.lookup(root, "a.txt");
    expect(info?.id).toBe(id);
    expect(info?.attrs).toMatchObject({ kind: "file", size: 0, mode: 0o644, nlink: 1 });
  });

  it("lookup of a missing name returns null; EEXIST on duplicate create; ENOTDIR on file parent", async () => {
    expect(await be.lookup(root, "nope")).toBeNull();
    const f = ulid();
    await be.create(root, "f", f, "file");
    await expect(be.create(root, "f", ulid(), "file")).rejects.toMatchObject({ errno: "EEXIST" });
    await expect(be.create(f, "child", ulid(), "file")).rejects.toMatchObject({ errno: "ENOTDIR" });
    await expect(be.readdir(f)).rejects.toMatchObject({ errno: "ENOTDIR" });
  });

  it("readdir returns the whole directory in one shot", async () => {
    const d = ulid();
    await be.create(root, "dir", d, "dir");
    for (const n of ["x", "y", "z"]) await be.create(d, n, ulid(), "file");
    expect((await be.readdir(d)).map((e) => e.name).sort()).toEqual(["x", "y", "z"]);
    expect(await be.readdir(root)).toHaveLength(1);
  });

  it("readdir range does not bleed across sibling directories", async () => {
    const d1 = ulid();
    const d2 = ulid();
    await be.create(root, "d1", d1, "dir");
    await be.create(root, "d2", d2, "dir");
    await be.create(d1, "only-in-d1", ulid(), "file");
    expect(await be.readdir(d2)).toEqual([]);
  });

  it("readdirPlus returns entries with attrs", async () => {
    await be.create(root, "f", ulid(), "file");
    const plus = await be.readdirPlus!(root);
    expect(plus).toHaveLength(1);
    expect(plus[0]!.name).toBe("f");
    expect(plus[0]!.attrs.kind).toBe("file");
  });
});
