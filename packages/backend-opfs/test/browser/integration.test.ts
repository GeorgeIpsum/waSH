import { describe, it, expect, afterEach } from "vitest";
import { Vfs, CachedBackend, MemoryBackend, ulid } from "@wash/vfs";
import { OpfsBackend } from "@wash/backend-opfs";
const roots: string[] = [];
function testRoot(): string { const n = `wash-test-${ulid()}`; roots.push(n); return n; }
afterEach(async () => {
  const o = await navigator.storage.getDirectory();
  for (const n of roots.splice(0)) await o.removeEntry(n, { recursive: true }).catch(() => {});
});

describe("Vfs + CachedBackend + OpfsBackend (manifest) end-to-end", () => {
  it("full session, reload with warming, contents + modes + hardlink intact", async () => {
    const name = testRoot();
    const be1 = await OpfsBackend.open(name);
    const vfs1 = new Vfs();
    await vfs1.mount("/", new CachedBackend(be1, { flushDelayMs: 60_000 }));
    await vfs1.mkdir("/project/src", { recursive: true });
    await vfs1.writeFile("/project/src/index.ts", "export const x = 1;\n");
    await vfs1.appendFile("/project/src/index.ts", "export const y = 2;\n");
    await vfs1.chmod("/project/src/index.ts", 0o755);
    await vfs1.link("/project/src/index.ts", "/project/hardlink.ts"); // hardlinks now supported
    await vfs1.symlink("/project/src/index.ts", "/project/main");
    await vfs1.rename("/project/src", "/project/lib"); // O(1) atomic dir rename
    await vfs1.fsync();
    await be1.close();

    const be2 = await OpfsBackend.open(name);
    const cached2 = new CachedBackend(be2, { flushDelayMs: 60_000 });
    cached2.warm(await be2.dump());
    const vfs2 = new Vfs();
    await vfs2.mount("/", cached2);
    expect(await vfs2.readTextFile("/project/lib/index.ts")).toBe("export const x = 1;\nexport const y = 2;\n");
    expect((await vfs2.stat("/project/lib/index.ts")).mode).toBe(0o755);
    expect(await vfs2.readTextFile("/project/hardlink.ts")).toBe("export const x = 1;\nexport const y = 2;\n");
    expect(await vfs2.readlink("/project/main")).toBe("/project/src/index.ts"); // POSIX stale path
    expect((await vfs2.stat("/project/lib/index.ts")).nlink).toBe(2);
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
