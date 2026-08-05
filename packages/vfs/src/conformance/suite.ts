import { describe, it, expect, beforeEach } from "vitest";
import type { NodeId, WashBackend } from "../types.js";
import { ulid } from "../ulid.js";

/**
 * Contract conformance suite for WashBackend implementations.
 * Backend authors: call this from a vitest test file.
 * Capability-gated cases skip automatically per backend.caps.
 */
export function runBackendConformance(
  name: string,
  factory: () => Promise<WashBackend> | WashBackend,
): void {
  describe(`WashBackend conformance: ${name}`, () => {
    let be: WashBackend;
    let root: NodeId;
    const enc = new TextEncoder();
    const dec = new TextDecoder();

    beforeEach(async () => {
      be = await factory();
      root = await be.root();
    });

    describe("namespace", () => {
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

      it("readdirPlus returns entries with attrs", async (ctx) => {
        if (!be.readdirPlus) return ctx.skip();
        await be.create(root, "f", ulid(), "file");
        const plus = await be.readdirPlus!(root);
        expect(plus).toHaveLength(1);
        expect(plus[0]!.name).toBe("f");
        expect(plus[0]!.attrs.kind).toBe("file");
      });
    });

    describe("content", () => {
      let file: NodeId;
      beforeEach(async () => {
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

      it("zero-length writes are a complete no-op", async () => {
        const f = ulid();
        await be.create(root, "z", f, "file");
        await be.write(f, 0, enc.encode("abc"));
        const before = await be.getattr(f);
        await be.write(f, 100, new Uint8Array(0));
        const after = await be.getattr(f);
        expect(after.size).toBe(3);
        expect(after.mtimeMs).toBe(before.mtimeMs);
        expect((await be.read(f, 0, 10)).byteLength).toBe(3);
      });
    });

    describe("unlink and rename", () => {
      let file: NodeId;
      beforeEach(async () => {
        file = ulid();
        await be.create(root, "f.txt", file, "file");
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

      it("rename onto itself is a POSIX no-op", async () => {
        const f = ulid();
        await be.create(root, "self", f, "file");
        await be.rename(root, "self", root, "self");
        expect((await be.lookup(root, "self"))?.id).toBe(f);
        expect((await be.readdir(root)).some((d) => d.name === "self")).toBe(true);
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

    describe("symlinks (capability-gated)", () => {
      it("create + readlink roundtrip", async (ctx) => {
        if (be.caps.symlinks !== "supported") return ctx.skip();
        const s = ulid();
        await be.symlink!(root, "ln", s, "/t");
        expect(await be.readlink!(s)).toBe("/t");
        expect((await be.lookup(root, "ln"))?.attrs.kind).toBe("symlink");
      });

      it("readlink on a regular file throws EINVAL", async (ctx) => {
        if (be.caps.symlinks !== "supported") return ctx.skip();
        const f = ulid();
        await be.create(root, "f", f, "file");
        await expect(be.readlink!(f)).rejects.toMatchObject({ errno: "EINVAL" });
      });
    });

    describe("hardlinks (capability-gated)", () => {
      it("nlink lifecycle", async (ctx) => {
        if (!be.caps.hardlinks) return ctx.skip();
        const f = ulid();
        await be.create(root, "a", f, "file");
        await be.write(f, 0, enc.encode("x"));
        await be.link!(root, "b", f);
        expect((await be.getattr(f)).nlink).toBe(2);
        await be.unlink(root, "a");
        expect(dec.decode(await be.read(f, 0, 10))).toBe("x");
        await be.unlink(root, "b");
        await expect(be.getattr(f)).rejects.toMatchObject({ errno: "ENOENT" });
      });

      it("link to a directory throws EPERM", async (ctx) => {
        if (!be.caps.hardlinks) return ctx.skip();
        const d = ulid();
        await be.create(root, "d", d, "dir");
        await expect(be.link!(root, "d2", d)).rejects.toMatchObject({ errno: "EPERM" });
      });

      it("link EEXIST takes precedence over EPERM when both apply", async (ctx) => {
        if (!be.caps.hardlinks) return ctx.skip();
        const d = ulid();
        await be.create(root, "d", d, "dir");
        const f = ulid();
        await be.create(root, "f", f, "file");
        await expect(be.link!(root, "f", d)).rejects.toMatchObject({ errno: "EEXIST" });
      });

      it("rename between two names of the same node is a POSIX no-op", async (ctx) => {
        if (!be.caps.hardlinks) return ctx.skip();
        const f = ulid();
        await be.create(root, "a", f, "file");
        await be.link!(root, "b", f);
        await be.rename(root, "a", root, "b");
        expect((await be.lookup(root, "a"))?.id).toBe(f);
        expect((await be.lookup(root, "b"))?.id).toBe(f);
        expect((await be.getattr(f)).nlink).toBe(2);
      });
    });

    describe("reserved names (capability-gated)", () => {
      it("reserved names are hidden and immutable", async (ctx) => {
        const reserved = be.caps.reservedNames?.[0];
        if (!reserved) return ctx.skip();
        await expect(be.create(root, reserved, ulid(), "file")).rejects.toMatchObject({ errno: "EPERM" });
        expect((await be.readdir(root)).map((d) => d.name)).not.toContain(reserved);
        expect(await be.lookup(root, reserved)).toBeNull();
      });

      it("symlink onto a reserved name is rejected", async (ctx) => {
        const reserved = be.caps.reservedNames?.[0];
        if (!reserved || be.caps.symlinks !== "supported" || !be.symlink) return ctx.skip();
        await expect(be.symlink(root, reserved, ulid(), "/t")).rejects.toMatchObject({ errno: "EPERM" });
      });
    });

    describe("fd lifecycle (capability-gated)", () => {
      it("retain keeps an unlinked inode readable; last release reclaims it", async (ctx) => {
        if (!be.caps.fdRetention) return ctx.skip();
        const root = await be.root();
        const f = ulid();
        await be.create(root, "f", f, "file");
        await be.write(f, 0, new TextEncoder().encode("keep"));
        await be.retain!(f);
        await be.unlink(root, "f");
        await be.flush();
        expect(new TextDecoder().decode(await be.read(f, 0, 100))).toBe("keep"); // anonymous, still readable
        expect((await be.getattr(f)).nlink).toBe(0);
        await be.release!(f);
        await be.flush();
        await expect(be.getattr(f)).rejects.toMatchObject({ errno: "ENOENT" });
      });

      it("rename-over a retained target keeps it alive until release", async (ctx) => {
        if (!be.caps.fdRetention) return ctx.skip();
        const root = await be.root();
        const a = ulid(), b = ulid();
        await be.create(root, "a", a, "file");
        await be.create(root, "b", b, "file");
        await be.write(b, 0, new TextEncoder().encode("bb"));
        await be.retain!(b);
        await be.rename(root, "a", root, "b");
        await be.flush();
        expect(new TextDecoder().decode(await be.read(b, 0, 100))).toBe("bb");
        await be.release!(b);
        await be.flush();
        await expect(be.getattr(b)).rejects.toMatchObject({ errno: "ENOENT" });
      });
    });

    describe("flush", () => {
      it("flush() resolves (durability point)", async () => {
        await be.create(root, "f", ulid(), "file");
        await be.flush();
      });
    });
  });
}
