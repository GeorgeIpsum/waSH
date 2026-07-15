# waSH — OPFS Manifest-Model Backend Design

**Date:** 2026-07-14
**Status:** Approved pending user review
**Scope:** Rewrite the internal storage model of `@wash/backend-opfs` (worker side) from a path-transparent tree + `.wash-attrs` sidecars to an **id-addressed blob store + a single atomically-swapped manifest**. The `WashBackend` contract, the client/worker RPC split, the browser test rig, and the conformance suite are unchanged.
**Supersedes:** `docs/superpowers/specs/2026-07-14-opfs-rename-transaction-design.md` (⛔ not implemented) and the sidecar/shadow implementation currently on PR #3.

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
- **OPFS gives the primitive for free:** `FileSystemWritableFileStream`
  (`createWritable()`) is spec-guaranteed swap-on-close — the file ends up with
  either its old contents or the fully-written new contents, never partial
  (WHATWG File System Standard §2.3.2).
- **OPFS precedent for id-addressed content:** SQLite's `opfs-sahpool` (the
  recommended SQLite-on-OPFS backend) stores content in opaquely-named files
  addressed by id, never path-renamed — the exact property that makes rename
  metadata-only. No surveyed OPFS project combines this with a single manifest;
  that combination is the acknowledged gap this design fills.

**Consequence:** with blobs addressed by inode id and never moved, no namespace
op touches content. `rename`/`create`/`unlink`/`symlink`/`chmod`/`mkdir` become
pure in-memory manifest edits committed by one atomic swap — **atomic and O(1)
by construction.** The entire failure-atomicity problem (F10 and the wave-3…7
finding class) does not exist in this model. This backend converges on the
same id-addressed inode/dirent model `@wash/backend-indexeddb` already uses,
differing only in the atomic-commit substrate (IDB transactions there;
manifest-swap here).

## 2. On-disk layout

The OPFS mount root holds a flat, opaque structure — no user-path-transparent
tree, no per-directory sidecars:

```
<mountRoot>/
├── manifest              — the single source of truth (atomically swapped on close of its createWritable)
└── blobs/
    ├── <inodeId>.0       — chunk 0 of inode <inodeId>  (ULID-named, never moved/renamed)
    ├── <inodeId>.1       — chunk 1
    └── …                  (chunkSize benched, default 64 KiB; a sparse/zero chunk is simply absent)
```

(There is no backend-addressed temp file. `createWritable()` performs its own
write-to-staging-then-swap-on-close internally per the File System Standard;
whatever transient the user agent creates during that is never named, read, or
relied on by this backend.)

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
}

interface Manifest {
  v: 1;                                              // version envelope (parse-gated)
  rootId: NodeId;
  inodes:  Record<NodeId, InodeRecord>;
  dirents: Record<NodeId /*parentId*/, Record<string /*name*/, { id: NodeId; kind: NodeKind }>>;
}
```

### 3.1 Atomic commit

`flush()` serializes the in-memory manifest and writes it via
`createWritable()`:

```
const w = await manifestFileHandle.createWritable();  // opens keep-existing-data staging
await w.write(serialized);                            // (truncate+write the whole manifest)
await w.close();                                       // COMMIT POINT — atomic swap-on-close
```

`close()` is the single linearization point for an entire batch of namespace
mutations. Because `CachedBackend` batches mutations and calls `flush()` once
per batch, the manifest is swapped once per batch — never per op. The reader
after any crash sees either the fully-old or the fully-new manifest.

Implementation note: `createWritable({ keepExistingData: false })` (the default)
plus a single `write()` of the complete serialized manifest is the whole
mechanism. A manual write-a-temp-file → `close` → `move(tmp, "manifest")` path is
NOT needed and NOT used — `createWritable`'s spec-guaranteed swap-on-close is the
atomic primitive.

### 3.2 Parse gate & versioning

The reader distinguishes: **valid v1 envelope** → use it; **absent / unparseable
/ truncated** → treat as no manifest → initialize a fresh empty mount (per the
clean-break decision, §8). The `v` field allows future format migration; v1 is
the only format written.

### 3.3 Blob garbage collection (RocksDB "manifest is ground truth")

Blobs are referenced ONLY by id from the manifest; a blob not reachable from a
committed manifest is inert. GC runs at open and opportunistically: enumerate
`blobs/`, compute the set of live inode ids from `manifest.inodes`, and
`removeEntry` any `<id>.<chunk>` whose `<id>` is not live. This reclaims:
- blobs written for an inode whose creating batch never committed (crash before
  `flush`), and
- chunks of unlinked inodes whose post-commit chunk deletion (§5) didn't finish.

GC is never a correctness dependency — orphaned blobs are only wasted space.

## 4. Operation mapping

The worker holds the manifest in memory (authoritative within the session) and
a pooled set of blob sync-access-handles. Every namespace op is an in-memory
manifest edit; content ops touch blobs. All namespace mutations are made
durable by the next `flush()`'s single atomic swap.

| Op | Manifest edit | Blob I/O |
|---|---|---|
| `root`/`lookup`/`readdir`/`getattr`/`readlink` | read in-memory maps | — |
| `create` / `mkdir` / `symlink` | add inode + dirent (EEXIST on taken name; ENOTDIR on file parent; symlink sets `target`) | — |
| `unlink` / `rmdir` | remove dirent; `nlink--`; GC inode at 0 (ENOTEMPTY for non-empty dir) | delete `<id>.*` chunks — post-commit, best-effort |
| `rename` | delete `(fromParent,fromName)`, set `(toParent,toName)→id`; POSIX overwrite (displaced GC / EISDIR / ENOTDIR / ENOTEMPTY); same-inode no-op | — |
| `link` | add dirent, `nlink++` (EEXIST before EPERM; EPERM on dir) | — |
| `chmod` / `utimes` | inode field update | — |
| `read` | inode bounds → chunk range read | `getAll`-equiv range over `<id>.<chunk>` via pool |
| `write` | update inode `size`/`mtime` | chunk-aligned RMW via pool (zero-length = no-op) |
| `truncate` | update inode `size`/`mtime` | delete dropped chunks; trim boundary chunk |
| `flush` | **atomic manifest swap** (§3.1) | flush dirty pooled handles |
| `dump` | return the manifest's `{inodes, dirents}` directly | — |
| `close` | final `flush`; close pooled handles | — |

### 4.1 Capability upgrades (fall out of the model)

`caps = { symlinks: "supported", hardlinks: true, atomicDirRename: true, renameCost: "O1", reservedNames: [] }` — identical to `@wash/backend-indexeddb`.

- **`hardlinks: true`** — dirents and inodes are separate manifest maps, so a
  second dirent to one inode id is trivial; `link` is supported.
- **`atomicDirRename: true` + `renameCost: "O1"`** — a directory rename
  re-parents ONE dirent; the subtree's inodes/dirents are keyed by id, not path,
  so nothing under it changes. The `"subtree"` non-atomicity is gone.
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

- **Commit granularity = write-back batch.** `CachedBackend` flushes once per
  batch → one manifest swap per batch. A tab crash loses at most the last
  un-flushed batch (the accepted write-back risk); the manifest is always a
  complete prior generation, never partial (spec-guaranteed swap-on-close).
- **Manifest never claims phantom bytes.** An inode's `size` update and the
  blob write that backs it ride the SAME batch: the size is only committed by
  the manifest swap, which happens after the batch's blob writes. A blob write
  that rejects (quota) fails its op with the mapped errno and its size update is
  never committed. Conversely a committed manifest's sizes always have their
  blobs on disk (blob writes precede the swap within the flush).
- **Blob write/flush failures** map through `errnoFromDom` (e.g. `QuotaExceededError → ENOSPC`).
  The pooled-handle flush-failure poison mechanism (sticky `pendingFlushErrors`,
  reported once by `flush`/`close`) carries over from PR #3 for fsync fidelity.
- **Open-time recovery** = parse the manifest (parse-gate → fresh mount if
  absent/garbage) + GC-scan `blobs/`. No shadows, no `.old`/`.tmp` generations,
  no sidecar reconciliation.
- **Size guard.** A benched manifest-size threshold (§7) above which the backend
  emits a one-time console warning, making the whole-rewrite scaling cliff
  observable rather than silent. The documented scaling lever if it's ever hit
  is a log+checkpoint manifest (out of scope here).
- **`undoMem`/rollback machinery does not exist** — there is no multi-step
  transaction to roll back. An op that fails before the manifest edit leaves the
  in-memory manifest untouched; the edit is the last, infallible step (pure
  in-memory map mutation), and durability is the separate atomic swap.

## 6. Code structure

Kept from PR #3 (unchanged or lightly adapted):
- `src/client.ts`, `src/rpc.ts` — RPC, closed-state guard, worker-failure
  hygiene (`onerror`/`onmessageerror`/`failAllPending`). Client method surface
  unchanged (it's the `WashBackend` shape).
- `src/lru.ts` — repurposed to pool blob sync-access-handles.
- The `testHooks`/`__injectFault` scaffold, `vitest.browser.config.ts`, the
  browser-rig conventions.

New / replaced worker internals:
- `src/manifest.ts` (new) — `Manifest` types, `parseManifest` (parse-gate,
  v-envelope), `serializeManifest`, `commitManifest(dirHandle, manifest)`
  (createWritable swap), `loadManifest(dirHandle)`. Pure logic + a thin OPFS
  handle dependency; the pure parts are Node-unit-testable.
- `src/blobs.ts` (new) — chunk store over `blobs/<id>.<chunk>`: `readRange`,
  `writeRange`, `truncate`, `deleteInode`, backed by the sync-handle pool.
- `src/worker.ts` (rewritten) — holds the in-memory manifest + blob store; maps
  every op per §4; `flush` = commit manifest + flush blob handles.
- `src/sidecar.ts` — **deleted** (no sidecars in this model).

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
migration code would be pure dead legacy. A mount whose root has no parseable
`manifest` initializes an empty filesystem (creating `blobs/` and an empty
manifest on first `flush`). No detection/refusal of the old format is
implemented (there is no deployed old-format data to protect).

## 9. Testing

1. **Manifest unit tests (Node, `manifest.ts`):** v1 round-trip; parse-gate
   (valid / absent / truncated / garbage / v0-unknown); commit-swap semantics
   against a fake OPFS dir handle (old-or-new-never-partial).
2. **Blob store unit tests (Node/fake-OPFS where feasible, else browser):**
   chunk-aligned RMW, sparse reads-as-zeros, truncate boundary trim, range read
   short-at-EOF, per-inode delete.
3. **Conformance (browser, Chromium):** full `@wash/vfs/conformance` green for
   raw `OpfsBackend` and `CachedBackend(OpfsBackend, {flushDelayMs:1})`. The
   **hardlink** and **same-inode-rename** cases now RUN (new capability); the
   **reserved-names** case now SKIPS (`reservedNames: []`).
4. **Durability/crash browser tests (fault-injected):** manifest-swap failure →
   prior generation intact, no partial state, op rejects; blob-write quota
   failure → op rejects ENOSPC, manifest never commits the phantom size;
   simulated crash (close without final flush + reopen) → last committed
   manifest loads, orphaned blobs GC'd; **O(1) atomic directory rename** (rename
   a deep non-empty subtree, assert ids/content/metadata intact and no
   per-descendant work).
5. **Regression note:** the wave-3…7 rename findings and the F10 class are
   *non-applicable by construction* (the sidecar/shadow/multi-entry mechanism
   they attacked no longer exists); the suite records this with an
   "rename is a single atomic manifest edit" assertion rather than per-finding
   guards.
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
- Fault-injected manifest-swap and blob-write failures leave a consistent prior
  generation; crash recovery GC's orphaned blobs.
- `dump()`/`warm()` work end-to-end (default-backend mount-time warming).
- `apps/bench` reports the chunk-size sweep and the manifest scaling curve; the
  §5 size-guard threshold is set from it.

## 11. Out of scope

- Log+checkpoint manifest for very large trees (the documented scaling lever if
  the size guard is hit); v1 is whole-manifest swap.
- Migration from the old path-transparent/sidecar format (clean break).
- The CachedBackend failed-flush reconciliation / fsync-strict contract change
  (tracked pre-Plan-4 item) — this backend's durability-signal completeness
  through the cache still depends on it, same as the IDB backend; the manifest
  model does not change that seam.
- Cross-tab collision beyond Web-Locks single-writer.
