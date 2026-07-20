import { afterAll } from "vitest";
import { runBackendConformance } from "@wash/vfs/conformance";
import { CachedBackend, ulid } from "@wash/vfs";
import { OpfsBackend } from "@wash/backend-opfs";

const roots: string[] = [];
const opened: OpfsBackend[] = [];
afterAll(async () => {
  // Close every backend this file opened BEFORE removing its root: a pooled
  // sync-access handle holds an exclusive lock on its file, so closing first
  // (which flushes and releases the pool) keeps the recursive removeEntry
  // below from racing a still-open handle.
  await Promise.all(opened.splice(0).map((be) => be.close().catch(() => {})));
  const origin = await navigator.storage.getDirectory();
  for (const name of roots.splice(0)) {
    await origin.removeEntry(name, { recursive: true }).catch(() => {});
  }
});

function freshRoot(): string {
  const name = `wash-conf-${ulid()}`;
  roots.push(name);
  return name;
}

async function freshBackend(): Promise<OpfsBackend> {
  const be = await OpfsBackend.open(freshRoot());
  opened.push(be);
  return be;
}

runBackendConformance("OpfsBackend", () => freshBackend());

runBackendConformance(
  "CachedBackend(OpfsBackend, writeback)",
  async () => new CachedBackend(await freshBackend(), { flushDelayMs: 1 }),
);
