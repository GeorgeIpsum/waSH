import { describe, it, expect, beforeEach } from "vitest";
import { IndexedDBBackend } from "../src/backend.js";
import { ulid } from "@wash/vfs";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("IndexedDBBackend unlink/rename/links", () => {
  let be: IndexedDBBackend;
  let root: string;
  beforeEach(async () => {
    be = await IndexedDBBackend.open(`ln-${ulid()}`, { chunkSize: 8 });
    root = await be.root();
  });

  it("unlink GCs the inode and its chunks; ENOTEMPTY for full dirs", async () => {
    const f = ulid();
    await be.create(root, "f", f, "file");
    await be.write(f, 0, enc.encode("0123456789")); // 2 chunks
    await be.unlink(root, "f");
    expect(await be.lookup(root, "f")).toBeNull();
    await expect(be.getattr(f)).rejects.toMatchObject({ errno: "ENOENT" });
    const d = ulid();
    await be.create(root, "d", d, "dir");
    await be.create(d, "kid", ulid(), "file");
    await expect(be.unlink(root, "d")).rejects.toMatchObject({ errno: "ENOTEMPTY" });
    await be.unlink(d, "kid");
    await be.unlink(root, "d"); // empty now
    expect(await be.lookup(root, "d")).toBeNull();
  });

  it("hardlinks share content; GC only at nlink 0; EEXIST beats EPERM on double-fault link", async () => {
    const f = ulid();
    await be.create(root, "a", f, "file");
    await be.write(f, 0, enc.encode("shared"));
    await be.link!(root, "b", f);
    expect((await be.getattr(f)).nlink).toBe(2);
    await be.unlink(root, "a");
    expect(dec.decode(await be.read(f, 0, 100))).toBe("shared");
    const d = ulid();
    await be.create(root, "d", d, "dir");
    await expect(be.link!(root, "b", d)).rejects.toMatchObject({ errno: "EEXIST" }); // name taken AND dir target
    await expect(be.link!(root, "c", d)).rejects.toMatchObject({ errno: "EPERM" });
    await be.unlink(root, "b");
    await expect(be.getattr(f)).rejects.toMatchObject({ errno: "ENOENT" });
  });

  it("rename moves a dirent; same-inode rename is a POSIX no-op", async () => {
    const f = ulid();
    await be.create(root, "a", f, "file");
    await be.link!(root, "b", f);
    await be.rename(root, "a", root, "b");
    expect((await be.lookup(root, "a"))?.id).toBe(f);
    expect((await be.lookup(root, "b"))?.id).toBe(f);
    expect((await be.getattr(f)).nlink).toBe(2);
    await be.rename(root, "a", root, "c");
    expect(await be.lookup(root, "a")).toBeNull();
    expect((await be.lookup(root, "c"))?.id).toBe(f);
  });

  it("rename overwrite semantics: file over file GCs displaced; dir-over-nonempty ENOTEMPTY; file-over-dir EISDIR; dir-over-file ENOTDIR", async () => {
    const f1 = ulid();
    const f2 = ulid();
    await be.create(root, "f1", f1, "file");
    await be.create(root, "f2", f2, "file");
    await be.rename(root, "f1", root, "f2");
    expect((await be.lookup(root, "f2"))?.id).toBe(f1);
    await expect(be.getattr(f2)).rejects.toMatchObject({ errno: "ENOENT" });
    const d1 = ulid();
    const d2 = ulid();
    await be.create(root, "d1", d1, "dir");
    await be.create(root, "d2", d2, "dir");
    await be.create(d2, "kid", ulid(), "file");
    await expect(be.rename(root, "d1", root, "d2")).rejects.toMatchObject({ errno: "ENOTEMPTY" });
    await expect(be.rename(root, "f2", root, "d1")).rejects.toMatchObject({ errno: "EISDIR" });
    await expect(be.rename(root, "d1", root, "f2")).rejects.toMatchObject({ errno: "ENOTDIR" });
  });

  it("mid-op transaction failure surfaces as an error, never a partial retry", async () => {
    const f = ulid();
    await be.create(root, "a", f, "file");
    await be.link!(root, "b", f);
    await be.flush();
    // Deterministically kill the txn after unlink's first internal read.
    const orig = (be as unknown as { getInode: (tx: IDBTransaction, id: string) => Promise<unknown> }).getInode.bind(be);
    let calls = 0;
    (be as unknown as { getInode: unknown }).getInode = async (tx: IDBTransaction, id: string) => {
      const out = await orig(tx, id);
      if (++calls === 1) tx.abort();
      return out;
    };
    await expect(be.unlink(root, "a")).rejects.toBeTruthy();
    (be as unknown as { getInode: unknown }).getInode = orig;
    await expect(be.flush()).rejects.toBeTruthy(); // abort surfaced once, poison cleared
    // No corruption: the abort rolled the whole batch back; both names intact, nlink untouched.
    expect((await be.lookup(root, "a"))?.id).toBe(f);
    expect((await be.lookup(root, "b"))?.id).toBe(f);
    expect((await be.getattr(f)).nlink).toBe(2);
  });

  it("symlink stores target on the inode; readlink EINVAL on non-symlink", async () => {
    const s = ulid();
    await be.symlink!(root, "ln", s, "/target");
    expect((await be.lookup(root, "ln"))?.attrs.kind).toBe("symlink");
    expect(await be.readlink!(s)).toBe("/target");
    const f = ulid();
    await be.create(root, "f", f, "file");
    await expect(be.readlink!(f)).rejects.toMatchObject({ errno: "EINVAL" });
  });
});
