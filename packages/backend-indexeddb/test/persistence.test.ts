import { describe, it, expect } from "vitest";
import { IndexedDBBackend } from "../src/backend.js";
import { ulid } from "@wash/vfs";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("persistence across reopen", () => {
  it("namespace, content, links, and ids survive close/reopen", async () => {
    const name = `persist-${ulid()}`;
    const be = await IndexedDBBackend.open(name, { chunkSize: 8 });
    const root = await be.root();
    const d = ulid();
    const f = ulid();
    await be.create(root, "dir", d, "dir");
    await be.create(d, "file.txt", f, "file");
    await be.write(f, 0, enc.encode("persisted content"));
    await be.link!(d, "hard", f);
    await be.symlink!(root, "ln", ulid(), "/dir/file.txt");
    await be.flush();
    be.close();

    const be2 = await IndexedDBBackend.open(name, { chunkSize: 8 });
    expect(await be2.root()).toBe(root);
    expect((await be2.lookup(root, "dir"))?.id).toBe(d);
    expect((await be2.lookup(d, "file.txt"))?.id).toBe(f);
    expect(dec.decode(await be2.read(f, 0, 100))).toBe("persisted content");
    expect((await be2.getattr(f)).nlink).toBe(2);
    expect(await be2.readlink!((await be2.lookup(root, "ln"))!.id)).toBe("/dir/file.txt");
    be2.close();
  });

  it("uncommitted shared-txn work still lands once control returns to the event loop", async () => {
    const name = `persist2-${ulid()}`;
    const be = await IndexedDBBackend.open(name);
    const root = await be.root();
    await be.create(root, "x", ulid(), "file");
    // no explicit flush(): the shared txn auto-commits at the macrotask boundary
    await new Promise((r) => setTimeout(r, 0));
    be.close();
    const be2 = await IndexedDBBackend.open(name);
    expect((await be2.lookup(root, "x"))?.attrs.kind).toBe("file");
    be2.close();
  });
});
