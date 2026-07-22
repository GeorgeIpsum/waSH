import { describe, it, expect, afterAll } from "vitest";
import { ulid } from "@wash/vfs";
import { OpfsBackend } from "@wash/backend-opfs";

const enc = new TextEncoder();
const dec = new TextDecoder();

const roots: string[] = [];
const opened: OpfsBackend[] = [];
afterAll(async () => {
  await Promise.all(opened.splice(0).map((be) => be.close().catch(() => {})));
  const origin = await navigator.storage.getDirectory();
  for (const name of roots.splice(0)) {
    await origin.removeEntry(name, { recursive: true }).catch(() => {});
  }
});

function freshRoot(): string {
  const name = `wash-retain-${ulid()}`;
  roots.push(name);
  return name;
}

async function freshBackend(): Promise<OpfsBackend> {
  const be = await OpfsBackend.open(freshRoot());
  opened.push(be);
  return be;
}

describe("OpfsBackend retain/release (F4)", () => {
  it("caps.fdRetention is true", async () => {
    const be = await freshBackend();
    expect(be.caps.fdRetention).toBe(true);
  });

  it("retain keeps an unlinked inode readable; the last release reclaims it", async () => {
    const be = await freshBackend();
    const root = await be.root();
    const f = ulid();
    await be.create(root, "f", f, "file");
    await be.write(f, 0, enc.encode("keep"));

    await be.retain(f); // an fd references it
    await be.unlink(root, "f"); // nlink -> 0, but retained
    expect(dec.decode(await be.read(f, 0, 100))).toBe("keep"); // anonymous inode still readable
    expect((await be.getattr(f)).nlink).toBe(0);

    await be.release(f); // last reference dropped -> reclaimed
    await expect(be.getattr(f)).rejects.toMatchObject({ errno: "ENOENT" });
  });

  it("retain on an unknown id rejects ENOENT; release on an unknown id does not reject", async () => {
    const be = await freshBackend();
    const unknown = ulid();
    await expect(be.retain(unknown)).rejects.toMatchObject({ errno: "ENOENT" });
    await expect(be.release(unknown)).resolves.toBeUndefined();
  });

  it("crash-reopen sweep: an nlink:0 orphan unreachable to a fresh worker is dropped on open, and its blob is reclaimed once both on-disk generations rotate past it", async () => {
    const name = freshRoot();
    const be1 = await OpfsBackend.open(name);
    const root1 = await be1.root();
    const f = ulid();
    await be1.create(root1, "f", f, "file");
    await be1.write(f, 0, enc.encode("orphaned"));
    await be1.retain(f); // an fd references it
    await be1.unlink(root1, "f"); // nlink -> 0, but retained: record + blob survive on disk
    await be1.flush(); // persist the nlink:0 (retained) record
    await be1.close(); // releases the single-writer lock; the in-memory retains map is discarded
                        // (this is the crash-safety premise: retain-count is never persisted)

    const be2 = await OpfsBackend.open(name); // fresh worker: retains map starts empty
    const root2 = await be2.root();
    // the orphan is unreachable (no dirent, nlink 0, no live retain) — swept at open, not just hidden
    await expect(be2.getattr(f)).rejects.toMatchObject({ errno: "ENOENT" });

    // Force both on-disk manifest slots to rotate past the swept generation (mirrors the
    // durability suite's "union GC preserves a fallback-referenced blob" mechanics, but for
    // the case where BOTH retained generations have moved on): two more commits guarantee
    // neither slot's fallback generation still resolves f's chunk.
    await be2.create(root2, "d1", ulid(), "file");
    await be2.flush();
    await be2.create(root2, "d2", ulid(), "file");
    await be2.flush();
    await (be2 as unknown as { call: (op: string, a: unknown[]) => Promise<unknown> }).call("gc", []);

    const origin = await navigator.storage.getDirectory();
    const blobDir = await (await origin.getDirectoryHandle(name)).getDirectoryHandle("blobs");
    const names: string[] = [];
    for await (const n of (blobDir as unknown as { keys(): AsyncIterableIterator<string> }).keys()) {
      names.push(n);
    }
    expect(names.some((n) => n.startsWith(f))).toBe(false); // f's chunk file is gone
  });
});
