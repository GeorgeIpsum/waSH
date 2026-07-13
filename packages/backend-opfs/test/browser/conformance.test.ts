import { afterAll } from "vitest";
import { runBackendConformance } from "@wash/vfs/conformance";
import { CachedBackend, ulid } from "@wash/vfs";
import { OpfsBackend } from "@wash/backend-opfs";

const roots: string[] = [];
afterAll(async () => {
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

runBackendConformance("OpfsBackend", () => OpfsBackend.open(freshRoot()));

runBackendConformance(
  "CachedBackend(OpfsBackend, writeback)",
  async () => new CachedBackend(await OpfsBackend.open(freshRoot()), { flushDelayMs: 1 }),
);
