# waSH — OPFS Manifest-Model Backend Design

**Date:** 2026-07-14
**Status:** Approved pending user review
**Scope:** Rewrite the internal storage model of `@wash/backend-opfs` (worker side) from a path-transparent tree + `.wash-attrs` sidecars to an **id-addressed blob store + a single atomically-swapped manifest**. The `WashBackend` contract, the client/worker RPC split, the browser test rig, and the conformance suite are unchanged.
**Supersedes:** `docs/superpowers/specs/2026-07-14-opfs-rename-transaction-design.md` (⛔ not implemented) and the sidecar/shadow implementation currently on PR #3.
**Hardened by:** a seven-finding adversarial review (transcript `.lil-bro/20260715-083407-opfs-manifest-spec-review.md`, all AGREED, 0 deadlocked). §§3.1a, 3.2, 3.3, 4, 5, 6, 11 below incorporate its amendments; finding ids (F1–F7) are cited inline.

## 1. Why this redesign exists

The OPFS `rename` op produced correctness findings across seven external review
waves plus two adversarial design debates. A clean-slate review of the
transaction-based redesign reached a fundamental result (transcript
`.lil-bro/20260714-184328-opfs-rename-spec-review.md`, finding F10):

> Multi-entry atomicity cannot be composed from OPFS single-entry primitives
> (`move`/`removeEntry`/`write`) via in-memory rollback. Any operation touching
> more than one OPFS entry — overwrite-rename (displaced-remove + source-move),
> or a file move that also moves its metadata record — can fail after a partial
> effect, and no step-pairing/halt protocol manufactures atomicity the platform
> doesn't provide.

A prior-art survey (general crash-consistency systems; OPFS-specific projects)
confirmed the field's answer and is the basis for this design:

- **Systems consensus** (Git, SQLite, LMDB, ZFS, RocksDB, lightning-fs): keep
  all namespace+metadata in ONE object swapped atomically, and store data as
  id/content-addressed blobs that never move — converting "N objects change
  together" into "1 object changes; everything else is inert if orphaned."
- **Crash-consistent metadata commit via a two-generation scheme (LMDB-style):**
  the manifest is kept in two slots (`manifest.a`/`manifest.b`), each carrying a
  `generation` counter and a `checksum`. A commit writes the new generation
  **in place** into the *non-current* slot via a worker sync access handle
  (`truncate` + `write(body+checksum)` + `flush`); the reader selects the
  highest-generation slot whose checksum validates. A torn/partial write
  corrupts only the slot being written; the other slot (the prior generation)
  remains valid, so the reader always recovers a complete generation. This is
  LMDB's dual-meta-page discipline: torn-write tolerance comes from the
  generation scheme + self-validation, NOT from an atomic-swap primitive — so the
  worker stays fully synchronous and takes no dependency on `createWritable()`'s
  soft "user agents try to ensure no partial writes" wording.
- **OPFS precedent for id-addressed content:** SQLite's `opfs-sahpool` (the
  recommended SQLite-on-OPFS backend) stores content in opaquely-named files
  addressed by id, never path-renamed — the exact property that makes rename
  metadata-only. No surveyed OPFS project combines this with a single manifest;
  that combination is the acknowledged gap this design fills.

**Consequence:** with blobs addressed by inode id and never moved, no namespace
op touches content. `rename`/`create`/`unlink`/`symlink`/`chmod`/`mkdir` become
pure in-memory manifest edits committed by one generation write per flush batch —
**atomic and O(1) per operation** (durable-commit cost is a separate axis, §5/F5).
The entire multi-entry failure-atomicity problem (F10 and the wave-3…7 finding
class) does not exist in this model — a namespace mutation touches exactly one
durable object (the manifest generation), never several. This backend converges on the
same id-addressed inode/dirent model `@wash/backend-indexeddb` already uses,
differing only in the atomic-commit substrate (IDB transactions there;
manifest-swap here).

## 2. On-disk layout

The OPFS mount root holds a flat, opaque structure — no user-path-transparent
tree, no per-directory sidecars:

```
<mountRoot>/
├── manifest.a            — one of two retained manifest generations (A/B; F3)
├── manifest.b            — the other generation; reader picks the highest valid generation
└── blobs/
    ├── <inodeId>.0.<gen> — chunk 0 of inode <inodeId>, as of manifest generation <gen>
    ├── <inodeId>.1.<gen> — chunk 1, as of generation <gen>
    └── …                  (chunkSize benched, default 64 KiB; a sparse/zero chunk is simply absent)
```

**Chunks are copy-on-write and VERSIONED, not mutated in place (P1-A/P1-B fix).** A chunk
file is named `blobs/<inodeId>.<chunkIdx>.<gen>`, where `<gen>` is the manifest generation
the version was staged for — there is no bare `<id>.<chunk>` file. A chunk version is
**immutable once its generation is committed**: the current batch's mutations always COW into
`<id>.<chunk>.<stagedGen>` (`stagedGen` = the committed `generation + 1`, constant for the
whole batch), copying the committed bytes forward once so unmutated parts of the chunk
survive; the committed versions (≤ the current `generation`) are never touched. The manifest
schema carries NO per-chunk version field — a reader derives each chunk's version at open as
"the highest `<gen>` ≤ the selected manifest generation," so there is no manifest bloat. This
is what makes content crash-atomic in the same sense metadata already was (§3.1/§5): a crash
between a blob flush and the manifest generation write leaves an **orphan** staged-gen chunk
file on disk, never a corrupted committed one — the prior (still-selected) generation always
resolves its own intact chunk versions, and the orphan is later reclaimed by GC (§3.3).

**Two manifest generations (F3), not one.** A single manifest is a single point
of whole-filesystem loss: a corrupt/truncated manifest would strand every blob
and (with GC) destroy all data. Following the LMDB dual-meta-page / ZFS
uberblock-ring pattern the prior-art survey surfaced, the backend keeps **two
generations** in `manifest.a` / `manifest.b` and alternates writes between the
two slots (a new commit overwrites the OLDER slot). There is no separate head
pointer — each manifest is self-describing via a `generation` field, so the
reader needs no third file that could itself corrupt.

All storage I/O uses worker-only **sync access handles** — for blobs (fast
in-place random access) and for the manifest slots (in-place generation writes,
§3.1). There is no `createWritable`/async-writable use and no backend-addressed
temp file; the whole worker storage path is synchronous.

- `<inodeId>` is the caller-minted ULID from the `WashBackend` contract.
- Chunk index files (`.<n>`) mirror the IndexedDB backend's chunking so small
  files are one chunk, large files are range-readable, and sparse regions cost
  nothing (an absent chunk reads as zeros).
- No file under `blobs/` is ever renamed or moved; content is addressed only by
  `(inodeId, chunkIdx)`.

## 3. The manifest

The whole namespace + metadata as one serializable structure — the exact shape
`@wash/vfs`'s `CachedBackend.warm()` consumes, plus symlink targets:

```ts
interface InodeRecord {
  kind: NodeKind;               // "file" | "dir" | "symlink"
  size: number;
  mode: number;                 // 0o777 mask
  mtimeMs: number;
  ctimeMs: number;
  nlink: number;
  target?: string;              // symlinks only
  holes?: Array<[number, number]>; // files only; range-encoded, sorted, non-overlapping,
                                    // half-open [startChunk, endChunkExclusive) all-zero
                                    // chunk ranges; OMITTED when empty (P1 deep, below)
}

interface Manifest {
  v: 1;                                              // format-version envelope (parse-gated)
  generation: number;                                // monotonic; reader picks highest valid (F3)
  checksum: string;                                  // over the serialized body sans this field (F3)
  rootId: NodeId;
  inodes:  Record<NodeId, InodeRecord>;
  dirents: Record<NodeId /*parentId*/, Record<string /*name*/, { id: NodeId; kind: NodeKind }>>;
}
```

**`InodeRecord.holes` — per-file HOLES, authoritative for zeros (P1 deep fix).**
§2 already establishes that a chunk WITH content resolves correctly as "the highest
on-disk version ≤ the selected generation" (nothing writes a chunk after its last
write). What that scan cannot tell, on its own, is whether an in-range chunk with NO
live version is *genuinely sparse* or is a *truncated-away chunk whose stale pre-truncate
version still lingers on disk* (kept around for GC/fallback, §3.3) — after a
shrink→reopen→extend→reopen sequence, the naive "guess from disk+size" reader resolves
such a chunk to its stale version and resurfaces old bytes instead of zeros. `holes`
closes this: it is the exact, range-encoded set of chunk indices `C ∈ [0,
ceil(size/chunkSize))` whose content is entirely zero (never-written OR
truncated-away). The reader's rule is now unconditional: chunk `C` in-range and
`C ∈ holes` → **return zeros, never resolve or read any on-disk version, no matter
what a disk scan would suggest**; chunk `C` in-range and `C ∉ holes` → resolve+read its
version as before (§2's rule still holds for non-hole chunks). Holes are maintained
exactly by the worker on every content op: `write` removes the touched chunk range from
`holes` (it now has content) and, if the write starts past the old EOF, adds the
newly-sparse gap `[oldChunkCount, firstTouchedChunk)` as new holes; `truncate`-shrink
clamps `holes` to drop/trim ranges `>=` the new chunk count (the shrunk boundary chunk
itself stays non-hole — its intra-chunk tail already reads as zeros via short-read);
`truncate`-extend adds the newly-in-range chunks `[oldChunkCount, newChunkCount)` as
holes. `holes` is OMITTED (not an empty array) when a file has no holes, so a normal
contiguous file adds zero manifest bytes. It is part of the JSON body and covered by the
existing checksum discipline like every other inode field.

The serialized form places `checksum` such that a truncated write cannot yield a
byte sequence that both parses AND validates (e.g. checksum is computed over the
body and a truncated body fails the check). This is what lets an in-place write
be torn without silently corrupting a generation — a partial write simply fails
validation and the reader falls back to the other slot.

### 3.1 Commit (ordered, fail-closed; two-generation, sync) (F1, F2, F3)

`flush()` commits an entire batch of namespace mutations as one durable step,
in this strict order — **blobs first, manifest last, and never a manifest that
references non-durable bytes**:

1. **Flush every dirty blob sync-access-handle.** (F2) Every content mutation this
   batch touched a COW'd **staged-generation** chunk version (`<id>.<chunk>.<stagedGen>`,
   §2) — the committed versions (≤ the current `generation`) were never written to, so
   this step can never corrupt already-durable content, only fail to durably persist
   the new staged bytes.
2. **If ANY blob flush fails:** do NOT commit the manifest; **roll the in-memory working
   manifest back to the last-committed generation AND discard this batch's staged chunk
   versions** (§3.1a); reject with the mapped errno. Because the committed chunk versions
   were never touched, discarding the staged versions requires no byte restoration — just
   deleting the staged-gen files and reverting the chunk-version map. Re-drive of the batch
   is the declared CachedBackend dependency (§11 / F1).
3. **Serialize the working manifest** with an incremented `generation` and a
   fresh `checksum`.
4. **Write it in place into the NON-current slot** (`manifest.a`/`manifest.b`,
   whichever is NOT the current highest-valid generation) via a sync access
   handle: `truncate(0)` → `write(bodyBytes, {at:0})` → `flush()`. This overwrites
   only the older generation; the current generation is untouched until step 5
   observes the new one as the highest valid.
5. The new slot, once flushed with a valid checksum, IS the new current
   generation (highest `generation`). This is the batch's linearization point.

`CachedBackend` batches and calls `flush()` once per batch, so a generation is
written once per batch — never per op. A crash at any step leaves a complete
prior generation in the other slot (torn new slot fails checksum → reader falls
back). See §5 for the full crash/failure matrix.

### 3.1a Whole-batch rollback (the only rollback; single-path) (F1)

The backend keeps the **last-committed serialized manifest** (it is exactly the
bytes of the current highest-valid slot). The in-memory working manifest is
mutated as ops apply. On a failed flush (step 2 above, or any op rejection whose
partial in-memory edits must be discarded), the working manifest is **restored
wholesale from the last-committed serialized form** — a single in-memory object
replacement that CANNOT half-fail (contrast the superseded design's per-step
disk-inverse rollback). This solves the phantom-size case (a `CachedBackend`
content replay of `truncate` then a failing `write` leaves the working manifest
ahead; rollback discards the whole batch's edits so no generation ever commits a
size without its bytes). The resulting cache/backend divergence for ops the
cache already dequeued is the declared dependency, §11.

**Content rollback is the COW mirror of this, and needs no byte restoration.**
Every content mutation this batch (write/truncate) COW'd into a staged-generation
chunk version (§2); rollback simply deletes those staged-gen files and reverts the
in-memory chunk-version map to whichever version (possibly none) each chunk
resolved to before this batch — the committed versions underneath were never
touched, so there is nothing to restore byte-for-byte (contrast the earlier,
now-removed in-memory content undo-log, which had to snapshot and replay whole
committed chunks). This closes P1-A (a crash between blob flush and the manifest
generation write can no longer corrupt the prior generation's content — it can
only leave an inert orphan staged version, reclaimed by GC §3.3) and P1-B (a
partially-failed multi-chunk write's already-COW'd chunks are staged-only and
discarded by this same rollback, never silently persisted by a later `!dirty`
commit).

### 3.2 Parse gate, versioning, and the highest-valid-generation reader (F3)

The reader loads BOTH slots and selects the manifest with the **highest
`generation` whose `checksum` validates**, independent of any pointer file (there
is none — each slot self-describes). Outcomes:

- **≥1 slot valid** → use the highest-generation valid one; if the other slot is
  invalid it is a torn in-flight write, harmlessly overwritten by the next
  commit.
- **Both slots absent** → a never-initialized mount → initialize empty (create
  `blobs/`, write generation 0 into a slot on first `flush`).
- **Both slots present but NEITHER validates** → the mount is unrecoverable:
  reject open with an EIO-class error. **Do NOT initialize empty and do NOT GC**
  — silently reinitializing would delete every blob and destroy recoverable data
  (F3). Surfacing the error lets a human/tool intervene.

The `v` field allows future format migration; v1 is the only format written.
Readers also accept a v0 bare-object manifest (none exist yet; forward-compat
only) but writers always emit v1 with generation+checksum.

### 3.3 Blob garbage collection — live set is the UNION of retained generations + working, VERSION-aware (F4, F7)

Blobs are chunk **versions** (§2), referenced by `(inodeId, chunkIdx)` resolving to a
specific `<gen>`; a chunk version unreachable from any manifest view that could still
be read is inert. Because the backend retains TWO fallback-eligible generations (§3.2),
GC must treat BOTH as roots — plus the in-memory working manifest, which includes
created-but-unflushed inodes and this session's staged (but not yet committed) chunk
mutations:

> **GC invariant:** a physical file `<id>.<chunk>.<v>` is collectible **iff**, for
> EVERY retained view (the working manifest, on-disk generation A, on-disk generation
> B), it is either not the version that view resolves for `(id, chunk)`, or `chunk` is
> outside that inode's size in that view, **or `chunk` is a HOLE in that view's own
> `InodeRecord.holes`** (P1 deep). Equivalently: the live set is the union, over
> every retained view, of each view's resolved chunk-version FILE for every file
> inode's chunks within that view's size AND NOT a hole in that view — computed per view
> by parsing its manifest, then for each file inode and each `chunk` in `0 ..
> ceil(size/chunkSize)-1` that is not in that view's own `holes`, resolving
> the highest `<id>.<chunk>.<v>` with `v <= thatView'sGeneration` (the working view uses
> the in-memory `generation`). Reclaim every `blobs/*` file not in the union.

A hole chunk references no live chunk file by definition (its content is authoritatively
zero — §3 above), so it contributes nothing to the union regardless of what version a raw
disk scan would otherwise resolve for it. This is what reclaims a truncated-then-re-holed
chunk's stale version: once every retained view marks that chunk as a hole (or out of
size), no view's resolved-version set references the stale file any longer and it becomes
collectible — exactly the case the multi-reopen regression test exercises.

This supersedes the earlier id-only union rule: GC now also reclaims **superseded chunk
versions** once no retained generation resolves to them, not just whole abandoned
inodes — e.g. an overwritten chunk's old committed version becomes collectible as soon
as no retained view's size-gated resolution still points at it.

Why the union (F7): if GC used only the newest generation and later fell back to
the older one (because the newest slot corrupted), the older generation could
reference a chunk version GC already deleted — restoring metadata that points at
destroyed data. With the union rule, a chunk version referenced by inode `x` in an
older retained generation survives until that generation's slot is **overwritten by a
newer valid commit** (at which point no fallback can reach it and it becomes
collectible). This is the LMDB free-list / ZFS block-free "don't free data reachable
from a retained older root" discipline.

Why the working set (F4): an inode created in-memory but not yet flushed has its
chunk versions on disk but is absent from both committed generations; a chunk mutated
this session is COW'd into a staged-generation version absent from every committed
generation until commit. Without the working set in the union, in-session GC would
reap a live-but-unflushed or live-but-uncommitted chunk version. GC runs at open
(working = the just-loaded generation, no unflushed/staged state — chunk versions are
resolved fresh from disk via a version-map scan, §2) and opportunistically in-session
(working = the mutated manifest + this session's staged chunk versions); the simplest
safe realization is that in-session GC only runs when there is no dirty pending state,
or restricts deletion to files absent from the union above.

**Orphan staged versions from a crashed/torn commit** (P1-A): a chunk version staged
toward a generation whose manifest write never completed (or was itself torn) has
`v` greater than either retained generation's own generation number, so it is excluded
from every view's size-gated resolution and is collectible on the next GC pass —
exactly the mechanism that reclaims a crash's orphan bytes without ever having
referenced or corrupted committed data.

GC is never a correctness dependency for existing data — it only reclaims
provably-unreachable bytes.

## 4. Operation mapping

The worker holds the manifest in memory (authoritative within the session) and
a pooled set of blob sync-access-handles. Every namespace op is an in-memory
manifest edit; content ops touch blobs. All namespace mutations are made
durable by the next `flush()`'s ordered fail-closed generation commit (§3.1).

| Op | Manifest edit | Blob I/O |
|---|---|---|
| `root`/`lookup`/`readdir`/`getattr`/`readlink` | read in-memory maps | — |
| `create` / `mkdir` / `symlink` | add inode + dirent (EEXIST on taken name; ENOTDIR on file parent; symlink sets `target`) | — |
| `unlink` / `rmdir` | remove dirent; `nlink--`; GC inode at 0 (ENOTEMPTY for non-empty dir) | none in-op — `<id>.<chunk>.<v>` versions reclaimed by version-aware GC (§3.3) |
| `rename` | delete `(fromParent,fromName)`, set `(toParent,toName)→id`; POSIX overwrite (displaced GC / EISDIR / ENOTDIR / ENOTEMPTY); same-inode no-op | — |
| `link` | add dirent, `nlink++` (EEXIST before EPERM; EPERM on dir) | — |
| `chmod` / `utimes` | inode field update | — |
| `read` | inode bounds → chunk range read | resolve each chunk's version via the working `chunkVersion` map, range-read `<id>.<chunk>.<v>` via pool |
| `write` | update inode `size`/`mtime` | COW each touched chunk into `<id>.<chunk>.<stagedGen>` (copying committed bytes forward once), then chunk-aligned RMW via pool (zero-length = no-op) |
| `truncate` | update inode `size`/`mtime` | drop tail chunks from the working view (physical files kept for GC, §3.3); COW + physically shrink the boundary chunk into `<stagedGen>` |
| `flush` | **ordered fail-closed commit (§3.1):** flush dirty blob handles FIRST → if any fail, roll back working manifest + reject → else write the new generation into the non-current slot | (blob handle flushes happen before the manifest write) |
| `dump` | return the manifest's `{inodes, dirents}` directly | — |
| `close` | final `flush`; close pooled handles; **release the per-root Web Lock** (§5/F6) | — |

### 4.1 Capability upgrades (fall out of the model)

`caps = { symlinks: "supported", hardlinks: true, atomicDirRename: true, renameCost: "O1", reservedNames: [] }` — identical to `@wash/backend-indexeddb`.

- **`hardlinks: true`** — dirents and inodes are separate manifest maps, so a
  second dirent to one inode id is trivial; `link` is supported.
- **`atomicDirRename: true` + `renameCost: "O1"`** — a directory rename
  re-parents ONE dirent; the subtree's inodes/dirents are keyed by id, not path,
  so nothing under it changes. The `"subtree"` non-atomicity is gone. **Scope of
  the cap (F5):** `renameCost` describes the OPERATION's scaling in the renamed
  subtree's size (O(1) — no per-descendant work), which is the cap's defined
  semantic. It does NOT describe durable-commit cost, which is a separate axis
  every mutation shares: **committing any batch is O(manifest size)** (one whole
  generation write), amortized across all mutations in the flush batch. See §5.
- **`reservedNames: []`** — the manifest and `blobs/` live in an opaque OPFS
  structure users never address by path (the VFS namespace is entirely inside
  the manifest), so no user-facing name needs reserving. The reserved-name
  finding class is eliminated.

### 4.2 Same errno parity as the reference/IDB backend

`lookup` returns `null` (not ENOENT) for missing names; `link` checks EEXIST
before EPERM; same-inode rename is a POSIX no-op; POSIX rename overwrite
semantics (EISDIR/ENOTDIR/ENOTEMPTY); unlink GC at `nlink ≤ 0`; reads past EOF
return short results; zero-length writes are POSIX no-ops; sparse chunks read
as zeros. The conformance suite is the oracle.

## 5. Durability, crash consistency, error handling

- **Single-writer is a correctness precondition — enforced (F6).**
  `OpfsBackend.open()` acquires a **Web Lock named `wash-opfs:<rootDirName>`**
  and holds it for the backend's lifetime (`navigator.locks.request` with
  `ifAvailable`), releasing it in `close()`. A second opener of the same root
  fails fast with `EBUSY`. Two concurrent writers would each commit generations
  from a stale snapshot and silently lose each other's work (and GC the loser's
  blobs) — so the lock is mandatory, acquired by the BACKEND itself (raw
  `OpfsBackend.open()` without the VFS is safe), independent of the VFS's own
  `mount({exclusive:true})` Web Lock (which is a separate, higher belt).
- **Ordered fail-closed commit (F2), §3.1.** A batch's blob handles are all
  flushed before the manifest generation is written; any blob-flush failure
  aborts the commit (no generation written), rolls the working manifest back to
  last-committed (§3.1a), and rejects. The honest durability guarantee is the
  strongest OPFS allows: a committed generation is written only after every
  backing blob flush **returned success** (`FileSystemSyncAccessHandle.flush()`
  is best-effort transfer-to-storage; OPFS exposes no stronger device barrier).
- **Manifest never claims phantom bytes.** Combined effect of the ordering above
  and whole-batch rollback (§3.1a): a blob write/flush failure prevents the
  generation from committing and discards the batch's in-memory edits, so no
  generation ever names bytes that aren't durable, and none ever commits a size
  from a `truncate` whose paired `write` failed.
- **Content is crash-atomic via copy-on-write versioned chunks (closes P1-A/P1-B).**
  Content is never mutated in place across generations: every mutation COW's into a
  staged-generation chunk version (§2), and the committed generation's own chunk
  versions are immutable once committed. This restores, for CONTENT, the same "always
  a complete prior generation" guarantee the manifest generation scheme already gave
  metadata — a crash between the blob flush and the manifest generation write cannot
  corrupt committed content, because the write never touched a committed chunk file;
  it only leaves an orphan staged-gen file that the next GC pass reclaims (§3.3). There
  is no in-memory content undo-log (superseded — see §3.1a); COW makes byte-level
  rollback/restoration unnecessary.
- **Crash/failure matrix (all end in a complete generation, content included):**
  crash before any blob flush → last committed generation intact, in-flight batch
  lost (accepted write-back risk), any COW'd staged chunk versions are inert orphans;
  crash after blob flushes, before/during the new-slot write → new slot torn → fails
  checksum → reader falls back to the prior generation in the other slot, which
  resolves only its own already-committed chunk versions (never the just-flushed
  staged ones — those remain > the fallback generation and are orphaned, reclaimed by
  GC); crash after the new slot is flushed valid → it is the new committed generation,
  and the staged chunk versions it references are now themselves committed. No path
  yields a partial or phantom state, for metadata or content.
- **Blob write/flush failures** map through `errnoFromDom` (e.g.
  `QuotaExceededError → ENOSPC`). The pooled-handle flush-failure poison
  mechanism (sticky `pendingFlushErrors`, reported once by `flush`/`close`)
  carries over from PR #3 for fsync fidelity.
- **Open-time recovery** = load both slots, pick the highest valid generation
  (§3.2; unrecoverable → EIO, never empty-and-GC), then GC-scan `blobs/` against
  the union live set (§3.3). No shadows, no sidecar reconciliation.
- **Durable-commit cost is O(manifest size) per flush batch (F5).** Every
  committed batch writes a whole generation; a build/import of a 50k-file tree
  with per-op fsync would pay O(N) per commit / O(N²) bytes overall. The write-back
  cache amortizes this across all mutations in a batch (the common case), but the
  cost is real. A benched **size-guard threshold** (§7) emits a one-time console
  warning above which the whole-rewrite cliff is observable rather than silent;
  the documented scaling lever if it is ever hit is a log+checkpoint manifest
  (out of scope, §11).
- **The only rollback is a whole-manifest in-memory restore (§3.1a)** — a single
  object replacement that cannot half-fail. There is no per-step disk-inverse
  rollback (the mechanism the superseded transaction design failed to make
  correct); durability is the separate generation write, which either happened
  (valid checksum in the newest slot) or did not.

## 6. Code structure

Kept from PR #3 (unchanged or lightly adapted):
- `src/client.ts`, `src/rpc.ts` — RPC, closed-state guard, worker-failure
  hygiene (`onerror`/`onmessageerror`/`failAllPending`). Client method surface
  unchanged (it's the `WashBackend` shape).
- `src/lru.ts` — repurposed to pool blob sync-access-handles.
- The `testHooks`/`__injectFault` scaffold, `vitest.browser.config.ts`, the
  browser-rig conventions.

New / replaced worker internals:
- `src/manifest.ts` (new) — `Manifest` types (with `generation`/`checksum`);
  `serializeManifest`/`parseManifest` with the checksum discipline (§3);
  `computeChecksum`; `loadManifest(dirHandle)` (read both slots, pick highest
  valid, or EIO — §3.2); `commitManifest(dirHandle, manifest, prevGen)` (write
  the new generation into the non-current slot via a sync access handle:
  `truncate`+`write`+`flush` — §3.1); the whole-batch in-memory
  snapshot/restore (§3.1a). The pure parts (serialize/parse/checksum/reader
  selection over supplied slot bytes) are Node-unit-testable; slot I/O is browser.
- `src/blobs.ts` (new) — copy-on-write versioned chunk store over
  `blobs/<id>.<chunk>.<gen>`: `read`/`write`/`truncate` resolve/mutate via a
  `chunkVersion` map (highest version ≤ selected generation), COW-ing into a
  caller-supplied `stagedGen` on first mutation per batch (`cow()`); `rollbackBatch`/
  `commitBatch` discard or keep this batch's staged versions (replaces the earlier
  in-memory content undo-log); `buildVersionMap(selectedGen)` resolves the map from
  disk at open; version-aware GC helpers (§3.3) resolve an arbitrary generation's
  view for the union live-set computation. Backed by the sync-handle pool, keyed by
  full versioned filename. Fully synchronous I/O.
- `src/worker.ts` (rewritten) — acquires the per-root Web Lock at open (§5/F6);
  holds the in-memory working manifest + last-committed snapshot + blob store;
  maps every op per §4; `flush` = ordered fail-closed commit (§3.1).
- `src/sidecar.ts` — **deleted** (no sidecars in this model).

No `createWritable`/async-writable is used anywhere; all storage I/O is via
worker sync access handles (§2). `src/client.ts` gains the per-root Web-Lock
acquisition on `open()` (or the worker signals lock failure back over RPC as
`EBUSY`) — a small addition to the otherwise-unchanged client.

Deleted from PR #3's worker: the entire sidecar subsystem, the
shadow/restore/truth-preserving-commit rename machinery, `physDir`/`physName`,
the generation-swap plans, active-physName occupancy, `.wash-shadow-*` handling.
None of it exists in the manifest model.

## 7. apps/bench

- **Chunk-size sweep** (deferred from the data-layout decision): 1 MiB
  sequential + random write/read across candidate chunk sizes, on real OPFS via
  the browser bench path (or the existing fake-OPFS Node path with the
  relativity caveat), to freeze the default.
- **Manifest-size scaling curve**: namespace mutation throughput vs file count
  (100 / 1k / 10k / 50k files) to locate the whole-rewrite cliff and set the §5
  size-guard threshold empirically.

## 8. Migration

**Clean break, no migration.** The manifest format is a fresh v1 on-disk layout.
The old path-transparent + `.wash-attrs` format is neither read nor converted:
PR #3 never merged and no released artifact carries old-format data, so
migration code would be pure dead legacy. A mount whose root has **neither
manifest slot present** (a never-initialized mount) initializes an empty
filesystem (creating `blobs/` and writing generation 0 on first `flush`). Note
the distinction from §3.2's unrecoverable case: *both slots absent* → fresh
empty init; *both slots present but neither validates* → EIO, no init, no GC
(F3). No detection/refusal of the old path-transparent format is implemented
(there is no deployed old-format data to protect).

## 9. Testing

1. **Manifest unit tests (Node, `manifest.ts`):** v1 round-trip;
   serialize→checksum→parse; the parse gate over supplied slot bytes
   (valid / absent / truncated-fails-checksum / garbage / v0-bare); the
   **highest-valid-generation reader** given every {A,B} × {valid, corrupt,
   absent} combination — including "newest corrupt → fall back to older valid"
   and "both invalid → EIO, no empty-init"; the whole-batch snapshot/restore
   (§3.1a) leaves the working manifest byte-equal to last-committed.
2. **Blob store unit tests (Node/fake-OPFS where feasible, else browser):**
   chunk-aligned RMW, sparse reads-as-zeros, truncate boundary trim, range read
   short-at-EOF, per-inode delete; the **union GC live set** (F4/F7): a blob
   referenced only by the older retained generation is NOT collected; one
   referenced by the working manifest but no committed generation is NOT
   collected; one absent from both generations and working IS collected.
3. **Conformance (browser, Chromium):** full `@wash/vfs/conformance` green for
   raw `OpfsBackend` and `CachedBackend(OpfsBackend, {flushDelayMs:1})`. The
   **hardlink** and **same-inode-rename** cases now RUN (new capability); the
   **reserved-names** case now SKIPS (`reservedNames: []`).
4. **Durability/crash browser tests (fault-injected via `__injectFault`):**
   - blob-flush failure during commit (§3.1 step 2) → no new generation written,
     working manifest rolled back to last-committed, op rejects ENOSPC, next
     read/dump reflects last-committed state (no phantom size);
   - torn new-slot write (fault mid-slot-write) → reopen selects the prior valid
     generation from the other slot; data intact;
   - **both-slots-invalid** (corrupt both) → open rejects EIO and performs NO GC
     (assert blobs still present);
   - **union GC after fallback**: commit gen N+1 unlinking `x`, then corrupt the
     N+1 slot, reopen → falls back to gen N which still references `x`, and `x`'s
     blob was NOT collected;
   - **O(1) atomic directory rename**: rename a deep non-empty subtree, assert
     ids/content/metadata intact and no per-descendant work;
   - **Web Lock**: a second `OpfsBackend.open()` on the same root rejects `EBUSY`;
     after the first `close()` a new open succeeds.
5. **Regression note:** the wave-3…7 rename findings and the F10 multi-entry class
   are *non-applicable by construction* (the sidecar/shadow/multi-entry mechanism
   they attacked no longer exists); the suite records this with a "rename is a
   single in-memory manifest edit committed atomically" assertion rather than
   per-finding guards.
6. **Integration (browser):** `Vfs` + `CachedBackend` + `OpfsBackend`
   end-to-end: tree build, content, symlink, hardlink, directory rename across a
   simulated reload with `warm(await be.dump())`; EXDEV across a memory mount and
   an OPFS mount.

## 10. Exit criteria

- `pnpm turbo build test typecheck` green; `@wash/backend-opfs test:browser`
  green in Chromium; `@wash/backend-indexeddb test:browser` unaffected.
- Conformance green (raw + cached) with hardlink + same-inode-rename running and
  reserved-names skipping.
- Persistence pinned: namespace, content, symlinks, hardlinks, and modes survive
  close/reopen via manifest load; a directory rename is O(1), atomic, and
  id-stable.
- Fault-injected blob-flush and torn-slot-write failures leave a consistent prior
  generation (highest-valid-generation reader); both-slots-invalid rejects EIO
  and does NOT GC; union GC preserves blobs reachable from either retained
  generation; a second opener of a mounted root gets `EBUSY`.
- `dump()`/`warm()` work end-to-end (default-backend mount-time warming).
- `apps/bench` reports the chunk-size sweep and the manifest scaling curve; the
  §5 size-guard threshold is set from it.

## 11. Out of scope

- Log+checkpoint manifest for very large trees (the documented scaling lever if
  the size guard is hit); v1 writes a whole generation per flush batch.
- Migration from the old path-transparent/sidecar format (clean break).
- **The CachedBackend failed-flush reconciliation / fsync-strict contract change
  (tracked pre-Plan-4 item) — DECLARED DEPENDENCY (F1).** This backend commits a
  flush batch atomically: on any failure it rolls the whole batch back to the
  last-committed generation (§3.1a), exactly as `@wash/backend-indexeddb` aborts
  its shared transaction. `CachedBackend` dequeues succeeded prefix ops before
  the batch is confirmed durable, so a mid-batch failure diverges the cache from
  the rolled-back backend until that contract change (ops not dequeued until
  flush confirms) lands. This is NOT manifest-specific — it is the identical seam
  the IDB backend already carries and tracks; the manifest backend inherits it
  unchanged. In-backend guarantees (no phantom generation, ordered fail-closed
  commit, two-generation crash recovery) are independently sound; only
  cache/backend *convergence after a mid-batch failure* depends on the contract
  work. (In-scope alternatives — solving it below the cache per-op — were
  rejected on the record: a torn `truncate`+`write` replay can't be fixed by a
  per-op backend boundary because the two calls must be atomic *together*, which
  only the batch-level commit or the cache contract provides.)
- Cross-tab *sharing* (concurrent writers to one root) — prevented by the
  mandatory per-root Web Lock (§5/F6), which fails the second writer fast rather
  than allowing lost updates. Concurrent multi-writer support is not a goal.
