import { describe, it, expect, afterEach } from "vitest";
import { OpfsBackend } from "@wash/backend-opfs";
import { ulid } from "@wash/vfs";

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

describe("OpfsBackend symlinks", () => {
  it("creates, reads, lists, unlinks, and persists symlinks", async () => {
    const rootName = testRoot();
    const be = await OpfsBackend.open(rootName);
    const root = await be.root();
    const s = ulid();
    await be.symlink(root, "ln", s, "/some/target");
    const info = await be.lookup(root, "ln");
    expect(info?.id).toBe(s);
    expect(info?.attrs.kind).toBe("symlink");
    expect(info?.attrs.size).toBe("/some/target".length);
    expect(await be.readlink(s)).toBe("/some/target");
    expect((await be.readdir(root)).map((d) => `${d.name}:${d.kind}`)).toEqual(["ln:symlink"]);
    await expect(be.symlink(root, "ln", ulid(), "/x")).rejects.toMatchObject({ errno: "EEXIST" });
    await be.close();

    const be2 = await OpfsBackend.open(rootName);
    const root2 = await be2.root();
    const again = await be2.lookup(root2, "ln");
    expect(again?.attrs.kind).toBe("symlink");
    expect(await be2.readlink(again!.id)).toBe("/some/target");
    await be2.unlink(root2, "ln");
    expect(await be2.lookup(root2, "ln")).toBeNull();
    await be2.close();
  });

  it("readlink on a file throws EINVAL", async () => {
    const be = await OpfsBackend.open(testRoot());
    const root = await be.root();
    const f = ulid();
    await be.create(root, "f", f, "file");
    await expect(be.readlink(f)).rejects.toMatchObject({ errno: "EINVAL" });
    await be.close();
  });
});
