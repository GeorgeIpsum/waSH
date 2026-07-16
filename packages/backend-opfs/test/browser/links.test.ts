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

describe("OpfsBackend symlinks + hardlinks", () => {
  it("symlink/readlink round-trip, persists; readlink EINVAL on non-symlink", async () => {
    const name = testRoot();
    const be = await OpfsBackend.open(name);
    const root = await be.root();
    const s = ulid();
    await be.symlink(root, "ln", s, "/some/target");
    expect((await be.lookup(root, "ln"))?.attrs.kind).toBe("symlink");
    expect(await be.readlink(s)).toBe("/some/target");
    const f = ulid();
    await be.create(root, "f", f, "file");
    await expect(be.readlink(f)).rejects.toMatchObject({ errno: "EINVAL" });
    await be.close();
    const be2 = await OpfsBackend.open(name);
    const again = await be2.lookup(await be2.root(), "ln");
    expect(await be2.readlink(again!.id)).toBe("/some/target");
    await be2.close();
  });

  it("hardlink shares content + nlink; GC only at 0; EEXIST beats EPERM; EPERM on dir", async () => {
    const be = await OpfsBackend.open(testRoot());
    const root = await be.root();
    const f = ulid();
    await be.create(root, "a", f, "file");
    await be.write(f, 0, enc.encode("shared"));
    await be.link(root, "b", f);
    expect((await be.getattr(f)).nlink).toBe(2);
    await be.unlink(root, "a");
    expect(dec.decode(await be.read(f, 0, 100))).toBe("shared");
    const d = ulid();
    await be.create(root, "d", d, "dir");
    await expect(be.link(root, "b", d)).rejects.toMatchObject({ errno: "EEXIST" });
    await expect(be.link(root, "c", d)).rejects.toMatchObject({ errno: "EPERM" });
    await be.unlink(root, "b");
    await expect(be.getattr(f)).rejects.toMatchObject({ errno: "ENOENT" });
    await be.close();
  });
});
