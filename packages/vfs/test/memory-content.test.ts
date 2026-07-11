import { describe, it, expect, beforeEach } from "vitest";
import { MemoryBackend } from "../src/backend/memory.js";
import { ulid } from "../src/ulid.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("MemoryBackend content + unlink + rename", () => {
  let be: MemoryBackend;
  let root: string;
  let file: string;
  beforeEach(async () => {
    be = new MemoryBackend();
    root = await be.root();
    file = ulid();
    await be.create(root, "f.txt", file, "file");
  });

  it("writes and reads back", async () => {
    await be.write(file, 0, enc.encode("hello"));
    expect(dec.decode(await be.read(file, 0, 100))).toBe("hello");
    expect((await be.getattr(file)).size).toBe(5);
  });

  it("supports offset writes and sparse zero-fill", async () => {
    await be.write(file, 3, enc.encode("abc"));
    const out = await be.read(file, 0, 6);
    expect([...out.slice(0, 3)]).toEqual([0, 0, 0]);
    expect(dec.decode(out.slice(3))).toBe("abc");
  });

  it("read past EOF returns short result", async () => {
    await be.write(file, 0, enc.encode("hi"));
    expect((await be.read(file, 1, 100)).byteLength).toBe(1);
    expect((await be.read(file, 5, 100)).byteLength).toBe(0);
  });

  it("truncate shrinks and extends", async () => {
    await be.write(file, 0, enc.encode("hello"));
    await be.truncate(file, 2);
    expect(dec.decode(await be.read(file, 0, 100))).toBe("he");
    await be.truncate(file, 4);
    const out = await be.read(file, 0, 100);
    expect(out.byteLength).toBe(4);
    expect([...out.slice(2)]).toEqual([0, 0]);
  });

  it("read/write on a directory throws EISDIR", async () => {
    await expect(be.read(root, 0, 1)).rejects.toMatchObject({ errno: "EISDIR" });
    await expect(be.write(root, 0, enc.encode("x"))).rejects.toMatchObject({ errno: "EISDIR" });
  });

  it("unlink removes entry and GCs the node", async () => {
    await be.unlink(root, "f.txt");
    expect(await be.lookup(root, "f.txt")).toBeNull();
    await expect(be.getattr(file)).rejects.toMatchObject({ errno: "ENOENT" });
  });

  it("unlink of missing name throws ENOENT; non-empty dir throws ENOTEMPTY", async () => {
    await expect(be.unlink(root, "ghost")).rejects.toMatchObject({ errno: "ENOENT" });
    const d = ulid();
    await be.create(root, "d", d, "dir");
    await be.create(d, "kid", ulid(), "file");
    await expect(be.unlink(root, "d")).rejects.toMatchObject({ errno: "ENOTEMPTY" });
  });

  it("rename moves an entry between directories", async () => {
    const d = ulid();
    await be.create(root, "d", d, "dir");
    await be.rename(root, "f.txt", d, "g.txt");
    expect(await be.lookup(root, "f.txt")).toBeNull();
    expect((await be.lookup(d, "g.txt"))?.id).toBe(file);
  });

  it("rename overwrites an existing file target", async () => {
    const other = ulid();
    await be.create(root, "old", other, "file");
    await be.rename(root, "f.txt", root, "old");
    expect((await be.lookup(root, "old"))?.id).toBe(file);
    await expect(be.getattr(other)).rejects.toMatchObject({ errno: "ENOENT" });
  });

  it("rename dir-over-nonempty-dir throws ENOTEMPTY; file-over-dir EISDIR; dir-over-file ENOTDIR", async () => {
    const d1 = ulid(); const d2 = ulid();
    await be.create(root, "d1", d1, "dir");
    await be.create(root, "d2", d2, "dir");
    await be.create(d2, "kid", ulid(), "file");
    await expect(be.rename(root, "d1", root, "d2")).rejects.toMatchObject({ errno: "ENOTEMPTY" });
    await expect(be.rename(root, "f.txt", root, "d1")).rejects.toMatchObject({ errno: "EISDIR" });
    await expect(be.rename(root, "d1", root, "f.txt")).rejects.toMatchObject({ errno: "ENOTDIR" });
  });
});
