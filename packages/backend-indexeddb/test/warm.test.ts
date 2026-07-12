import { describe, it, expect } from "vitest";
import { IndexedDBBackend } from "../src/backend.js";
import { CachedBackend, ulid } from "@wash/vfs";

describe("IndexedDBBackend.dump + CachedBackend.warm", () => {
  it("dump round-trips the full namespace into a warm cache", async () => {
    const be = await IndexedDBBackend.open(`warm-${ulid()}`);
    const root = await be.root();
    const d = ulid();
    await be.create(root, "src", d, "dir");
    for (let i = 0; i < 25; i++) await be.create(d, `file-${i}.ts`, ulid(), "file");
    const dump = await be.dump!();
    expect(dump.inodes.length).toBe(27); // root + dir + 25 files
    expect(dump.dirents.length).toBe(26);
    const cached = new CachedBackend(be);
    cached.warm(dump);
    expect((await cached.readdir(d)).length).toBe(25);
    expect((await cached.lookup(root, "src"))?.id).toBe(d);
  });
});
