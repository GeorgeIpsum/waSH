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
| 2025-07-12 | node/fake-idb (macOS) | 173.49 | 373.81 | 485.98 | 256 KiB fastest (2.8x over 16 KiB); 64 KiB baseline pending browser validation |
