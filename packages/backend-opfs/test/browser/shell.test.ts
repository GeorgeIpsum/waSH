import { describe, it, expect, afterEach } from "vitest";
import { OpfsBackend } from "@wash/backend-opfs";
import { ulid } from "@wash/vfs";

const roots: string[] = [];
export function testRoot(): string {
  const name = `wash-test-${ulid()}`;
  roots.push(name);
  return name;
}
afterEach(async () => {
  const origin = await navigator.storage.getDirectory();
  for (const name of roots.splice(0)) await origin.removeEntry(name, { recursive: true }).catch(() => {});
});

describe("OpfsBackend manifest shell", () => {
  it("opens an empty mount, exposes a dir root, persists across reopen", async () => {
    const name = testRoot();
    const be = await OpfsBackend.open(name);
    const root = await be.root();
    const attrs = await be.getattr(root);
    expect(attrs.kind).toBe("dir");
    expect(attrs.mode).toBe(0o755);
    await be.flush();
    await be.close();
    const be2 = await OpfsBackend.open(name);
    expect(await be2.root()).toBe(root); // rootId persisted in the manifest
    await be2.close();
  });

  it("declares the id-addressed caps", async () => {
    const be = await OpfsBackend.open(testRoot());
    expect(be.caps).toEqual({
      symlinks: "supported", hardlinks: true, atomicDirRename: true, renameCost: "O1", reservedNames: [],
    });
    await be.close();
  });

  it("enforces single-writer: a second open of the same root gets EBUSY; reopen after close works", async () => {
    const name = testRoot();
    const be = await OpfsBackend.open(name);
    await expect(OpfsBackend.open(name)).rejects.toMatchObject({ errno: "EBUSY" });
    await be.close();
    const be2 = await OpfsBackend.open(name); // lock released
    await be2.close();
  });

  it("getattr of unknown id throws ENOENT; unimplemented op throws ENOSYS", async () => {
    const be = await OpfsBackend.open(testRoot());
    await expect(be.getattr(ulid())).rejects.toMatchObject({ errno: "ENOENT" });
    await expect(
      (be as unknown as { call: (op: string, a: unknown[]) => Promise<unknown> }).call("nonexistent-op", []),
    ).rejects.toMatchObject({ errno: "ENOSYS" });
    await be.close();
  });
});
