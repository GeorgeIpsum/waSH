# @wash/backend-indexeddb

A persistent [IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)
`WashBackend` for [`@wash/vfs`](../vfs). Implements spec §5 of the waSH design
doc: metadata at memory speed after mount (via bulk warming into
`CachedBackend`), IDB round-trips paid in bulk rather than per file.

## Schema

One database per mount, four object stores:

| Store     | Key                    | Value                                              |
|-----------|------------------------|-----------------------------------------------------|
| `dirents` | `[parentId, name]`     | `{ childId, kind }`                                  |
| `inodes`  | `inodeId` (ULID)       | `{ kind, size, mode, mtimeMs, ctimeMs, nlink, target? }` |
| `data`    | `[inodeId, chunkIdx]`  | `Uint8Array` (chunked content, default 64 KB chunks) |
| `meta`    | `string`                | fs metadata (`rootId`, `schemaVersion`)              |

## Usage

```ts
import { Vfs, CachedBackend } from "@wash/vfs";
import { IndexedDBBackend } from "@wash/backend-indexeddb";

const be = await IndexedDBBackend.open("my-project");
const cached = new CachedBackend(be, { flushDelayMs: 500 });
cached.warm(await be.dump!()); // bulk-load metadata before the first op

const vfs = new Vfs();
await vfs.mount("/", cached);
await vfs.writeFile("/hello.txt", "hi");
await vfs.fsync(); // durability point: flushes the dirty batch to IDB
be.close();
```

Always wrap `IndexedDBBackend` in `CachedBackend` for real workloads — using it
unwrapped works (it satisfies `WashBackend` directly and passes conformance
on its own) but every op pays a full IDB round-trip.

## Options

`IndexedDBBackend.open(dbName, opts?)`:

- `durability?: "relaxed" | "strict"` (default `"relaxed"`) — passed through
  to the underlying `IDBTransaction`'s durability hint. `"relaxed"` lets the
  browser buffer the commit for throughput; `"strict"` forces it to disk
  before the transaction completes. This is a v1 deviation from spec §5,
  which wants background flushes at `"relaxed"` and explicit fsync at
  `"strict"` — the `WashBackend.flush()` contract has no mode parameter, so
  durability is a per-backend constructor option for now, not a per-call one.
- `chunkSize?: number` (default 64 KiB) — size of each `data` record; content
  is split into fixed-size chunks so partial writes and reads touch only the
  chunks they overlap.
- `factory?: IDBFactory` (default the global `indexedDB`) — inject an
  alternate factory (e.g. `fake-indexeddb`) for tests.

## Transaction batching

The backend holds one lazily-created, shared `IDBTransaction` per write-back
flush batch: every op issued between flushes runs against that same
transaction, so IndexedDB commits once per batch instead of once per op.
`flush()` is the durability point — it awaits the shared transaction's
completion (or surfaces its abort reason) and only then lets the next batch
start. Reads issued before a flush observe the batch's in-flight writes;
nothing is durable until `flush()` (driven by `Vfs.fsync()` or
`CachedBackend`'s flush timer) resolves.

## Testing

Run the shared `@wash/vfs` conformance suite against both the raw backend and
the cached backend:

```ts
import { runBackendConformance } from "@wash/vfs/conformance";
import { CachedBackend, ulid } from "@wash/vfs";
import { IndexedDBBackend } from "@wash/backend-indexeddb";

runBackendConformance("IndexedDBBackend", () => IndexedDBBackend.open(`conf-${ulid()}`));
runBackendConformance(
  "CachedBackend(IndexedDBBackend, writeback)",
  async () => new CachedBackend(await IndexedDBBackend.open(`confc-${ulid()}`), { flushDelayMs: 1 }),
);
```

- `pnpm --filter @wash/backend-indexeddb test` — runs everything (unit,
  persistence, warming, conformance, integration) against Node's
  `fake-indexeddb`.
- `pnpm --filter @wash/backend-indexeddb test:browser` — runs the same suite
  in a real Chromium `IndexedDB` implementation via `@vitest/browser` +
  Playwright. First install the browser binary once:
  `pnpm exec playwright install chromium`.
