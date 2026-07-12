import { describe, it, expect } from "vitest";
import { IndexedDBBackend } from "../src/backend.js";
import { ulid } from "@wash/vfs";

describe("IndexedDBBackend shell", () => {
  it("open bootstraps a root dir inode and persists it across reopen", async () => {
    const name = `sh-${ulid()}`;
    const be = await IndexedDBBackend.open(name);
    const root = await be.root();
    const attrs = await be.getattr(root);
    expect(attrs.kind).toBe("dir");
    expect(attrs.mode).toBe(0o755);
    be.close();
    const be2 = await IndexedDBBackend.open(name);
    expect(await be2.root()).toBe(root); // ids stable across sessions
    be2.close();
  });

  it("declares the required caps", async () => {
    const be = await IndexedDBBackend.open(`sh-${ulid()}`);
    expect(be.caps).toEqual({
      symlinks: "supported",
      hardlinks: true,
      atomicDirRename: true,
      renameCost: "O1",
    });
    be.close();
  });

  it("getattr of an unknown id throws ENOENT; setattr updates mode and mtime", async () => {
    const be = await IndexedDBBackend.open(`sh-${ulid()}`);
    await expect(be.getattr(ulid())).rejects.toMatchObject({ errno: "ENOENT" });
    const root = await be.root();
    await be.setattr(root, { mode: 0o700, mtimeMs: 12345 });
    const attrs = await be.getattr(root);
    expect(attrs.mode).toBe(0o700);
    expect(attrs.mtimeMs).toBe(12345);
    be.close();
  });

  it("flush resolves after pending work commits", async () => {
    const be = await IndexedDBBackend.open(`sh-${ulid()}`);
    await be.setattr(await be.root(), { mtimeMs: 1 });
    await be.flush();
    await be.flush(); // idempotent
    be.close();
  });

  it("ops spanning a macrotask boundary reuse a fresh txn transparently (withTx retry path)", async () => {
    const be = await IndexedDBBackend.open(`sh-${ulid()}`);
    const root = await be.root();
    await be.setattr(root, { mtimeMs: 111 });
    await new Promise((r) => setTimeout(r, 0)); // shared txn auto-commits here
    await be.setattr(root, { ctimeMs: 222 }); // must retry on a fresh txn, not throw
    const attrs = await be.getattr(root);
    expect(attrs.mtimeMs).toBe(111);
    expect(attrs.ctimeMs).toBe(222);
    be.close();
  });

  it("an aborted batch poisons ops until flush() reports and clears it", async () => {
    const be = await IndexedDBBackend.open(`sh-${ulid()}`);
    const root = await be.root();
    await be.setattr(root, { mtimeMs: 1 }); // opens the shared txn
    (be as unknown as { tx: IDBTransaction }).tx.abort(); // simulate quota/forced abort
    await new Promise((r) => setImmediate(r)); // abort event fires asynchronously (matches fake-indexeddb's dispatch)
    await expect(be.setattr(root, { mtimeMs: 2 })).rejects.toBeTruthy(); // poisoned, no suffix txn
    await expect(be.flush()).rejects.toBeTruthy(); // abort surfaced exactly once
    await be.setattr(root, { mtimeMs: 3 }); // cleared: fresh txn works
    await be.flush();
    expect((await be.getattr(root)).mtimeMs).toBe(3);
    be.close();
  });

  it("an abort is never masked by the stale-handle retry (no-wait race)", async () => {
    const be = await IndexedDBBackend.open(`sh-${ulid()}`);
    const root = await be.root();
    await be.setattr(root, { mtimeMs: 1 });
    (be as unknown as { tx: IDBTransaction }).tx.abort();
    // No wait here — this races the abort event on purpose.
    await expect(be.setattr(root, { mtimeMs: 2 })).rejects.toBeTruthy();
    await expect(be.flush()).rejects.toBeTruthy();
    await be.setattr(root, { mtimeMs: 3 });
    await be.flush();
    expect((await be.getattr(root)).mtimeMs).toBe(3);
    be.close();
  });
});
