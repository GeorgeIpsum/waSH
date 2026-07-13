import { describe, it, expect, afterEach } from "vitest";
import { OpfsBackend, SIDECAR_NAME } from "@wash/backend-opfs";
import { ulid } from "@wash/vfs";

const roots: string[] = [];
export function testRoot(): string {
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

describe("OpfsBackend shell", () => {
  it("opens, exposes a dir root, and closes", async () => {
    const be = await OpfsBackend.open(testRoot());
    const root = await be.root();
    const attrs = await be.getattr(root);
    expect(attrs.kind).toBe("dir");
    expect(attrs.mode).toBe(0o755);
    expect(attrs.nlink).toBe(1);
    await be.close();
  });

  it("declares the required caps", async () => {
    const be = await OpfsBackend.open(testRoot());
    expect(be.caps).toEqual({
      symlinks: "supported",
      hardlinks: false,
      atomicDirRename: false,
      renameCost: "subtree",
      reservedNames: [SIDECAR_NAME],
    });
    await be.close();
  });

  it("unimplemented ops reject with ENOSYS across the RPC boundary", async () => {
    const be = await OpfsBackend.open(testRoot());
    await expect(be.readdir(await be.root())).rejects.toMatchObject({ errno: "ENOSYS" });
    await be.close();
  });
});
