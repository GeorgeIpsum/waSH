import { bench, describe } from "vitest";
import { CachedBackend, MemoryBackend, ulid, type WashBackend } from "@wash/vfs";
import { IndexedDBBackend } from "@wash/backend-indexeddb";

const enc = new TextEncoder();
const FILES = 200;

async function populated(be: WashBackend): Promise<{ be: WashBackend; root: string; dir: string; ids: string[] }> {
  const root = await be.root();
  const dir = ulid();
  await be.create(root, "src", dir, "dir");
  const ids: string[] = [];
  for (let i = 0; i < FILES; i++) {
    const id = ulid();
    await be.create(dir, `file-${i}.ts`, id, "file");
    ids.push(id);
  }
  await be.flush();
  return { be, root, dir, ids };
}

const memory = await populated(new MemoryBackend());
const idb = await populated(await IndexedDBBackend.open(`bench-${ulid()}`));
const cachedIdb = await populated(new CachedBackend(await IndexedDBBackend.open(`benchc-${ulid()}`), { flushDelayMs: 50 }));

for (const [label, ctx] of [["MemoryBackend", memory], ["IndexedDBBackend", idb], ["CachedBackend(IDB)", cachedIdb]] as const) {
  describe(`${label}: metadata hot paths`, () => {
    bench("lookup hit", async () => {
      await ctx.be.lookup(ctx.dir, "file-42.ts");
    });
    bench("lookup miss (PATH-probe shape)", async () => {
      await ctx.be.lookup(ctx.dir, "no-such-command");
    });
    bench(`readdir (${FILES} entries)`, async () => {
      await ctx.be.readdir(ctx.dir);
    });
    bench("getattr", async () => {
      await ctx.be.getattr(ctx.ids[7]!);
    });
  });

  describe(`${label}: create+unlink cycle`, () => {
    bench("create then unlink", async () => {
      const id = ulid();
      await ctx.be.create(ctx.root, `tmp-${id}`, id, "file");
      await ctx.be.unlink(ctx.root, `tmp-${id}`);
    });
  });
}

describe("IDB chunk-size sweep: 1 MiB sequential write+read", () => {
  const payload = new Uint8Array(1024 * 1024).map((_, i) => i & 0xff);
  for (const kib of [16, 64, 256]) {
    bench(`chunkSize ${kib} KiB`, async () => {
      const be = await IndexedDBBackend.open(`sweep-${ulid()}`, { chunkSize: kib * 1024 });
      const root = await be.root();
      const id = ulid();
      await be.create(root, "blob", id, "file");
      await be.write(id, 0, payload);
      await be.read(id, 0, payload.byteLength);
      await be.flush();
      be.close();
    });
  }
  bench("append 4 KiB x64 (log-writer shape, 64 KiB chunks)", async () => {
    const be = await IndexedDBBackend.open(`sweep-${ulid()}`);
    const root = await be.root();
    const id = ulid();
    await be.create(root, "log", id, "file");
    const line = enc.encode("x".repeat(4096));
    for (let i = 0; i < 64; i++) await be.write(id, i * 4096, line);
    await be.flush();
    be.close();
  });
});
