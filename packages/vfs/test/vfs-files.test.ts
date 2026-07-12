import { describe, it, expect, beforeEach } from "vitest";
import { Vfs } from "../src/core/vfs.js";
import { MemoryBackend } from "../src/backend/memory.js";

const enc = new TextEncoder();

describe("Vfs file io", () => {
  let vfs: Vfs;
  beforeEach(async () => {
    vfs = new Vfs();
    await vfs.mount("/", new MemoryBackend());
  });

  it("writeFile / readFile / readTextFile roundtrip", async () => {
    await vfs.writeFile("/f.txt", "hello");
    expect(await vfs.readTextFile("/f.txt")).toBe("hello");
    expect(await vfs.readFile("/f.txt")).toEqual(enc.encode("hello"));
  });

  it("writeFile truncates existing content", async () => {
    await vfs.writeFile("/f.txt", "long content");
    await vfs.writeFile("/f.txt", "hi");
    expect(await vfs.readTextFile("/f.txt")).toBe("hi");
  });

  it("appendFile appends; 'a' fd appends regardless of position", async () => {
    await vfs.writeFile("/log", "one\n");
    await vfs.appendFile("/log", "two\n");
    expect(await vfs.readTextFile("/log")).toBe("one\ntwo\n");
  });

  it("open flags: r missing ENOENT, wx existing EEXIST, write on r EBADF", async () => {
    await expect(vfs.open("/nope", "r")).rejects.toMatchObject({ errno: "ENOENT" });
    await vfs.writeFile("/f", "x");
    await expect(vfs.open("/f", "wx")).rejects.toMatchObject({ errno: "EEXIST" });
    const fd = await vfs.open("/f", "r");
    await expect(vfs.write(fd, enc.encode("y"))).rejects.toMatchObject({ errno: "EBADF" });
    await vfs.close(fd);
  });

  it("sequential fd reads advance position; positional reads do not", async () => {
    await vfs.writeFile("/f", "abcdef");
    const fd = await vfs.open("/f", "r");
    expect(new TextDecoder().decode(await vfs.read(fd, 2))).toBe("ab");
    expect(new TextDecoder().decode(await vfs.read(fd, 2))).toBe("cd");
    expect(new TextDecoder().decode(await vfs.read(fd, 2, { position: 0 }))).toBe("ab");
    expect(new TextDecoder().decode(await vfs.read(fd, 2))).toBe("ef");
    expect((await vfs.read(fd, 2)).byteLength).toBe(0); // EOF
    await vfs.close(fd);
  });

  it("close invalidates the fd", async () => {
    const fd = await vfs.open("/f2", "w");
    await vfs.close(fd);
    await expect(vfs.read(fd, 1)).rejects.toMatchObject({ errno: "EBADF" });
  });

  it("open on a directory throws EISDIR; truncate works by path", async () => {
    await vfs.mkdir("/d");
    await expect(vfs.open("/d", "r")).rejects.toMatchObject({ errno: "EISDIR" });
    await vfs.writeFile("/t", "abcdef");
    await vfs.truncate("/t", 3);
    expect(await vfs.readTextFile("/t")).toBe("abc");
  });

  it("a+ opens with read cursor at 0 while writes still append", async () => {
    await vfs.writeFile("/f3", "hello");
    const fd = await vfs.open("/f3", "a+");
    expect(new TextDecoder().decode(await vfs.read(fd, 5))).toBe("hello");
    await vfs.write(fd, new TextEncoder().encode("!"));
    await vfs.close(fd);
    expect(await vfs.readTextFile("/f3")).toBe("hello!");
  });

  it("concurrent appends both land (O_APPEND atomicity)", async () => {
    await vfs.writeFile("/log", "");
    const fd1 = await vfs.open("/log", "a");
    const fd2 = await vfs.open("/log", "a");
    await Promise.all([vfs.write(fd1, enc.encode("A")), vfs.write(fd2, enc.encode("B"))]);
    await vfs.close(fd1);
    await vfs.close(fd2);
    const out = await vfs.readTextFile("/log");
    expect(out.length).toBe(2);
    expect(out.split("").sort().join("")).toBe("AB");
  });
});
