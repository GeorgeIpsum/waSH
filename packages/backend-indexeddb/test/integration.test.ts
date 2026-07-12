import { describe, it, expect } from "vitest";
import { Vfs, CachedBackend, MemoryBackend, ulid } from "@wash/vfs";
import { IndexedDBBackend } from "../src/backend.js";

describe("Vfs + CachedBackend + IndexedDBBackend end-to-end", () => {
  it("full session: tree, content, links, fsync, simulated reload with warming", async () => {
    const dbName = `e2e-${ulid()}`;

    // Session 1
    const be1 = await IndexedDBBackend.open(dbName);
    const cached1 = new CachedBackend(be1, { flushDelayMs: 60_000 });
    const vfs1 = new Vfs();
    await vfs1.mount("/", cached1);
    await vfs1.mkdir("/project/src", { recursive: true });
    await vfs1.writeFile("/project/src/index.ts", "export const x = 1;\n");
    await vfs1.appendFile("/project/src/index.ts", "export const y = 2;\n");
    await vfs1.symlink("/project/src/index.ts", "/project/main");
    await vfs1.rename("/project/src/index.ts", "/project/src/main.ts");
    await vfs1.fsync();
    be1.close();

    // Session 2 (simulated reload): reopen, warm, verify
    const be2 = await IndexedDBBackend.open(dbName);
    const cached2 = new CachedBackend(be2, { flushDelayMs: 60_000 });
    cached2.warm(await be2.dump!());
    const vfs2 = new Vfs();
    await vfs2.mount("/", cached2);
    expect(await vfs2.readTextFile("/project/src/main.ts")).toBe("export const x = 1;\nexport const y = 2;\n");
    expect(await vfs2.readlink("/project/main")).toBe("/project/src/index.ts"); // symlink target is a path string, unaffected by the rename
    expect((await vfs2.readdir("/project")).map((d) => d.name)).toEqual(["main", "src"]);
    be2.close();
  });

  it("EXDEV across a memory mount and an IDB mount", async () => {
    const be = await IndexedDBBackend.open(`e2e-${ulid()}`);
    const vfs = new Vfs();
    await vfs.mount("/", new MemoryBackend());
    await vfs.mkdir("/idb");
    await vfs.mount("/idb", new CachedBackend(be, { flushDelayMs: 1 }));
    await vfs.writeFile("/local.txt", "x");
    await expect(vfs.rename("/local.txt", "/idb/moved.txt")).rejects.toMatchObject({ errno: "EXDEV" });
    await vfs.writeFile("/idb/direct.txt", "y");
    await vfs.fsync();
    expect(await vfs.readTextFile("/idb/direct.txt")).toBe("y");
    be.close();
  });
});
