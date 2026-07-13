import { describe, it, expect, afterEach } from "vitest";
import { OpfsBackend, SIDECAR_NAME } from "@wash/backend-opfs";
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

describe("OpfsBackend create/unlink", () => {
  it("creates dirs and files with caller ids and default attrs", async () => {
    const be = await OpfsBackend.open(testRoot());
    const root = await be.root();
    const d = ulid();
    await be.create(root, "dir", d, "dir");
    const f = ulid();
    await be.create(d, "f.txt", f, "file", { mode: 0o600 });
    expect((await be.lookup(root, "dir"))?.id).toBe(d);
    const info = await be.lookup(d, "f.txt");
    expect(info?.id).toBe(f);
    expect(info?.attrs).toMatchObject({ kind: "file", mode: 0o600, nlink: 1, size: 0 });
    await expect(be.create(root, "dir", ulid(), "file")).rejects.toMatchObject({ errno: "EEXIST" });
    await expect(be.create(f, "x", ulid(), "file")).rejects.toMatchObject({ errno: "ENOTDIR" });
    await be.close();
  });

  it("rejects reserved-name mutations with EPERM", async () => {
    const be = await OpfsBackend.open(testRoot());
    const root = await be.root();
    await expect(be.create(root, SIDECAR_NAME, ulid(), "file")).rejects.toMatchObject({ errno: "EPERM" });
    await expect(be.unlink(root, SIDECAR_NAME)).rejects.toMatchObject({ errno: "EPERM" });
    await be.close();
  });

  it("unlink removes files; dirs must be empty — but a sidecar-only dir counts as empty", async () => {
    const be = await OpfsBackend.open(testRoot());
    const root = await be.root();
    const d = ulid();
    await be.create(root, "d", d, "dir");
    const f = ulid();
    await be.create(d, "kid", f, "file", { mode: 0o700 }); // mode → sidecar exists in d
    await expect(be.unlink(root, "d")).rejects.toMatchObject({ errno: "ENOTEMPTY" });
    await be.unlink(d, "kid");
    // d now contains ONLY its .wash-attrs sidecar — POSIX-empty:
    await be.unlink(root, "d");
    expect(await be.lookup(root, "d")).toBeNull();
    await expect(be.unlink(root, "ghost")).rejects.toMatchObject({ errno: "ENOENT" });
    await be.close();
  });

  it("a failed create leaves no residue and the directory stays usable", async () => {
    const be = await OpfsBackend.open(testRoot());
    const root = await be.root();
    await expect(be.create(root, SIDECAR_NAME, ulid(), "file")).rejects.toMatchObject({ errno: "EPERM" });
    expect((await be.readdir(root))).toEqual([]);
    const f = ulid();
    await be.create(root, "ok.txt", f, "file");
    expect((await be.lookup(root, "ok.txt"))?.id).toBe(f);
    await be.close();
  });

  it("a fault-injected sidecar write during create leaves no residue (T4)", async () => {
    const be = await OpfsBackend.open(testRoot(), { testHooks: true });
    const root = await be.root();
    await (be as unknown as { call: (op: string, a: unknown[]) => Promise<unknown> }).call(
      "__injectFault",
      ["sidecarWrite"],
    );
    await expect(be.create(root, "x", ulid(), "file", { mode: 0o700 })).rejects.toMatchObject({ errno: "ENOSPC" });
    expect(await be.lookup(root, "x")).toBeNull();
    expect(await be.readdir(root)).toEqual([]);
    const id2 = ulid();
    await be.create(root, "x", id2, "file"); // default mode: no sidecar write involved, must succeed
    expect((await be.lookup(root, "x"))?.id).toBe(id2);
    await be.close();
  });

  it("created entries persist across reopen", async () => {
    const rootName = testRoot();
    const be = await OpfsBackend.open(rootName);
    const root = await be.root();
    const d = ulid();
    await be.create(root, "keep", d, "dir");
    await be.create(d, "file", ulid(), "file");
    await be.close();

    const be2 = await OpfsBackend.open(rootName);
    const root2 = await be2.root();
    const dir = await be2.lookup(root2, "keep");
    expect(dir?.attrs.kind).toBe("dir");
    expect((await be2.readdir(dir!.id)).map((x) => x.name)).toEqual(["file"]);
    await be2.close();
  });
});
