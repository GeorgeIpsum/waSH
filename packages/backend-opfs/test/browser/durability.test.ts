import { describe, it, expect, afterEach } from "vitest";
import { OpfsBackend } from "@wash/backend-opfs";
import { ulid } from "@wash/vfs";
const enc = new TextEncoder();
const dec = new TextDecoder();
const roots: string[] = [];
function testRoot(): string { const n = `wash-test-${ulid()}`; roots.push(n); return n; }
afterEach(async () => {
  const o = await navigator.storage.getDirectory();
  for (const n of roots.splice(0)) await o.removeEntry(n, { recursive: true }).catch(() => {});
});
function fault(be: unknown) {
  return (be as { call: (op: string, a: unknown[]) => Promise<unknown> }).call.bind(be) as
    (op: string, a: unknown[]) => Promise<unknown>;
}

describe("OpfsBackend durability + GC", () => {
  it("a torn manifest-slot write falls back to the prior generation on reopen", async () => {
    const name = testRoot();
    const be = await OpfsBackend.open(name, { testHooks: true });
    const root = await be.root();
    await be.create(root, "safe", ulid(), "file");
    await be.flush(); // commits generation 1 (slot a)
    const c = fault(be);
    await c("__injectFault", ["slotWrite", 0, 1]); // next generation write tears
    await be.create(root, "doomed", ulid(), "file");
    await expect(be.flush()).rejects.toBeTruthy(); // slot write fails; working rolled back
    await be.close();
    const be2 = await OpfsBackend.open(name);
    const root2 = await be2.root();
    expect((await be2.lookup(root2, "safe"))?.id).toBeTruthy(); // gen 1 intact
    expect(await be2.lookup(root2, "doomed")).toBeNull();        // torn gen 2 discarded
    await be2.close();
  });

  it("a blob-flush failure aborts the commit and rolls the working manifest back", async () => {
    const be = await OpfsBackend.open(testRoot(), { testHooks: true });
    const root = await be.root();
    const f = ulid();
    await be.create(root, "f", f, "file");
    await be.write(f, 0, enc.encode("data"));
    const c = fault(be);
    await c("__injectFault", ["blobFlush", 0, 1]); // blob flush during commit fails
    await expect(be.flush()).rejects.toMatchObject({ errno: "ENOSPC" });
    // whole-batch rollback: the uncommitted file is dropped from the working manifest
    expect(await be.lookup(root, "f")).toBeNull();
    await be.flush(); // fault consumed (times:1) → clean commit succeeds
    await be.close();
  });

  it("union GC preserves a blob still referenced by a retained (fallback) generation", async () => {
    const name = testRoot();
    const be = await OpfsBackend.open(name, { testHooks: true });
    const root = await be.root();
    const x = ulid();
    await be.create(root, "x", x, "file");
    await be.write(x, 0, enc.encode("valuable"));
    await be.flush();            // gen 1 → slot a; references x
    await be.unlink(root, "x");  // working manifest drops x (deferred delete: blob NOT removed)
    await be.flush();            // gen 2 → slot b; does NOT reference x. But gen 1 (slot a) is retained.
    // x is gone from the working namespace, yet its blob must survive (referenced by retained gen 1)
    expect(await be.lookup(root, "x")).toBeNull();
    await fault(be)("gc", []);   // GC must keep x's blob: gen 1 (fallback) still references it
    // x's blob is still on disk (reachable from the retained gen 1)
    const origin = await navigator.storage.getDirectory();
    const blobDir = await (await origin.getDirectoryHandle(name)).getDirectoryHandle("blobs");
    const names: string[] = [];
    for await (const n of (blobDir as unknown as { keys(): AsyncIterableIterator<string> }).keys()) names.push(n);
    expect(names.some((n) => n.startsWith(x))).toBe(true);
    await be.close();
  });

  it("both manifest slots corrupt → open rejects EIO and does NOT GC blobs", async () => {
    const name = testRoot();
    const be = await OpfsBackend.open(name);
    const root = await be.root();
    const f = ulid();
    await be.create(root, "f", f, "file");
    await be.write(f, 0, enc.encode("keep"));
    await be.flush();
    await be.close();
    const origin = await navigator.storage.getDirectory();
    const dir = await origin.getDirectoryHandle(name);
    for (const slot of ["manifest.a", "manifest.b"]) {
      const fh = await dir.getFileHandle(slot, { create: true });
      // `createSyncAccessHandle` is worker-only (not exposed on the main thread in any
      // browser — see https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createSyncAccessHandle);
      // this test file runs on the main thread, so use the async writable stream instead.
      // `createWritable()` truncates the file by default, so the write below fully replaces
      // its contents with garbage bytes.
      const w = await fh.createWritable();
      await w.write(enc.encode("garbage"));
      await w.close();
    }
    await expect(OpfsBackend.open(name)).rejects.toMatchObject({ errno: "EIO" });
    // blobs untouched: the file's chunk still present
    const blobDir = await dir.getDirectoryHandle("blobs");
    const names: string[] = [];
    for await (const n of (blobDir as unknown as { keys(): AsyncIterableIterator<string> }).keys()) names.push(n);
    expect(names.some((n) => n.startsWith(f))).toBe(true);
  });

  it("unreadable manifest slots (not NotFound) → open rejects EIO and does NOT GC blobs", async () => {
    const name = testRoot();
    const be = await OpfsBackend.open(name);
    const root = await be.root();
    const f = ulid();
    await be.create(root, "f", f, "file");
    await be.write(f, 0, enc.encode("keep"));
    await be.flush();
    await be.close();
    const origin = await navigator.storage.getDirectory();
    const dir = await origin.getDirectoryHandle(name);
    // Replace each manifest slot FILE with a DIRECTORY of the same name → getFileHandle
    // throws TypeMismatchError (a non-NotFound read error), which must NOT be seen as "absent".
    for (const slot of ["manifest.a", "manifest.b"]) {
      await dir.removeEntry(slot).catch(() => {});
      await dir.getDirectoryHandle(slot, { create: true });
    }
    await expect(OpfsBackend.open(name)).rejects.toMatchObject({ errno: "EIO" });
    // blobs must survive (no empty-init GC)
    const blobDir = await dir.getDirectoryHandle("blobs");
    const names: string[] = [];
    for await (const n of (blobDir as unknown as { keys(): AsyncIterableIterator<string> }).keys()) names.push(n);
    expect(names.some((n) => n.startsWith(f))).toBe(true);
  });

  it("failed flush rolls back an in-place OVERWRITE — committed content is not corrupted", async () => {
    const name = testRoot();
    const be = await OpfsBackend.open(name, { testHooks: true });
    const root = await be.root();
    const f = ulid();
    await be.create(root, "f", f, "file");
    await be.write(f, 0, enc.encode("AAAA"));
    await be.flush();                      // commit F="AAAA"
    await be.write(f, 0, enc.encode("BB")); // in-place overwrite → blob physically "BBAA"
    await fault(be)("__injectFault", ["blobFlush", 0, 1]);
    await expect(be.flush()).rejects.toMatchObject({ errno: "ENOSPC" }); // rollback restores content
    expect(dec.decode(await be.read(f, 0, 4))).toBe("AAAA"); // NOT "BBAA"
    await be.close();
    const be2 = await OpfsBackend.open(name);
    const f2 = await be2.lookup(await be2.root(), "f");
    expect(dec.decode(await be2.read(f2!.id, 0, 4))).toBe("AAAA"); // survives reopen
    await be2.close();
  });

  it("failed flush rolls back a TRUNCATE-shrink — the discarded tail is restored", async () => {
    const name = testRoot();
    const be = await OpfsBackend.open(name, { testHooks: true });
    const root = await be.root();
    const f = ulid();
    await be.create(root, "f", f, "file");
    const N = 70000;
    const payload = new Uint8Array(N);
    for (let i = 0; i < N; i++) payload[i] = (i % 250) + 1; // non-zero, so "zeros" corruption is detectable
    await be.write(f, 0, payload);
    await be.flush();                       // commit F size 70000
    await be.truncate(f, 5000);             // eager physical shrink (delete tail + shrink boundary)
    await fault(be)("__injectFault", ["blobFlush", 0, 1]);
    await expect(be.flush()).rejects.toMatchObject({ errno: "ENOSPC" }); // rollback restores blobs
    expect((await be.getattr(f)).size).toBe(N); // manifest rolled back to 70000
    const back = await be.read(f, 0, N);
    expect(back.byteLength).toBe(N);
    expect([...back]).toEqual([...payload]); // original bytes restored, NOT zeros
    await be.close();
    const be2 = await OpfsBackend.open(name);
    const f2 = await be2.lookup(await be2.root(), "f");
    const back2 = await be2.read(f2!.id, 0, N);
    expect([...back2]).toEqual([...payload]); // survives reopen
    await be2.close();
  });

  it("rollback restores committed content even when the mutated chunk was NOT pooled (cross-session)", async () => {
    const name = testRoot();
    const be = await OpfsBackend.open(name);
    const root = await be.root();
    const f = ulid();
    await be.create(root, "f", f, "file");
    await be.write(f, 0, enc.encode("AAAA"));
    await be.flush();
    await be.close(); // pool emptied; chunk is on disk only

    // Reopen with a FRESH worker (empty pool): the first mutation of this
    // committed chunk must snapshot its bytes from DISK, not record it absent.
    const be2 = await OpfsBackend.open(name, { testHooks: true });
    const f2 = (await be2.lookup(await be2.root(), "f"))!.id;
    await be2.write(f2, 0, enc.encode("BB")); // unpooled snapshot path
    await fault(be2)("__injectFault", ["blobFlush", 0, 1]);
    await expect(be2.flush()).rejects.toMatchObject({ errno: "ENOSPC" });
    // If snapshot had wrongly recorded the chunk absent, rollback would have
    // DELETED it → this read would be empty/zeros. It must be the committed "AAAA".
    expect(dec.decode(await be2.read(f2, 0, 4))).toBe("AAAA");
    await be2.close();
  });
});
