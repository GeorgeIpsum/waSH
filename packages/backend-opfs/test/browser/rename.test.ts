import { describe, it, expect, afterEach } from "vitest";
import { OpfsBackend } from "@wash/backend-opfs";
import { ulid } from "@wash/vfs";

const enc = new TextEncoder();
const dec = new TextDecoder();
const roots: string[] = [];
function testRoot(): string {
  const name = `wash-test-${ulid()}`;
  roots.push(name);
  return name;
}
afterEach(async () => {
  const origin = await navigator.storage.getDirectory();
  for (const name of roots.splice(0)) {
    await origin.removeEntry(name, { recursive: true }).catch(() => {});
  }
});

describe("OpfsBackend rename", () => {
  it("renames files within and across directories, id-stable, content intact", async () => {
    const be = await OpfsBackend.open(testRoot());
    const root = await be.root();
    const d = ulid();
    await be.create(root, "dst", d, "dir");
    const f = ulid();
    await be.create(root, "a.txt", f, "file");
    await be.write(f, 0, enc.encode("payload"));
    await be.rename(root, "a.txt", root, "b.txt");
    expect((await be.lookup(root, "b.txt"))?.id).toBe(f);
    await be.rename(root, "b.txt", d, "c.txt");
    expect((await be.lookup(d, "c.txt"))?.id).toBe(f);
    expect(await be.lookup(root, "b.txt")).toBeNull();
    expect(dec.decode(await be.read(f, 0, 100))).toBe("payload"); // id + content survive
    await be.close();
  });

  it("overwrite semantics: file-over-file replaces; dir-over-nonempty ENOTEMPTY; file-over-dir EISDIR; dir-over-file ENOTDIR", async () => {
    const be = await OpfsBackend.open(testRoot());
    const root = await be.root();
    const f1 = ulid();
    const f2 = ulid();
    await be.create(root, "f1", f1, "file");
    await be.create(root, "f2", f2, "file");
    await be.write(f1, 0, enc.encode("one"));
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
    await be.close();
  });

  it("directory rename moves the whole subtree with stable descendant ids, sidecar attrs, and open handles", async () => {
    const rootName = testRoot();
    const be = await OpfsBackend.open(rootName);
    const root = await be.root();
    const src = ulid();
    await be.create(root, "src", src, "dir");
    const sub = ulid();
    await be.create(src, "sub", sub, "dir");
    const f = ulid();
    await be.create(sub, "deep.txt", f, "file", { mode: 0o700 });
    await be.write(f, 0, enc.encode("deep-content")); // pooled handle open on f
    const ln = ulid();
    await be.symlink(src, "ln", ln, "/x");

    await be.rename(root, "src", root, "moved");
    expect((await be.lookup(root, "moved"))?.id).toBe(src); // dir id stable
    expect((await be.lookup(src, "sub"))?.id).toBe(sub);
    const deep = await be.lookup(sub, "deep.txt");
    expect(deep?.id).toBe(f);
    expect(deep?.attrs.mode).toBe(0o700); // sidecar transported
    expect(dec.decode(await be.read(f, 0, 100))).toBe("deep-content");
    expect(await be.readlink(ln)).toBe("/x");
    await be.close();

    const be2 = await OpfsBackend.open(rootName); // persisted layout
    const root2 = await be2.root();
    const moved = await be2.lookup(root2, "moved");
    const sub2 = await be2.lookup(moved!.id, "sub");
    const deep2 = await be2.lookup(sub2!.id, "deep.txt");
    expect(deep2?.attrs.mode).toBe(0o700);
    expect(dec.decode(await be2.read(deep2!.id, 0, 100))).toBe("deep-content");
    await be2.close();
  });
});
