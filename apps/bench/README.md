# bench

FS-backend benchmark matrix (spec §5/§9): metadata hot paths, create/unlink
cycles, and the chunk-size sweep that validates the 64 KiB default before
freezing it.

Run: `pnpm --filter bench bench`

Caveat: this runs against fake-indexeddb in Node — numbers are RELATIVE
(backend code overhead, chunking strategy), not absolute browser performance.
Real-Chromium numbers come from the browser rig (Plan 2 Task 8 infrastructure)
in a later pass. Record sweep results and the chunk-size decision here:

| date | environment | 16 KiB | 64 KiB | 256 KiB | decision |
|------|-------------|--------|--------|---------|----------|
| 2026-07-12 | node/fake-idb (macOS) | 173.49 | 373.81 | 485.98 | 256 KiB fastest (2.8x over 16 KiB); 64 KiB baseline pending browser validation |

## `@wash/backend-opfs` scaling story (analytical, not benched)

`@wash/backend-opfs` (spec: `docs/superpowers/specs/2026-07-14-opfs-manifest-backend-design.md`)
uses a whole-generation manifest: every durable commit (`flush()`/`close()`)
serializes the **entire** namespace (all inodes + dirents) to JSON and writes
it as one new generation into the non-current `manifest.a`/`manifest.b` slot
via a sync access handle. From that design falls out a scaling story that can
be stated analytically without running it:

- **Namespace ops are O(1) in memory.** `create`/`unlink`/`rename`/`link`/
  `setattr` each touch a constant number of entries in the in-memory
  `inodes`/`dirents` maps and just set a `dirty` flag — no per-op disk I/O,
  no O(N) work regardless of tree size. This is true of `rename` in
  particular: `atomicDirRename: true` / `renameCost: "O1"` — renaming a
  directory only ever rebinds one dirent, never touches descendants.
- **Durable commit is O(manifest size), not O(1).** The cost that *does*
  scale with tree size is paid once per flush batch: `writeGeneration()` in
  `packages/backend-opfs/src/worker.ts` calls `serializeManifest(mani, ...)`
  over the *whole* manifest and writes the *whole* result, every time,
  regardless of how many entries changed since the last commit. A batch of
  many small mutations amortizes this nicely (one whole-manifest write pays
  for N ops), but a single `flush()` against a large existing tree — e.g.
  "create 20k files, then one more rename, then flush" — pays the full
  O(existing manifest size) rewrite cost for that one incremental op. This
  is the same cost model called out in the design spec §5/§7 as the
  documented v1 tradeoff (log+checkpoint manifest is the deferred scaling
  lever — see §11 / "Not in scope" below).
- **Size-guard threshold: 2 MiB serialized manifest.** `worker.ts` module
  scope defines `MANIFEST_SIZE_WARN_BYTES = 2 * 1024 * 1024` and a one-time
  `warnedManifestSize` latch; `writeGeneration()` checks the serialized byte
  length against it and, the first time it's exceeded, `console.warn`s the
  byte size and that per-flush rewrite cost is `O(manifest size)`, suggesting
  fewer files or a future log+checkpoint manifest. It never throws —
  advisory only. 2 MiB of the backend's manifest JSON shape (id, kind, size,
  mode, two timestamps, nlink per inode, plus one dirent per name) works out
  to roughly a 15k–20k-entry tree — a reasoned round-number default, **not**
  an empirically benched crossover (see below for why).

### What's deferred, and why

The manifest-size scaling curve (namespace-mutation throughput vs. file
count: 100 / 1k / 10k / 50k files) and the OPFS chunk-size sweep (1 MiB
write+read across candidate chunk sizes on real OPFS) described in spec §7
are **deferred, not run**. `apps/bench` here runs in **Node with
fake-indexeddb** — it has no OPFS/browser harness. OPFS's durable-write path
(`FileSystemSyncAccessHandle`) is spec'd as **worker-only** and requires a
real browser (Chromium 102+/Firefox 111+/Safari 15.2+); it cannot run inside
Node, and fabricating "OPFS numbers" against a Node polyfill would measure
nothing real. Building a dedicated browser-bench harness (à la
`packages/backend-opfs/vitest.browser.config.ts`'s Playwright/Chromium rig,
but for throughput measurement rather than correctness) is out of scope for
this pass. Until that harness exists:

- The 2 MiB / ~15k–20k-entry size-guard threshold above is a reasoned
  default, not a benched one — the crossover point where a whole-manifest
  rewrite becomes user-visibly slow (the spec's suggested acceptability line
  is roughly a per-flush write latency > ~16 ms) has not been empirically
  located on real OPFS.
- `@wash/backend-opfs` does **not** expose a `chunkSize` option (unlike
  `@wash/backend-indexeddb`, whose sweep above is real Node/fake-idb data).
  Its `BlobStore` (`packages/backend-opfs/src/blobs.ts`) takes an internal
  `chunkSize` constructor parameter but the backend always constructs it
  with the shared default, `CHUNK_SIZE` (65536 / 64 KiB, from
  `@wash/vfs`'s `packages/vfs/src/types.ts`) — matching this table's 64 KiB
  baseline. Wiring a public `chunkSize` option through to `BlobStore` was
  deliberately skipped (YAGNI): nothing consumes it yet, since the sweep
  that would justify a non-default choice is exactly what's deferred here.
  When the browser-bench harness lands, it should sweep `BlobStore`'s
  internal parameter directly (or expose the option then) rather than
  wiring an unused knob through the public API now.

Follow-up (tracked, not scheduled in this pass): build an
`apps/bench/bench/opfs.browser.bench.ts` (or equivalent) run through a
Playwright/Chromium harness analogous to `backend-opfs`'s `test:browser`,
covering both the chunk-size sweep and the manifest-size scaling curve, and
use its numbers to replace this section's analytical reasoning with measured
figures — at which point the size-guard threshold in `worker.ts` should be
revisited against the actual observed crossover.
