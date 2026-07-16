import { describe, it, expect, afterEach } from "vitest";
import { OpfsBackend } from "@wash/backend-opfs";
import { ulid } from "@wash/vfs";
const enc = new TextEncoder(), dec = new TextDecoder();
const roots: string[] = [];
function testRoot(): string { const n = `wash-test-${ulid()}`; roots.push(n); return n; }
afterEach(async () => {
  const o = await navigator.storage.getDirectory();
  for (const n of roots.splice(0)) await o.removeEntry(n, { recursive: true }).catch(() => {});
});

async function fileFixture(chunkless = false) {
  const be = await OpfsBackend.open(testRoot(), { handlePoolSize: 4 });
  const root = await be.root();
  const f = ulid();
  await be.create(root, "f", f, "file");
  return { be, root, f };
}

describe("OpfsBackend content", () => {
  it("write/read with offsets, EOF clamp, sparse gap zero-fill", async () => {
    const { be, f } = await fileFixture();
    await be.write(f, 0, enc.encode("hello world"));
    expect(dec.decode(await be.read(f, 0, 100))).toBe("hello world");
    expect(dec.decode(await be.read(f, 6, 5))).toBe("world");
    expect((await be.read(f, 11, 10)).byteLength).toBe(0);
    await be.write(f, 20, enc.encode("far"));
    const out = await be.read(f, 0, 100);
    expect(out.byteLength).toBe(23);
    expect([...out.slice(11, 20)]).toEqual(new Array(9).fill(0));
    expect((await be.getattr(f)).size).toBe(23);
    await be.close();
  });

  it("zero-length write no-op; EISDIR on dirs; truncate shrink+sparse-extend; persists", async () => {
    const name = testRoot();
    const be = await OpfsBackend.open(name);
    const root = await be.root();
    const f = ulid();
    await be.create(root, "t", f, "file");
    await be.write(f, 0, enc.encode("0123456789"));
    const before = await be.getattr(f);
    await be.write(f, 100, new Uint8Array(0));
    expect((await be.getattr(f)).size).toBe(10);
    expect((await be.getattr(f)).mtimeMs).toBe(before.mtimeMs);
    await expect(be.write(root, 0, enc.encode("x"))).rejects.toMatchObject({ errno: "EISDIR" });
    await expect(be.read(root, 0, 1)).rejects.toMatchObject({ errno: "EISDIR" });
    await be.truncate(f, 4);
    expect(dec.decode(await be.read(f, 0, 100))).toBe("0123");
    await be.truncate(f, 6);
    const out = await be.read(f, 0, 100);
    expect(out.byteLength).toBe(6);
    expect([...out.slice(4)]).toEqual([0, 0]);
    await be.flush();
    await be.close();
    const be2 = await OpfsBackend.open(name);
    const f2 = await be2.lookup(await be2.root(), "t");
    expect((await be2.read(f2!.id, 0, 100)).byteLength).toBe(6);
    await be2.close();
  });

  it("handle pool evicts beyond capacity without corrupting content", async () => {
    const be = await OpfsBackend.open(testRoot(), { handlePoolSize: 2 });
    const root = await be.root();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const f = ulid();
      await be.create(root, `f${i}`, f, "file");
      await be.write(f, 0, enc.encode(`content-${i}`));
      ids.push(f);
    }
    for (let i = 0; i < 5; i++) expect(dec.decode(await be.read(ids[i]!, 0, 100))).toBe(`content-${i}`);
    await be.close();
  });
});
