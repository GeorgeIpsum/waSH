import { describe, it, expect, beforeEach } from "vitest";
import { IndexedDBBackend } from "../src/backend.js";
import { ulid } from "@wash/vfs";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("IndexedDBBackend content (small chunkSize to exercise boundaries)", () => {
  let be: IndexedDBBackend;
  let root: string;
  let file: string;
  beforeEach(async () => {
    be = await IndexedDBBackend.open(`ct-${ulid()}`, { chunkSize: 8 });
    root = await be.root();
    file = ulid();
    await be.create(root, "f", file, "file");
  });

  it("writes and reads across chunk boundaries", async () => {
    await be.write(file, 0, enc.encode("0123456789abcdef-tail")); // 21 bytes over 8-byte chunks
    expect(dec.decode(await be.read(file, 0, 100))).toBe("0123456789abcdef-tail");
    expect(dec.decode(await be.read(file, 6, 6))).toBe("6789ab"); // straddles chunk 0→1
    expect((await be.getattr(file)).size).toBe(21);
  });

  it("offset write past EOF zero-fills the gap (sparse chunks read as zeros)", async () => {
    await be.write(file, 20, enc.encode("end")); // chunks 0-1 never written
    const out = await be.read(file, 0, 23);
    expect(out.byteLength).toBe(23);
    expect([...out.slice(0, 20)]).toEqual(new Array(20).fill(0));
    expect(dec.decode(out.slice(20))).toBe("end");
  });

  it("read past EOF returns short result; empty file reads empty", async () => {
    await be.write(file, 0, enc.encode("hi"));
    expect((await be.read(file, 1, 100)).byteLength).toBe(1);
    expect((await be.read(file, 5, 100)).byteLength).toBe(0);
  });

  it("partial mid-file overwrite preserves surrounding bytes", async () => {
    await be.write(file, 0, enc.encode("aaaaaaaaaaaaaaaa")); // 2 full chunks
    await be.write(file, 7, enc.encode("XY")); // straddles the boundary
    expect(dec.decode(await be.read(file, 0, 100))).toBe("aaaaaaaXYaaaaaaa");
  });

  it("truncate shrinks (trimming the boundary chunk) and extends sparsely", async () => {
    await be.write(file, 0, enc.encode("0123456789abcdef"));
    await be.truncate(file, 10);
    expect(dec.decode(await be.read(file, 0, 100))).toBe("0123456789");
    await be.truncate(file, 12);
    const out = await be.read(file, 0, 100);
    expect(out.byteLength).toBe(12);
    expect([...out.slice(10)]).toEqual([0, 0]);
  });

  it("truncate to zero then rewrite works; read/write on a dir throws EISDIR", async () => {
    await be.write(file, 0, enc.encode("data"));
    await be.truncate(file, 0);
    expect((await be.read(file, 0, 100)).byteLength).toBe(0);
    await be.write(file, 0, enc.encode("new"));
    expect(dec.decode(await be.read(file, 0, 100))).toBe("new");
    await expect(be.read(root, 0, 1)).rejects.toMatchObject({ errno: "EISDIR" });
    await expect(be.write(root, 0, enc.encode("x"))).rejects.toMatchObject({ errno: "EISDIR" });
  });

  it("zero-length writes are POSIX no-ops (size, mtime, content untouched)", async () => {
    await be.write(file, 0, enc.encode("abc"));
    const before = await be.getattr(file);
    await be.write(file, 100, new Uint8Array(0));
    const after = await be.getattr(file);
    expect(after.size).toBe(3);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect((await be.read(file, 0, 10)).byteLength).toBe(3);
    await expect(be.write(root, 0, new Uint8Array(0))).rejects.toMatchObject({ errno: "EISDIR" });
  });
});
