import { describe, it, expect, afterEach } from "vitest";
import { Vfs, CachedBackend, MemoryBackend, ulid } from "@wash/vfs";
import { OpfsBackend } from "@wash/backend-opfs";

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

describe("Vfs + CachedBackend + OpfsBackend end-to-end", () => {
  it("full session, reload with warming, contents intact", async () => {
    const rootName = testRoot();

    const be1 = await OpfsBackend.open(rootName);
    const vfs1 = new Vfs();
    await vfs1.mount("/", new CachedBackend(be1, { flushDelayMs: 60_000 }));
    await vfs1.mkdir("/project/src", { recursive: true });
    await vfs1.writeFile("/project/src/index.ts", "export const x = 1;\n");
    await vfs1.appendFile("/project/src/index.ts", "export const y = 2;\n");
    await vfs1.chmod("/project/src/index.ts", 0o755);
    await vfs1.symlink("/project/src/index.ts", "/project/main");
    await vfs1.rename("/project/src", "/project/lib");
    await vfs1.fsync();
    await be1.close();

    const be2 = await OpfsBackend.open(rootName);
    const cached2 = new CachedBackend(be2, { flushDelayMs: 60_000 });
    cached2.warm(await be2.dump());
    const vfs2 = new Vfs();
    await vfs2.mount("/", cached2);
    expect(await vfs2.readTextFile("/project/lib/index.ts")).toBe("export const x = 1;\nexport const y = 2;\n");
    expect((await vfs2.stat("/project/lib/index.ts")).mode).toBe(0o755); // sidecar survived the dir rename
    expect(await vfs2.readlink("/project/main")).toBe("/project/src/index.ts"); // POSIX: stale path string
    expect((await vfs2.readdir("/project")).map((d) => d.name)).toEqual(["lib", "main"]);
    await be2.close();
  });

  it("EXDEV across a memory mount and an OPFS mount", async () => {
    const be = await OpfsBackend.open(testRoot());
    const vfs = new Vfs();
    await vfs.mount("/", new MemoryBackend());
    await vfs.mkdir("/opfs");
    await vfs.mount("/opfs", new CachedBackend(be, { flushDelayMs: 1 }));
    await vfs.writeFile("/local.txt", "x");
    await expect(vfs.rename("/local.txt", "/opfs/moved.txt")).rejects.toMatchObject({ errno: "EXDEV" });
    await vfs.writeFile("/opfs/direct.txt", "y");
    await vfs.fsync();
    expect(await vfs.readTextFile("/opfs/direct.txt")).toBe("y");
    await be.close();
  });
});
