import { runBackendConformance } from "@wash/vfs/conformance";
import { CachedBackend, ulid } from "@wash/vfs";
import { IndexedDBBackend } from "../src/backend.js";

runBackendConformance("IndexedDBBackend", () => IndexedDBBackend.open(`conf-${ulid()}`));

runBackendConformance(
  "CachedBackend(IndexedDBBackend, writeback)",
  async () => new CachedBackend(await IndexedDBBackend.open(`confc-${ulid()}`), { flushDelayMs: 1 }),
);
