# @wash/backend-opfs

An [Origin Private File System (OPFS)](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)
`WashBackend` for [`@wash/vfs`](../vfs) — **the intended default backend for
the `wash` package** (Plan 6): the terminal mounts OPFS by default and falls
back to [`@wash/backend-indexeddb`](../backend-indexeddb) only where OPFS or
sync access handles are unavailable (see "Browser requirements" below).

Storage model, on-disk layout, and the full crash-consistency argument are
specified in
[`docs/superpowers/specs/2026-07-14-opfs-manifest-backend-design.md`](../../docs/superpowers/specs/2026-07-14-opfs-manifest-backend-design.md).
This README is a summary of that design plus how to run the package's tests.

## Architecture: id-addressed blobs + a two-generation manifest

Earlier iterations of this backend mirrored the OPFS directory tree
path-for-path, with a hidden per-directory sidecar file carrying mode bits
and symlink targets. That shape made every multi-entry mutation (an
overwrite-rename, a directory rename) an attempt to compose atomicity out of
OPFS's single-entry primitives (`move`/`removeEntry`/`write`) — which cannot
be done safely (see the spec's §1 for the adversarial-review finding that
killed that design). This rewrite replaces it with the same shape the
`@wash/backend-indexeddb` backend already uses, adapted to OPFS's
synchronous-worker primitives instead of IndexedDB transactions:

- **Content lives in id-addressed blobs, never moved.** Each inode's bytes
  are chunked across `blobs/<inodeId>.<chunkIdx>` files (default chunk size
  64 KiB, matching `@wash/vfs`'s `CHUNK_SIZE`). A blob is never renamed —
  content is addressed purely by `(inodeId, chunkIdx)` — so no namespace
  operation (`rename`, `create`, `unlink`, `chmod`, `mkdir`, `link`,
  `symlink`) ever touches a blob. This is the same trick SQLite's
  `opfs-sahpool` VFS uses for OPFS content.
- **The whole namespace + metadata is one manifest, kept in two generations.**
  `manifest.a` and `manifest.b` each hold a self-describing generation: a
  header line (`generation` + a checksum) followed by the JSON body
  (`rootId`, every inode's attrs, every directory's dirents). A commit writes
  the next generation **in place** into whichever slot is currently the
  *older* one, via `truncate(0)` → `write(header+body)` → `flush()` on a sync
  access handle. The reader loads both slots and picks the one with the
  highest generation whose checksum validates — so a crash mid-write leaves a
  torn new slot that simply fails its checksum, and the reader falls back to
  the other slot's last-good generation. There is no separate head pointer to
  corrupt, and both generations are kept live so a torn write is *never* fatal
  as long as the other slot survives. This is LMDB's dual-meta-page /
  ZFS-uberblock-ring discipline, not an atomic-rename primitive OPFS doesn't
  provide.
- **Every namespace op is a pure in-memory manifest edit.** `create`,
  `mkdir`, `unlink`, `rmdir`, `chmod`, `utimes`, `symlink`, `link`, and
  `rename` all just mutate the in-memory working manifest (add/remove an
  inode record, add/remove/reparent a dirent). None of that touches disk
  until the next `flush()` — see the caps table below for what this buys.
- **The worker is fully synchronous — no `createWritable`.** All storage I/O
  (blob chunks and manifest slots alike) goes through
  `FileSystemSyncAccessHandle`, which is fast but worker-only (it throws on
  the main thread), so the entire storage engine lives in a dedicated worker
  (`worker.ts`) that the main-thread `OpfsBackend` (`client.ts`) talks to over
  RPC (`rpc.ts`). Ops run strictly sequentially through one promise chain in
  the worker, so a multi-step commit is never observed half-done by another
  op. Nothing in this backend uses the async `createWritable()` API or its
  weaker "best effort, no partial writes" durability wording.
- **Single-writer, enforced by a Web Lock.** `OpfsBackend.open()` acquires
  `navigator.locks.request("wash-opfs:<rootDirName>", { ifAvailable: true })`
  and holds it for the backend's lifetime, releasing it in `close()`. A
  second `open()` on the same root rejects with `EBUSY` immediately, rather
  than letting two writers each commit from a stale generation and silently
  clobber each other's work (and GC the loser's still-referenced blobs).

### GC

A blob is only ever deleted once it is unreachable from every manifest that
could still be read — that's the union of both on-disk generations' inode
ids **and** the in-memory working manifest's ids (which may include inodes
created but not yet flushed). Using only the newest generation would be
unsafe: if that generation ever corrupts and the backend falls back to the
older one, the older generation could reference a blob GC already deleted
because the newer one had dropped it. Garbage collection runs at `open()`
(scanning `blobs/` against the union of the working manifest and both retained
on-disk generations); an internal `gc` op is available for maintenance, but GC
is not triggered automatically mid-session, so within a long-lived session
orphaned chunks accumulate until the next `open()`.

## Usage

```ts
import { Vfs, CachedBackend } from "@wash/vfs";
import { OpfsBackend } from "@wash/backend-opfs";

const be = await OpfsBackend.open("my-project");
const cached = new CachedBackend(be, { flushDelayMs: 500 });
cached.warm(await be.dump()); // bulk-load metadata before the first op

const vfs = new Vfs();
await vfs.mount("/", cached);
await vfs.writeFile("/hello.txt", "hi");
await vfs.fsync(); // durability point: flushes dirty blobs, then commits a manifest generation
await be.close();
```

As with the IndexedDB backend, always wrap `OpfsBackend` in `CachedBackend`
for real workloads — the raw backend satisfies `WashBackend` and passes
conformance on its own, but every op is a worker round trip.

## Caps

```ts
{ symlinks: "supported", hardlinks: true, atomicDirRename: true, renameCost: "O1", reservedNames: [] }
```

Identical to `@wash/backend-indexeddb`'s caps — a direct consequence of the
manifest model:

| Cap | Value | Why |
|---|---|---|
| `symlinks` | `"supported"` | A symlink is an inode record with a `target` string field; the backend stores the target verbatim without validation or resolution (dangling and absolute targets are preserved as-is; resolution is the VFS's job). |
| `hardlinks` | `true` | Dirents and inodes are separate manifest maps, so a second dirent pointing at one inode id (and bumping its `nlink`) is a normal edit — no link-count tracking to bolt on. |
| `atomicDirRename` | `true` | Directory rename re-parents exactly one dirent; the subtree's inodes and dirents are keyed by id, not by path, so nothing under the renamed directory changes. |
| `renameCost` | `"O1"` | Same reasoning as above — the operation's cost does not scale with the size of the renamed subtree. This describes the *operation's* scaling, not the durable-commit cost (see below). |
| `reservedNames` | `[]` | The manifest and `blobs/` live in an OPFS structure the VFS namespace never addresses by path (unlike the old sidecar model's `.wash-attrs`), so there is no user-facing name to reserve. |

## The honest scaling note

`renameCost: "O1"` describes the *operation* — renaming a directory does no
per-descendant work. It does **not** describe the cost of making that
rename (or any other mutation) durable. **Every committed flush batch writes
a whole manifest generation** — `flush()` serializes the entire in-memory
namespace and metadata and writes it into a slot — so **durable commit is
O(manifest size), not O(the batch's mutations)**, amortized across every op
`CachedBackend` folded into that batch. Building a large tree (many files) in
one write-back batch pays this once per batch, which is cheap; forcing a
`flush()`/`fsync()` per mutation on a filesystem with tens of thousands of
entries would pay a full manifest rewrite every time, which is not.

This is a real, unavoidable cost of the "one atomically-swapped object"
design (§1 of the spec), not a bug. The plan tracks two follow-ups neither of
which has landed in this package yet:

- A benched **size-guard threshold** (`apps/bench`'s manifest-scaling curve,
  spec §7/§10) above which the backend should emit a one-time warning so the
  cliff is observable instead of silent. Not yet implemented.
- A **log+checkpoint manifest** (append small deltas between periodic full
  rewrites) as the scaling lever if the threshold above is ever hit in
  practice. Explicitly out of scope for this rewrite (spec §11).

## Browser requirements

The binding constraint is `FileSystemSyncAccessHandle` (specifically
`createSyncAccessHandle`) — the backend is unusable without it, since it's
OPFS's only fast synchronous I/O path and this design has no
`createWritable` fallback. Per MDN's browser-compat-data
(`api/FileSystemSyncAccessHandle.json`, `mdn/browser-compat-data` on GitHub):

| Engine | Minimum version |
|---|---|
| Chromium (Chrome/Edge) | 102+ |
| Firefox | 111+ |
| Safari | 15.2+ |

The compat data lists Chrome Android at 109+ and reports Firefox
Android/Safari iOS as mirroring their desktop versions above — not verified
against a physical device in this pass. OPFS root access itself
(`navigator.storage.getDirectory`) has shipped since Chrome 86, but that's
moot here since sync access handles are the actual floor. Below this floor,
or on a browser without OPFS at all, `wash` falls back to
`@wash/backend-indexeddb` per the Plan 6 default-backend selection.

## Testing

```
pnpm --filter @wash/backend-opfs test          # Node: pure modules only (manifest codec, lru)
pnpm --filter @wash/backend-opfs test:browser  # real OPFS in Chromium via @vitest/browser + Playwright
```

`test:browser` needs the Playwright browser binary installed once:

```
pnpm exec playwright install chromium
```

The Node suite (`test/node/**`) covers only the backend-internal pure
modules that don't touch OPFS — `manifest.ts`'s serialize/parse/checksum and
highest-valid-generation selection logic, and the LRU pool. There is no OPFS
implementation available under Node, so everything that touches the
filesystem (namespace ops, content, rename, symlinks, hardlinks,
warm/dump, durability/GC fault injection, and the end-to-end `Vfs`
integration test) lives under `test/browser/**` and runs against a real
Chromium OPFS implementation.

Shared `@wash/vfs` conformance runs against both the raw backend and
`CachedBackend(OpfsBackend, { flushDelayMs: 1 })`. Because this backend's
caps now match `@wash/backend-indexeddb`'s, the **hardlink** and
**same-inode-rename** conformance cases run (rather than skip), and the
**reserved-names** case skips (`reservedNames: []` — there is nothing left to
reserve now that the sidecar is gone).

`test/browser/integration.test.ts` is the end-to-end proof: build a tree,
write and append content, `chmod`, hardlink (`vfs.link`), symlink, rename a
non-empty directory (O(1), atomic), `fsync`, close, then reopen a second
`OpfsBackend` against the same root and warm a fresh `CachedBackend` from
`await be.dump()` — confirming content, mode, hardlink `nlink`, and the
symlink's target (served by the backend directly; `readlink` is never
warmed into the cache) all survive the round trip. A second test confirms
`EXDEV` when renaming across a memory-backed mount and an OPFS-backed mount.
