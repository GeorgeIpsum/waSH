import { describe, it, expect, afterEach } from "vitest";
import { OpfsBackend } from "@wash/backend-opfs";
import { ulid } from "@wash/vfs";

const enc = new TextEncoder();
const dec = new TextDecoder();
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

describe("OpfsBackend rename", () => {
  it("renames files within and across directories, id-stable, content intact", async () => {
    const be = await OpfsBackend.open(testRoot());
    const root = await be.root();
    const d = ulid();
    await be.create(root, "dst", d, "dir");
    const f = ulid();
    await be.create(root, "a.txt", f, "file");
    await be.write(f, 0, enc.encode("payload"));
    await be.rename(root, "a.txt", root, "b.txt");
    expect((await be.lookup(root, "b.txt"))?.id).toBe(f);
    await be.rename(root, "b.txt", d, "c.txt");
    expect((await be.lookup(d, "c.txt"))?.id).toBe(f);
    expect(await be.lookup(root, "b.txt")).toBeNull();
    expect(dec.decode(await be.read(f, 0, 100))).toBe("payload"); // id + content survive
    await be.close();
  });

  it("overwrite semantics: file-over-file replaces; dir-over-nonempty ENOTEMPTY; file-over-dir EISDIR; dir-over-file ENOTDIR", async () => {
    const be = await OpfsBackend.open(testRoot());
    const root = await be.root();
    const f1 = ulid();
    const f2 = ulid();
    await be.create(root, "f1", f1, "file");
    await be.create(root, "f2", f2, "file");
    await be.write(f1, 0, enc.encode("one"));
    await be.rename(root, "f1", root, "f2");
    expect((await be.lookup(root, "f2"))?.id).toBe(f1);
    await expect(be.getattr(f2)).rejects.toMatchObject({ errno: "ENOENT" });
    const d1 = ulid();
    const d2 = ulid();
    await be.create(root, "d1", d1, "dir");
    await be.create(root, "d2", d2, "dir");
    await be.create(d2, "kid", ulid(), "file");
    await expect(be.rename(root, "d1", root, "d2")).rejects.toMatchObject({ errno: "ENOTEMPTY" });
    await expect(be.rename(root, "f2", root, "d1")).rejects.toMatchObject({ errno: "EISDIR" });
    await expect(be.rename(root, "d1", root, "f2")).rejects.toMatchObject({ errno: "ENOTDIR" });
    await be.close();
  });

  it("directory rename moves the whole subtree with stable descendant ids, sidecar attrs, and open handles", async () => {
    const rootName = testRoot();
    const be = await OpfsBackend.open(rootName);
    const root = await be.root();
    const src = ulid();
    await be.create(root, "src", src, "dir");
    const sub = ulid();
    await be.create(src, "sub", sub, "dir");
    const f = ulid();
    await be.create(sub, "deep.txt", f, "file", { mode: 0o700 });
    await be.write(f, 0, enc.encode("deep-content")); // pooled handle open on f
    const ln = ulid();
    await be.symlink(src, "ln", ln, "/x");

    await be.rename(root, "src", root, "moved");
    expect((await be.lookup(root, "moved"))?.id).toBe(src); // dir id stable
    expect((await be.lookup(src, "sub"))?.id).toBe(sub);
    const deep = await be.lookup(sub, "deep.txt");
    expect(deep?.id).toBe(f);
    expect(deep?.attrs.mode).toBe(0o700); // sidecar transported
    expect(dec.decode(await be.read(f, 0, 100))).toBe("deep-content");
    expect(await be.readlink(ln)).toBe("/x");
    await be.close();

    const be2 = await OpfsBackend.open(rootName); // persisted layout
    const root2 = await be2.root();
    const moved = await be2.lookup(root2, "moved");
    const sub2 = await be2.lookup(moved!.id, "sub");
    const deep2 = await be2.lookup(sub2!.id, "deep.txt");
    expect(deep2?.attrs.mode).toBe(0o700);
    expect(dec.decode(await be2.read(deep2!.id, 0, 100))).toBe("deep-content");
    await be2.close();
  });

  it("file-over-symlink overwrite clears stale sidecar metadata (reopen-proof)", async () => {
    const rootName = testRoot();
    const be = await OpfsBackend.open(rootName);
    const root = await be.root();
    await be.symlink(root, "target", ulid(), "/x");
    const f = ulid();
    await be.create(root, "f", f, "file");
    await be.rename(root, "f", root, "target");
    expect((await be.lookup(root, "target"))?.attrs.kind).toBe("file");
    await be.close();

    const be2 = await OpfsBackend.open(rootName); // stale sidecar would misclassify here
    const root2 = await be2.root();
    const info = await be2.lookup(root2, "target");
    expect(info?.attrs.kind).toBe("file");
    await expect(be2.readlink(info!.id)).rejects.toMatchObject({ errno: "EINVAL" });
    await be2.close();
  });

  it("mode metadata does not leak from a displaced entry", async () => {
    const rootName = testRoot();
    const be = await OpfsBackend.open(rootName);
    const root = await be.root();
    await be.create(root, "victim", ulid(), "file", { mode: 0o700 });
    const f = ulid();
    await be.create(root, "plain", f, "file"); // default 0o644, no sidecar record
    await be.rename(root, "plain", root, "victim");
    expect((await be.lookup(root, "victim"))?.attrs.mode).toBe(0o644);
    await be.close();
    const be2 = await OpfsBackend.open(rootName);
    const root2 = await be2.root();
    expect((await be2.lookup(root2, "victim"))?.attrs.mode).toBe(0o644);
    await be2.close();
  });

  it("a fault-injected primary-move failure restores the displaced symlink intact (I3)", async () => {
    const rootName = testRoot();
    const be = await OpfsBackend.open(rootName, { testHooks: true });
    const root = await be.root();
    await be.symlink(root, "victimLn", ulid(), "/x");
    const f = ulid();
    await be.create(root, "f", f, "file");
    // The shadow-aside move consumes trigger 0 (skip); skip=1 makes the
    // PRIMARY move (f -> victimLn) the one that fails.
    await (be as unknown as { call: (op: string, a: unknown[]) => Promise<unknown> }).call(
      "__injectFault",
      ["moveStep", 1],
    );
    await expect(be.rename(root, "f", root, "victimLn")).rejects.toMatchObject({ errno: "ENOSPC" });
    expect((await be.lookup(root, "f"))?.id).toBe(f); // rename fully rolled back
    await be.close();

    const be2 = await OpfsBackend.open(rootName); // reopen-proof: sidecar must have traveled with the restore
    const root2 = await be2.root();
    const victim = await be2.lookup(root2, "victimLn");
    expect(victim?.attrs.kind).toBe("symlink"); // pre-fix: plain file
    expect(await be2.readlink(victim!.id)).toBe("/x");
    await be2.close();
  });

  it("rename with sidecar metadata aborts cleanly when the destination sidecar write fails", async () => {
    const rootName = testRoot();
    const be = await OpfsBackend.open(rootName, { testHooks: true });
    const root = await be.root();
    const f = ulid();
    await be.create(root, "exec.sh", f, "file", { mode: 0o755 }); // sidecarWrite #1 happens here (create)
    await (be as unknown as { call: (op: string, a: unknown[]) => Promise<unknown> }).call("__injectFault", ["sidecarWrite", 0]);
    await expect(be.rename(root, "exec.sh", root, "moved.sh")).rejects.toMatchObject({ errno: "ENOSPC" });
    // clean abort: still at the old name, mode intact, maps consistent
    const info = await be.lookup(root, "exec.sh");
    expect(info?.id).toBe(f);
    expect(info?.attrs.mode).toBe(0o755);
    expect(await be.lookup(root, "moved.sh")).toBeNull();
    // retry succeeds and metadata survives
    await be.rename(root, "exec.sh", root, "moved.sh");
    expect((await be.lookup(root, "moved.sh"))?.attrs.mode).toBe(0o755);
    await be.close();

    // reopen-proof: the in-session rec.mode is authoritative regardless of any
    // sidecar corruption, so only a reopen (fresh discovery purely from disk +
    // persisted sidecar JSON) can expose a lost/mistransported mode annotation.
    const be2 = await OpfsBackend.open(rootName);
    const root2 = await be2.root();
    expect(await be2.lookup(root2, "exec.sh")).toBeNull();
    expect((await be2.lookup(root2, "moved.sh"))?.attrs.mode).toBe(0o755);
    await be2.close();
  });

  it("overwrite renames leave no shadow residue", async () => {
    const be = await OpfsBackend.open(testRoot());
    const root = await be.root();
    const f1 = ulid();
    const f2 = ulid();
    await be.create(root, "a", f1, "file");
    await be.create(root, "b", f2, "file");
    await be.rename(root, "a", root, "b");
    expect((await be.readdir(root)).map((d) => d.name)).toEqual(["b"]);
    await be.close();
  });

  it("dir rename aborts cleanly when the sidecar transport fails (no chimera tree)", async () => {
    const be = await OpfsBackend.open(testRoot(), { testHooks: true });
    const root = await be.root();
    const d = ulid();
    await be.create(root, "src", d, "dir");
    const f = ulid();
    await be.create(d, "exec.sh", f, "file", { mode: 0o755 }); // non-empty sidecar in src
    await (be as unknown as { call: (op: string, a: unknown[]) => Promise<unknown> }).call("__injectFault", ["sidecarMove", 0]);
    await expect(be.rename(root, "src", root, "moved")).rejects.toMatchObject({ errno: "ENOSPC" });
    expect((await be.lookup(root, "src"))?.id).toBe(d);
    expect((await be.readdir(d)).map((x) => x.name)).toEqual(["exec.sh"]);
    expect((await be.lookup(d, "exec.sh"))?.attrs.mode).toBe(0o755);
    expect(await be.lookup(root, "moved")).toBeNull();
    await be.rename(root, "src", root, "moved");
    expect((await be.lookup(d, "exec.sh"))?.attrs.mode).toBe(0o755);
    await be.close();
  });

  it("post-commit cleanup failure surfaces the error but leaves a truthful namespace", async () => {
    const be = await OpfsBackend.open(testRoot(), { testHooks: true });
    const root = await be.root();
    const d = ulid();
    await be.create(root, "src", d, "dir");
    await be.create(d, "f", ulid(), "file");
    await (be as unknown as { call: (op: string, a: unknown[]) => Promise<unknown> }).call("__injectFault", ["moveCleanup", 0]);
    await expect(be.rename(root, "src", root, "moved")).rejects.toMatchObject({ errno: "ENOSPC" });
    expect((await be.lookup(root, "moved"))?.id).toBe(d);
    expect((await be.readdir(d)).map((x) => x.name)).toEqual(["f"]);
    await be.flush();
    await be.close();
  });

  it("overwriting a dirty pooled target does not poison fsync when the rename succeeds", async () => {
    const be = await OpfsBackend.open(testRoot(), { testHooks: true });
    const root = await be.root();
    const a = ulid();
    const b = ulid();
    await be.create(root, "a", a, "file");
    await be.create(root, "b", b, "file");
    await be.write(b, 0, new TextEncoder().encode("dirty-target"));
    await (be as unknown as { call: (op: string, a: unknown[]) => Promise<unknown> }).call("__injectFault", ["evictFlush", 0]);
    await be.rename(root, "a", root, "b");
    await be.flush(); // must resolve: those bytes were intentionally destroyed
    await be.close();
  });

  it("shadow-phase sidecar failure aborts cleanly; displaced target never stranded", async () => {
    const be = await OpfsBackend.open(testRoot(), { testHooks: true });
    const root = await be.root();
    const a = ulid();
    const victim = ulid();
    await be.create(root, "a", a, "file");
    await be.symlink(root, "victim", victim, "/t"); // displaced entry WITH sidecar metadata
    await (be as unknown as { call: (op: string, args: unknown[]) => Promise<unknown> }).call("__injectFault", ["sidecarWrite", 0]);
    await expect(be.rename(root, "a", root, "victim")).rejects.toMatchObject({ errno: "ENOSPC" });
    // clean abort: victim still present and intact, no shadows anywhere
    expect((await be.lookup(root, "victim"))?.id).toBe(victim);
    expect(await be.readlink(victim)).toBe("/t");
    expect((await be.readdir(root)).map((d) => d.name).sort()).toEqual(["a", "victim"]);
    await be.rename(root, "a", root, "victim"); // retry clean
    expect((await be.lookup(root, "victim"))?.id).toBe(a);
    await be.close();
  });

  it("source flush poison survives the overwrite-success clear", async () => {
    const be = await OpfsBackend.open(testRoot(), { testHooks: true });
    const root = await be.root();
    const src = ulid();
    const dst = ulid();
    await be.create(root, "src", src, "file");
    await be.create(root, "dst", dst, "file");
    await be.write(dst, 0, enc.encode("dirty-displaced"));
    await be.write(src, 0, enc.encode("dirty-source"));
    await (be as unknown as { call: (op: string, args: unknown[]) => Promise<unknown> }).call("__injectFault", ["evictFlush", 0, 2]); // both closes fail
    await be.rename(root, "src", root, "dst"); // succeeds
    await expect(be.flush()).rejects.toMatchObject({ errno: "ENOSPC" }); // source poison retained
    await be.flush(); // cleared after one report
    await be.close();
  });
});
