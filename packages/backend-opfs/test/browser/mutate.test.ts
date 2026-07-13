import { describe, it, expect, afterEach } from "vitest";
import { OpfsBackend, SIDECAR_NAME } from "@wash/backend-opfs";
import { ulid } from "@wash/vfs";

const enc = new TextEncoder();
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

describe("OpfsBackend create/unlink", () => {
  it("creates dirs and files with caller ids and default attrs", async () => {
    const be = await OpfsBackend.open(testRoot());
    const root = await be.root();
    const d = ulid();
    await be.create(root, "dir", d, "dir");
    const f = ulid();
    await be.create(d, "f.txt", f, "file", { mode: 0o600 });
    expect((await be.lookup(root, "dir"))?.id).toBe(d);
    const info = await be.lookup(d, "f.txt");
    expect(info?.id).toBe(f);
    expect(info?.attrs).toMatchObject({ kind: "file", mode: 0o600, nlink: 1, size: 0 });
    await expect(be.create(root, "dir", ulid(), "file")).rejects.toMatchObject({ errno: "EEXIST" });
    await expect(be.create(f, "x", ulid(), "file")).rejects.toMatchObject({ errno: "ENOTDIR" });
    await be.close();
  });

  it("rejects reserved-name mutations with EPERM", async () => {
    const be = await OpfsBackend.open(testRoot());
    const root = await be.root();
    await expect(be.create(root, SIDECAR_NAME, ulid(), "file")).rejects.toMatchObject({ errno: "EPERM" });
    await expect(be.unlink(root, SIDECAR_NAME)).rejects.toMatchObject({ errno: "EPERM" });
    await be.close();
  });

  it("unlink removes files; dirs must be empty — but a sidecar-only dir counts as empty", async () => {
    const be = await OpfsBackend.open(testRoot());
    const root = await be.root();
    const d = ulid();
    await be.create(root, "d", d, "dir");
    const f = ulid();
    await be.create(d, "kid", f, "file", { mode: 0o700 }); // mode → sidecar exists in d
    await expect(be.unlink(root, "d")).rejects.toMatchObject({ errno: "ENOTEMPTY" });
    await be.unlink(d, "kid");
    // d now contains ONLY its .wash-attrs sidecar — POSIX-empty:
    await be.unlink(root, "d");
    expect(await be.lookup(root, "d")).toBeNull();
    await expect(be.unlink(root, "ghost")).rejects.toMatchObject({ errno: "ENOENT" });
    await be.close();
  });

  it("a failed create leaves no residue and the directory stays usable", async () => {
    const be = await OpfsBackend.open(testRoot());
    const root = await be.root();
    await expect(be.create(root, SIDECAR_NAME, ulid(), "file")).rejects.toMatchObject({ errno: "EPERM" });
    expect((await be.readdir(root))).toEqual([]);
    const f = ulid();
    await be.create(root, "ok.txt", f, "file");
    expect((await be.lookup(root, "ok.txt"))?.id).toBe(f);
    await be.close();
  });

  it("a fault-injected sidecar write during create leaves no residue (T4)", async () => {
    const be = await OpfsBackend.open(testRoot(), { testHooks: true });
    const root = await be.root();
    await (be as unknown as { call: (op: string, a: unknown[]) => Promise<unknown> }).call(
      "__injectFault",
      ["sidecarWrite"],
    );
    await expect(be.create(root, "x", ulid(), "file", { mode: 0o700 })).rejects.toMatchObject({ errno: "ENOSPC" });
    expect(await be.lookup(root, "x")).toBeNull();
    expect(await be.readdir(root)).toEqual([]);
    const id2 = ulid();
    await be.create(root, "x", id2, "file"); // default mode: no sidecar write involved, must succeed
    expect((await be.lookup(root, "x"))?.id).toBe(id2);
    await be.close();
  });

  it("unlinking a dirty file never poisons fsync even if its discard-flush fails", async () => {
    const be = await OpfsBackend.open(testRoot(), { testHooks: true });
    const root = await be.root();
    const f = ulid();
    await be.create(root, "doomed", f, "file");
    await be.write(f, 0, enc.encode("x"));
    await (be as unknown as { call: (op: string, a: unknown[]) => Promise<unknown> }).call("__injectFault", ["evictFlush", 0]);
    await be.unlink(root, "doomed"); // discard path: swallow, no poison
    await be.flush(); // must resolve
    await be.close();
  });

  // Codex wave-6 finding 3: discardPooled used to run BEFORE removeEntry, swallowing
  // any flush failure unconditionally — if removeEntry then failed, the file survived
  // but its durability failure had already been silently discarded. Fixed by closing
  // the pooled handle via closePooled (which queues a flush failure into
  // pendingFlushErrors like a normal eviction, rather than swallowing it up front) and
  // only splicing that entry back out as moot once removeEntry actually confirms the
  // delete. This test only arms "removeEntry" (not "evictFlush"), so it exercises the
  // ordering fix itself (delete-fails -> file survives, with its map/node entries
  // intact) rather than the compound double-fault case.
  it("unlink surfaces a delete failure and preserves the flush poison", async () => {
    const be = await OpfsBackend.open(testRoot(), { testHooks: true });
    const root = await be.root();
    const f = ulid();
    await be.create(root, "f", f, "file");
    await be.write(f, 0, enc.encode("bytes"));
    await (be as unknown as { call: (op: string, a: unknown[]) => Promise<unknown> }).call("__injectFault", ["removeEntry", 0]);
    await expect(be.unlink(root, "f")).rejects.toBeTruthy();
    expect((await be.lookup(root, "f"))?.id).toBe(f); // still present
    await be.close();
  });

  it("recreating a name after a failed sidecar cleanup does not inherit stale metadata", async () => {
    const rootName = testRoot();
    const be = await OpfsBackend.open(rootName, { testHooks: true });
    const root = await be.root();
    const f1 = ulid();
    // This create's own sidecar write (mode 0o700 → non-default) happens BEFORE
    // __injectFault is armed below, so it succeeds untouched and is not part of the
    // fault-site count.
    await be.create(root, "x", f1, "file", { mode: 0o700 }); // sidecar record written
    // skip=0: the very next maybeFault("sidecarWrite") trigger fails. The only
    // writeSidecarFile call between here and that trigger is unlink's own best-effort
    // cleanup write below — so skip=0 lands exactly on the unlink cleanup, not on some
    // earlier create.
    await (be as unknown as { call: (op: string, a: unknown[]) => Promise<unknown> }).call("__injectFault", ["sidecarWrite", 0]);
    await be.unlink(root, "x"); // cleanup write fails, swallowed by design → stale record on disk
    const f2 = ulid();
    await be.create(root, "x", f2, "file"); // default mode — pre-fix: skips sidecar entirely
    expect((await be.lookup(root, "x"))?.attrs.mode).toBe(0o644);
    await be.close();

    const be2 = await OpfsBackend.open(rootName);
    const root2 = await be2.root();
    expect((await be2.lookup(root2, "x"))?.attrs.mode).toBe(0o644); // pre-fix: stale 0o700 applied
    await be2.close();
  });

  it("created entries persist across reopen", async () => {
    const rootName = testRoot();
    const be = await OpfsBackend.open(rootName);
    const root = await be.root();
    const d = ulid();
    await be.create(root, "keep", d, "dir");
    await be.create(d, "file", ulid(), "file");
    await be.close();

    const be2 = await OpfsBackend.open(rootName);
    const root2 = await be2.root();
    const dir = await be2.lookup(root2, "keep");
    expect(dir?.attrs.kind).toBe("dir");
    expect((await be2.readdir(dir!.id)).map((x) => x.name)).toEqual(["file"]);
    await be2.close();
  });
});
