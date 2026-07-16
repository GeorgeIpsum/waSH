import { describe, it, expect, afterEach } from "vitest";
import { OpfsBackend } from "@wash/backend-opfs";
import { ulid } from "@wash/vfs";

const roots: string[] = [];
function testRoot(): string { const n = `wash-test-${ulid()}`; roots.push(n); return n; }
afterEach(async () => {
  const origin = await navigator.storage.getDirectory();
  for (const n of roots.splice(0)) await origin.removeEntry(n, { recursive: true }).catch(() => {});
});

describe("OpfsBackend namespace", () => {
  it("create + lookup with default attrs; missing → null; EEXIST; ENOTDIR", async () => {
    const be = await OpfsBackend.open(testRoot());
    const root = await be.root();
    const d = ulid();
    await be.create(root, "dir", d, "dir");
    const f = ulid();
    await be.create(d, "f.txt", f, "file", { mode: 0o600 });
    expect((await be.lookup(root, "dir"))?.id).toBe(d);
    expect(await be.lookup(root, "nope")).toBeNull();
    const info = await be.lookup(d, "f.txt");
    expect(info?.attrs).toMatchObject({ kind: "file", mode: 0o600, nlink: 1, size: 0 });
    await expect(be.create(root, "dir", ulid(), "file")).rejects.toMatchObject({ errno: "EEXIST" });
    await expect(be.create(f, "x", ulid(), "file")).rejects.toMatchObject({ errno: "ENOTDIR" });
    await expect(be.readdir(f)).rejects.toMatchObject({ errno: "ENOTDIR" });
    await be.close();
  });

  it("readdir lists all children regardless of insertion order; persists across reopen", async () => {
    const name = testRoot();
    const be = await OpfsBackend.open(name);
    const root = await be.root();
    for (const n of ["b", "a", "c"]) await be.create(root, n, ulid(), "file");
    expect((await be.readdir(root)).map((e) => e.name).sort()).toEqual(["a", "b", "c"]);
    await be.close();
    const be2 = await OpfsBackend.open(name);
    expect((await be2.readdir(await be2.root())).map((e) => e.name).sort()).toEqual(["a", "b", "c"]);
    await be2.close();
  });

  it("unlink removes files; dirs must be empty; ENOENT missing; chmod/utimes update", async () => {
    const be = await OpfsBackend.open(testRoot());
    const root = await be.root();
    const f = ulid();
    await be.create(root, "f", f, "file");
    await be.unlink(root, "f");
    expect(await be.lookup(root, "f")).toBeNull();
    await expect(be.getattr(f)).rejects.toMatchObject({ errno: "ENOENT" });
    await expect(be.unlink(root, "ghost")).rejects.toMatchObject({ errno: "ENOENT" });
    const d = ulid();
    await be.create(root, "d", d, "dir");
    await be.create(d, "kid", ulid(), "file");
    await expect(be.unlink(root, "d")).rejects.toMatchObject({ errno: "ENOTEMPTY" });
    const g = ulid();
    await be.create(root, "g", g, "file");
    await be.setattr(g, { mode: 0o700, mtimeMs: 999 });
    const a = await be.getattr(g);
    expect(a.mode).toBe(0o700);
    expect(a.mtimeMs).toBe(999);
    await be.close();
  });

  it("masks mode to 0o777 and applies default modes when attrs omitted", async () => {
    const be = await OpfsBackend.open(testRoot());
    const root = await be.root();
    // high bits above 0o777 are stripped
    const hb = ulid();
    await be.create(root, "hb", hb, "file", { mode: 0o100700 });
    expect((await be.getattr(hb)).mode).toBe(0o700);
    // defaults when no attrs provided: dir 0o755, file 0o644, symlink handled elsewhere
    const dd = ulid();
    await be.create(root, "dd", dd, "dir");
    expect((await be.getattr(dd)).mode).toBe(0o755);
    const df = ulid();
    await be.create(root, "df", df, "file");
    expect((await be.getattr(df)).mode).toBe(0o644);
    await be.close();
  });

  it("setattr updates only the provided fields and masks mode", async () => {
    const be = await OpfsBackend.open(testRoot());
    const root = await be.root();
    const f = ulid();
    await be.create(root, "f", f, "file");
    const start = await be.getattr(f);
    // mode-only: mtime/ctime unchanged, high bits masked
    await be.setattr(f, { mode: 0o102750 });
    let a = await be.getattr(f);
    expect(a.mode).toBe(0o750);
    expect(a.mtimeMs).toBe(start.mtimeMs);
    expect(a.ctimeMs).toBe(start.ctimeMs);
    // mtime-only: mode unchanged
    await be.setattr(f, { mtimeMs: 555 });
    a = await be.getattr(f);
    expect(a.mtimeMs).toBe(555);
    expect(a.mode).toBe(0o750);
    // ctime-only: mtime + mode unchanged
    await be.setattr(f, { ctimeMs: 777 });
    a = await be.getattr(f);
    expect(a.ctimeMs).toBe(777);
    expect(a.mtimeMs).toBe(555);
    expect(a.mode).toBe(0o750);
    await be.close();
  });
});
