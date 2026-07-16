import { describe, it, expect, afterEach } from "vitest";
import { OpfsBackend } from "@wash/backend-opfs";
import { ulid } from "@wash/vfs";
const enc = new TextEncoder();
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
});
