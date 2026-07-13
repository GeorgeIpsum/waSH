import { describe, it, expect, afterEach } from "vitest";
import { OpfsBackend, SIDECAR_NAME } from "@wash/backend-opfs";
import { ulid } from "@wash/vfs";

const roots: string[] = [];
export function testRoot(): string {
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

describe("OpfsBackend shell", () => {
  it("opens, exposes a dir root, and closes", async () => {
    const be = await OpfsBackend.open(testRoot());
    const root = await be.root();
    const attrs = await be.getattr(root);
    expect(attrs.kind).toBe("dir");
    expect(attrs.mode).toBe(0o755);
    expect(attrs.nlink).toBe(1);
    await be.close();
  });

  it("declares the required caps", async () => {
    const be = await OpfsBackend.open(testRoot());
    expect(be.caps).toEqual({
      symlinks: "supported",
      hardlinks: false,
      atomicDirRename: false,
      renameCost: "subtree",
      reservedNames: [SIDECAR_NAME],
    });
    await be.close();
  });

  it("an unknown op name rejects with ENOSYS across the RPC boundary", async () => {
    const be = await OpfsBackend.open(testRoot());
    // dump() shipped in Task 8 — no stubbed op is left to exercise the ENOSYS
    // sentinel, so call the private RPC directly with a bogus op name instead.
    await expect(
      (be as unknown as { call: (op: string, a: unknown[]) => Promise<unknown> }).call("nonexistent-op", []),
    ).rejects.toMatchObject({ errno: "ENOSYS" });
    await be.close();
  });

  it("worker failure rejects in-flight calls instead of hanging them", async () => {
    const be = await OpfsBackend.open(testRoot());
    const root = await be.root();
    const internals = be as unknown as { worker: Worker };
    internals.worker.terminate(); // kill the worker out from under the client
    const inflight = be.getattr(root); // posts to a dead worker: would hang forever pre-fix
    internals.worker.dispatchEvent(new ErrorEvent("error", { message: "boom" }));
    await expect(inflight).rejects.toThrow(/worker error/);
    await be.close(); // close after worker death: should not hang
  }, 2000);

  it("close() is idempotent and post-close calls reject immediately", { timeout: 2000 }, async () => {
    const be = await OpfsBackend.open(testRoot());
    const root = await be.root();
    await be.close();
    await be.close(); // second close: no hang
    await expect(be.getattr(root)).rejects.toThrow(/closed/);
  });
});
