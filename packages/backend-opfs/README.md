# @wash/backend-opfs

An [Origin Private File System (OPFS)](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)
`WashBackend` for [`@wash/vfs`](../vfs). Implements spec §6 of the waSH design
doc: real, hierarchical, quota-backed storage with synchronous file I/O via
`FileSystemSyncAccessHandle`.

This is **the intended default backend for the `wash` package** (Plan 6): the
terminal mounts OPFS by default and falls back to
[`@wash/backend-indexeddb`](../backend-indexeddb) only where OPFS or sync
access handles are unavailable (see "Browser support" below).

## Worker architecture

`FileSystemSyncAccessHandle` — the only fast, synchronous read/write API OPFS
offers — is spec'd as **worker-only**; it throws on the main thread. So all
filesystem state lives in a dedicated storage worker (`worker.ts`) owned by
the backend:

- `client.ts` is the main-thread facade. It spins up the worker, and every
  `WashBackend` method is an RPC call (`rpc.ts`) sent over `postMessage` and
  resolved when the worker replies.
- The worker holds the in-memory node table (`id → handle`), a bounded LRU
  pool of open `FileSystemSyncAccessHandle`s (default 64 — each holds an
  exclusive lock on its file, so unbounded-open is not an option), and every
  sidecar it has read.
- Ops run **strictly sequentially** through a single promise chain in the
  worker — no op starts until the previous one's result has been posted back.
  This is what makes multi-step mutations (directory rename's shadow-rename
  dance, sidecar transport) safe without a separate lock: nothing can observe
  an intermediate state.
- `OpfsBackend.close()` tells the worker to flush and drop all pooled
  handles, then terminates the worker. A worker crash or malformed message
  rejects every in-flight call instead of hanging the caller forever.

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
await vfs.fsync(); // durability point: flushes dirty sync-access handles
await be.close();
```

As with the IndexedDB backend, always wrap `OpfsBackend` in `CachedBackend`
for real workloads — the raw backend satisfies `WashBackend` and passes
conformance on its own, but every op is a worker round trip.

## Caps (honest limitations)

| Cap | Value | Why |
|---|---|---|
| `symlinks` | `"supported"` | Emulated — see sidecar, below. |
| `hardlinks` | `false` | OPFS has no link count; not modeled. |
| `atomicDirRename` | `false` | See `renameCost`. |
| `renameCost` | `"subtree"` | OPFS's native `move()` is file-only. Renaming a directory recreates the destination subtree and walks every descendant, rebinding each existing `NodeId` to its new handle (ids stay stable) — **not atomic**: a failure partway through can leave the source and destination each holding part of the tree. Compare `@wash/backend-indexeddb`, where directory rename is O(1). |
| `reservedNames` | `[".wash-attrs"]` | See sidecar, below. |

**The sidecar.** OPFS has no inode table, no mode bits, and no native
symlinks. Each directory may hold a hidden `.wash-attrs` JSON file (name →
`{ mode, symlink }`, deviations-from-default only) that supplies file mode
and emulated symlink targets. It lives *inside* the directory it describes,
so it transports for free on a directory rename (the integration test's
`chmod` + subtree-rename case in `test/browser/integration.test.ts` pins
this down). `.wash-attrs` is declared in `caps.reservedNames`: the backend
hides it from `readdir`/`lookup` and rejects user `create`/`unlink`/`rename`
targeting that name with `EPERM` (precedent: `.git`).

**File mtime tracks `File.lastModified`, free.** A file's mtime is
`File.lastModified` unless something in the *current* worker session says
otherwise: an in-session `write`/`truncate` or an explicit
`setattr(mtimeMs)`/utimes stamps the node's in-memory mtime, which then wins
over `File.lastModified` until the node is dropped from memory. Critically,
merely *discovering* a file (on first lookup/readdir, or on reopen after a
close) does **not** stamp an mtime — a freshly-discovered file's mtime falls
straight through to `File.lastModified`, so mtimes for untouched files are
accurate across a close/reopen. The sidecar does not persist mtime, so an
explicit `setattr(mtimeMs)`/utimes call is session-scoped: after a
close/reopen it is gone and mtime again tracks `File.lastModified`. Directory
and symlink mtimes are always session-scoped (stamped at creation/discovery
time; there is no `File.lastModified` equivalent for them to fall back to).

**Symlink targets are POSIX-honest, not validated.** `readlink` returns
whatever path string was passed to `symlink()`, even across a rename of an
ancestor directory that would make the target unreachable — matching real
POSIX symlink semantics (a symlink stores a path, not a resolved reference).
The integration test's `/project/main → /project/src/index.ts` case (target
left stale after `/project/src` is renamed to `/project/lib`) pins this down.

## Browser support

The binding constraint is `FileSystemSyncAccessHandle` (specifically
`createSyncAccessHandle`), since the backend is unusable without it. Verified
directly against MDN's browser-compat-data source
(`api/FileSystemSyncAccessHandle.json`, `mdn/browser-compat-data` on GitHub)
on 2026-07-13:

| Engine | Minimum version |
|---|---|
| Chromium (Chrome/Edge) | 102+ |
| Firefox | 111+ |
| Safari | 15.2+ |

OPFS root access itself (`navigator.storage.getDirectory`,
`FileSystemDirectoryHandle`) has been available since Chrome 86, but that's
moot here — sync access handles are the actual floor. Not independently
verified in this pass: mobile-browser parity (Chrome Android/Firefox
Android/Safari iOS mirror their desktop versions per the same BCD data, but
that wasn't re-checked against a device), and any Safari-specific
correctness quirks beyond the documented cap table (tracked as a Plan 3
deferred item, not covered by this package's test suite, which runs against
Chromium only).

Below this floor (or on a browser without OPFS at all), `wash` falls back to
`@wash/backend-indexeddb` per the Plan 6 default-backend selection.

## Testing

```
pnpm --filter @wash/backend-opfs test          # Node: pure modules only (lru, sidecar codec)
pnpm --filter @wash/backend-opfs test:browser  # real OPFS in Chromium via @vitest/browser + Playwright
```

`test:browser` needs the Playwright browser binary installed once:

```
pnpm exec playwright install chromium
```

The Node suite (`test/node/**`) covers only backend-internal pure modules
(`Lru`, the sidecar codec) that don't touch OPFS — there is no OPFS
implementation available under Node, so everything that touches the
filesystem (namespace, content, rename, symlinks, warm/dump, the end-to-end
`Vfs` integration test) lives under `test/browser/**` and runs against a
real Chromium OPFS implementation. Shared `@wash/vfs` conformance runs
against both the raw backend and `CachedBackend(OpfsBackend, { flushDelayMs: 1 })`,
with symlink and reserved-name cases exercised (first backend to hit the
reserved-names cap) and hardlink cases skipped (`caps.hardlinks === false`).
