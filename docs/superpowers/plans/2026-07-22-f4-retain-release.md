# F4 retain/release fd lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An open fd keeps an unlinked inode alive and readable/writable until the last fd closes (`fd = open(f); unlink(f); read(fd)` succeeds — `exec 3<f; rm f`), across every backend.

**Architecture:** Plan 3 of 3 for the pre-Plan-4 work (spec `docs/superpowers/specs/2026-07-20-pre-plan4-durability-design.md`, §A). The lifecycle unit is the **fd-table reference**. Each backend keeps an in-memory per-inode **retain-count** = live fd references; an inode is reclaimed only when `nlink === 0` AND retain-count === 0. `FdTable` is the single owner (`retain` on reference add, `release` on drop, once-only). In the blessed stack `Vfs.file.backend` is a `CachedBackend`, so it is the retain owner: it keeps its own count (gating cache eviction) and forwards `retain`/`release` **ordered into the write-back queue** to `inner`. Retain-count is in-memory (never persisted), so a crash while unlinked-but-retained can leave an `nlink:0` orphan — every persistent backend does an **open-time unreachable-`nlink0` sweep** (§A.7). Spans `@wash/vfs`, `@wash/backend-opfs`, `@wash/backend-indexeddb`, and the shared conformance suite.

**Tech Stack:** TypeScript strict/ESM. `@wash/vfs` vitest (Node); OPFS/IDB have browser suites (`test:browser`, playwright/chromium) and IDB also runs Node via `fake-indexeddb`.

## Global Constraints

- **Retain-count model (§A.1):** an inode is reclaimed only when `nlink === 0` AND retain-count === 0. A retained inode whose `nlink` hit 0 is an *anonymous* node — no name, still readable/writable via its fds; the last `release` reclaims it.
- **FdTable is the single owner (§A.1/A.5):** `retain` on every reference add (`open`, later `dup`), `release` on every drop (`close`). Release is **once-only and VFS-owned** — `FdTable` removes the fd entry then releases exactly once; a second `close(fd)` hits `EBADF` (entry gone) and cannot double-release.
- **CachedBackend is the retain owner (§A.2):** keeps its own per-id retain-count; while retain-count > 0 it does NOT drop that id's `attrCache`/`dirtyData` on `unlink`/`rename`-displace (`dropVictim` respects retain); `inner.retain`/`inner.release` are **enqueued into and ordered with the write-back queue** (an inner retain never precedes the inode's queued `create`).
- **Every last-reference drop respects retain (§A.3):** `unlink`, `rename`-over (displaced target), overwrite — in BOTH `CachedBackend.dropVictim` AND the raw backends' reclamation choke points. Not just `unlink`.
- **open() is all-or-nothing (§A.4):** `Vfs.open` leaves no visible side effect when it returns no fd. For `O_TRUNC` on an existing inode, `retain` BEFORE the truncate. For create, `create → retain`, and roll back the create (`unlink`) on retain failure. Any failure after a successful `retain` calls `release`. (Accepted residual: an `O_TRUNC` that truncates then fails on a purely in-memory later step leaves the file truncated — POSIX-acceptable.)
- **retain validates, release is lenient (§A.2/A.5):** `retain(id)` throws `ENOENT` if the inode is unknown — this is what makes the write-back **ordering** requirement meaningful (a premature `inner.retain` before a queued `create` would ENOENT; ordering avoids it). `release(id)` is best-effort: a per-fd decrement that **no-ops on an unknown id** (never throws), reclaiming only at retain-0-with-`nlink`-0; a transient failure must not wedge `close`. `Vfs.close` must not reject because `release` rejected.
- **Explicit capability (§A.6):** `caps.fdRetention: boolean`. All three backends set it `true` once they implement retain/release. A WRITABLE mount used by the shell engine requires it — `Vfs.mount` rejects (clear error) a writable mount whose backend lacks `fdRetention`. The `retain?`/`release?` hooks stay `?`-optional in the TS interface for read-only/exotic backends.
- **Open-time unreachable-`nlink0` sweep (§A.7):** on open, treat an inode with `nlink === 0` AND no dirent (unreachable) as garbage in EVERY GC view (OPFS: the working manifest AND both on-disk A/B slots via `unionLiveChunkFiles`; IDB: a new orphan sweep). Safe because retain is gone on reopen — no live fd needs an `nlink:0`-unreachable inode.
- ESM, TS strict, ES2022. `VfsError` from `../errors.js`. Conventional commits per green cycle. Branch: continue on `feat/pre-plan4-durability` (this is Plan 3 of the same branch/PR #4) — verify with `git branch --show-current`.

---

### Task 1: Contract — `types.ts` retain/release hooks + `fdRetention` cap

**Files:**
- Modify: `packages/vfs/src/types.ts` (WashBackend, BackendCaps)
- Modify (cap literals, keep typecheck green): `packages/vfs/src/backend/memory.ts:30`, `packages/backend-opfs/src/client.ts:14`, `packages/backend-indexeddb/src/backend.ts:35`
- Test: none (type-only; the backends flip the cap in their own tasks)

**Interfaces:**
- Produces: `WashBackend.retain?(id: NodeId): void | Promise<void>`, `WashBackend.release?(id: NodeId): void | Promise<void>`, `BackendCaps.fdRetention: boolean`.

- [ ] **Step 1: Add the contract**

In `packages/vfs/src/types.ts`, add to `BackendCaps` (after `renameCost`):
```ts
  /** True iff the backend keeps an unlinked inode's content alive while an fd retains it
   *  (implements retain/release). Required for a WRITABLE mount used by the shell engine. */
  fdRetention: boolean;
```
Add to `WashBackend` (near `flush`):
```ts
  /** An fd reference was acquired on this inode — do not reclaim it even at nlink 0. */
  retain?(id: NodeId): void | Promise<void>;
  /** An fd reference was dropped — reclaim if now unreferenced. Best-effort, must not throw meaningfully. */
  release?(id: NodeId): void | Promise<void>;
```

- [ ] **Step 2: Keep every `BackendCaps` literal green (set the new required field)**

`fdRetention` is required, so each caps literal must set it. Set it `false` for now in all three real backends (each flips to `true` in its own task): `packages/vfs/src/backend/memory.ts` (`caps` at ~:30), `packages/backend-opfs/src/client.ts` (~:14), `packages/backend-indexeddb/src/backend.ts` (~:35). Add `fdRetention: false,` to each literal.

- [ ] **Step 3: Typecheck**

Run: `pnpm turbo typecheck`
Expected: clean. (Any test double that spreads `...inner.caps` inherits the field; a standalone caps literal in a test that now errors must add `fdRetention: false` — grep `caps: BackendCaps` / `caps =` under `packages/*/test` and fix any literal the compiler flags.)

- [ ] **Step 4: Commit**

```bash
git add packages/vfs/src/types.ts packages/vfs/src/backend/memory.ts packages/backend-opfs/src/client.ts packages/backend-indexeddb/src/backend.ts
git commit -m "feat(vfs): WashBackend retain/release hooks + BackendCaps.fdRetention (contract)"
```

---

### Task 2: MemoryBackend retain/release (reference implementation)

**Files:**
- Modify: `packages/vfs/src/backend/memory.ts`
- Test: `packages/vfs/test/` (new `memory-retention.test.ts`, or extend an existing backend test)

**Interfaces:**
- Consumes: Task 1's hooks.
- Produces: `MemoryBackend.retain`/`release`; `caps.fdRetention = true`; reclamation gated on retain-count in `decNlinkAndMaybeGC` (used by both `unlink` and `rename` displacement).

- [ ] **Step 1: Write the failing test**

Create `packages/vfs/test/memory-retention.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { MemoryBackend } from "../src/backend/memory.js";
import { ulid } from "../src/ulid.js";

const enc = new TextEncoder(); const dec = new TextDecoder();

describe("MemoryBackend retain/release", () => {
  it("a retained inode survives unlink and stays readable; the last release reclaims it", async () => {
    const be = new MemoryBackend();
    const root = await be.root();
    const f = ulid();
    await be.create(root, "f", f, "file");
    await be.write(f, 0, enc.encode("data"));
    be.retain!(f);                              // an fd references it
    await be.unlink(root, "f");                 // nlink → 0, but retained
    expect(dec.decode(await be.read(f, 0, 100))).toBe("data"); // anonymous inode still readable
    await expect(be.getattr(f)).resolves.toMatchObject({ nlink: 0 });
    be.release!(f);                             // last reference dropped → reclaimed
    await expect(be.getattr(f)).rejects.toMatchObject({ errno: "ENOENT" });
  });

  it("rename-over a retained target keeps the displaced inode alive until release", async () => {
    const be = new MemoryBackend();
    const root = await be.root();
    const a = ulid(), b = ulid();
    await be.create(root, "a", a, "file");
    await be.create(root, "b", b, "file");
    await be.write(b, 0, enc.encode("bbb"));
    be.retain!(b);                              // fd on b
    await be.rename(root, "a", root, "b");      // b displaced (nlink→0), retained
    expect(dec.decode(await be.read(b, 0, 100))).toBe("bbb");
    be.release!(b);
    await expect(be.getattr(b)).rejects.toMatchObject({ errno: "ENOENT" });
  });

  it("caps.fdRetention is true", () => {
    expect(new MemoryBackend().caps.fdRetention).toBe(true);
  });
});
```
Run RED: `pnpm --filter @wash/vfs test memory-retention` → FAIL (`retain` undefined; `unlink` reclaims immediately so the post-unlink read/getattr throws ENOENT).

- [ ] **Step 2: Implement retain/release + gate reclamation**

In `packages/vfs/src/backend/memory.ts`:
- Set `fdRetention: true` in the `caps` literal (~:30, flipping Task 1's `false`).
- Add a field: `private retains = new Map<NodeId, number>();`
- Add methods:
```ts
  retain(id: NodeId): void {
    this.retains.set(id, (this.retains.get(id) ?? 0) + 1);
  }
  release(id: NodeId): void {
    const n = (this.retains.get(id) ?? 0) - 1;
    if (n > 0) { this.retains.set(id, n); return; }
    this.retains.delete(id);
    // Reference count hit zero: reclaim iff the inode is now anonymous (nlink 0).
    const node = this.nodes.get(id);
    if (node && node.attrs.nlink <= 0) this.nodes.delete(id);
  }
```
- Gate `decNlinkAndMaybeGC` (currently `n.attrs.nlink -= 1; if (n.attrs.nlink <= 0) this.nodes.delete(id);`) on retain-count:
```ts
  private decNlinkAndMaybeGC(id: NodeId): void {
    const n = this.node(id);
    n.attrs.nlink -= 1;
    // Keep an anonymous inode alive while an fd retains it (§A.1); release() reclaims it.
    if (n.attrs.nlink <= 0 && (this.retains.get(id) ?? 0) === 0) this.nodes.delete(id);
  }
```
(The dir arms of `unlink`/`rename` delete the inode directly — dirs can't be `open`ed for content and have no retain path, so leave them. This gate covers both `unlink` and `rename`-displacement, which both funnel through `decNlinkAndMaybeGC`.)

- [ ] **Step 3: GREEN + regression**

Run: `pnpm --filter @wash/vfs test memory-retention && pnpm --filter @wash/vfs test`
Expected: new tests pass; whole vfs suite stays green.

- [ ] **Step 4: Commit**

```bash
git add packages/vfs/src/backend/memory.ts packages/vfs/test/memory-retention.test.ts
git commit -m "feat(vfs): MemoryBackend retain/release keeps anonymous inodes alive until last close"
```

---

### Task 3: CachedBackend retain/release (retain owner)

**Files:**
- Modify: `packages/vfs/src/cache/cached-backend.ts`
- Test: `packages/vfs/test/cached-retention.test.ts`

**Interfaces:**
- Consumes: Task 1's hooks; existing `attrCache`/`dirtyData`/`dropVictim`/`enqueue`/`queue`.
- Produces: `CachedBackend.retain`/`release`; own per-id retain-count; `dropVictim` respects retain; `caps.fdRetention` reflects `inner`.

- [ ] **Step 1: Write the failing test**

Create `packages/vfs/test/cached-retention.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { CachedBackend } from "../src/cache/cached-backend.js";
import { MemoryBackend } from "../src/backend/memory.js";
import { ulid } from "../src/ulid.js";
const enc = new TextEncoder(); const dec = new TextDecoder();

describe("CachedBackend retain/release", () => {
  it("a retained inode survives unlink through the cache and reclaims on last release", async () => {
    const be = new CachedBackend(new MemoryBackend(), { flushDelayMs: 60_000 });
    const root = await be.root();
    const f = ulid();
    await be.create(root, "f", f, "file");
    await be.write(f, 0, enc.encode("cached"));
    await be.retain(f);
    await be.unlink(root, "f");                  // cache keeps the entry (retained)
    expect(dec.decode(await be.read(f, 0, 100))).toBe("cached"); // served from dirtyData
    await be.flush();                            // inner retain ordered before inner unlink → inner keeps it
    expect(dec.decode(await be.read(f, 0, 100))).toBe("cached");
    await be.release(f);
    await be.flush();
    await expect(be.getattr(f)).rejects.toMatchObject({ errno: "ENOENT" });
  });

  it("inner retain is ordered into the write-back queue (never precedes create)", async () => {
    const be = new CachedBackend(new MemoryBackend(), { flushDelayMs: 60_000 });
    const root = await be.root();
    const f = ulid();
    await be.create(root, "f", f, "file"); // create still queued
    await be.retain(f);                     // must enqueue inner.retain AFTER create, not call inner now
    await be.flush();                       // create then retain apply in order (no ENOENT)
    expect(be.caps.fdRetention).toBe(true);
  });
});
```
Run RED: `pnpm --filter @wash/vfs test cached-retention` → FAIL (`retain` undefined; unlink evicts the cache entry so the post-unlink read misses).

- [ ] **Step 2: Implement**

In `packages/vfs/src/cache/cached-backend.ts`:
- `caps`: the constructor sets `this.caps`. Ensure `fdRetention` reflects the inner backend — set `this.caps = { ...inner.caps, fdRetention: inner.caps.fdRetention }` (CachedBackend implements the hooks, so it advertises whatever `inner` supports). Locate the existing `this.caps = ...` assignment and add/confirm the `fdRetention` passthrough.
- Add a field: `private retains = new Map<NodeId, number>();`
- Add methods (retain/release forward to `inner` ordered via `enqueue`, and gate cache eviction):
```ts
  async retain(id: NodeId): Promise<void> {
    this.retains.set(id, (this.retains.get(id) ?? 0) + 1);
    this.enqueue(() => Promise.resolve(this.inner.retain?.(id))); // ordered after this id's create/writes
  }
  async release(id: NodeId): Promise<void> {
    const n = (this.retains.get(id) ?? 0) - 1;
    if (n > 0) this.retains.set(id, n);
    else {
      this.retains.delete(id);
      const a = this.attrCache.get(id);
      if (a && a.nlink <= 0) { this.attrCache.delete(id); this.dirtyData.delete(id); } // anonymous → evict cache
    }
    this.enqueue(() => Promise.resolve(this.inner.release?.(id)));
  }
```
- Gate `dropVictim`: where it evicts on `nlink <= 0` (the file arm — `this.attrCache.delete(id)` + the guarded `this.dirtyData.delete(id)`), skip eviction while retained. Change the file arm so the eviction only runs when `(this.retains.get(id) ?? 0) === 0`:
```ts
      if (hit.nlink <= 0) {
        if ((this.retains.get(id) ?? 0) > 0) return; // anonymous but retained — keep cache for open fds (§A.2)
        this.attrCache.delete(id);
        if (wasOnlyLink || this.caps.hardlinks === false) {
          this.dirtyData.delete(id);
        }
      }
```
(The nlink decrement `hit.nlink -= 1` still happens before this check — the inode becomes anonymous with nlink 0 but the cache entry is kept. The dir arm is unchanged.)

- [ ] **Step 3: GREEN + regression**

Run: `pnpm --filter @wash/vfs test cached-retention && pnpm --filter @wash/vfs test`
Expected: new tests pass; whole vfs suite green (including the Plan 2 write-back/conformance tests — `dropVictim`'s non-retained path is unchanged).

- [ ] **Step 4: Commit**

```bash
git add packages/vfs/src/cache/cached-backend.ts packages/vfs/test/cached-retention.test.ts
git commit -m "feat(vfs): CachedBackend retain/release — retain owner; dropVictim respects retain; inner ordered"
```

---

### Task 4: FdTable + Vfs.open/close retain wiring

> **Amendment (2026-07-22):** the `Vfs.mount` writable-cap check moved OUT of this task to the capstone **Task 8** — the gate rejects any writable mount whose backend lacks `fdRetention`, but OPFS/IDB do not flip that cap to `true` until Tasks 6/7, so landing the gate here breaks the OPFS/IDB integration tests (they mount their raw backend into a `Vfs`). Task 4 is now the open/close retain wiring only; the gate lands last, once every backend advertises the cap.

**Files:**
- Modify: `packages/vfs/src/core/fd.ts`, `packages/vfs/src/core/vfs.ts`
- Test: `packages/vfs/test/vfs-retention.test.ts`

**Interfaces:**
- Consumes: `WashBackend.retain?`/`release?`; `FdTable.alloc`/`get`/`close`; `Vfs.open`/`close`.
- Produces: `Vfs.open` retains all-or-nothing; `Vfs.close` releases once-only. (The `Vfs.mount` cap check is Task 8.)

- [ ] **Step 1: Write the failing test**

Create `packages/vfs/test/vfs-retention.test.ts`:
```ts
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
```
(Confirm `vfs.unlink` exists as a public method — grep `async unlink` in `core/vfs.ts`; if the delete method is named differently, e.g. `rm`, use that. Adjust the read signature to the actual `Vfs.read(fd, length, opts)` shape.)
Run RED: `pnpm --filter @wash/vfs test vfs-retention` → FAIL (open doesn't retain, so unlink reclaims and the fd read misses; mount doesn't check the cap).

- [ ] **Step 2: Implement all-or-nothing open + once-only close**

In `packages/vfs/src/core/vfs.ts` `open()` (currently: resolve→(EISDIR/EEXIST/O_TRUNC truncate)→create-on-ENOENT→`fds.alloc`), thread retain:
- For the **existing-inode** branch: acquire `retain` BEFORE the truncate (§A.4). Replace the `if (flags === "w"||"w+") await r.backend.truncate(r.id, 0)` region so the order is `retain(id)` → then `truncate`; on a later failure call `release`:
```ts
      const r = await this.resolve(p);
      if (r.attrs.kind === "dir") throw new VfsError("EISDIR", p);
      if (flags === "wx" || flags === "ax") throw new VfsError("EEXIST", p);
      await r.backend.retain?.(r.id);                 // BEFORE truncate (§A.4): a retain failure aborts with content intact
      try {
        if (flags === "w" || flags === "w+") await r.backend.truncate(r.id, 0);
      } catch (e) { await r.backend.release?.(r.id).catch(() => {}); throw e; }
      target = { backend: r.backend, id: r.id };
```
- For the **create** (ENOENT) branch: `create → retain`, rolling back the create on retain failure:
```ts
      const { backend, dirId, name } = await this.resolveParent(p);
      const id = ulid();
      await backend.create(dirId, name, id, "file");
      try {
        await backend.retain?.(id);
      } catch (e) {
        await backend.unlink(dirId, name).catch(() => {}); // roll back the create (§A.4)
        throw e;
      }
      target = { backend, id };
```
- (`fds.alloc` and the append-seek stay as-is. The `getattr` for append-seek is a purely in-memory later step — if IT throws, per §A.4 residual we accept the truncated/created state; but to be clean, wrap the post-alloc seek so a throw releases: optional, note it in the report. Minimum: the retain is acquired before any truncate and rolled back on create failure.)

In `Vfs.close()` (currently `this.fds.close(fd)`), release once-only. Change `FdTable.close` to RETURN the removed `OpenFile` (so the caller can release), and have `Vfs.close` release best-effort:
```ts
  async close(fd: number): Promise<void> {
    const file = this.fds.close(fd);            // throws EBADF if already closed → no double release
    await Promise.resolve(file.backend.release?.(file.id)).catch(() => {}); // best-effort (§A.5): never wedge close
  }
```

In `packages/vfs/src/core/fd.ts`, change `close` to return the entry:
```ts
  close(fd: number): OpenFile {
    const f = this.files.get(fd);
    if (!f) throw new VfsError("EBADF", String(fd));
    this.files.delete(fd);
    return f;
  }
```

- [ ] **Step 3: Writable-mount cap check**

In `Vfs.mount(path, backend, opts?)` — grep the `mount` method — reject a writable mount whose backend lacks `fdRetention`. If mounts have a read-only flag, gate on it; otherwise treat all mounts as writable for this check:
```ts
    if (!backend.caps.fdRetention /* && mount is writable */) {
      throw new VfsError("EINVAL", "backend lacks fd-lifetime support (fdRetention); required for a writable mount");
    }
```
(If a read-only mount concept does not exist yet, apply the check unconditionally and note in the report that read-only relaxation is deferred. Keep existing tests green — they mount `MemoryBackend` which now has `fdRetention: true`.)

- [ ] **Step 4: GREEN + regression**

Run: `pnpm --filter @wash/vfs test && pnpm turbo typecheck`
Expected: new tests pass; whole vfs suite green (every existing `new Vfs(); vfs.mount("/", new MemoryBackend())` still works since Memory now advertises `fdRetention: true`); typecheck clean. If any existing test mounts a backend without the cap, that mount now throws — update those tests to use a retaining backend or note them.

- [ ] **Step 5: Commit**

```bash
git add packages/vfs/src/core/fd.ts packages/vfs/src/core/vfs.ts packages/vfs/test/vfs-retention.test.ts
git commit -m "feat(vfs): Vfs.open retains all-or-nothing, close releases once-only; writable mount requires fdRetention"
```

---

### Task 5: Shared conformance fd-lifecycle cases

**Files:**
- Modify: `packages/vfs/src/conformance/suite.ts`
- Test: runs via `packages/vfs/test/conformance-memory.test.ts` (Node) and later OPFS/IDB browser suites

**Interfaces:**
- Consumes: `caps.fdRetention`, `retain?`/`release?` on the backend under test.
- Produces: `caps.fdRetention`-gated fd-lifecycle cases every backend must pass. These are the shared F4 contract tests; Tasks 6/7 make OPFS/IDB pass them.

- [ ] **Step 1: Add the gated cases**

In `packages/vfs/src/conformance/suite.ts`, add a block (mirror the existing `caps.hardlinks`-gated style at ~:218):
```ts
  if (be.caps.fdRetention) {
    it("retain keeps an unlinked inode readable; last release reclaims it", async () => {
      const root = await be.root();
      const f = ulid();
      await be.create(root, "f", f, "file");
      await be.write(f, 0, new TextEncoder().encode("keep"));
      await be.retain!(f);
      await be.unlink(root, "f");
      await be.flush();
      expect(new TextDecoder().decode(await be.read(f, 0, 100))).toBe("keep"); // anonymous, still readable
      expect((await be.getattr(f)).nlink).toBe(0);
      await be.release!(f);
      await be.flush();
      await expect(be.getattr(f)).rejects.toMatchObject({ errno: "ENOENT" });
    });

    it("rename-over a retained target keeps it alive until release", async () => {
      const root = await be.root();
      const a = ulid(), b = ulid();
      await be.create(root, "a", a, "file");
      await be.create(root, "b", b, "file");
      await be.write(b, 0, new TextEncoder().encode("bb"));
      await be.retain!(b);
      await be.rename(root, "a", root, "b");
      await be.flush();
      expect(new TextDecoder().decode(await be.read(b, 0, 100))).toBe("bb");
      await be.release!(b);
      await be.flush();
      await expect(be.getattr(b)).rejects.toMatchObject({ errno: "ENOENT" });
    });
  }
```
(Use the suite's existing `be`, `it`, `ulid`, `expect` bindings and its established patterns — check how the file obtains `be` and whether `flush` is always present. If the suite's backend factory yields a bare backend without `flush` in some path, guard the `flush()` calls with `await be.flush?.()`.)

- [ ] **Step 2: Run (Memory passes now; OPFS/IDB pending)**

Run: `pnpm --filter @wash/vfs test conformance-memory`
Expected: PASS for `MemoryBackend` and `CachedBackend(MemoryBackend)` (Tasks 2-3 make them compliant). OPFS/IDB browser conformance will fail until Tasks 6/7 — that is expected and those suites are not run here.

- [ ] **Step 3: Commit**

```bash
git add packages/vfs/src/conformance/suite.ts
git commit -m "test(vfs): conformance fd-lifecycle cases gated on caps.fdRetention"
```

---

### Task 6: OPFS retain/release + open-time unreachable-nlink0 sweep

**Files:**
- Modify: `packages/backend-opfs/src/worker.ts` (ops registry, unlink/rename gates, open-time sweep), `packages/backend-opfs/src/client.ts` (forwarders + cap)
- Test: `packages/backend-opfs/test/browser/` (new `retention.test.ts`) + existing conformance (Task 5 cases now run)

**Interfaces:**
- Consumes: Task 1's hooks; the worker op-registry pattern (`ops.gc` at `worker.ts:304-307`); `unionLiveChunkFiles` (`worker.ts:208-220`); `ops.open` GC tail (`worker.ts:294`).
- Produces: worker `retain`/`release` ops, an in-memory `retains: Map<id, number>`, retain-gated inode deletion in unlink (`worker.ts:366-369`) and rename displacement (`worker.ts:498-501`), open-time orphan sweep, client forwarders, `caps.fdRetention = true`.

- [ ] **Step 1: Write the browser test**

Create `packages/backend-opfs/test/browser/retention.test.ts` mirroring the Memory retention tests but over `freshBackend()` (see `test/browser/conformance.test.ts` for `freshBackend`/cleanup helpers). Cases: retain→unlink→read-succeeds→release→gone; a reopen after unlink-while-retained (simulating a "crash") sweeps the orphan (open a fresh `OpfsBackend` on the same root dir → the `nlink:0` inode and its blobs are gone). Include a `caps.fdRetention === true` assertion.
Run RED (browser): `pnpm --filter @wash/backend-opfs test:browser retention` → FAIL.

- [ ] **Step 2: Worker retain/release + in-memory count**

In `packages/backend-opfs/src/worker.ts`, inside the module/worker scope add `const retains = new Map<string, number>();` and two ops in the `ops` registry (mirror `ops.gc`):
```ts
    async retain(id: NodeId): Promise<OpResult> {
      if (!mani.inodes[id]) throw new VfsError("ENOENT", id); // retain validates existence (contract)
      retains.set(id, (retains.get(id) ?? 0) + 1);
      return { value: undefined };
    },
    async release(id: NodeId): Promise<OpResult> {
      const n = (retains.get(id) ?? 0) - 1;
      if (n > 0) { retains.set(id, n); return { value: undefined }; }
      retains.delete(id);
      // reference gone: if the inode is anonymous (present with nlink 0), reclaim it now,
      // then persist + GC exactly the way ops.unlink does (read ops.unlink at worker.ts:355-375
      // to see how it obtains the working manifest and persists via commit()).
      const rec = mani.inodes[id];
      if (rec && rec.nlink <= 0) {
        delete mani.inodes[id];
        await commit(/* ...as ops.unlink does... */);
        await blobs.gc(await unionLiveChunkFiles());
      }
      return { value: undefined };
    },
```
**First read `ops.unlink` (`worker.ts:355-375`)** — it is the template for retain/release: it obtains the working manifest (`mani`), mutates `mani.inodes`, and persists via `commit()`. Use the SAME manifest variable and `commit()` call shape here (the map notes `commit()` at `worker.ts:162-185`, `unionLiveChunkFiles` at `:208-220`, `blobs.gc` at `blobs.ts:357`). Do not invent a manifest handle — mirror `ops.unlink` exactly.

- [ ] **Step 3: Gate reclamation on retain-count**

In `ops.unlink` (`worker.ts:366-369`), gate the inode-record deletion:
```ts
      child.nlink -= 1;
      if (child.nlink <= 0 && (retains.get(e.id) ?? 0) === 0) {
        delete mani.inodes[e.id]; // blob chunks reclaimed by GC
      }
      // else: nlink 0 but retained → keep mani.inodes[e.id] so union GC does not reclaim its chunks;
      //       release() (or the open-time sweep) reclaims it later.
```
Apply the identical retain-gate to the rename-displacement drop (`worker.ts:498-501`, using the displaced id).

- [ ] **Step 4: Open-time unreachable-`nlink0` sweep (§A.7)**

In `ops.open` (`worker.ts:256-296`), before/alongside the existing `await blobs.gc(await unionLiveChunkFiles())` (`:294`): retain-count is empty on a fresh worker, so any `nlink === 0` inode in the loaded working manifest is unreachable garbage. Sweep it from the working manifest so the next commit doesn't re-persist it, then let the union GC (which already unions both A/B slots) reclaim its blobs:
```ts
      for (const [id, rec] of Object.entries(mani.inodes)) {
        if (rec.nlink <= 0) delete mani.inodes[id]; // unreachable on reopen (retain is gone) — §A.7
      }
      await blobs.gc(await unionLiveChunkFiles()); // union across working + both slots already
```
(Confirm `mani` at this point is the loaded working manifest, and that dropping the record before `unionLiveChunkFiles()` means `addLiveChunkFiles` no longer lists those chunks — per the map, `addLiveChunkFiles` walks `m.inodes`, so a removed record's chunks fall out of the live set and get reclaimed. The union over both on-disk slots handles a slot that still carries the orphan.)

- [ ] **Step 5: Client forwarders + cap**

In `packages/backend-opfs/src/client.ts`: add `async retain(id: NodeId): Promise<void> { await this.call("retain", [id]); }` and the same for `release` (mirroring `unlink` at `:117`), and set `fdRetention: true` in the `caps` literal (~:14).

- [ ] **Step 6: GREEN (browser) + conformance**

Run: `pnpm --filter @wash/backend-opfs test:browser`
Expected: the new retention test AND the Task-5 conformance fd-lifecycle cases (now running against `OpfsBackend` and `CachedBackend(OpfsBackend)`) pass; the existing OPFS browser suites stay green (baseline 92p/6skip → grows by the new cases).

- [ ] **Step 7: Commit**

```bash
git add packages/backend-opfs/src/worker.ts packages/backend-opfs/src/client.ts packages/backend-opfs/test/browser/retention.test.ts
git commit -m "feat(backend-opfs): retain/release + open-time unreachable-nlink0 sweep (F4)"
```

---

### Task 7: IndexedDB retain/release + open-time orphan sweep

**Files:**
- Modify: `packages/backend-indexeddb/src/backend.ts`
- Test: `packages/backend-indexeddb/test/` (new `retention.test.ts`; runs Node via fake-indexeddb + browser)

**Interfaces:**
- Consumes: Task 1's hooks; `gcInode` (`backend.ts:468-476`) — the single reclamation choke point for unlink + rename displacement; `static open` (`backend.ts:92-107`); `withTx`/`chunkRange`.
- Produces: `retain`/`release` methods, an in-memory `retains: Map<id, number>`, retain-gated `gcInode`, an open-time orphan sweep, `caps.fdRetention = true`.

- [ ] **Step 1: Write the test**

Create `packages/backend-indexeddb/test/retention.test.ts` mirroring the Memory retention cases over `IndexedDBBackend.open(\`ret-${ulid()}\`)` (the file runs under both Node/fake-indexeddb and browser configs). Add a **persistence/crash** case: open db X, create+write f, retain f, unlink f (nlink 0, retained), `flush`; then WITHOUT release, `new` open on the same db name X (simulating a crash — retain-count is gone) → the orphan `nlink:0` inode and its data chunks are swept (getattr(f) → ENOENT, and the `data` store has no chunks for f). Assert `caps.fdRetention === true`.
Run RED (Node): `pnpm --filter @wash/backend-indexeddb test retention` → FAIL.

- [ ] **Step 2: retain/release + in-memory count**

In `packages/backend-indexeddb/src/backend.ts`: add `private retains = new Map<NodeId, number>();` and:
```ts
  async retain(id: NodeId): Promise<void> {
    await this.withTx(async (tx, r) => { await this.getInode(tx, r, id); }); // validates existence → ENOENT if unknown
    this.retains.set(id, (this.retains.get(id) ?? 0) + 1);
  }
  async release(id: NodeId): Promise<void> {
    const n = (this.retains.get(id) ?? 0) - 1;
    if (n > 0) { this.retains.set(id, n); return; }
    this.retains.delete(id);
    // reference gone: reclaim iff the inode is anonymous (nlink 0)
    await this.withTx(async (tx, r) => {
      const rec = (await r(tx.objectStore("inodes").get(id))) as InodeRecord | undefined;
      if (rec && rec.nlink <= 0) {
        await r(tx.objectStore("inodes").delete(id));
        await r(tx.objectStore("data").delete(this.chunkRange(id)));
      }
    });
  }
```
Set `fdRetention: true` in the `caps` literal (~:35).

- [ ] **Step 3: Gate `gcInode`**

In `gcInode` (`backend.ts:468-476`), gate the physical deletion on retain-count (keep the inode record + data while retained; still drop the nlink):
```ts
  private async gcInode(tx: IDBTransaction, r: ReqFn, id: NodeId, rec: InodeRecord): Promise<void> {
    rec.nlink -= 1;
    if (rec.nlink <= 0 && (this.retains.get(id) ?? 0) === 0) {
      await r(tx.objectStore("inodes").delete(id));
      await r(tx.objectStore("data").delete(this.chunkRange(id)));
    } else {
      await r(tx.objectStore("inodes").put(rec, id)); // persist the decremented nlink (0, retained → kept)
    }
  }
```
(Both `unlink` and `rename`-displacement funnel through `gcInode`, so this one gate covers §A.3.)

- [ ] **Step 4: Open-time orphan sweep (§A.7)**

In `static open` (`backend.ts:92-107`), after the root-bootstrap `await txDone(tx)` (~:105) and before `return new IndexedDBBackend(...)`, run a sweep: retain-count is gone on a fresh open, so every `nlink <= 0` inode is unreachable garbage — delete it and its data chunks:
```ts
    await IndexedDBBackend.sweepOrphans(db); // §A.7
    return new IndexedDBBackend(...);
```
Add the static helper (its own readwrite tx over `inodes` + `data`):
```ts
  private static async sweepOrphans(db: IDBDatabase): Promise<void> {
    const tx = db.transaction(["inodes", "data"], "readwrite");
    const inodes = tx.objectStore("inodes");
    const orphans: NodeId[] = [];
    await new Promise<void>((resolve, reject) => {
      const cur = inodes.openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return resolve();
        const rec = c.value as InodeRecord;
        if (rec.nlink <= 0) orphans.push(c.primaryKey as NodeId);
        c.continue();
      };
      cur.onerror = () => reject(cur.error);
    });
    for (const id of orphans) {
      inodes.delete(id);
      tx.objectStore("data").delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
    }
    await txDone(tx);
  }
```
(Match `chunkRange`'s actual key shape — the map shows `this.chunkRange(id)` is `IDBKeyRange.bound([id, first], [id, last])` at `backend.ts:375-377`; reuse the same bounds. `txDone`/`req` helpers are in `idb.ts`.)

- [ ] **Step 5: GREEN (Node + browser) + conformance**

Run: `pnpm --filter @wash/backend-indexeddb test && pnpm --filter @wash/backend-indexeddb test:browser`
Expected: the new retention + crash-sweep test passes (Node fake-indexeddb + browser); the Task-5 conformance fd-lifecycle cases (now running against `IndexedDBBackend` and `CachedBackend(IndexedDBBackend)`) pass; existing suites stay green (baseline 92p/5skip grows).

- [ ] **Step 6: Commit + full gate**

```bash
git add packages/backend-indexeddb/src/backend.ts packages/backend-indexeddb/test/retention.test.ts
git commit -m "feat(backend-indexeddb): retain/release + open-time orphan sweep (F4)"
```
Then the full gate: `pnpm turbo build test typecheck` (Node) green, and the two browser suites green.

### Task 8 (capstone): writable-mount `fdRetention` gate

Lands LAST — after Tasks 6/7 flip OPFS and IDB to `fdRetention: true`, so no backend's integration tests break.

**Files:**
- Modify: `packages/vfs/src/core/vfs.ts` (`mount`)
- Test: `packages/vfs/test/vfs-retention.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/vfs/test/vfs-retention.test.ts`:
```ts
  it("a writable mount whose backend lacks fdRetention is rejected", async () => {
    const vfs = new Vfs();
    const be = new MemoryBackend();
    (be.caps as { fdRetention: boolean }).fdRetention = false; // simulate a non-retaining backend
    await expect(vfs.mount("/", be)).rejects.toMatchObject({ errno: "EINVAL" });
  });
```
Run RED: `pnpm --filter @wash/vfs test vfs-retention -t "lacks fdRetention"` → FAIL (mount doesn't check the cap yet).

- [ ] **Step 2: Add the gate**

In `Vfs.mount(path, backend, opts?)` (grep `async mount`), reject a writable mount whose backend lacks the cap. If a read-only mount concept does not exist yet, apply unconditionally (note it in the report):
```ts
    if (!backend.caps.fdRetention /* && mount is writable */) {
      throw new VfsError("EINVAL", "backend lacks fd-lifetime support (fdRetention); required for a writable mount");
    }
```

- [ ] **Step 3: Full gate**

Run: `pnpm turbo build test typecheck` (Node) + `pnpm --filter @wash/backend-opfs test:browser` + `pnpm --filter @wash/backend-indexeddb test:browser`.
Expected: ALL green — every real backend now advertises `fdRetention: true`, so no `mount(...)` of a real backend is rejected; only the cap-forced-false test asserts the rejection.

- [ ] **Step 4: Commit**

```bash
git add packages/vfs/src/core/vfs.ts packages/vfs/test/vfs-retention.test.ts
git commit -m "feat(vfs): reject a writable mount whose backend lacks fdRetention (F4 capstone)"
```

---

## Exit criteria
- `fd = open(f); unlink(f); read(fd)` succeeds; the inode is reclaimed only after the last `close` — across MemoryBackend, `CachedBackend`, OPFS, and IDB.
- `rename`-over a retained target keeps the displaced inode alive until release; every last-reference drop (unlink/rename-over) respects retain in both `CachedBackend.dropVictim` and the raw backends.
- `Vfs.open` is all-or-nothing (retain before truncate; create rolled back on retain failure); `Vfs.close` releases once-only (`EBADF` on double close, no double release); best-effort release never wedges close.
- A writable mount whose backend lacks `caps.fdRetention` is rejected; all three real backends advertise `fdRetention: true`.
- A crash while unlinked-but-retained is reconciled by the open-time unreachable-`nlink0` sweep (OPFS across working+both A/B slots; IDB orphan sweep) — no orphaned inode/blobs survive a reopen.
- `pnpm turbo build test typecheck` green; OPFS + IDB browser suites green.

## Not in scope
- `dup`/`dup2` fd-reference sharing (`exec 4<&3`) — Plan 4 (the FdTable-owned retain path already accommodates it: a dup would `retain` again).
- Read-only mount relaxation of the `fdRetention` requirement (apply unconditionally for v1 unless a read-only mount concept already exists).
- Persisting retain-count across reopen (deliberately in-memory; the open-time sweep is the crash-safety mechanism).
