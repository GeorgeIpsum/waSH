import { describe, it, expect, afterEach } from "vitest";
import { OpfsBackend } from "@wash/backend-opfs";
import { ulid } from "@wash/vfs";
const enc = new TextEncoder(), dec = new TextDecoder();
const roots: string[] = [];
function testRoot(): string { const n = `wash-test-${ulid()}`; roots.push(n); return n; }
afterEach(async () => {
  const o = await navigator.storage.getDirectory();
  for (const n of roots.splice(0)) await o.removeEntry(n, { recursive: true }).catch(() => {});
});

describe("OpfsBackend rename (O(1) atomic, id-addressed)", () => {
  it("moves files within/across dirs, id-stable, content intact; same-inode no-op", async () => {
    const be = await OpfsBackend.open(testRoot());
    const root = await be.root();
    const d = ulid();
    await be.create(root, "d", d, "dir");
    const f = ulid();
    await be.create(root, "a", f, "file");
    await be.write(f, 0, enc.encode("payload"));
    await be.rename(root, "a", root, "b");
    expect((await be.lookup(root, "b"))?.id).toBe(f);
    await be.rename(root, "b", d, "c");
    expect((await be.lookup(d, "c"))?.id).toBe(f);
    expect(await be.lookup(root, "b")).toBeNull();
    expect(dec.decode(await be.read(f, 0, 100))).toBe("payload");
    await be.link(d, "hard", f);
    await be.rename(d, "c", d, "hard"); // both name the same inode → POSIX no-op
    expect((await be.lookup(d, "c"))?.id).toBe(f);
    expect((await be.lookup(d, "hard"))?.id).toBe(f);
    expect((await be.getattr(f)).nlink).toBe(2);
    await be.close();
  });

  it("overwrite semantics: file-over-file GCs displaced; dir-over-nonempty ENOTEMPTY; file-over-dir EISDIR; dir-over-file ENOTDIR", async () => {
    const be = await OpfsBackend.open(testRoot());
    const root = await be.root();
    const f1 = ulid(), f2 = ulid();
    await be.create(root, "f1", f1, "file");
    await be.create(root, "f2", f2, "file");
    await be.rename(root, "f1", root, "f2");
    expect((await be.lookup(root, "f2"))?.id).toBe(f1);
    await expect(be.getattr(f2)).rejects.toMatchObject({ errno: "ENOENT" });
    const d1 = ulid(), d2 = ulid();
    await be.create(root, "d1", d1, "dir");
    await be.create(root, "d2", d2, "dir");
    await be.create(d2, "kid", ulid(), "file");
    await expect(be.rename(root, "d1", root, "d2")).rejects.toMatchObject({ errno: "ENOTEMPTY" });
    await expect(be.rename(root, "f2", root, "d1")).rejects.toMatchObject({ errno: "EISDIR" });
    await expect(be.rename(root, "d1", root, "f2")).rejects.toMatchObject({ errno: "ENOTDIR" });
    await be.close();
  });

  it("directory rename is O(1) and atomic: subtree ids/content unchanged", async () => {
    const name = testRoot();
    const be = await OpfsBackend.open(name);
    const root = await be.root();
    const src = ulid();
    await be.create(root, "src", src, "dir");
    const sub = ulid();
    await be.create(src, "sub", sub, "dir");
    const f = ulid();
    await be.create(sub, "deep.txt", f, "file", { mode: 0o700 });
    await be.write(f, 0, enc.encode("deep"));
    await be.rename(root, "src", root, "moved");
    expect((await be.lookup(root, "moved"))?.id).toBe(src);
    expect((await be.lookup(src, "sub"))?.id).toBe(sub);
    const deep = await be.lookup(sub, "deep.txt");
    expect(deep?.id).toBe(f);
    expect(deep?.attrs.mode).toBe(0o700);
    expect(dec.decode(await be.read(f, 0, 100))).toBe("deep");
    await be.close();
    const be2 = await OpfsBackend.open(name);
    const root2 = await be2.root();
    const moved = await be2.lookup(root2, "moved");
    const sub2 = await be2.lookup(moved!.id, "sub");
    expect(dec.decode(await be2.read((await be2.lookup(sub2!.id, "deep.txt"))!.id, 0, 100))).toBe("deep");
    await be2.close();
  });
});
