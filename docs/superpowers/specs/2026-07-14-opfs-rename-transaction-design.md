# waSH — OPFS Rename Transaction & Sidecar Durability Design

**Date:** 2026-07-14
**Status:** ⛔ SUPERSEDED — NOT to be implemented. Superseded 2026-07-14 by the manifest-model redesign (`docs/superpowers/specs/2026-07-14-opfs-manifest-backend-design.md`).
**Why superseded:** A clean-slate adversarial review of THIS spec (transcript `.lil-bro/20260714-184328-opfs-rename-spec-review.md`) reached a fundamental result (finding F10): multi-entry atomicity cannot be composed from OPFS single-entry primitives (`move`/`removeEntry`/`write`) via LIFO rollback — the `OpTxn` step-present/step-absent invariant assumes single-op disk inverses, but a rename touches multiple entries (byte-move + metadata-record-move; displaced-remove + source-move). A prior-art survey (general crash-consistency systems + OPFS-specific projects) confirmed the field's answer: keep ALL metadata in one atomically-swapped manifest object and store data in id-addressed blobs that never move on rename — so rename becomes a metadata-only edit, atomic and O(1) by construction (the same model `@wash/backend-indexeddb` already uses). This whole transaction/sidecar/shadow design is therefore unnecessary; the redesign eliminates it.
**Original scope (kept for the record):** `@wash/backend-opfs` worker — restructure the `rename` op onto an in-memory transaction primitive, and make sidecar file writes crash/quota-durable.

This design was validated through a five-turn adversarial review (transcript:
`.lil-bro/20260714-171812-opfs-rename-txn-design.md`, 10 findings, all agreed,
0 deadlocked). Section headers cite the finding(s) each mechanism answers.

## 1. Problem & goal

The OPFS `rename` op has produced correctness findings across seven external
review waves — always the same class: a fallible step mid-rename (quota,
storage error, failed sidecar write) interleaving badly with shadow-move,
restore, and commit bookkeeping. Each fix revealed the next interleaving
because failure handling was spread through the op body as ad-hoc branches
("did the helper commit? / is the source rebound? / was the shadow dropped?").

**Goal:** make a rejected rename leave consistent, retryable state *by
construction* — one failure code path, no per-step commit-state reasoning —
and make sidecar writes durable against the truncate-then-write and
copy-based-`.old` corruption windows.

**Non-goals (explicit, from the brainstorm decisions):**
- No on-disk journal. The mechanism is an in-memory transaction; the worker is
  single-writer and its in-memory state is authoritative within a session.
- Recovery direction is **roll-back only** — a rejected rename means "didn't
  happen." No roll-forward.
- Crash-mid-rename may leave disk debris (an orphaned `.wash-shadow-*`); that is
  accepted. A crash-time sweep is out of scope (possible future work).
- Only `rename` is rewritten onto the primitive, plus `writeSidecarFile` /
  sidecar deletion are made durable. `create`/`unlink`/`symlink`/`setattr` keep
  their existing memory-commits-last fixes; the primitive is designed to be
  adoptable by them later but they are not touched now.

## 2. The transaction primitive `OpTxn` (F1, F3, F4)

A step-based all-or-nothing wrapper. The unit of registration is a **paired
step** recording BOTH inverses of one fallible action, registered *after* that
action's work has succeeded:

```ts
interface TxnStep {
  /** Physical inverse (move back, remove a created dir). Absent for memory-only steps. */
  undoDisk?: () => Promise<void>;
  /** Synchronous, exact, snapshot-based memory restore. Never throws. */
  undoMem: () => void;
}

class OpTxn {
  private steps: TxnStep[] = [];
  private postCommitActions: (() => Promise<void>)[] = [];
  private committed = false;

  /** Register a completed step's inverses. Call immediately after the step succeeds. */
  did(step: TxnStep): void;

  /** Irreversible/best-effort work (deletes, poison splices). Runs only after commit. */
  postCommit(fn: () => Promise<void>): void;

  /**
   * Run the reversible body, then commit, then post-commit actions.
   * Body throws → rollback (see below) → rethrow original error.
   */
  async run<T>(body: (txn: OpTxn) => Promise<T>): Promise<T>;
}
```

### 2.1 Rollback protocol (F1, F3)

On body throw, `run()` walks `steps` in **strict LIFO** order. For each step:

1. If `undoDisk` is present, run it.
2. **Only if `undoDisk` resolved** (or was absent), run `undoMem`.
3. If `undoDisk` **rejects**, the walk **HALTS immediately** — remaining
   (earlier) steps are left intact in *both* domains, `undoMem` for the current
   step is NOT run, and rollback stops.

Then the original error is rethrown.

**Invariant (the whole point):** every step is either fully present (disk +
memory effects both live) or fully absent (both reverted). Memory never gets
ahead of or behind disk. A halt leaves a *consistent intermediate state* — some
prefix of steps applied, cleanly — never a chimera. Because disk-undo is
confirmed before memory-undo, and the walk halts on the first disk-undo
failure, in-memory state (the authoritative projection) always matches the
durable projection at the halt point.

### 2.2 Commit boundary and post-commit actions (F4, F5)

`run()` sets `committed = true` at the end of the body (before returning its
value). Post-commit actions then execute in registration order; **each is
individually best-effort** (failure is swallowed or routed to the poison list —
never triggers rollback). Irreversible effects (deleting a shadow, `nodes.delete`
of a displaced node, splicing destroyed-bytes poison) live ONLY here. This is
why "a committed deletion can't be rolled back" (the wave-7 finding) is a
non-problem: nothing deleted can ever need resurrection, because deletion never
happens in the reversible phase.

### 2.3 Design rules the primitive imposes

- **No failure branches in the op body.** The body is a linear sequence of
  reversible steps, then commit, then post-commit actions. No step inspects
  commit state; no `try/catch` appears in the body. The only failure control
  flow lives in `run()`.
- **Reversible steps must not mutate `pendingFlushErrors`.** Poison mutations
  are either post-commit actions or pooled-handle eviction side-effects that
  survive rollback by design (a rolled-back rename's surviving files keep their
  legitimate poisons). (F5)
- **Physical addressing only.** Steps address entries by `(rec.physDir,
  rec.name)` — never by `parent.dir` (see §3).

## 3. NodeRec model change: `physDir` (F2, F9)

A directory rename physically relocates children one at a time; mid-operation
the children are **split** across two OPFS directories. The current model
(which assumes `parent.dir` is every child's physical container) cannot
represent this, so a halt could land in an unrepresentable state.

**Amendment:** `NodeRec` gains a field:

```ts
physDir: FileSystemDirectoryHandle; // the directory that physically holds this entry right now
```

Logical parentage (`parentId` + which dentry map lists the entry) is **decoupled**
from physical location (`physDir` + `name`). Rules:

- Every op that physically touches an entry — `unlink`'s `removeEntry`, the move
  helpers' source cleanup, all sidecar file access — uses `(rec.physDir, rec.name)`.
- A move step updates the **child's** `physDir` as that child moves. Mid-tree,
  `child1.physDir === newDir` while `child2.physDir === oldDir` and
  `srcRec.dir === oldDir`: every field is individually true, and
  `readdir`/`lookup`/`getattr`/content ops all work because none of them needs
  the parent handle. The split directory is a **representable, fully operational**
  state.

### 3.1 Physical identity uses `isSameEntry`, never `===` (F9)

`FileSystemDirectoryHandle` object identity is meaningless across
`getDirectoryHandle()` calls — two distinct objects can designate the same OPFS
directory. All physical-location comparisons use the standardized
`FileSystemHandle.isSameEntry()` (`Promise<boolean>`, worker-available, predates
sync access handles — within our engine floor):

```ts
// "already there" fast path in moveFileEntry, for idempotent re-walks on retry:
if (rec.name === newName && (await rec.physDir.isSameEntry(destDir))) return;
```

Object identity (`rec.physDir === destDir`) may be used ONLY as a cheap
short-circuit *before* the `isSameEntry` await (it is exact on first attempts,
where `physDir` was assigned from the same object), never as the sole test.

## 4. Transaction-aware move helpers (F2, F3)

`moveFileEntry` and `moveTree` take the `OpTxn` and register one paired step per
physical action, so the outer op has no opaque awaited commit to reason about.

- **`moveFileEntry(txn, rec, id, destParentId, destDir, newName)`:**
  already-there fast path (§3.1) first; else perform the physical move
  (native `move` or copy+delete fallback), then `txn.did(...)` with:
  - `undoDisk`: move the file back to `(prevPhysDir, prevName)`.
  - `undoMem`: restore `rec.physDir`, `rec.name`, `rec.parentId`, `rec.file` from
    snapshots taken before the move.
- **`moveTree(txn, rec, id, destParentId, destDir, newName)`:**
  `getDirectoryHandle(newName, {create:true})` on the destination parent (a
  paired step whose `undoDisk` removes the created dir if empty), then recurse
  depth-first over children (each child move is its own registered step), then a
  final **root rebind** step (`undoMem` restores the dir/parentId/name; `undoDisk`
  removes the created dest dir / no-op as appropriate), then a source-dir-removal
  step.

Registration is in execution order (children depth-first, root rebind last);
strict-LIFO rollback (§2.1) therefore unwinds root-rebind → children →
create-dest. Every intermediate halt is representable via `physDir` and
converges under unchanged retry via the `isSameEntry` fast path — so **no
composite moveTree rollback protocol is needed** (that was only required when the
model couldn't represent partial subtrees).

## 5. The rename op on `OpTxn` (F1, F5, F8)

Reversible phase (inside `run`), in this order — **the source's primary move is
the terminal reversible disk step**:

1. **Validations** (kinds, ENOTEMPTY, reserved names both sides, same-entry
   no-op) — before any step; a validation failure rejects with nothing done.
2. **Destination-name sidecar record transport** (if the moving entry has a
   record): move the record into the destination sidecar via the generation swap
   (§6). Step inverse: reverse record move; memory undo: restore the `tp.sidecar`
   snapshot.
3. **Displaced aside-move** (if overwriting): move the displaced entry to
   `.wash-shadow-<ulid>` via `moveFileEntry`/`moveTree`. Its poison (if the
   displaced file was dirty) is recorded by the pooled-handle close — a
   rollback-surviving side effect, not a reversible step.
4. **Primary source move** into `toName` via the helpers. **No reversible step
   follows this.**
5. **Memory-only map updates** — `fromChildren.delete`, `toChildren.set`, parent
   mtimes. These are infallible; their undos are pure memory.

Then **commit**. Post-commit actions (best-effort, never roll back):

- Discard the displaced shadow: `removeEntry(shadowName)`, `nodes.delete`, drop
  its shadowName sidecar record.
- Splice the displaced entry's flush poison (destroyed bytes) out of
  `pendingFlushErrors` — see §7.

### 5.1 Halt taxonomy — why every reachable halt is retry-benign (F1, F8)

A halt only occurs when some step's `undoDisk` fails during unwind, which only
runs if a *later* reversible step failed. Enumerate by which step's unwind halts:

| Unwind halts at | Reachable? | Resulting state | Unchanged retry of `rename(a,b)` |
|---|---|---|---|
| After step 5 (memory-only) | No — memory undos can't fail | — | — |
| After step 4 (primary move) | **No** — step 5 is memory-only, nothing fallible follows step 4, so no unwind is ever triggered after the source moves | The ENOENT-wedge state (source left `fromName`, op rejected) is **structurally impossible** | — |
| Undoing step 3 (aside move-back fails) | Yes | Displaced sits at shadow name (`physDir`/`name` say so); `toName` vacant in maps & disk; source untouched at `fromName`. **Halt handler resurfaces the shadow** (§5.2). | Validations pass, destination lookup finds nothing → non-overwrite path → succeeds. Shadow is visible debris. Clean. |
| Undoing step 2 (reverse record swap fails) | Yes | Stale sidecar record under shadow name (tolerated garbage per reader rules); source & destination names untouched | Clean non-overwrite rename. |

**Every reachable halt leaves `fromName` present and `toName` vacant** — exactly
the precondition the queued closure needs. For directory moves, a mid-tree halt
leaves the source dir at `fromName` with some children's `physDir` already at the
destination; retry re-runs `moveTree`, `getDirectoryHandle(create:true)` returns
the same dest dir, and the per-child `isSameEntry` fast path converges.

### 5.2 Resurfaced shadows (F5, F8)

When rollback halts while undoing the aside step (step 3), the displaced file's
bytes are physically at the shadow name but would otherwise vanish from the
logical namespace of a rejected op. The halt handler therefore, using only
**infallible memory writes**, re-registers the displaced entry in the
destination's dentry map under its physical shadow name
(`toChildren.set(shadowName, {id, kind})`; the NodeRec's `physDir`/`name` already
say the shadow location). Consequences:

- Data never disappears: `readdir` shows `.wash-shadow-…` — ugly, honest,
  user-recoverable with a plain rename. No sweep dependency.
- The poison stays correct with no new rule: the entry is live, so its durability
  failure is legitimately reportable, and refers to a file the user can see.
- The retry contract is untouched: shadow name ≠ `toName`, so the unchanged
  queued `rename(a,b)` still runs the clean non-overwrite path.

## 6. Durable sidecar writes: the generation scheme (F6, F7)

`writeSidecarFile`'s current truncate(0)-then-write on a sync handle has a
quota-failure window that durably empties a directory's sidecar (symlinks demote
to plain files on reopen). Replace it with a **generation swap** where the old
content survives until a real commit point.

### 6.1 Versioned envelope + parse gate (F7)

Sidecar files use a versioned envelope: `{"v":1,"entries":{ <name>: {...} }}`.
The reader distinguishes three outcomes, which the existing
`parseSidecar()`-returns-`{}`-on-garbage behavior CANNOT (garbage must not read
as valid-empty):

- **Valid envelope** → use its `entries`.
- **Unparseable / truncated / empty file** → treat the file as ABSENT (a
  truncated JSON envelope cannot parse; the closing braces are missing by
  construction).
- **Genuinely-empty `entries` in a valid envelope** → use as an empty sidecar.

Migration: readers accept both v0 bare objects (existing on-disk data) and v1
envelopes; writers emit only v1. A truncated v0 file also fails parse, so the
gate is sound for pre-migration data.

### 6.2 Write transaction

Three reserved names under the §7 predicate: `.wash-attrs` (main),
`.wash-attrs.tmp` (staging, **never read**), `.wash-attrs.old` (previous
generation).

1. Write `.wash-attrs.tmp` — fresh handle: create → write new envelope → flush →
   close.
2. If `.wash-attrs` exists: move it to `.wash-attrs.old` (native `move`; no-move
   engines copy to a freshly created `.old`, flush, close).
3. Install new content at `.wash-attrs` (native: `tmp.move(dir, ".wash-attrs")` —
   destination vacant by step 2, sequential worker; no-move: fresh-create main,
   write from tmp content, flush, close).
4. **Delete `.wash-attrs.old`. This deletion is the durable commit.**
5. Delete `.wash-attrs.tmp` if it still exists (no-move path).

### 6.3 Reader precedence (absolute)

`.old` (if it parses) > `main` > nothing. **`.tmp` is never read.**

- `.old` parses → the last write never committed → restore it (best-effort
  promote back to main) and use it; any `main` alongside is a suspect partial
  install and is discarded.
- `.old` present but does not parse → treat as absent, delete best-effort, fall
  through to `main`.
- only `main` → untouched or committed install; use it.
- `.tmp`-only (first-ever sidecar write, crashed before step 2) → reads as **no
  sidecar**; delete the stray tmp. (Roll-back semantics: the in-flight change
  didn't happen.)

This closes the reviewer's decisive double-failure trace: move fails at step 3,
catch cleanup double-fails, RPC rejects, clean reopen → `.old` present and
parseable → **pre-change content loads**; the rejected change cannot surface,
because the old generation survives until step 4 and nothing before it destroys
the old content. Partial `.old` from a failed copy on a no-move engine
self-invalidates via the parse gate → intact `main` wins.

### 6.4 Sidecar deletion is the same transaction

When a directory's sidecar becomes logically empty (e.g. `chmod 0700 → 0644`,
symlink cleanup), deletion uses the generation protocol, never a raw
`removeEntry`: native — move `main → .old`, then delete `.old` (commit);
no-move — copy `main → .old` (parse-gated), `removeEntry(main)`, delete `.old`
(commit). A failure/crash before the commit leaves a parseable `.old` → reader
restores it → "the delete didn't happen" (roll-back semantics).

### 6.5 Crash residue (no data-loss residual)

The generation scheme + parse gate leave **no data-loss window**, on either
native-move or no-move engines, because `.old` is created before `main` is
touched (step 2) and deleted only after `main` is committed (step 4), and the
parse gate rejects any partial `.old`:

- Native-move engine: `main → .old` (step 2) is atomic; every crash/failure
  point has either a parseable `.old` (→ pre-change content) or, post-commit, an
  intact new `main`. No residual.
- No-move engine: step 2 (`copy main → .old`) and step 3 (`write new main`) are
  non-atomic, but they are ordered so `.old` outlives step 3. A partial `.old`
  from a crash mid-copy fails the parse gate → falls through to the still-intact
  `main` (step 3 hasn't started). A partial `main` from a crash mid-step-3 is
  beaten by the complete, parseable `.old`. Either way the reader loads a
  complete generation.

The only residual is **stray files** (`.tmp`/`.old`) left by a crash, which are
never user-visible (reserved names, §7), are cleaned best-effort on the next read
(parse gate) and the next successful write of that directory's sidecar, and cost
extra disk churn. This is strictly narrower than the pre-design truncate-then-
write defect (which durably lost metadata); the generation scheme eliminates the
data-loss class entirely. (An earlier point in the debate conceded a no-move
data-loss residual under a simpler "main wins" reader rule; the parse-gated
`.old`-precedence rule adopted in §6.3 supersedes that and closes it.)

## 7. Reserved-name predicate (F6)

Replace every hard-coded `name === SIDECAR_NAME` check with a single predicate
over a list, used by `ensureChildren`, `lookup`, `create`, `unlink`, `rename`
(both names), and `symlink`:

```ts
const RESERVED_NAMES = [".wash-attrs", ".wash-attrs.tmp", ".wash-attrs.old"];
function isReservedName(name: string): boolean { return RESERVED_NAMES.includes(name); }
```

`caps.reservedNames` carries all three; the conformance suite's reserved-names
case already iterates the caps list, so all three get coverage. `ensureChildren`
skips any reserved name during discovery, so a crash-leftover `.tmp`/`.old` is
never registered as a user-visible file.

## 8. Dependencies and declared deferrals (F5, F10)

Per the debate's binding wording constraint, this design's guarantees are split:

**Independently sound (no dependency on any other layer):** the rename
transaction's namespace and data guarantees — rollback exactness (§2.1), halt
taxonomy and retry-benignness (§5.1), shadow resurfacing (§5.2), split-directory
representability (§3), and sidecar write/delete durability (§6). Nothing in
findings F1–F4, F6–F9 depends on the cache layer.

**NOT independently sound — declared dependency on the pre-Plan-4 CachedBackend
contract work (failed-flush reconciliation / journal-until-flush-confirmed /
fsync-strict):**

1. **Same-session cache visibility of resurfaced shadows.** A warm
   `CachedBackend` readdir cache will not list a shadow resurfaced during a failed
   flush until caches rebuild (next session). Bounded to one cache generation;
   data always survives and is fully visible thereafter.
2. **F10, recorded verbatim as a requirement on the contract work:**
   `CachedBackend.flush()`'s failure path calls `inner.flush().catch(() => {})`
   before rethrowing the queue-head error (added in Plan 2 so a poisoned
   IndexedDB backend could clear its abort poison). For the OPFS poison list this
   settle-call can **consume an unrelated durability signal**: a rename rejects →
   the settle-flush reports-and-clears the resurfaced shadow's poison → the cache
   swallows it → the caller sees only the rename failure and the durability
   warning is lost. **The contract must distinguish "settle after failure" from
   "durability point": a settle-call must not consume durability signals it does
   not itself report.** In-scope alternatives were rejected on the record: a
   worker-side flush-mode discriminator IS the fsync-strict contract change by
   another name; a cache-side deferral breaks the IndexedDB backend's recovery
   semantics (a deferred already-reported abort would fail a later healthy fsync).

**Interim behavior until the contract work lands:** shadow data always survives
and becomes fully visible at the next session; the poison signal for a resurfaced
shadow can be lost to the settle path in the double-fault case — an
advisory-signal loss, never a data loss, bounded to one cache generation. The
spec does NOT claim the failed-op durability-signal invariant is fully satisfied
until that work lands.

## 9. File structure

- `packages/backend-opfs/src/txn.ts` (new) — `OpTxn`, `TxnStep`. Pure, unit-
  testable in Node (no OPFS): step registration, LIFO rollback, halt-on-disk-undo-
  failure, commit boundary, post-commit ordering. This is the highest-value unit
  test surface — the rollback protocol is pure control flow.
- `packages/backend-opfs/src/sidecar.ts` (modify) — versioned envelope
  serialize/parse, the three-outcome parse gate, v0/v1 migration read. Pure,
  Node-tested.
- `packages/backend-opfs/src/worker.ts` (modify) — `physDir` on `NodeRec`;
  `isReservedName` predicate; txn-aware `moveFileEntry`/`moveTree`; `rename` on
  `OpTxn`; `writeSidecarFile` and sidecar deletion on the generation scheme;
  `ensureSidecar` reader precedence. Remove the shadow/restore/truth-preserving-
  commit patchwork.

## 10. Error handling

- Every DOMException from a fallible step maps through `errnoFromDom` (already the
  worker convention) so RPC rejections carry an errno. Sidecar generation-scheme
  failures reject with the mapped errno of the failing OPFS call.
- `undoMem` closures must be infallible by construction (pure field/map
  restores). `undoDisk` closures may fail; that is the halt trigger (§2.1).
- Post-commit action failures route to `pendingFlushErrors` or are swallowed per
  their kind (deletes swallowed; a flush failure poisons); none rejects the op.

## 11. Testing

All rename/sidecar behavioral tests run in real Chromium (`test:browser`, the
existing rig). Fault paths use the existing `testHooks`-gated
`__injectFault(site, skip, times)` op — new sites: `sidecarTmpWrite`,
`sidecarOldMove`, `sidecarInstall`, `sidecarCommitDelete`, plus the existing
`moveStep`/`moveCleanup`/`evictFlush`.

1. **`OpTxn` unit tests (Node, `txn.ts`):** LIFO order; disk-undo-confirms-before-
   memory-undo; halt-on-disk-undo-failure leaves earlier steps intact in both
   domains; post-commit runs only after commit and never triggers rollback;
   post-commit failures don't reject.
2. **Sidecar generation unit tests (Node, `sidecar.ts`):** envelope round-trip;
   parse gate (valid / truncated / empty-file / valid-empty-entries / v0-bare /
   v0-truncated); reader precedence resolution given each {main, old, tmp}
   presence combination.
3. **Rename transaction browser tests:** the §5.1 halt taxonomy — one fault-
   injected test per reachable halt row asserting (a) the op rejects, (b) the
   post-halt namespace matches the table, (c) an unchanged retry succeeds cleanly,
   (d) resurfaced shadows are visible via raw-worker `readdir`; plus the
   directory split-and-converge case.
4. **Sidecar durability browser tests:** fault-inject each generation step;
   assert reopen loads pre-change content before the commit-delete and new content
   after; the no-move fallback path (force the copy branch); empty-sidecar delete
   transaction.
5. **Conformance:** the full `@wash/vfs/conformance` suite stays green (raw +
   `CachedBackend`) in Chromium; reserved-names case now covers all three names.
6. **Regression:** every prior wave-3…7 finding gets a browser test asserting the
   structure prevents it (these become permanent guards that the patchwork is
   gone).

## 12. Out of scope for this design

- On-disk journal / crash-time debris sweep (orphaned `.wash-shadow-*` reclamation).
- The CachedBackend failed-flush reconciliation / fsync-strict contract change
  (§8) — tracked pre-Plan-4 item; this design names F10 as a requirement on it.
- Adopting `OpTxn` in `create`/`unlink`/`symlink`/`setattr` (primitive is designed
  to allow it; not done here).
- A versioned-pointer sidecar scheme to erase the no-move-engine crash residual
  (§6.5) — the parse-gated generation is the accepted floor.
