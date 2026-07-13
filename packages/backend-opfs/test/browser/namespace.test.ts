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

describe("OpfsBackend namespace reads", () => {
  it("sees pre-existing OPFS content with stable session ids", async () => {
    const rootName = testRoot();
    // seed the directory directly through OPFS APIs
    const origin = await navigator.storage.getDirectory();
    const seed = await origin.getDirectoryHandle(rootName, { create: true });
    const sub = await seed.getDirectoryHandle("src", { create: true });
    await sub.getFileHandle("main.ts", { create: true });

    const be = await OpfsBackend.open(rootName);
    const root = await be.root();
    const dir = await be.lookup(root, "src");
    expect(dir?.attrs.kind).toBe("dir");
    const again = await be.lookup(root, "src");
    expect(again?.id).toBe(dir?.id); // session-stable ids for discovered entries
    const file = await be.lookup(dir!.id, "main.ts");
    expect(file?.attrs.kind).toBe("file");
    expect((await be.readdir(dir!.id)).map((d) => d.name)).toEqual(["main.ts"]);
    await be.close();
  });

  it("hides the sidecar from readdir and lookup", async () => {
    const rootName = testRoot();
    const origin = await navigator.storage.getDirectory();
    const seed = await origin.getDirectoryHandle(rootName, { create: true });
    const sidecar = await seed.getFileHandle(SIDECAR_NAME, { create: true });
    const w = await sidecar.createWritable();
    await w.write(JSON.stringify({ "f.txt": { mode: 0o700 } }));
    await w.close();
    await seed.getFileHandle("f.txt", { create: true });

    const be = await OpfsBackend.open(rootName);
    const root = await be.root();
    expect((await be.readdir(root)).map((d) => d.name)).toEqual(["f.txt"]);
    expect(await be.lookup(root, SIDECAR_NAME)).toBeNull();
    const f = await be.lookup(root, "f.txt");
    expect(f?.attrs.mode).toBe(0o700); // sidecar mode applied
    await be.close();
  });

  it("setattr persists mode via the sidecar across reopen; times update in-session", async () => {
    const rootName = testRoot();
    const be = await OpfsBackend.open(rootName);
    const root = await be.root();
    // create via raw OPFS seeding is not available post-open; use worker create in Task 4 —
    // for THIS task, seed before open:
    await be.close();
    const origin = await navigator.storage.getDirectory();
    const seed = await origin.getDirectoryHandle(rootName, { create: true });
    await seed.getFileHandle("script.sh", { create: true });

    const be2 = await OpfsBackend.open(rootName);
    const root2 = await be2.root();
    const f = await be2.lookup(root2, "script.sh");
    await be2.setattr(f!.id, { mode: 0o755, mtimeMs: 12345 });
    const a = await be2.getattr(f!.id);
    expect(a.mode).toBe(0o755);
    expect(a.mtimeMs).toBe(12345);
    await be2.close();

    const be3 = await OpfsBackend.open(rootName);
    const root3 = await be3.root();
    const f3 = await be3.lookup(root3, "script.sh");
    expect(f3?.attrs.mode).toBe(0o755); // sidecar persisted the mode
    await be3.close();
  });

  it("discovered files report File.lastModified, not discovery time (reopen-proof mtime)", async () => {
    const rootName = testRoot();
    const be = await OpfsBackend.open(rootName);
    const root = await be.root();
    const f = ulid();
    await be.create(root, "f.txt", f, "file");
    await be.write(f, 0, new TextEncoder().encode("content"));
    await be.flush();
    await be.close();

    await new Promise((r) => setTimeout(r, 50));
    const gap = Date.now(); // strictly after the write, strictly before rediscovery

    const be2 = await OpfsBackend.open(rootName);
    const root2 = await be2.root();
    const info = await be2.lookup(root2, "f.txt");
    expect(info!.attrs.mtimeMs).toBeLessThan(gap); // pre-fix: fabricated at lookup time (>= gap)
    await be2.close();
  });

  it("pooled getattr reports File.lastModified for an untouched, freshly-discovered file (I1)", async () => {
    const rootName = testRoot();
    const be = await OpfsBackend.open(rootName);
    const root = await be.root();
    const f = ulid();
    await be.create(root, "f.txt", f, "file");
    await be.write(f, 0, new TextEncoder().encode("content"));
    await be.flush();
    await be.close();

    await new Promise((r) => setTimeout(r, 50));
    const gap = Date.now(); // strictly after the write, strictly before rediscovery

    const be2 = await OpfsBackend.open(rootName);
    const root2 = await be2.root();
    const info = await be2.lookup(root2, "f.txt"); // discovery only: no in-session mtime yet
    await be2.read(info!.id, 0, 100); // pools a sync-access handle for the id
    const attrs = await be2.getattr(info!.id); // pre-fix: reports the discovery-time placeholder (0)
    expect(attrs.mtimeMs).toBeGreaterThan(0);
    expect(attrs.mtimeMs).toBeLessThan(gap);
    await be2.close();
  });

  it("readdir on a file throws ENOTDIR; getattr of unknown id ENOENT", async () => {
    const rootName = testRoot();
    const origin = await navigator.storage.getDirectory();
    const seed = await origin.getDirectoryHandle(rootName, { create: true });
    await seed.getFileHandle("f", { create: true });
    const be = await OpfsBackend.open(rootName);
    const root = await be.root();
    const f = await be.lookup(root, "f");
    await expect(be.readdir(f!.id)).rejects.toMatchObject({ errno: "ENOTDIR" });
    await expect(be.getattr(ulid())).rejects.toMatchObject({ errno: "ENOENT" });
    await be.close();
  });
});
