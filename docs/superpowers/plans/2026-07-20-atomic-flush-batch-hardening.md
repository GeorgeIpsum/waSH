# Atomic-Flush-Batch Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every `WashBackend` used under `CachedBackend` (Memory, IndexedDB, OPFS) honor the **atomic flush-batch** contract: any mutating-op rejection OR flush rejection rolls the backend's state back to its last successful `flush()`.

**Architecture:** This is Plan 1 of 3 for the pre-Plan-4 durability work (spec `docs/superpowers/specs/2026-07-20-pre-plan4-durability-design.md`). It is a prerequisite for Plan 2 (CachedBackend journaling), which re-queues a whole batch on failure and is only correct if the inner backend rolled that batch back. Approach: (1) extend the `flush()` signature with an ignored-for-now `opts`; (2) add a shared conformance case that fault-free-injects a mid-batch mutating-op failure and asserts the prior mutation is not durable; (3) make each of the three backends roll back the in-flight batch on any mutating-op throw.

**Tech Stack:** TypeScript strict/ESM, vitest (Node for Memory/IDB-via-fake-indexeddb + manifest units; Chromium browser mode for OPFS), the shared `@wash/vfs/conformance` suite.

## Global Constraints

- **Atomic flush-batch contract (spec §2):** a backend's ops applied since its last successful `flush()` form one atomic batch; ANY failure — a mutating-op rejection (backend request error OR JS-thrown `VfsError` validation) OR a `flush()` rejection — rolls the backend's in-memory AND durable state back to that last successful flush. `flush()` resolves only if the entire batch is durable.
- **Scope of rollback:** only MUTATING ops trigger batch rollback (`create`, `write`, `truncate`, `unlink`, `rename`, `link`, `symlink`, `setattr`). Read ops (`lookup`, `getattr`, `readdir`, `readdirPlus`, `read`, `readlink`) never roll the batch back — reads are not part of a flush batch.
- `flush` signature is exactly `flush(opts?: { strict?: boolean }): Promise<void>`; in THIS plan every backend accepts and IGNORES `opts` (its `flush` already throws on durability failure, i.e. is inherently strict). Plan 2 gives `strict` behavior to `CachedBackend`.
- Backends: `MemoryBackend` (`packages/vfs/src/backend/memory.ts`), `IndexedDBBackend` (`packages/backend-indexeddb/src/backend.ts`), OPFS worker (`packages/backend-opfs/src/worker.ts`).
- ESM, TS strict, ES2022. Conventional commits after every green cycle. Branch: `feat/pre-plan4-durability`.

> **⚠️ SUPERSEDED (2026-07-21) except Task 1.** During execution, Task 3 (MemoryBackend rollback) broke two existing conformance/vfs tests, revealing that this plan's premise — "roll back the whole batch on ANY op failure" — is over-broad and contradicts the established conformance contract (a validation failure must not wipe unrelated un-flushed state). The spec was corrected to a **narrow, barrier-only** contract (`docs/superpowers/specs/2026-07-20-pre-plan4-durability-design.md` §2 "Design correction"), under which the backends are **already compliant**. **Only Task 1 (the `flush(opts?)` signature) stands and is committed (5de02ec).** Tasks 2–6 are cancelled. The real durability work moves entirely to Plan 2 (CachedBackend journaling), revised for barrier-only re-queue.

---

---

### Task 1: `flush(opts?)` contract signature

**Files:**
- Modify: `packages/vfs/src/types.ts` (the `WashBackend.flush` line)
- Modify: `packages/vfs/src/backend/memory.ts` (`flush`), `packages/vfs/src/cache/cached-backend.ts` (`flush`), `packages/backend-indexeddb/src/backend.ts` (`flush`), `packages/backend-opfs/src/client.ts` (`flush`)
- Test: none new (typecheck only)

**Interfaces:**
- Produces: `WashBackend.flush(opts?: { strict?: boolean }): Promise<void>` — the signature Plan 2 consumes.

- [ ] **Step 1: Change the contract**

In `packages/vfs/src/types.ts`, change:
```ts
  flush(): Promise<void>;
```
to:
```ts
  /** Durability barrier. `strict: true` REJECTS if the batch cannot be made durable
   *  (honored by CachedBackend; raw backends are inherently strict and ignore opts). */
  flush(opts?: { strict?: boolean }): Promise<void>;
```

- [ ] **Step 2: Widen each impl's signature (accept + ignore opts)**

`memory.ts`: `async flush(): Promise<void> {}` → `async flush(_opts?: { strict?: boolean }): Promise<void> {}`
`cached-backend.ts`: `async flush(): Promise<void> {` → `async flush(_opts?: { strict?: boolean }): Promise<void> {` (leave body unchanged this plan).
`backend-indexeddb/src/backend.ts`: `async flush(): Promise<void> {` → `async flush(_opts?: { strict?: boolean }): Promise<void> {`.
`backend-opfs/src/client.ts`: `async flush(): Promise<void> {` → `async flush(_opts?: { strict?: boolean }): Promise<void> {` (it forwards `this.call("flush", [])`; leave the RPC args unchanged — the OPFS worker's flush op takes no args and is inherently strict).

- [ ] **Step 3: Typecheck**

Run: `pnpm turbo typecheck`
Expected: clean (the optional param is backward-compatible with all call sites).

- [ ] **Step 4: Commit**

```bash
git add packages/vfs/src/types.ts packages/vfs/src/backend/memory.ts packages/vfs/src/cache/cached-backend.ts packages/backend-indexeddb/src/backend.ts packages/backend-opfs/src/client.ts
git commit -m "feat(vfs): flush(opts?: {strict?}) signature (accepted, ignored by raw backends)"
```

---

### Task 2: Shared conformance case — atomic flush-batch (RED for all three)

**Files:**
- Modify: `packages/vfs/src/conformance/suite.ts`
- Test: the suite itself (runs against every backend)

**Interfaces:**
- Consumes: `runBackendConformance(name, () => Promise<WashBackend>)` (existing).
- Produces: an `atomic flush-batch` describe block every backend must pass.

- [ ] **Step 1: Add the conformance case**

In `packages/vfs/src/conformance/suite.ts`, inside the top-level backend describe (near the existing `flush` describe), add:
```ts
    describe("atomic flush-batch", () => {
      it("a mutating-op failure rolls back the prior uncommitted mutation", async () => {
        const root = await be.root();
        const a = ulid();
        await be.create(root, "a", a, "file");        // op 1: applied, not yet flushed
        // op 2: a mutating op that fails by validation BEFORE flushing the batch
        await expect(be.unlink(root, "missing")).rejects.toMatchObject({ errno: "ENOENT" });
        // The whole un-flushed batch must have rolled back to the last successful flush:
        // "a" (created in the same batch, never flushed) is gone.
        expect(await be.lookup(root, "a")).toBeNull();
      });

      it("commits survive across a successful flush before a later failure", async () => {
        const root = await be.root();
        const a = ulid();
        await be.create(root, "a", a, "file");
        await be.flush();                              // "a" is now durable (its own batch)
        await expect(be.unlink(root, "missing")).rejects.toMatchObject({ errno: "ENOENT" });
        // A failure in a LATER batch must not roll back the already-flushed "a".
        expect((await be.lookup(root, "a"))?.id).toBe(a);
      });
    });
```
(The suite already imports `ulid` and has `be`/`root` fixtures; match the file's existing style. If a per-test fresh backend is needed, follow the existing pattern in the suite.)

- [ ] **Step 2: Run to verify RED where hardening is missing**

Run: `pnpm --filter @wash/vfs test conformance` (Node: Memory) and note the browser backends separately.
Expected: the FIRST test FAILS for `MemoryBackend` (and, when run, IDB/OPFS): after `unlink("missing")` throws, `lookup("a")` still returns the node (no rollback). The SECOND test passes (post-flush survival already holds).

- [ ] **Step 3: Commit the RED test**

```bash
git add packages/vfs/src/conformance/suite.ts
git commit -m "test(vfs): conformance case for atomic flush-batch rollback (RED until backends harden)"
```

---

### Task 3: MemoryBackend snapshot/rollback

**Files:**
- Modify: `packages/vfs/src/backend/memory.ts`
- Test: `packages/vfs/src/conformance/suite.ts` (Task 2 case, now GREEN for Memory) + a focused Node unit test

**Interfaces:**
- Consumes: Task 2 conformance case.
- Produces: `MemoryBackend` satisfies atomic flush-batch — snapshot on first mutation since flush, restore on any mutating-op throw, clear on `flush()`.

- [ ] **Step 1: Focused failing unit test**

Create `packages/vfs/test/memory-atomic-batch.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { MemoryBackend } from "../src/backend/memory.js";
import { ulid } from "../src/ulid.js";

describe("MemoryBackend atomic flush-batch", () => {
  it("rolls back an uncommitted batch on a mutating-op failure", async () => {
    const be = new MemoryBackend();
    const root = await be.root();
    const a = ulid();
    await be.create(root, "a", a, "file");
    await be.write(a, 0, new Uint8Array([1, 2, 3]));
    await expect(be.unlink(root, "missing")).rejects.toMatchObject({ errno: "ENOENT" });
    expect(await be.lookup(root, "a")).toBeNull();          // create rolled back
    await expect(be.getattr(a)).rejects.toMatchObject({ errno: "ENOENT" });
  });

  it("keeps flushed state and only rolls back the current batch", async () => {
    const be = new MemoryBackend();
    const root = await be.root();
    const a = ulid();
    await be.create(root, "a", a, "file");
    await be.flush();
    const b = ulid();
    await be.create(root, "b", b, "file");                  // new batch
    await expect(be.unlink(root, "missing")).rejects.toMatchObject({ errno: "ENOENT" });
    expect((await be.lookup(root, "a"))?.id).toBe(a);       // survived
    expect(await be.lookup(root, "b")).toBeNull();          // rolled back
  });
});
```

- [ ] **Step 2: Run RED**

Run: `pnpm --filter @wash/vfs test memory-atomic-batch`
Expected: FAIL — the create is not rolled back after the failed unlink.

- [ ] **Step 3: Implement snapshot/rollback in MemoryBackend**

In `packages/vfs/src/backend/memory.ts`, add a batch snapshot taken on the first mutation since the last flush and restored on any mutating-op throw. Add fields + helpers:
```ts
  /** Deep snapshot of `nodes` taken before the first mutation since the last successful flush;
   *  restored on any mutating-op throw (atomic flush-batch, spec §2). null between batches. */
  private batchSnapshot: Map<NodeId, MemNode> | null = null;

  private cloneNodes(): Map<NodeId, MemNode> {
    const copy = new Map<NodeId, MemNode>();
    for (const [id, n] of this.nodes) {
      copy.set(id, {
        attrs: { ...n.attrs },
        data: n.data.slice(),
        children: n.children ? new Map(n.children) : null,
        target: n.target,
      });
    }
    return copy;
  }

  /** Run a mutating op body atomically w.r.t. the flush batch: snapshot lazily on the first
   *  mutation since flush, and restore that snapshot if the body throws. */
  private async mutate<T>(body: () => Promise<T> | T): Promise<T> {
    if (this.batchSnapshot === null) this.batchSnapshot = this.cloneNodes();
    try {
      return await body();
    } catch (e) {
      this.nodes = this.batchSnapshot!;   // roll the whole un-flushed batch back
      this.batchSnapshot = this.cloneNodes(); // re-baseline (the rolled-back state is the new batch base)
      throw e;
    }
  }
```
Wrap EACH mutating op's body in `this.mutate(...)`. For example `create`:
```ts
  async create(parent: NodeId, name: string, id: NodeId, kind: NodeKind, attrs?: Partial<Attrs>): Promise<void> {
    return this.mutate(async () => {
      // ...existing create body verbatim...
    });
  }
```
Apply the same wrap to `write`, `truncate`, `unlink`, `rename`, `link`, `symlink`, `setattr` (every mutating method). Do NOT wrap reads.

Then make `flush` clear the snapshot (the batch is now the durable baseline):
```ts
  async flush(_opts?: { strict?: boolean }): Promise<void> {
    this.batchSnapshot = null; // commit point: subsequent mutations start a fresh batch
  }
```
Note on the restore: `this.nodes = this.batchSnapshot` reverts the whole namespace+content to the pre-batch state; the immediate re-clone makes the restored state the new batch baseline so a subsequent op's snapshot is correct.

- [ ] **Step 4: Run GREEN (unit + conformance-Memory)**

Run: `pnpm --filter @wash/vfs test memory-atomic-batch && pnpm --filter @wash/vfs test conformance`
Expected: both unit tests pass; the Task 2 `atomic flush-batch` conformance case passes for `MemoryBackend`. Confirm no OTHER conformance/cached tests regressed (a mutating op that legitimately fails now rolls the batch back — verify the existing suite has no test that interleaves a failing mutation and asserts a prior mutation SURVIVES without a flush; if one exists, it was asserting the old, contract-violating behavior — flag it in the report for the reviewer rather than silently changing it).

- [ ] **Step 5: Commit**

```bash
git add packages/vfs/src/backend/memory.ts packages/vfs/test/memory-atomic-batch.test.ts
git commit -m "feat(vfs): MemoryBackend atomic flush-batch (snapshot on first mutation, rollback on op failure)"
```

---

### Task 4: OPFS metadata-op rollback

**Files:**
- Modify: `packages/backend-opfs/src/worker.ts`
- Test: `packages/backend-opfs/test/browser/durability.test.ts` (new case) + the shared conformance (Task 2) run against OPFS

**Interfaces:**
- Consumes: Task 2 conformance; the existing `dirty`, `rollbackToCommitted()`, `ops` registry, and `self.onmessage`/`chain`/`ensure` dispatch in worker.ts.
- Produces: OPFS rolls back the working manifest on ANY mutating worker-op throw, not just content ops.

- [ ] **Step 1: Failing browser test**

Add to `packages/backend-opfs/test/browser/durability.test.ts`:
```ts
  it("a metadata-op validation failure rolls back the uncommitted batch (atomic flush-batch)", async () => {
    const be = await OpfsBackend.open(testRoot());
    const root = await be.root();
    const a = ulid();
    await be.create(root, "a", a, "file");            // op 1: mani dirty, not committed
    await expect(be.unlink(root, "missing")).rejects.toMatchObject({ errno: "ENOENT" }); // op 2: metadata validation throw
    expect(await be.lookup(root, "a")).toBeNull();    // create rolled back
    await be.close();
  });
```

- [ ] **Step 2: Run RED**

Run: `pnpm turbo build --filter @wash/backend-opfs && pnpm --filter @wash/backend-opfs test:browser durability`
Expected: FAIL — after `unlink("missing")` throws (metadata op, no rollback today), `lookup("a")` still finds `a`.

- [ ] **Step 3: Wrap mutating metadata ops with rollback-on-throw**

In `packages/backend-opfs/src/worker.ts`, the content ops (`write`, `truncate`) already `await rollbackToCommitted(); throw e;` on failure. Extend the SAME treatment to the mutating metadata ops. The cleanest single-point fix is a `mutatingOp` wrapper applied where each is registered in the `ops` object. Add near the `ops` definition:
```ts
/** Wrap a mutating op so any throw rolls the working manifest back to last-committed
 *  before the error propagates (atomic flush-batch, spec §2). Content ops (write/truncate)
 *  already do this inline; this covers the metadata ops that mutate `mani` directly. */
function mutating<A extends unknown[]>(fn: (...args: A) => Promise<OpResult>): (...args: A) => Promise<OpResult> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (e) {
      if (dirty) await rollbackToCommitted();
      throw e;
    }
  };
}
```
Then wrap the registrations of the metadata mutating ops: `create`, `unlink`, `rename`, `link`, `symlink`, `setattr`. E.g. change:
```ts
  async create(parent, name, id, kind, attrs?) { /* ... */ },
```
to register the wrapped form. Since `ops` is an object literal, apply the wrapper after it is defined:
```ts
for (const name of ["create", "unlink", "rename", "link", "symlink", "setattr"] as const) {
  ops[name] = mutating(ops[name] as (...a: never[]) => Promise<OpResult>) as OpFn;
}
```
Place this loop immediately after the `const ops` object literal and before `ensure`/`self.onmessage`. Do NOT wrap read ops or `open`/`flush`/`close`/`dump`/`gc`. (`write`/`truncate` keep their existing inline rollback — wrapping them too is harmless since `rollbackToCommitted` on an already-rolled-back `mani` is idempotent, but to avoid a double call, leave `write`/`truncate` OUT of the loop.)

- [ ] **Step 4: Run GREEN (new test + conformance + full durability suite)**

Run: `pnpm turbo build --filter @wash/backend-opfs && pnpm --filter @wash/backend-opfs test:browser durability conformance`
Expected: the new metadata-rollback test passes; the shared `atomic flush-batch` conformance case passes for `OpfsBackend` (raw + cached); all existing durability/content/namespace/links/rename tests still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/backend-opfs/src/worker.ts packages/backend-opfs/test/browser/durability.test.ts
git commit -m "fix(backend-opfs): metadata ops roll back the batch on any throw (atomic flush-batch)"
```

---

### Task 5: IDB explicit-abort on any mutating-op throw

**Files:**
- Modify: `packages/backend-indexeddb/src/backend.ts`
- Test: `packages/backend-indexeddb/test/*` (new Node case via fake-indexeddb) + shared conformance run against IDB

**Interfaces:**
- Consumes: Task 2 conformance; the existing `withTx`, `this.tx`, `lastAbort`, and mutating op methods.
- Produces: IDB explicitly aborts the active shared transaction on ANY mutating-op throw (request error OR JS-thrown validation), so a prior op in the same batch rolls back.

- [ ] **Step 1: Failing Node test**

Add `packages/backend-indexeddb/test/atomic-batch.test.ts` (follow the package's existing fake-indexeddb test setup — import the same helper the other Node tests use to construct a backend):
```ts
import { describe, it, expect } from "vitest";
import "fake-indexeddb/auto";
import { IndexedDBBackend } from "../src/backend.js";
import { ulid } from "@wash/vfs";

describe("IndexedDBBackend atomic flush-batch", () => {
  it("aborts the shared txn on a JS-thrown validation failure, rolling back the prior op", async () => {
    const be = await IndexedDBBackend.open(`atomic-${ulid()}`); // match the package's actual open() signature
    const root = await be.root();
    const a = ulid();
    await be.create(root, "a", a, "file");
    await expect(be.unlink(root, "missing")).rejects.toMatchObject({ errno: "ENOENT" });
    expect(await be.lookup(root, "a")).toBeNull(); // create rolled back with the aborted txn
  });
});
```
(Adjust `IndexedDBBackend.open(...)` to the real constructor/opener used elsewhere in this package's tests.)

- [ ] **Step 2: Run RED**

Run: `pnpm --filter @wash/backend-indexeddb test atomic-batch`
Expected: FAIL — `unlink("missing")` throws a JS `VfsError` before issuing a request, so the shared txn is not aborted, `create` commits, and `lookup("a")` still finds `a`.

- [ ] **Step 3: Abort the active txn on any mutating-op throw**

In `packages/backend-indexeddb/src/backend.ts`, wrap each MUTATING op so a throw aborts the active shared transaction before rethrowing. Add a helper that mirrors OPFS's `mutating`:
```ts
  /** Run a mutating op so any throw ABORTS the active shared transaction (rolling back every
   *  request in the current un-flushed batch), then rethrows. Request failures already abort the
   *  txn; this also covers JS-thrown VfsError validation that never issued a request. */
  private async mutating<T>(body: () => Promise<T>): Promise<T> {
    try {
      return await body();
    } catch (e) {
      const tx = this.tx;
      if (tx) {
        try { tx.abort(); } catch { /* already aborting/aborted */ }
      }
      throw e;
    }
  }
```
Wrap the body of each mutating method (`create`, `write`, `truncate`, `unlink`, `rename`, `link`, `symlink`, `setattr`) in `this.mutating(async () => { ...existing body... })`. Do NOT wrap reads. Verify that after `tx.abort()`, the existing `lastAbort`/`txCompletion` settle machinery correctly surfaces the abort on the next `withTx`/`flush` (it should — abort triggers the transaction's error/abort handler which sets `lastAbort`); if the abort's async error double-reports, reconcile with the existing sticky-abort logic (the report should note how).

- [ ] **Step 4: Run GREEN (new test + conformance + full IDB suites)**

Run: `pnpm --filter @wash/backend-indexeddb test && pnpm --filter @wash/backend-indexeddb test:browser`
Expected: the new atomic-batch test passes; the shared `atomic flush-batch` conformance case passes for IDB (raw + cached); all existing IDB tests still pass (the abort-poisoning / withTx-retry tests are the ones most likely to interact — confirm they stay green, and if the explicit abort changes their timing, adjust the implementation, not the tests, and explain).

- [ ] **Step 5: Commit**

```bash
git add packages/backend-indexeddb/src/backend.ts packages/backend-indexeddb/test/atomic-batch.test.ts
git commit -m "fix(backend-indexeddb): abort the shared txn on any mutating-op throw (atomic flush-batch)"
```

---

### Task 6: Full gate + regression sweep

**Files:** none (verification only)

- [ ] **Step 1: Whole-monorepo gate**

Run: `pnpm turbo build test typecheck`
Expected: green.

- [ ] **Step 2: Browser suites**

Run: `pnpm --filter @wash/backend-opfs test:browser && pnpm --filter @wash/backend-indexeddb test:browser`
Expected: green, including the shared `atomic flush-batch` conformance case for both raw and `CachedBackend`-wrapped variants.

- [ ] **Step 3: Regression note**

Confirm no existing test relied on the pre-hardening behavior (a failed mutating op leaving a prior un-flushed mutation applied). If any did, it was asserting contract-violating behavior — list it in the final report for the human to confirm the update, per the plan-conflict rule.

## Exit criteria
- `pnpm turbo build test typecheck` green; OPFS + IDB browser suites green.
- The shared `atomic flush-batch` conformance case passes for MemoryBackend, IndexedDBBackend, and OpfsBackend — raw and under `CachedBackend`.
- `flush(opts?: { strict?: boolean })` is the contract signature; raw backends accept and ignore `opts`.
- A mid-batch mutating-op failure (request error OR JS-thrown validation) rolls the whole un-flushed batch back to the last successful flush, on all three backends.

## Not in scope (later plans)
- `strict` flush BEHAVIOR (rejecting on non-durable) — Plan 2 (CachedBackend journaling + fsync-strict).
- The CachedBackend journal / re-queue / backpressure — Plan 2.
- retain/release, `caps.fdRetention`, the open-time `nlink0` sweep — Plan 3 (F4 fd-lifecycle).
