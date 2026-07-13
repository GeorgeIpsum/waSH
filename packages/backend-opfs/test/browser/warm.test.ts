import { describe, it, expect, afterEach } from "vitest";
import { OpfsBackend } from "@wash/backend-opfs";
import { CachedBackend, ulid } from "@wash/vfs";

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

describe("OpfsBackend dump + warm", () => {
  it("dump round-trips the namespace into a warm cache", async () => {
    const be = await OpfsBackend.open(testRoot());
    const root = await be.root();
    const d = ulid();
    await be.create(root, "src", d, "dir");
    for (let i = 0; i < 10; i++) await be.create(d, `f${i}.ts`, ulid(), "file");
    await be.symlink(root, "ln", ulid(), "/src/f0.ts");
    const dump = await be.dump();
    expect(dump.inodes.length).toBe(13); // root + dir + 10 files + symlink
    expect(dump.dirents.length).toBe(12);
    const cached = new CachedBackend(be);
    cached.warm(dump);
    expect((await cached.readdir(d)).length).toBe(10);
    expect((await cached.lookup(root, "src"))?.id).toBe(d);
    expect(await cached.lookup(d, "nope")).toBeNull(); // complete-dir negative, no worker call
    await be.close();
  });
});
