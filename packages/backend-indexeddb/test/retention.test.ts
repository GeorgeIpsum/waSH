import { describe, it, expect } from "vitest";
import { ulid } from "@wash/vfs";
import { IndexedDBBackend } from "../src/backend.js";
import { openDb, req } from "../src/idb.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("IndexedDBBackend retain/release (F4)", () => {
  it("caps.fdRetention is true", async () => {
    const be = await IndexedDBBackend.open(`ret-${ulid()}`);
    expect(be.caps.fdRetention).toBe(true);
  });

  it("retain keeps an unlinked inode readable; the last release reclaims it", async () => {
    const be = await IndexedDBBackend.open(`ret-${ulid()}`);
    const root = await be.root();
    const f = ulid();
    await be.create(root, "f", f, "file");
    await be.write(f, 0, enc.encode("keep"));

    await be.retain!(f); // an fd references it
    await be.unlink(root, "f"); // nlink -> 0, but retained
    expect(dec.decode(await be.read(f, 0, 100))).toBe("keep"); // anonymous inode still readable
    expect((await be.getattr(f)).nlink).toBe(0);

    await be.release!(f); // last reference dropped -> reclaimed
    await expect(be.getattr(f)).rejects.toMatchObject({ errno: "ENOENT" });
  });

  it("rename-over a retained target keeps it alive until release", async () => {
    const be = await IndexedDBBackend.open(`ret-${ulid()}`);
    const root = await be.root();
    const a = ulid();
    const b = ulid();
    await be.create(root, "a", a, "file");
    await be.create(root, "b", b, "file");
    await be.write(b, 0, enc.encode("bbb"));

    await be.retain!(b); // fd on b
    await be.rename(root, "a", root, "b"); // b displaced (nlink -> 0), retained
    expect(dec.decode(await be.read(b, 0, 100))).toBe("bbb");
    expect((await be.getattr(b)).nlink).toBe(0);

    await be.release!(b);
    await expect(be.getattr(b)).rejects.toMatchObject({ errno: "ENOENT" });
  });

  it("retain on an unknown id rejects ENOENT; release on an unknown id does not reject", async () => {
    const be = await IndexedDBBackend.open(`ret-${ulid()}`);
    const unknown = ulid();
    await expect(be.retain!(unknown)).rejects.toMatchObject({ errno: "ENOENT" });
    await expect(be.release!(unknown)).resolves.toBeUndefined();
  });

  it("crash-reopen sweep: an nlink:0 orphan unreachable to a fresh instance is dropped on open, and its data chunks are gone", async () => {
    const name = `ret-${ulid()}`;
    const be1 = await IndexedDBBackend.open(name);
    const root1 = await be1.root();
    const f = ulid();
    await be1.create(root1, "f", f, "file");
    await be1.write(f, 0, enc.encode("orphaned"));
    await be1.retain!(f); // an fd references it
    await be1.unlink(root1, "f"); // nlink -> 0, but retained: record + chunks survive
    await be1.flush(); // persist the nlink:0 (retained) record
    await be1.close(); // simulates a crash: the in-memory retains map is discarded
    // (this is the crash-safety premise: retain-count is never persisted)

    const be2 = await IndexedDBBackend.open(name); // fresh instance: retains map starts empty
    // the orphan is unreachable (no dirent, nlink 0, no live retain) — swept at open, not just hidden
    await expect(be2.getattr(f)).rejects.toMatchObject({ errno: "ENOENT" });
    await be2.close();

    // Verify the "data" store has no leftover chunks for f (not just that the inode is gone).
    const raw = await openDb(name);
    const tx = raw.transaction("data", "readonly");
    const keys = (await req(tx.objectStore("data").getAllKeys())) as [string, number][];
    raw.close();
    expect(keys.some(([id]) => id === f)).toBe(false);
  });

  it("a concurrent open is rejected EBUSY — the sweep can't delete a live instance's retained inode", async (ctx) => {
    // Browser-only: needs the Web Locks API. Under fake-indexeddb (Node) there is no lock,
    // so a concurrent open is not rejected; this single-writer guarantee holds where Web
    // Locks exists (the real deployment target).
    if (!(globalThis as { navigator?: { locks?: unknown } }).navigator?.locks) return ctx.skip();
    const name = `ret-conc-${ulid()}`;
    const a = await IndexedDBBackend.open(name);
    const root = await a.root();
    const f = ulid();
    await a.create(root, "f", f, "file");
    await a.write(f, 0, enc.encode("live"));
    await a.retain!(f);
    await a.unlink(root, "f"); // f: nlink 0, retained by a's open fd, persisted below
    await a.flush();
    // A second concurrent open of the same db must be rejected — otherwise its open-time
    // sweep would delete f's inode+chunks while a still reads it through the fd.
    await expect(IndexedDBBackend.open(name)).rejects.toMatchObject({ errno: "EBUSY" });
    expect(dec.decode(await a.read(f, 0, 100))).toBe("live"); // a's retained data intact
    await a.close();
    // After a closes (releasing the lock), a fresh open acquires it and sweeps the now-unreferenced orphan.
    const b = await IndexedDBBackend.open(name);
    await expect(b.getattr(f)).rejects.toMatchObject({ errno: "ENOENT" });
    await b.close();
  });
});
