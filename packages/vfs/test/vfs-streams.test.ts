import { describe, it, expect, beforeEach } from "vitest";
import { Vfs } from "../src/core/vfs.js";
import { MemoryBackend } from "../src/backend/memory.js";
import { CHUNK_SIZE } from "../src/types.js";

describe("Vfs streams + fsync + unmount", () => {
  let vfs: Vfs;
  beforeEach(async () => {
    vfs = new Vfs();
    await vfs.mount("/", new MemoryBackend());
  });

  it("streams a large file in chunks", async () => {
    const big = new Uint8Array(CHUNK_SIZE * 2 + 100).fill(7);
    await vfs.writeFile("/big", big);
    const chunks: Uint8Array[] = [];
    const rs = await vfs.createReadStream("/big");
    for await (const c of rs as unknown as AsyncIterable<Uint8Array>) chunks.push(c);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    expect(total).toBe(big.byteLength);
  });

  it("write stream writes sequentially; append mode appends", async () => {
    const ws = await vfs.createWriteStream("/out");
    const w = ws.getWriter();
    await w.write(new TextEncoder().encode("hello "));
    await w.write(new TextEncoder().encode("world"));
    await w.close();
    expect(await vfs.readTextFile("/out")).toBe("hello world");
    const as = await vfs.createWriteStream("/out", { append: true });
    const aw = as.getWriter();
    await aw.write(new TextEncoder().encode("!"));
    await aw.close();
    expect(await vfs.readTextFile("/out")).toBe("hello world!");
  });

  it("fsync flushes a write-back mount to its inner backend", async () => {
    const { CachedBackend } = await import("../src/cache/cached-backend.js");
    const inner = new MemoryBackend();
    vfs = new Vfs();
    await vfs.mount("/", new CachedBackend(inner, { flushDelayMs: 60_000 }));
    await vfs.writeFile("/f", "data");
    const root = await inner.root();
    expect(await inner.lookup(root, "f")).toBeNull();
    await vfs.fsync();
    expect(await inner.lookup(root, "f")).not.toBeNull();
  });

  it("unmount flushes and removes; refuses / and unknown paths", async () => {
    await vfs.mkdir("/mnt");
    await vfs.mount("/mnt", new MemoryBackend());
    await vfs.writeFile("/mnt/x", "1");
    await vfs.unmount("/mnt");
    await expect(vfs.stat("/mnt/x")).rejects.toMatchObject({ errno: "ENOENT" });
    await expect(vfs.unmount("/mnt")).rejects.toMatchObject({ errno: "ENOENT" });
    await expect(vfs.unmount("/")).rejects.toMatchObject({ errno: "EINVAL" });
  });

  it("exclusive mount acquires a web lock when navigator.locks exists", async () => {
    const held: string[] = [];
    const fakeLocks = {
      request: async (name: string, opts: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<unknown>) => {
        if (held.includes(name)) return cb(null);
        held.push(name);
        return cb({ name });
      },
    };
    // Node >= 21 defines a read-only `navigator` accessor on globalThis, so a
    // plain assignment throws ("has only a getter"); defineProperty replaces
    // it, and the finally-block `delete` below restores the empty state.
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: fakeLocks } });
    try {
      const v2 = new Vfs();
      await v2.mount("/", new MemoryBackend(), { exclusive: true });
      const v3 = new Vfs();
      await expect(v3.mount("/", new MemoryBackend(), { exclusive: true })).rejects.toMatchObject({ errno: "EPERM" });
    } finally {
      delete (globalThis as Record<string, unknown>).navigator;
    }
  });

  it("unmount flushes queued write-back ops before removing the mount", async () => {
    const { CachedBackend } = await import("../src/cache/cached-backend.js");
    const inner = new MemoryBackend();
    await vfs.mkdir("/mnt");
    await vfs.mount("/mnt", new CachedBackend(inner, { flushDelayMs: 60_000 }));
    await vfs.writeFile("/mnt/f", "data");
    const root = await inner.root();
    expect(await inner.lookup(root, "f")).toBeNull();
    await vfs.unmount("/mnt");
    expect(await inner.lookup(root, "f")).not.toBeNull();
  });

  it("concurrent unmounts splice the right mounts", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    class SlowFlush extends MemoryBackend {
      override async flush(): Promise<void> {
        await gate;
      }
    }
    await vfs.mkdir("/a");
    await vfs.mkdir("/b");
    await vfs.mount("/a", new SlowFlush());
    await vfs.mount("/b", new MemoryBackend());
    const pending = vfs.unmount("/a");
    await vfs.unmount("/b");
    release();
    await pending;
    expect((await vfs.stat("/")).kind).toBe("dir");
    await expect(vfs.unmount("/a")).rejects.toMatchObject({ errno: "ENOENT" });
    await expect(vfs.unmount("/b")).rejects.toMatchObject({ errno: "ENOENT" });
  });

  it("mount releases the lock when backend.root() fails after acquisition", async () => {
    const held = new Set<string>();
    const fakeLocks = {
      request: async (name: string, _opts: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<unknown>) => {
        if (held.has(name)) return cb(null);
        held.add(name);
        try {
          return await cb({ name });
        } finally {
          held.delete(name);
        }
      },
    };
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: fakeLocks } });
    try {
      const bad = new MemoryBackend();
      (bad as unknown as { root: () => Promise<string> }).root = async () => {
        throw new Error("boom");
      };
      const v = new Vfs();
      await expect(v.mount("/", bad, { exclusive: true })).rejects.toThrow("boom");
      const v2 = new Vfs();
      await v2.mount("/", new MemoryBackend(), { exclusive: true }); // lock was released
    } finally {
      delete (globalThis as Record<string, unknown>).navigator;
    }
  });

  it(
    "mount propagates lock-manager failures instead of hanging",
    async () => {
      const fakeLocks = {
        request: async () => {
          throw new Error("locks down");
        },
      };
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: fakeLocks } });
      try {
        const v = new Vfs();
        await expect(v.mount("/", new MemoryBackend(), { exclusive: true })).rejects.toThrow("locks down");
      } finally {
        delete (globalThis as Record<string, unknown>).navigator;
      }
    },
    2000,
  );
});
