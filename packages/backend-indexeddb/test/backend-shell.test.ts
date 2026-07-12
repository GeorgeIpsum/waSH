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
});
