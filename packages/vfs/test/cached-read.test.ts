import { describe, it, expect, beforeEach, vi } from "vitest";
import { CachedBackend } from "../src/cache/cached-backend.js";
import { MemoryBackend } from "../src/backend/memory.js";
import { ulid } from "../src/ulid.js";

describe("CachedBackend read caches", () => {
  let inner: MemoryBackend;
  let be: CachedBackend;
  let root: string;
  beforeEach(async () => {
    inner = new MemoryBackend();
    be = new CachedBackend(inner);
    root = await be.root();
  });

  it("caches lookup: second call does not hit inner", async () => {
    await be.create(root, "f", ulid(), "file");
    const spy = vi.spyOn(inner, "lookup");
    await be.lookup(root, "f");
    await be.lookup(root, "f");
    expect(spy).toHaveBeenCalledTimes(0); // create() primed the cache
  });

  it("caches negative lookups", async () => {
    const spy = vi.spyOn(inner, "lookup");
    expect(await be.lookup(root, "ghost")).toBeNull();
    expect(await be.lookup(root, "ghost")).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("create invalidates the negative entry", async () => {
    expect(await be.lookup(root, "later")).toBeNull();
    await be.create(root, "later", ulid(), "file");
    expect((await be.lookup(root, "later"))?.attrs.kind).toBe("file");
  });

  it("caches getattr and readdir; mutations update them in place", async () => {
    const f = ulid();
    await be.create(root, "f", f, "file");
    await be.readdir(root); // prime
    const rdSpy = vi.spyOn(inner, "readdir");
    const gaSpy = vi.spyOn(inner, "getattr");
    await be.write(f, 0, new TextEncoder().encode("abc"));
    expect((await be.getattr(f)).size).toBe(3);
    await be.create(root, "g", ulid(), "file");
    expect((await be.readdir(root)).map((d) => d.name).sort()).toEqual(["f", "g"]);
    await be.unlink(root, "g");
    expect((await be.readdir(root)).map((d) => d.name)).toEqual(["f"]);
    expect(rdSpy).toHaveBeenCalledTimes(0);
    expect(gaSpy).toHaveBeenCalledTimes(0);
  });

  it("rename moves the dirent between cached directories", async () => {
    const d = ulid();
    await be.create(root, "d", d, "dir");
    const f = ulid();
    await be.create(root, "f", f, "file");
    await be.readdir(root);
    await be.readdir(d);
    await be.rename(root, "f", d, "g");
    expect((await be.readdir(root)).map((x) => x.name)).toEqual(["d"]);
    expect((await be.readdir(d)).map((x) => x.name)).toEqual(["g"]);
    expect(await be.lookup(root, "f")).toBeNull();
    expect((await be.lookup(d, "g"))?.id).toBe(f);
  });

  it("mutating returned attrs does not corrupt the cache", async () => {
    const f = ulid();
    await be.create(root, "f", f, "file");
    await be.flush(); // writeback: `inner` only sees the create after a flush
    const be2 = new CachedBackend(inner); // fresh wrapper → cache-miss path
    const info = await be2.lookup(root, "f");
    info!.attrs.size = 999999;
    expect((await be2.lookup(root, "f"))?.attrs.size).toBe(0);
    expect((await be2.getattr(f)).size).toBe(0);
  });

  it("hardlink aliases stay coherent through write/link/unlink", async () => {
    const f = ulid();
    await be.create(root, "a", f, "file");
    await be.lookup(root, "a");
    await be.link!(root, "b", f);
    await be.write(f, 0, new TextEncoder().encode("xyz"));
    expect((await be.lookup(root, "a"))?.attrs.size).toBe(3);
    expect((await be.lookup(root, "b"))?.attrs.size).toBe(3);
    expect((await be.lookup(root, "b"))?.attrs.nlink).toBe(2);
    await be.unlink(root, "a");
    expect((await be.lookup(root, "b"))?.attrs.nlink).toBe(1);
    expect((await be.getattr(f)).size).toBe(3);
  });

  it("rename between two aliases of the same node is a cache-coherent no-op", async () => {
    const f = ulid();
    await be.create(root, "a", f, "file");
    await be.link!(root, "b", f);
    await be.rename(root, "a", root, "b");
    expect((await be.lookup(root, "a"))?.id).toBe(f);
    expect((await be.lookup(root, "b"))?.id).toBe(f);
    expect((await be.getattr(f)).nlink).toBe(2);
    await be.unlink(root, "b");
    expect((await be.lookup(root, "a"))?.id).toBe(f);
    expect((await be.getattr(f)).nlink).toBe(1);
  });
});
