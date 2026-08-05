import { describe, it, expect } from "vitest";
import { Vfs } from "../src/core/vfs.js";
import { MemoryBackend } from "../src/backend/memory.js";
const enc = new TextEncoder(); const dec = new TextDecoder();

describe("Vfs fd retention (exec 3<f; rm f)", () => {
  it("an open fd keeps an unlinked file readable until close", async () => {
    const vfs = new Vfs();
    await vfs.mount("/", new MemoryBackend());
    const fd = await vfs.open("/f", "w+");
    await vfs.write(fd, enc.encode("hello"));
    await vfs.unlink("/f");                         // rm f
    expect(await vfs.exists("/f")).toBe(false);      // name gone
    expect(dec.decode(await vfs.read(fd, 100, { position: 0 }))).toBe("hello"); // fd still reads
    await vfs.close(fd);
    // after last close the inode is reclaimed (no assertion path to it by name; smoke: reopen creates fresh)
  });

  it("close is once-only; a second close is EBADF and cannot double-release", async () => {
    const vfs = new Vfs();
    await vfs.mount("/", new MemoryBackend());
    const fd = await vfs.open("/f", "w");
    await vfs.close(fd);
    await expect(vfs.close(fd)).rejects.toMatchObject({ errno: "EBADF" });
  });

  it("a writable mount whose backend lacks fdRetention is rejected", async () => {
    const vfs = new Vfs();
    const be = new MemoryBackend();
    (be.caps as { fdRetention: boolean }).fdRetention = false; // simulate a non-retaining backend
    await expect(vfs.mount("/", be)).rejects.toMatchObject({ errno: "EINVAL" });
  });
});
