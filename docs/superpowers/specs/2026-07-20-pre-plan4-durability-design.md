# Pre-Plan-4 durability & fd-lifecycle — design

**Status:** design, ready for implementation-planning.
**Hardened by adversarial review:** `.lil-bro/20260719-210821-f4-retain-release-review.md` (F4, 11 findings, consensus) and `.lil-bro/20260720-010429-cachedbackend-journaling-review.md` (CachedBackend journaling, 17 findings, consensus).

## 1. Why this exists
Three consolidated hard items must land before the shell engine (Plan 4), because the engine's semantics hit them immediately:

1. **F4 — open fds keep unlinked files alive.** `fd = open(f); unlink(f); read(fd)` must succeed (`exec 3<f; rm f`). Today `unlink` reclaims content at `nlink === 0` regardless of open fds.
2. **CachedBackend journal-until-flush-confirmed.** A failed mid-batch flush rolls the backend back but the cache has already dequeued the applied ops → permanent divergence.
3. **fsync-strict `flush(opts)`.** `fsync`/`close` must be able to report a durability failure (`ENOSPC`), not silently swallow it.

They are coupled at the VFS ↔ CachedBackend ↔ backend durability seam and share one contract surface, so they ship as one spec. **The work spans three packages** (`@wash/vfs`, `@wash/backend-opfs`, `@wash/backend-indexeddb`) plus the shared conformance suite, because item 2's journal is only sound over a backend with an atomic flush-batch, which both real backends need hardening to provide.

## 2. Contract changes (`packages/vfs/src/types.ts`)
```ts
interface BackendCaps {
  // ...existing...
  /** True iff the backend keeps an unlinked inode's content alive while an fd retains it
   *  (implements retain/release). Required for a WRITABLE mount used by the shell engine. */
  fdRetention: boolean;
}

interface WashBackend {
  // ...existing...
  /** An fd reference was acquired on this inode — do not reclaim it even at nlink 0. */
  retain?(id: NodeId): void | Promise<void>;
  /** An fd reference was dropped — reclaim if now unreferenced. Best-effort, must not throw meaningfully. */
  release?(id: NodeId): void | Promise<void>;
  /** Durability barrier. `strict: true` REJECTS if the batch cannot be made durable. */
  flush(opts?: { strict?: boolean }): Promise<void>;
}
```
**Atomic flush-batch requirement (documented contract on `flush`).** A backend's ops applied since its last successful `flush()` form one atomic batch. **ANY** failure — an op-application rejection (a backend request error OR a JS-thrown `VfsError` validation error) OR a `flush()` rejection — rolls the backend's in-memory AND durable state back to that last successful flush. `flush()` resolves only if the entire batch is durable. This is a required property of any backend wrapped by `CachedBackend`; the conformance suite verifies it.

---

## Section A — F4: retain/release fd lifecycle

### A.1 Model
- The lifecycle unit is the **fd-table reference**, not a path-open. A backend keeps an in-memory per-inode **retain-count** = the number of live fd references to that inode. `FdTable` is the single owner: it calls `retain(id)` when a reference is added and `release(id)` when one is dropped, so `open`, `close`, and Plan 4's `dup`/`dup2` (`exec 4<&3`) each adjust the count through the same path. *(F8)*
- An inode is **reclaimed only when `nlink === 0` AND retain-count === 0.** A retained inode whose `nlink` hit 0 is an *anonymous* node — no name, still readable/writable through its open fds; the last `release` reclaims it.

### A.2 CachedBackend is the retain owner *(F1/F2)*
In the blessed stack the VFS's `file.backend` is the `CachedBackend`, so `retain`/`release` land there.
- The `CachedBackend` keeps its **own** per-id retain-count. While retain-count > 0 it does **not** drop that id's `attrCache`/`dirtyData` on `unlink` or `rename`-displace (`dropVictim` must respect retain), so an open fd keeps reading the anonymous inode through the cache. The cache entry is dropped only when the last release fires.
- Any `inner.retain`/`inner.release` is **enqueued into and ordered with the write-back queue**, exactly like create/write, so an inner retain never precedes the inode's creation on the backend (a cached-only inode whose `create` is still queued can be retained with no premature inner call, avoiding `ENOENT`).

### A.3 unlink / rename / any last-reference drop *(F3)*
Every op that would drop an inode's last reference — `unlink`, `rename`-over (displaced target), overwrite — respects the retain-count, in **both** `CachedBackend.dropVictim` and the raw backends' rename displacement. Not just `unlink`.

### A.4 open() is all-or-nothing *(F5/F9)*
`Vfs.open()` never leaves visible side effects when it returns no fd:
- For `O_TRUNC` on an existing inode, acquire `retain(id)` **before** the truncate, so a retain failure aborts with content intact.
- For create, `create → retain(id)`, and **roll back the create (unlink)** on retain failure.
- Any failure after a successful `retain` calls `release(id)` (acquire/cleanup).
- (Accepted residual: an `O_TRUNC` that truncates and then fails on a purely in-memory later step leaves the file truncated — POSIX-acceptable.)

### A.5 release / close semantics *(F6/F10)*
- Once-only release is **VFS-owned**: `FdTable` removes an fd entry and calls `release(id)` **exactly once**; a second `close(fd)` on the same number hits `EBADF` (entry gone) and cannot double-release. No opaque token is needed.
- The backend's `release` is a plain **best-effort per-fd decrement** (reclaim at zero-with-`nlink`-zero); a transient RPC failure must not wedge `close`. If the backend/worker is gone, teardown reclaims anyway.

### A.6 Explicit capability, not silent optionality *(F7)*
`caps.fdRetention` advertises support. All three of our backends set it `true`. A writable mount used by the shell engine **requires** it — the VFS rejects (or surfaces a clear "no fd-lifetime support" error for) a writable engine mount whose backend lacks it, rather than silently keeping the F4 gap. The hooks stay `?`-optional in the TS interface for read-only/exotic backends.

### A.7 Crash safety — open-time unreachable-`nlink0` sweep *(F4/F11)*
Retain-count is in-memory (session/worker lifetime), never persisted. A flush while an inode is unlinked-but-retained commits an `nlink: 0` record; a crash before `close` would orphan it. Excluding it from the manifest is not viable — OPFS union GC keys blob liveness on `manifest.inodes` membership, so dropping the record would reclaim the live fd's data.
- Fix: on open, treat an inode with **`nlink === 0` AND no dirent** (unreachable) as garbage in **every** view the GC considers — the working manifest AND both on-disk A/B slots — not just the selected working manifest (`unionLiveChunkFiles` unions all three). Sweep the record and reclaim its blobs; the loaded working manifest drops the record so the next commit doesn't re-persist it.
- Applies to OPFS (open-time union GC) and IDB (add an orphan sweep at open). Safe because retain is gone on reopen, so no live fd needs a `nlink:0`-unreachable inode.

---

## Section B — CachedBackend atomic-batch journaling + fsync-strict

### B.1 The bug
`CachedBackend.flush()` applies queued write-back ops to `inner` and `queue.shift()`s each as it succeeds, then calls `inner.flush()`. On an `inner.flush()` (or, per the atomic-batch contract, any op) failure the backend rolls back the whole batch, but the cache has already dequeued those ops → they are lost from replay while rolled back on disk → the cache diverges permanently.

### B.2 Atomic-batch model *(F2/F4/F15)*
A flush cycle **owns** its batch:
- It **snapshots** the queue prefix at cycle start (the prefix present when `fsync` was called) and removes/isolates it from the live queue, so ops enqueued during the cycle form a **later** batch. *(F4 — replaces the current loop-on-live-queue, which lets a steady writer starve a strict `fsync`.)*
- It applies the owned batch to `inner`, then hits the `inner.flush(opts)` barrier.
- **On success:** discard the owned batch; run the identity-guarded `dirtyData` cleanup (B.4); release its reservations (B.6).
- **On ANY failure** (op-application OR barrier, at any position): re-queue the **ENTIRE** owned batch — applied prefix + failed op + unattempted suffix — to the **front** of the live queue in **original order**, preserving each content entry's owned payload, then surface the error. The backend has rolled the whole batch back (contract §2 / Section C), so re-applying the full batch next cycle is clean and idempotent (ops are absolute, caller-id'd). Only entries proven to be a no-op with no cache-visible effect may be dropped; the default is re-queue-all-in-order.

The batch is thus the atomic unit on **both** sides — the backend rolls it back atomically, the cache re-queues it atomically. No prefix/suffix is ever stranded.

### B.3 Content payloads are immutable and owned *(F1/F6)*
- A content journal entry captures the **specific buffer** it applies as an owned, immutable payload (`{ id, buf }`). `write`/`truncate` install a **fresh** `Uint8Array` (never mutate in place), so reference identity distinguishes versions. Replay writes that exact buffer, **never** re-reading live `dirtyData` (which could replay a newer `B` for an `A`-snapshot, violating the fsync-at-call barrier).
- `dirtyData[id]` remains the optimistic **latest** view for reads; a re-dirty installs a new buffer and enqueues its own entry (a later batch). A content op's `dirtyData` bytes are **not** deleted on inner-write success (as today) — only when the batch that flushed them is **durably confirmed**.

### B.4 Durable-confirm cleanup is identity-guarded *(F9)*
On durable confirmation of a content entry `{ id, A }`, delete `dirtyData[id]` **only if** `dirtyData.get(id)` is still exactly `A`; if a newer `B` was installed, leave it for its own entry's confirmation. (Same identity discipline as B.3, at the confirmation edge.)

### B.5 fsync-strict *(F4/F3)*
`flush(opts?: { strict?: boolean })`:
- **Background auto-flush** (enqueue timer) → non-strict: on failure it re-queues (B.2), fires `onFlushError`, and does **not** re-arm the timer (no spin-loop on persistent `ENOSPC`; a later flush retries). *(Closes the tracked "post-failed-timer-flush no re-arm" item.)*
- **`Vfs.fsync()` / unmount** → `flush({ strict: true })`: drains and barriers the call-time snapshot, and **rejects** if it cannot be made durable, so the shell's `fsync`/`close` reports `ENOSPC`. POSIX fsync = "everything written so far is durable, or an error." A rejecting strict flush still leaves the journal re-queued (writes not lost, just not durable).
- **Read-side `drain()`** must **not** swallow a flush failure and then read+cache rolled-back inner state *(F3)*: it propagates the failure so a cache-miss read never populates a sub-cache from a view older than the pending mutations. While a batch is un-durable, entries it touched are served optimistically from the cache.
- **Raw backends** ignore `opts` — their `flush()` already throws on durability failure (inherently strict).

### B.6 Bounded write-back / backpressure *(F5/F7/F8/F11/F12/F16/F17)*
Persistent `ENOSPC` must push back on the writer, not OOM.
- **Accounting (F16/F12):** track total bytes of **all live write-back payloads** — every journal-owned immutable payload in an active/pending batch (retained until its entry is durably confirmed) **plus** every current `dirtyData` buffer not yet owned by an entry. A buffer's bytes are charged while **any** live reference retains it; replacing `dirtyData[id]` does not free the old buffer while a journal entry still owns it; released only on **full dereference** (entry confirmed AND no longer the current `dirtyData`). Charge **heap-resident** bytes — a cold-clean-file write reserves the **full materialized buffer**, not logical growth.
- **Admission gate (F7/F8/F17):** every mutating op, once its exact projected buffer size is known (after any size-determining `getattr`; these reads mutate/reserve nothing), performs a **synchronous** check-and-increment on the accounting: if write-back is unhealthy (last flush failed) AND `totalLive + projected > bound`, reject `ENOSPC` **now**, having mutated/allocated nothing. Otherwise increment the reservation. This point is immediately before the first allocation/mutation (`materialize`/`dirtyData.set`/`enqueue`), with **no await between the check and the increment** — race-free (JS single-threaded), so two concurrent cold writes serialize at their reservations and neither over-admits. The increment persists through the subsequent `materialize` await and is **released** if any later step throws before the payload becomes a live reference.
- The reserved-name / unsupported-op rejections already run before cache mutation, so this fits the existing validate-before-mutate discipline.

---

## Section C — Backend atomic-flush-batch hardening (`backend-opfs`, `backend-indexeddb`)

The journal (Section B) is sound only if the inner backend honors the atomic-flush-batch contract (§2) for **all** ops and **all** failure classes. Both backends need hardening beyond their current content-only / request-only rollback:

- **OPFS *(F14)*:** `write`/`truncate` already roll back on any throw, and `commit()` rolls back on its failures, but the **metadata** worker ops (`create`/`unlink`/`rename`/`link`/`symlink`/`setattr`) mutate `mani` directly and throw validation `VfsError`s straight to the RPC boundary with no rollback. Wrap the op dispatch so that, once a flush batch is dirty, **any** op rejection calls `rollbackToCommitted()` before the error is returned.
- **IDB *(F13)*:** the shared-transaction abort is guaranteed for failed IDB **requests**, but a method that reads state and then throws a `VfsError` from JS control flow (e.g. `unlink(parent, "missing")` → `ENOENT` before issuing a request) does **not** abort the transaction, so an earlier `create` in the same batch can commit. Every op explicitly **aborts the active shared transaction** on any throw, not relying on request-failure auto-abort.
- Both also implement the F4 `retain`/`release` hooks, the `fdRetention` cap, and the open-time unreachable-`nlink0` sweep (A.7).

---

## Section D — Testing

### D.1 Shared conformance suite (MemoryBackend, IDB, OPFS)
- **fd lifecycle:** `open→unlink→read`; two fds on one inode (last close reclaims); `rename`-over a retained target keeps the fd alive; `open("w")` retain-failure leaves the FS unchanged; the `exec 3<f; exec 4<&3; rm f; close 3; read 4` dup case (retain per reference); a crash-sweep test — commit an unlinked-but-retained `nlink:0` inode, reopen, assert it and its blobs are swept from **every** GC view.
- **Atomic flush-batch:** within one un-flushed batch, op 1 succeeds and op 2 throws a **JS validation** error (`unlink` of a missing name); assert op 1 is **not** durable after the settling flush (whole-batch rollback). This is the case that forces the OPFS metadata-op wrapper and the IDB explicit-abort.

### D.2 CachedBackend tests (fault-injected inner)
- **No divergence:** inject an `inner.flush()` `ENOSPC` mid-batch → assert the whole batch re-queues, the backend sits at last-committed, and a later (space-freed) flush makes it durable; cache and backend never disagree. Same for a mid-batch op-application throw.
- **Payload retention:** write → snapshot into a flush → fail the barrier → the re-queued content op still has its bytes (durable content correct on retry, not a zero-length file). Concurrent re-dirty (A→B): the A-batch replays A; B gets its own entry; identity-guarded cleanup keeps B.
- **fsync-strict:** `Vfs.fsync()` rejects `ENOSPC` on a non-durable batch; a background auto-flush fires `onFlushError` and does not re-arm; **termination** — a steady concurrent writer does not starve a strict `fsync`.
- **Read consistency:** rename with a cold parent, fail the drain flush → the miss read does not cache the rolled-back listing.
- **Backpressure:** unhealthy + over-bound → a mutating op fails `ENOSPC` before any cache mutation; a cold-clean-file write reserves the full materialized buffer; accounting counts journal-owned payloads + `dirtyData`, released only on full dereference.

## Out of scope (deferred)
- **Chunk-granular dirty data.** Whole-file dirty buffers make large/sparse writes memory-heavy; a chunk-granular dirty model is the thorough fix and a larger change. v1 uses the full-projected-buffer reservation for backpressure.
- Cross-tab sharing beyond the single-writer Web Lock.
- Non-transactional (non-rollback) backends — out of contract for the write-back stack; a separate cache strategy for them is YAGNI while all backends are ours.
