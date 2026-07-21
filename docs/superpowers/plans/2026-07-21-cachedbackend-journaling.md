# CachedBackend Journaling + fsync-strict Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `CachedBackend`'s write-back durable and honest: a failed durability **barrier** (`inner.flush()`) re-queues the whole applied batch instead of losing its prefix (fixing the dequeued-prefix divergence); `flush({ strict: true })` (fsync) rejects on a non-durable barrier; write-back memory is bounded with backpressure.

**Architecture:** Plan 2 of 3 for the pre-Plan-4 durability work (spec `docs/superpowers/specs/2026-07-20-pre-plan4-durability-design.md`, §B), on the **narrow, barrier-only** contract (spec §2 Design correction): backends are self-atomic per op and roll their durable batch back **only on a barrier failure**. The divergence fix therefore triggers on an `inner.flush()` rejection, NEVER on a per-op application failure (those keep the existing "failed op stays at the queue head, applied prefix stays applied" behavior). The content-flush machinery is reworked so a re-queued content op still has its bytes: dirty buffers are **retained until durable-confirm** and the "one content op per dirty session" coalescing gate moves from `dirtyData.has(id)` to an explicit `contentOpPending` set (deferred deletion makes `dirtyData.has` unusable as the gate — see Task 1). All changes are in `packages/vfs/src/cache/cached-backend.ts` and `packages/vfs/src/core/vfs.ts`.

**Tech Stack:** TypeScript strict/ESM, vitest (Node). Test vehicle: `CachedBackend` over `MemoryBackend` with a `Proxy`/spread fault-injecting inner (the existing `packages/vfs/test/cached-writeback.test.ts` already uses both patterns — reuse them).

## Global Constraints

- **Narrow contract (spec §2):** ops are self-atomic; whole-batch rollback + whole-batch re-queue happen **only when `inner.flush()` rejects**. A per-op `inner` application failure leaves the applied prefix applied and the failed op at the queue head (existing behavior — the tests `cached-writeback.test.ts:132` "content survives a transient truncate failure" and `:163` "a rejecting op stays at the queue head" pin it; keep them green).
- **The re-queue rule (spec §B.2):** whenever `inner.flush()` rejects (whether reached as the end-of-cycle barrier or as the durability-point flush inside a per-op catch), re-queue the ops applied *this cycle* to the FRONT of the live queue in original order (`this.queue.unshift(...applied)`), then surface the error. The backend rolled its durable batch back, so re-application next cycle is clean. On a per-op failure whose durability-point `inner.flush()` *succeeds*, the applied prefix stays committed (shifted) and only the failed op remains at the head.
- **Content payload retention (spec §B.3/B.4):** a content-flush op does NOT delete `dirtyData[id]` when its `inner.write` succeeds; the bytes are applied to `inner` but not yet durable. `dirtyData[id]` is deleted only on **durable confirmation** (after `inner.flush()` resolves), and only if it is still that op's buffer (identity guard — `write`/`truncate` always install a fresh `Uint8Array`, so reference identity distinguishes versions). A re-queued content op re-reads its retained `dirtyData[id]`; because `dirtyData[id]` always holds the latest full-file buffer, a replay can only write newer-or-equal bytes, never stale ones (this satisfies spec §B.3's no-stale-replay intent without literal per-op buffer ownership).
- **Coalescing gate:** because deletion is deferred, the "one queued content op per dirty session" gate cannot key on `dirtyData.has(id)`. Use an explicit `contentOpPending: Set<NodeId>`, cleared the moment an op finishes applying to `inner` (whether or not the barrier later confirms), so a re-dirty that lands after the op ran gets its own fresh op.
- **fsync-strict (spec §B.5):** `flush({ strict: true })` (from `Vfs.fsync` and `Vfs.unmount`) rejects on a non-durable barrier; the background auto-flush timer is non-strict — it routes a failure to `onFlushError` and does NOT re-arm into a spin (a later `enqueue()` re-arms it). `flush` threads `opts` to `inner.flush(opts)` (raw backends already accept-and-ignore it, per Plan 1 commit 5de02ec).
- **Reads (spec §B.5):** a cache-miss read's `drain()` propagates a barrier failure (does not swallow it and then read+cache rolled-back inner state).
- **Backpressure (spec §B.6):** bounded write-back; a `write`/`truncate` fails `ENOSPC` — via a synchronous reservation, after the buffer size is known and with no `await` between the check and the install — when write-back is unhealthy (last barrier failed) AND the projected live-payload total exceeds `maxDirtyBytes`.
- Preserve existing invariants: the `flushing` serialization loop (concurrent `flush()` callers fully serialize — `flush` test `:112`), `withNodeLock`/`withNsLock`, `onFlushError` fire-and-forget for auto-flushes.
- ESM, TS strict, ES2022. `VfsError` is exported from `packages/vfs/src/errors.ts` (`import { VfsError } from "../src/errors.js"` in tests, `../errors.js` in src). Conventional commits per green cycle. Branch `feat/pre-plan4-durability`.

---

### Task 1: Content payload retention + explicit gate + barrier-failure re-queue (the divergence fix)

These three changes are one atomic unit: the re-queue needs the retained buffer to replay content, retention needs the explicit gate to avoid stranding a re-dirtied buffer, and the gate needs the confirm step to reopen. Splitting them leaves an un-testable intermediate state.

**Files:**
- Modify: `packages/vfs/src/cache/cached-backend.ts` (`flush`, `enqueueContentOp`, `queueContentFlush`, `dropVictim`; add fields + `confirmContent`/`discardContentConfirm`)
- Test: `packages/vfs/test/cached-writeback.test.ts`

**Interfaces:**
- Consumes: existing `dirtyData: Map<NodeId, Uint8Array>`, `queue`, `flushing`, `timer`, `enqueue`.
- Produces: `confirmContent()`, `discardContentConfirm()`, `contentOpPending: Set<NodeId>`, `pendingContentConfirm: Array<{ id: NodeId; buf: Uint8Array }>`. `flush(opts?)` re-queues on any `inner.flush()` rejection. (Task 4 later adds byte accounting to the dirty install/delete sites; Task 2/3 depend on `flush` throwing on barrier failure.)

- [ ] **Step 1: Write the failing tests**

Add three cases to `packages/vfs/test/cached-writeback.test.ts`. Add `import { VfsError } from "../src/errors.js";` if absent. Use a spread/Proxy-based flaky inner whose `flush` rejects a set number of times (hoist this helper to module scope so later tasks reuse it):
```ts
  function flushFlaky(inner: MemoryBackend, failTimes: number): WashBackend {
    let n = failTimes;
    return new Proxy(inner, {
      get(t, p, r) {
        const v = Reflect.get(t, p, r);
        if (p === "flush") {
          return async (o?: { strict?: boolean }) => {
            if (n-- > 0) throw new VfsError("ENOSPC");
            return (v as (o?: unknown) => Promise<void>).apply(t, [o]);
          };
        }
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    }) as unknown as WashBackend;
  }

  it("a failed barrier keeps the dirty buffer so the retry writes the real bytes", async () => {
    const inner = new MemoryBackend();
    const be = new CachedBackend(flushFlaky(inner, 1), { flushDelayMs: 60_000 });
    const root = await be.root();
    const f = ulid();
    await be.create(root, "f", f, "file");
    await be.write(f, 0, enc.encode("abc"));
    await expect(be.flush()).rejects.toMatchObject({ errno: "ENOSPC" }); // barrier fails once
    await be.flush();                                                    // retry succeeds
    expect(dec.decode(await inner.read(f, 0, 100))).toBe("abc");
  });

  it("no divergence: a failed barrier re-queues the batch; a later flush makes it durable", async () => {
    const inner = new MemoryBackend();
    const be = new CachedBackend(flushFlaky(inner, 1), { flushDelayMs: 60_000 });
    const root = await be.root();
    const a = ulid(), b = ulid();
    await be.create(root, "a", a, "file");
    await be.create(root, "b", b, "file");
    await expect(be.flush()).rejects.toMatchObject({ errno: "ENOSPC" });
    expect(be.pendingOps()).toBeGreaterThan(0);   // ops NOT lost
    await be.flush();                              // succeeds now
    expect((await inner.lookup(root, "a"))?.id).toBe(a);
    expect((await inner.lookup(root, "b"))?.id).toBe(b);
  });

  it("a re-dirtied file is not stranded across flushes", async () => {
    const inner = new MemoryBackend();
    const be = new CachedBackend(inner, { flushDelayMs: 60_000 });
    const root = await be.root();
    const f = ulid(), g = ulid();
    await be.create(root, "f", f, "file");
    await be.create(root, "g", g, "file");
    await be.flush();
    await be.write(f, 0, enc.encode("F1"));
    await be.write(g, 0, enc.encode("G1"));
    await be.flush();
    await be.write(g, 0, enc.encode("G2")); // re-dirty after g's op ran & confirmed
    await be.flush();
    expect(dec.decode(await inner.read(g, 0, 100))).toBe("G2");
    expect(dec.decode(await inner.read(f, 0, 100))).toBe("F1");
    expect(be.pendingOps()).toBe(0);
  });
```
(`enc`/`dec` TextEncoder/Decoder already exist in this file. Match the error field — grep `packages/vfs/src/errors.ts` for the property name; if `VfsError` has no `.code`, assert with the suite's existing `rejects.toThrow(...)` pattern instead.)

- [ ] **Step 2: Run RED**

Run: `pnpm --filter @wash/vfs test cached-writeback -t "failed barrier keeps" && pnpm --filter @wash/vfs test cached-writeback -t "no divergence"`
Expected: FAIL — the current `flush` (`cached-backend.ts:258-273`) shifts each op off before `inner.flush()`, so a barrier failure loses the applied prefix (`pendingOps()` is 0) and the content buffer was deleted on inner-write success, so the retry writes nothing.

- [ ] **Step 3: Add fields + confirm/discard helpers**

In the field block (near `private dirtyData = new Map<NodeId, Uint8Array>();`, line ~67) add:
```ts
  /** ids with a content-flush op queued or in-flight (coalescing gate; replaces the
   *  old `dirtyData.has` gate, which is unusable now that deletion is deferred). */
  private contentOpPending = new Set<NodeId>();
  /** content buffers applied to `inner` this flush cycle, awaiting durable-confirm. */
  private pendingContentConfirm: Array<{ id: NodeId; buf: Uint8Array }> = [];
```
Add the two helpers (place them near `enqueueContentOp`):
```ts
  /** After a successful inner.flush(): the recorded content buffers are durable.
   *  Delete each dirtyData[id] only if it is still that op's buffer (a concurrent
   *  re-dirty installs a fresh Uint8Array with its own later content op). */
  private confirmContent(): void {
    for (const { id, buf } of this.pendingContentConfirm) {
      if (this.dirtyData.get(id) === buf) this.dirtyData.delete(id);
    }
    this.pendingContentConfirm = [];
  }

  /** After a FAILED barrier: buffers stay in dirtyData for the replay (the flush
   *  re-queue); just clear the confirm list — the next cycle rebuilds it. */
  private discardContentConfirm(): void {
    this.pendingContentConfirm = [];
  }
```

- [ ] **Step 4: Move the coalescing gate to `contentOpPending` and defer deletion**

Replace `queueContentFlush` (`cached-backend.ts:438-441`):
```ts
  private queueContentFlush(id: NodeId): void {
    if (this.contentOpPending.has(id)) return; // op already queued/in-flight; it re-reads dirtyData
    this.contentOpPending.add(id);
    this.enqueueContentOp(id);
  }
```
Replace `enqueueContentOp` (`:452-467`):
```ts
  private enqueueContentOp(id: NodeId): void {
    this.enqueue(async () => {
      const buf = this.dirtyData.get(id);
      if (!buf) { this.contentOpPending.delete(id); return; } // evicted/unlinked before this op ran
      await this.inner.truncate(id, buf.byteLength);
      if (buf.byteLength > 0) await this.inner.write(id, 0, buf);
      // Applied to inner but NOT durable: keep the buffer so a barrier failure can
      // replay it; record it for identity-guarded durable-confirm cleanup.
      this.pendingContentConfirm.push({ id, buf });
      this.contentOpPending.delete(id);          // op finished applying → gate reopens
      if (this.dirtyData.get(id) !== buf) this.queueContentFlush(id); // re-dirtied mid-op → fresh op
    });
  }
```
In `dropVictim` (`:206-224`), immediately after each `this.dirtyData.delete(id);` (the dir arm at ~210 and the nlink-zero arm at ~220), add `this.contentOpPending.delete(id);` so an evicted id can be re-queued cleanly if it ever reappears.

- [ ] **Step 5: Rewrite `flush` to own the batch and re-queue on any `inner.flush()` rejection**

Rename the parameter `_opts` → `opts` and replace the `run` IIFE body (`:258-273`) with:
```ts
    const run = (async () => {
      const applied: Array<() => Promise<void>> = [];
      while (this.queue.length > 0) {
        const op = this.queue[0]!;
        try {
          await op();
        } catch (e) {
          // Per-op APPLICATION failure (narrow contract): the op is self-atomic and
          // stays at the head; the applied prefix stays applied. Give the backend a
          // durability point (sticky-abort backends clear it in flush()); if THAT
          // flush also rejects the backend rolled the batch back, so re-queue the
          // applied prefix (the same rule as the barrier path below).
          try {
            await this.inner.flush(opts);
            this.confirmContent();
          } catch {
            this.queue.unshift(...applied);
            this.discardContentConfirm();
          }
          throw e;
        }
        applied.push(this.queue.shift()!);
      }
      try {
        await this.inner.flush(opts);   // durability BARRIER
        this.confirmContent();          // the batch is durable
      } catch (e) {
        this.queue.unshift(...applied); // backend rolled the batch back → replay next cycle
        this.discardContentConfirm();   // buffers stay in dirtyData for the replay
        throw e;
      }
    })();
```
(The `applied.push(this.queue.shift()!)` on the success arm keeps insertion order; `unshift(...applied)` restores the front in order. The failed op in the per-op path is never shifted, so it stays at the head after the unshift.)

- [ ] **Step 6: Run GREEN + regression**

Run: `pnpm --filter @wash/vfs test cached-writeback && pnpm --filter @wash/vfs test`
Expected: the three new tests pass; the whole vfs suite (cached-read/writeback/warm + conformance, 153p/8skip baseline) stays green — in particular `:132` (transient truncate → per-op failure, buffer retained, retry lands), `:163` (rejecting op stays at head, `pendingOps()` unchanged), `:200` (onFlushError timer path, queue survives).

- [ ] **Step 7: Commit**

```bash
git add packages/vfs/src/cache/cached-backend.ts packages/vfs/test/cached-writeback.test.ts
git commit -m "fix(vfs): CachedBackend re-queues the applied batch on a barrier failure; retains dirty buffers until durable-confirm (no dequeued-prefix divergence)"
```

---

### Task 2: fsync-strict — Vfs.fsync/unmount reject on a non-durable barrier

**Files:**
- Modify: `packages/vfs/src/core/vfs.ts` (`fsync` line ~416, `unmount` line ~422)
- Test: `packages/vfs/test/cached-writeback.test.ts` + the vfs-level test that constructs a `Vfs`

**Interfaces:**
- Consumes: Task 1's `flush(opts?)` (throws on barrier failure; threads `opts` to `inner.flush(opts)`); existing `onFlushError`, `enqueue` timer.
- Produces: `Vfs.fsync()` / `Vfs.unmount()` call `flush({ strict: true })`; the strict rejection propagates to the caller. Background auto-flush stays non-strict.

- [ ] **Step 1: Write the failing tests**

```ts
  it("strict flush rejects on a non-durable barrier; a non-strict auto-flush routes to onFlushError", async () => {
    vi.useFakeTimers();
    try {
      const inner = new MemoryBackend();
      const errs: unknown[] = [];
      const be = new CachedBackend(flushFlaky(inner, 5), { flushDelayMs: 10 });
      be.onFlushError = (e) => errs.push(e);
      const root = await be.root();
      await be.create(root, "a", ulid(), "file"); // arms the auto-flush timer
      await vi.advanceTimersByTimeAsync(15);       // a background auto-flush fires and fails
      expect(errs.length).toBeGreaterThan(0);       // non-strict: reported, not thrown
      expect(be.pendingOps()).toBeGreaterThan(0);   // ops retained
    } finally {
      vi.useRealTimers();
    }
    const inner2 = new MemoryBackend();
    const be2 = new CachedBackend(flushFlaky(inner2, 1), { flushDelayMs: 60_000 });
    const r2 = await be2.root();
    await be2.create(r2, "a", ulid(), "file");
    await expect(be2.flush({ strict: true })).rejects.toMatchObject({ errno: "ENOSPC" });
  });
```

- [ ] **Step 2: Run RED**

Run: `pnpm --filter @wash/vfs test cached-writeback -t "strict flush rejects"`
Expected: The strict-rejection assertion passes already (Task 1 makes `flush` throw on a barrier failure). Confirm the auto-flush half also passes. Either way, complete Steps 3-4 for the `Vfs` wiring (the real deliverable of this task).

- [ ] **Step 3: Wire `Vfs.fsync` and `Vfs.unmount` to strict**

In `packages/vfs/src/core/vfs.ts`, change the flush in `fsync()` (line ~418) from `await m.backend.flush();` to `await m.backend.flush({ strict: true });`, and the flush in `unmount()` (line ~427) from `await m.backend.flush();` to `await m.backend.flush({ strict: true });`.

- [ ] **Step 4: Add the Vfs.fsync propagation test**

Grep `packages/vfs/test/` for `new Vfs(` to find the vfs-level test file and its mount/construction API. Add a case there asserting `Vfs.fsync(fd)` rejects when the mount's barrier fails (adapt construction to that file's helper; the mount backend must be a `CachedBackend(flushFlaky(inner, 1))`):
```ts
  it("Vfs.fsync rejects when the mount's durability barrier fails", async () => {
    // construct a Vfs whose mount backend is new CachedBackend(flushFlaky(inner, 1), { flushDelayMs: 60_000 })
    const fd = await vfs.open("/f", "w");
    await vfs.write(fd, enc.encode("x"));
    await expect(vfs.fsync(fd)).rejects.toMatchObject({ errno: "ENOSPC" });
  });
```

- [ ] **Step 5: Run GREEN + regression**

Run: `pnpm --filter @wash/vfs test && pnpm turbo typecheck`
Expected: both new cases pass; the whole vfs suite green; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/vfs/src/core/vfs.ts packages/vfs/test/
git commit -m "feat(vfs): fsync-strict — Vfs.fsync/unmount reject on a non-durable barrier; auto-flush stays non-strict"
```

---

### Task 3: Read-side drain propagates a barrier failure

**Files:**
- Modify (if the audit finds a gap): `packages/vfs/src/cache/cached-backend.ts` (`drain`, read methods)
- Test: `packages/vfs/test/cached-read.test.ts`

**Interfaces:**
- Consumes: Task 1's `flush` (throws on barrier failure); existing `drain()` (`:242-244`) and the read methods `lookup`/`getattr`/`readdir`/`read`/`materialize` that `await this.drain()` before touching `inner`.
- Produces: a cache-miss read whose `drain()` hit a barrier failure rejects instead of reading rolled-back `inner` state.

- [ ] **Step 1: Write the test**

```ts
  it("a cache-miss read after a failed drain does not read rolled-back inner state", async () => {
    const inner = new MemoryBackend();
    const be = new CachedBackend(flushFlaky(inner, 1), { flushDelayMs: 60_000 });
    const root = await be.root();
    const a = ulid();
    await be.create(root, "a", a, "file"); // queued, not durable
    await expect(be.readdir(root)).rejects.toMatchObject({ errno: "ENOSPC" }); // drain barrier fails
    await be.flush();
    expect((await inner.lookup(root, "a"))?.id).toBe(a);
  });
```
(Use whichever read reliably triggers `drain()` for a not-yet-cached target; confirm against `cached-read.test.ts` conventions — `readdir(root)` when the root listing isn't fully cached, else `getattr` on an uncached id.)

- [ ] **Step 2: Run**

Run: `pnpm --filter @wash/vfs test cached-read -t "does not read rolled-back"`
Expected: likely PASS — `drain()` (`:242-244`) already `await this.flush()`, which now throws, so a read that drains before reading `inner` already propagates. If it passes, this task is a verification: audit each read (`lookup:303`, `getattr:314`, `readdir:327`, `read:512`, `materialize:433`) to confirm (a) `drain()` is awaited before the `inner` read and (b) its rejection is not caught/swallowed. If any read reads `inner` regardless of a drain failure, fix it in Step 3; otherwise record the audit result in the commit body and skip Step 3.

- [ ] **Step 3: Implement propagation (only if the audit found a gap)**

Ensure `drain()` does not swallow the failure:
```ts
  private async drain(): Promise<void> {
    if (this.queue.length > 0 || this.flushing) await this.flush(); // throws on barrier failure
  }
```
and that no read method wraps `await this.drain()` in a `try/catch` that then proceeds to read `inner`. (`read`'s dirty-buffer fast path at `:507-511` correctly serves the retained optimistic buffer *without* draining — leave it; only the cache-miss arm drains.)

- [ ] **Step 4: Run GREEN + regression**

Run: `pnpm --filter @wash/vfs test cached-read && pnpm --filter @wash/vfs test`
Expected: the new test passes; the whole vfs suite green.

- [ ] **Step 5: Commit**

```bash
git add packages/vfs/src/cache/cached-backend.ts packages/vfs/test/cached-read.test.ts
git commit -m "test(vfs): read-side drain propagates a barrier failure instead of reading rolled-back inner state"
```

---

### Task 4: Bounded write-back + synchronous ENOSPC backpressure

**Files:**
- Modify: `packages/vfs/src/cache/cached-backend.ts` (constructor options, `write`, `truncate`, `dropVictim`, `confirmContent`, `flush`)
- Test: `packages/vfs/test/cached-writeback.test.ts`

**Interfaces:**
- Consumes: `dirtyData`, Task 1's confirm/discard + barrier catch.
- Produces: a `maxDirtyBytes?: number` option; `liveDirtyBytes` accounting via `setDirty`/`deleteDirty`; an `unhealthy` flag; a synchronous `admit(delta)` gate in `write`/`truncate`.

- [ ] **Step 1: Write the failing tests**

```ts
  it("backpressure: when write-back is unhealthy and over the byte bound, writes fail ENOSPC before mutating", async () => {
    const inner = new MemoryBackend();
    const be = new CachedBackend(flushFlaky(inner, 100), { flushDelayMs: 60_000, maxDirtyBytes: 8 });
    be.onFlushError = () => {};
    const root = await be.root();
    const f = ulid();
    await be.create(root, "f", f, "file");
    await be.write(f, 0, new Uint8Array(8));                     // fills the bound (healthy → allowed)
    await expect(be.flush()).rejects.toMatchObject({ errno: "ENOSPC" }); // barrier fails → unhealthy
    const g = ulid();
    await be.create(root, "g", g, "file");
    const before = be.pendingOps();
    await expect(be.write(g, 0, new Uint8Array(8))).rejects.toMatchObject({ errno: "ENOSPC" });
    expect(be.pendingOps()).toBe(before);                        // rejected before enqueuing
    expect((await be.read(g, 0, 100)).byteLength).toBe(0);       // and before mutating dirtyData
  });

  it("backpressure never fires while write-back is healthy", async () => {
    const inner = new MemoryBackend();
    const be = new CachedBackend(inner, { flushDelayMs: 60_000, maxDirtyBytes: 8 });
    const root = await be.root();
    const f = ulid();
    await be.create(root, "f", f, "file");
    await be.write(f, 0, new Uint8Array(1000)); // healthy: well over the bound, still accepted
    await be.flush();
    expect((await inner.read(f, 0, 1000)).byteLength).toBe(1000);
  });
```

- [ ] **Step 2: Run RED**

Run: `pnpm --filter @wash/vfs test cached-writeback -t "backpressure"`
Expected: FAIL — `maxDirtyBytes` is not an option and the write is accepted regardless of health/bound.

- [ ] **Step 3: Implement bounded write-back**

Widen the constructor options and add fields:
```ts
  constructor(protected inner: WashBackend, protected opts: { flushDelayMs?: number; maxDirtyBytes?: number } = {}) {
```
```ts
  private liveDirtyBytes = 0;                 // sum of byteLengths of all live dirtyData buffers
  private unhealthy = false;                  // last barrier failed; cleared on a successful barrier
  private get maxDirtyBytes(): number { return this.opts.maxDirtyBytes ?? 64 * 1024 * 1024; }
```
Route every `dirtyData` install/delete through helpers that maintain the counter:
```ts
  private setDirty(id: NodeId, buf: Uint8Array): void {
    const old = this.dirtyData.get(id);
    this.liveDirtyBytes += buf.byteLength - (old?.byteLength ?? 0);
    this.dirtyData.set(id, buf);
  }
  private deleteDirty(id: NodeId): void {
    const old = this.dirtyData.get(id);
    if (old) this.liveDirtyBytes -= old.byteLength;
    this.dirtyData.delete(id);
  }
```
Replace `this.dirtyData.set(id, next)` in `write` (`:480`) and `truncate` (`:497`) with `this.setDirty(id, next)`; replace `this.dirtyData.delete(id)` in `confirmContent` and in `dropVictim` (both arms) with `this.deleteDirty(id)`. Set health in `flush`: after the barrier `await this.inner.flush(opts)` succeeds, add `this.unhealthy = false;`; in BOTH re-queue catch arms (per-op double-fail and barrier), add `this.unhealthy = true;`.
Add the synchronous admission gate. In `write`, immediately before `this.queueContentFlush(id); this.setDirty(id, next);` (after `materialize`, with NO `await` between the check and the install):
```ts
      this.admit(next.byteLength - (this.dirtyData.get(id)?.byteLength ?? 0));
```
Same in `truncate` immediately before its `queueContentFlush`/`setDirty`. Define:
```ts
  /** Synchronous reservation: reject before mutating if write-back is unhealthy and
   *  the projected live-payload total would exceed the bound. delta = new buffer bytes
   *  minus the buffer this write replaces (negative on a shrink → always admits). */
  private admit(delta: number): void {
    if (this.unhealthy && delta > 0 && this.liveDirtyBytes + delta > this.maxDirtyBytes) {
      throw new VfsError("ENOSPC");
    }
  }
```

- [ ] **Step 4: Run GREEN + regression**

Run: `pnpm --filter @wash/vfs test cached-writeback && pnpm --filter @wash/vfs test`
Expected: both backpressure tests pass; the whole vfs suite green (a healthy write-back never rejects; `liveDirtyBytes` returns to 0 after a clean flush of all content).

- [ ] **Step 5: Commit**

```bash
git add packages/vfs/src/cache/cached-backend.ts packages/vfs/test/cached-writeback.test.ts
git commit -m "feat(vfs): bounded write-back with synchronous ENOSPC backpressure when unhealthy"
```

---

### Task 5: Integration — cache/backend agreement across a transient outage + full gate

**Files:**
- Test: `packages/vfs/test/cached-writeback.test.ts`

- [ ] **Step 1: Integration test**

```ts
  it("integration: cache and backend agree after a transient flush outage", async () => {
    const inner = new MemoryBackend();
    const be = new CachedBackend(flushFlaky(inner, 2), { flushDelayMs: 60_000 });
    be.onFlushError = () => {};
    const root = await be.root();
    const f = ulid();
    await be.create(root, "f", f, "file");
    await be.write(f, 0, enc.encode("hello"));
    await be.rename(root, "f", root, "g");
    await expect(be.flush()).rejects.toBeTruthy();  // fail 1
    await expect(be.flush()).rejects.toBeTruthy();  // fail 2
    await be.flush();                                // succeeds
    expect(await inner.lookup(root, "f")).toBeNull();
    expect((await inner.lookup(root, "g"))?.id).toBe(f);
    expect(dec.decode(await inner.read(f, 0, 100))).toBe("hello");
    expect(be.pendingOps()).toBe(0);
  });
```

- [ ] **Step 2: Run + full gate**

Run: `pnpm --filter @wash/vfs test && pnpm turbo build test typecheck`
Expected: the integration test passes; the monorepo gate is green. The CachedBackend changes don't touch the OPFS/IDB packages, but if in doubt run `pnpm --filter @wash/backend-opfs test:browser && pnpm --filter @wash/backend-indexeddb test:browser` (baselines: OPFS 92p/6skip, IDB 92p/5skip).

- [ ] **Step 3: Commit**

```bash
git add packages/vfs/test/cached-writeback.test.ts
git commit -m "test(vfs): integration — cache/backend agree after a transient flush outage"
```

## Exit criteria
- Any `inner.flush()` rejection re-queues the whole applied batch (front, in order); a later flush makes it durable; cache and backend never diverge (no dequeued-prefix loss).
- Content dirty buffers are retained until durable-confirm, cleaned up identity-guarded; a retry after a failed barrier writes the real bytes; a re-dirtied file is not stranded.
- Per-op application failures keep the failed op at the queue head with the applied prefix intact (existing tests `:132`, `:163`, `:200` stay green).
- `Vfs.fsync()` / `Vfs.unmount()` / `flush({ strict: true })` reject on a non-durable barrier; background auto-flush stays non-strict (`onFlushError`, no timer spin).
- A cache-miss read after a failed drain rejects rather than reading rolled-back inner state.
- Bounded write-back: an unhealthy + over-bound `write`/`truncate` fails `ENOSPC` before mutating the cache; a healthy write-back never rejects.
- `pnpm turbo build test typecheck` green.

## Not in scope
- Per-op-application-failure whole-batch rollback (narrow contract: only a barrier rejection re-queues).
- retain/release, `caps.fdRetention`, the open-time nlink0 sweep — Plan 3 (F4).
- Chunk-granular dirty data (whole-file buffers + reservation-based backpressure for v1).
- Single-fd fsync granularity (`fsync` flushes the whole mount) — acceptable for v1.
- Literal per-op buffer ownership (spec §B.3): the retain-until-confirm + full-file-buffer design already guarantees no stale replay; a re-read of `dirtyData[id]` yields newer-or-equal bytes only.
