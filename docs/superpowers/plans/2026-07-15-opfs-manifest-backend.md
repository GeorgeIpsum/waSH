# OPFS Manifest-Model Backend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `@wash/backend-opfs`'s worker storage model from path-transparent files + `.wash-attrs` sidecars to an id-addressed blob store + a two-generation A/B manifest (sync access handles, checksum, union GC), per `docs/superpowers/specs/2026-07-14-opfs-manifest-backend-design.md`.

**Architecture:** Content lives in id-addressed chunk files `blobs/<inodeId>.<chunkIdx>` that are never moved. The whole namespace + metadata lives in one manifest kept in two slots `manifest.a`/`manifest.b`, each with a `generation` counter + `checksum`, written in place via worker sync access handles. Every namespace op is an in-memory manifest edit; `flush` commits a batch by flushing dirty blob handles then writing the new generation into the non-current slot. Rename/create/unlink/chmod are O(1) atomic in-memory edits. A per-root Web Lock enforces single-writer.

**Tech Stack:** TypeScript strict/ESM, worker sync access handles (no `createWritable`), `@wash/vfs` (`WashBackend`, `VfsError`, `ulid`, `CHUNK_SIZE`, conformance suite), vitest browser mode + Playwright Chromium, vitest Node for pure modules.

## Global Constraints

- **Kept unchanged:** `src/rpc.ts`, `src/lru.ts` (already has `get`/`peek`/`set`/`delete(k,callEvict)`/`clear(callEvict)`/`keys`), the browser rig (`vitest.browser.config.ts`), the `testHooks`/`__injectFault(site,skip,times)` scaffold pattern, the RPC envelope (`RpcRequest{id,op,args}` / `RpcOk{id,ok:true,value}` / `RpcErr{id,ok:false,errno?,path?,message}`).
- **`src/sidecar.ts` and `test/node/sidecar.test.ts` are DELETED** (no sidecars in this model).
- **Caps exactly:** `{ symlinks: "supported", hardlinks: true, atomicDirRename: true, renameCost: "O1", reservedNames: [] }` — identical to `@wash/backend-indexeddb`.
- **No `createWritable`/async-writable anywhere.** All storage I/O is worker sync access handles.
- **Manifest on-disk format (verbatim):** a header line `wash-manifest-v1 <generation> <checksum>\n` followed by the JSON body `{"rootId":…,"inodes":…,"dirents":…}`. The checksum is FNV-1a-32 (hex) over the UTF-8 body bytes. A truncated body → checksum mismatch → invalid slot.
- **Two slots, alternating:** a commit writes the new generation into the slot that is NOT current; the reader selects the highest `generation` whose checksum validates. No head pointer.
- **GC live set = union of both retained valid generations' referenced ids ∪ the in-memory working manifest's ids.** A blob is collectible iff its inode id is in none of those.
- **Ordered fail-closed flush:** flush all dirty blob handles first; if any fails, do NOT write a manifest generation, roll the working manifest back to last-committed, reject. Only after all blob flushes succeed, write the new generation.
- **Single-writer:** `OpfsBackend.open()` acquires Web Lock `wash-opfs:<rootDirName>` (held for lifetime, released on `close`); a second opener gets `EBUSY`.
- **Errno parity with the IDB/reference backend:** `lookup` → `null` for missing (not ENOENT); `link` EEXIST before EPERM, EPERM on dir; same-inode rename is a POSIX no-op; POSIX rename overwrite (EISDIR/ENOTDIR/ENOTEMPTY); unlink GC at nlink ≤ 0; reads past EOF short; zero-length writes no-op; sparse chunks read as zeros; attr defaults dir 0o755 / symlink 0o777 / file 0o644, nlink 1, mtime/ctime = Date.now().
- **`DOMException → VfsError` via `errnoFromDom`** (existing helper; `QuotaExceededError → ENOSPC`, etc.); every fallible OPFS call maps its error.
- ESM-only, TS strict, ES2022. Conventional commits after every green cycle.
- **PR #3 re-point:** this work lands on the existing `feat/backend-opfs` branch; the final task force-updates PR #3.

---

### Task 1: Manifest pure core + caps update

**Files:**
- Create: `packages/backend-opfs/src/manifest.ts`
- Modify: `packages/backend-opfs/src/client.ts` (caps object only)
- Test: `packages/backend-opfs/test/node/manifest.test.ts`

**Interfaces:**
- Consumes: `NodeId`, `NodeKind` from `@wash/vfs`.
- Produces (used by the worker in Tasks 2+):
  - Types: `InodeRecord { kind; size; mode; mtimeMs; ctimeMs; nlink; target? }`, `Manifest { rootId: NodeId; inodes: Record<NodeId,InodeRecord>; dirents: Record<NodeId,Record<string,{id:NodeId;kind:NodeKind}>> }` (note: `generation`/`checksum` live in the header line, NOT in this object).
  - `fnv1a(bytes: Uint8Array): string` — 8-char hex.
  - `serializeManifest(m: Manifest, generation: number): Uint8Array` — header line + JSON body.
  - `parseManifest(bytes: Uint8Array): { generation: number; manifest: Manifest } | null` — null if header/body/checksum invalid.
  - `selectGeneration(slotA: Uint8Array | null, slotB: Uint8Array | null): { manifest: Manifest; generation: number; currentSlot: "a" | "b" } | { state: "empty" } | { state: "corrupt" }` — highest valid generation; `empty` if both null; `corrupt` if ≥1 present but none valid.
  - `emptyManifest(rootId: NodeId): Manifest`.
  - `liveIds(m: Manifest): Set<NodeId>` — the id set for GC.

- [ ] **Step 1: Write the failing tests**

`packages/backend-opfs/test/node/manifest.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  fnv1a, serializeManifest, parseManifest, selectGeneration, emptyManifest, liveIds,
  type Manifest,
} from "../../src/manifest.js";

const enc = new TextEncoder();

function sample(rootId = "R"): Manifest {
  return {
    rootId,
    inodes: {
      R: { kind: "dir", size: 0, mode: 0o755, mtimeMs: 1, ctimeMs: 1, nlink: 1 },
      F: { kind: "file", size: 3, mode: 0o644, mtimeMs: 2, ctimeMs: 2, nlink: 1 },
      L: { kind: "symlink", size: 4, mode: 0o777, mtimeMs: 3, ctimeMs: 3, nlink: 1, target: "/f" },
    },
    dirents: { R: { "f.txt": { id: "F", kind: "file" }, ln: { id: "L", kind: "symlink" } } },
  };
}

describe("manifest core", () => {
  it("fnv1a is deterministic and differs on change", () => {
    expect(fnv1a(enc.encode("hello"))).toBe(fnv1a(enc.encode("hello")));
    expect(fnv1a(enc.encode("hello"))).not.toBe(fnv1a(enc.encode("hellp")));
  });

  it("round-trips a manifest with its generation", () => {
    const bytes = serializeManifest(sample(), 7);
    const parsed = parseManifest(bytes);
    expect(parsed?.generation).toBe(7);
    expect(parsed?.manifest).toEqual(sample());
  });

  it("rejects a truncated body (checksum mismatch)", () => {
    const bytes = serializeManifest(sample(), 1);
    const truncated = bytes.slice(0, bytes.byteLength - 5);
    expect(parseManifest(truncated)).toBeNull();
  });

  it("rejects garbage and an empty buffer", () => {
    expect(parseManifest(enc.encode("not a manifest"))).toBeNull();
    expect(parseManifest(new Uint8Array(0))).toBeNull();
  });

  it("selectGeneration picks the highest valid; falls back when newest is corrupt", () => {
    const a = serializeManifest({ ...sample(), rootId: "A" }, 10);
    const b = serializeManifest({ ...sample(), rootId: "B" }, 11);
    expect(selectGeneration(a, b)).toMatchObject({ generation: 11, currentSlot: "b" });
    const bCorrupt = b.slice(0, b.byteLength - 4);
    expect(selectGeneration(a, bCorrupt)).toMatchObject({ generation: 10, currentSlot: "a" });
  });

  it("selectGeneration reports empty (both absent) vs corrupt (present, none valid)", () => {
    expect(selectGeneration(null, null)).toEqual({ state: "empty" });
    const garbage = enc.encode("xxxx");
    expect(selectGeneration(garbage, null)).toEqual({ state: "corrupt" });
    expect(selectGeneration(garbage, garbage)).toEqual({ state: "corrupt" });
  });

  it("emptyManifest has a root dir and no dirents; liveIds covers all inode ids", () => {
    const m = emptyManifest("ROOT");
    expect(m.inodes.ROOT.kind).toBe("dir");
    expect(m.dirents).toEqual({});
    expect(liveIds(sample())).toEqual(new Set(["R", "F", "L"]));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @wash/backend-opfs test manifest`
Expected: FAIL — `../../src/manifest.js` missing.

- [ ] **Step 3: Implement**

`packages/backend-opfs/src/manifest.ts`:
```ts
import type { NodeId, NodeKind } from "@wash/vfs";

export interface InodeRecord {
  kind: NodeKind;
  size: number;
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
  nlink: number;
  target?: string;
}

export interface Manifest {
  rootId: NodeId;
  inodes: Record<NodeId, InodeRecord>;
  dirents: Record<NodeId, Record<string, { id: NodeId; kind: NodeKind }>>;
}

const HEADER_PREFIX = "wash-manifest-v1";

/** FNV-1a 32-bit over the bytes, as 8-char lowercase hex. Corruption detection, not security. */
export function fnv1a(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.byteLength; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function serializeManifest(m: Manifest, generation: number): Uint8Array {
  const body = new TextEncoder().encode(
    JSON.stringify({ rootId: m.rootId, inodes: m.inodes, dirents: m.dirents }),
  );
  const header = new TextEncoder().encode(`${HEADER_PREFIX} ${generation} ${fnv1a(body)}\n`);
  const out = new Uint8Array(header.byteLength + body.byteLength);
  out.set(header, 0);
  out.set(body, header.byteLength);
  return out;
}

export function parseManifest(bytes: Uint8Array): { generation: number; manifest: Manifest } | null {
  const nl = bytes.indexOf(0x0a); // "\n"
  if (nl < 0) return null;
  const header = new TextDecoder().decode(bytes.subarray(0, nl));
  const parts = header.split(" ");
  if (parts.length !== 3 || parts[0] !== HEADER_PREFIX) return null;
  const generation = Number(parts[1]);
  const checksum = parts[2]!;
  if (!Number.isInteger(generation)) return null;
  const body = bytes.subarray(nl + 1);
  if (fnv1a(body) !== checksum) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as Manifest;
    if (!parsed || typeof parsed !== "object" || !parsed.rootId || !parsed.inodes || !parsed.dirents) {
      return null;
    }
    return { generation, manifest: parsed };
  } catch {
    return null;
  }
}

export type SelectResult =
  | { manifest: Manifest; generation: number; currentSlot: "a" | "b" }
  | { state: "empty" }
  | { state: "corrupt" };

export function selectGeneration(slotA: Uint8Array | null, slotB: Uint8Array | null): SelectResult {
  const a = slotA ? parseManifest(slotA) : null;
  const b = slotB ? parseManifest(slotB) : null;
  if (!a && !b) {
    if (!slotA && !slotB) return { state: "empty" };
    return { state: "corrupt" }; // ≥1 present but none valid
  }
  if (a && (!b || a.generation >= b.generation)) {
    return { manifest: a.manifest, generation: a.generation, currentSlot: "a" };
  }
  return { manifest: b!.manifest, generation: b!.generation, currentSlot: "b" };
}

export function emptyManifest(rootId: NodeId): Manifest {
  const now = Date.now();
  return {
    rootId,
    inodes: { [rootId]: { kind: "dir", size: 0, mode: 0o755, mtimeMs: now, ctimeMs: now, nlink: 1 } },
    dirents: {},
  };
}

export function liveIds(m: Manifest): Set<NodeId> {
  return new Set(Object.keys(m.inodes));
}
```

- [ ] **Step 4: Update client caps**

In `packages/backend-opfs/src/client.ts`, replace the `caps` object with:
```ts
  readonly caps: BackendCaps = {
    symlinks: "supported",
    hardlinks: true,
    atomicDirRename: true,
    renameCost: "O1",
    reservedNames: [],
  };
```
(Remove any `SIDECAR_NAME` import/reference in client.ts if present.)

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @wash/backend-opfs test manifest && pnpm --filter @wash/backend-opfs typecheck`
Expected: PASS (10 manifest tests); typecheck clean (client caps compiles).

- [ ] **Step 6: Commit**

```bash
git add packages/backend-opfs/src/manifest.ts packages/backend-opfs/src/client.ts packages/backend-opfs/test/node/manifest.test.ts
git commit -m "feat(backend-opfs): manifest pure core (serialize/parse/checksum/generation-select) + caps to id-addressed"
```

---

### Task 2: Worker lifecycle — Web Lock, manifest load/init/commit, blob store, root/getattr/flush/close

**Files:**
- Rewrite: `packages/backend-opfs/src/worker.ts`
- Create: `packages/backend-opfs/src/blobs.ts`
- Delete: `packages/backend-opfs/src/sidecar.ts`, `packages/backend-opfs/test/node/sidecar.test.ts`
- Test: `packages/backend-opfs/test/browser/shell.test.ts` (rewrite)

**Interfaces:**
- Consumes: Task 1 manifest core; `Lru` from `./lru.js`; `RpcRequest`/`RpcResponse` from `./rpc.js`; `VfsError`, `ulid` from `@wash/vfs`.
- Produces (worker-internal, used by Tasks 3–6):
  - Module state: `let mani: Manifest`, `let generation: number`, `let currentSlot: "a"|"b"`, `let dirty: boolean`, `let committedBytes: Uint8Array`, `let rootDir: FileSystemDirectoryHandle`, `let blobs: BlobStore` (holds the handle pool internally), `let releaseLock: (() => void) | null`. (Eviction-flush errors are tracked inside `BlobStore` and surfaced by `flushAll()`, not a worker-level array.)
  - Helpers: `inode(id): InodeRecord` (ENOENT), `requireDir(id)`, `requireFile(id)` (returns the inode, throws EISDIR/ENOENT), `children(id): Record<string,{id,kind}>` (the dirents map for a dir, creating `{}` if absent), `defaultMode(kind)`, `touchDir()` marks `dirty=true`, `commit(): Promise<void>` (the ordered fail-closed flush), `errnoFromDom`/`maybeFault` (kept), `chunkKey(id,idx)`.
  - Blob store (`blobs.ts`): `class BlobStore` with `read(id, offset, length, size): Promise<Uint8Array>`, `write(id, offset, data): Promise<void>`, `truncate(id, size, prevSize): Promise<void>`, `deleteInode(id, size): Promise<void>`, `flushAll(): VfsError | null`, `closeAll(): void`, `gc(liveIds: Set<string>): Promise<void>`.

- [ ] **Step 1: Write the failing shell tests (rewrite `shell.test.ts`)**

`packages/backend-opfs/test/browser/shell.test.ts`:
```ts
import { describe, it, expect, afterEach } from "vitest";
import { OpfsBackend } from "@wash/backend-opfs";
import { ulid } from "@wash/vfs";

const roots: string[] = [];
export function testRoot(): string {
  const name = `wash-test-${ulid()}`;
  roots.push(name);
  return name;
}
afterEach(async () => {
  const origin = await navigator.storage.getDirectory();
  for (const name of roots.splice(0)) await origin.removeEntry(name, { recursive: true }).catch(() => {});
});

describe("OpfsBackend manifest shell", () => {
  it("opens an empty mount, exposes a dir root, persists across reopen", async () => {
    const name = testRoot();
    const be = await OpfsBackend.open(name);
    const root = await be.root();
    const attrs = await be.getattr(root);
    expect(attrs.kind).toBe("dir");
    expect(attrs.mode).toBe(0o755);
    await be.flush();
    await be.close();
    const be2 = await OpfsBackend.open(name);
    expect(await be2.root()).toBe(root); // rootId persisted in the manifest
    await be2.close();
  });

  it("declares the id-addressed caps", async () => {
    const be = await OpfsBackend.open(testRoot());
    expect(be.caps).toEqual({
      symlinks: "supported", hardlinks: true, atomicDirRename: true, renameCost: "O1", reservedNames: [],
    });
    await be.close();
  });

  it("enforces single-writer: a second open of the same root gets EBUSY; reopen after close works", async () => {
    const name = testRoot();
    const be = await OpfsBackend.open(name);
    await expect(OpfsBackend.open(name)).rejects.toMatchObject({ errno: "EBUSY" });
    await be.close();
    const be2 = await OpfsBackend.open(name); // lock released
    await be2.close();
  });

  it("getattr of unknown id throws ENOENT; unimplemented op throws ENOSYS", async () => {
    const be = await OpfsBackend.open(testRoot());
    await expect(be.getattr(ulid())).rejects.toMatchObject({ errno: "ENOENT" });
    await expect(
      (be as unknown as { call: (op: string, a: unknown[]) => Promise<unknown> }).call("nonexistent-op", []),
    ).rejects.toMatchObject({ errno: "ENOSYS" });
    await be.close();
  });
});
```

- [ ] **Step 2: Delete the sidecar files, run to verify RED**

```bash
git rm packages/backend-opfs/src/sidecar.ts packages/backend-opfs/test/node/sidecar.test.ts
```
Run: `pnpm turbo build --filter @wash/backend-opfs` then `pnpm --filter @wash/backend-opfs test:browser shell`
Expected: FAIL — worker still imports sidecar / shell tests fail (backend not rewritten). This is the RED baseline; the whole worker is replaced next.

- [ ] **Step 3: Implement the blob store**

`packages/backend-opfs/src/blobs.ts`:
```ts
import { CHUNK_SIZE, VfsError } from "@wash/vfs";
import { Lru } from "./lru.js";

/** Chunked content store over blobs/<inodeId>.<chunkIdx>, sync-access-handle backed. */
export class BlobStore {
  private pool: Lru<string, FileSystemSyncAccessHandle>;
  /** An eviction that fails to flush loses data silently; record it so the next flushAll surfaces it. */
  private evictError: VfsError | null = null;
  constructor(
    private readonly blobDir: FileSystemDirectoryHandle,
    poolSize: number,
    readonly chunkSize: number = CHUNK_SIZE,
  ) {
    this.pool = new Lru(poolSize, (_k, h) => this.onEvict(h));
  }

  private onEvict(h: FileSystemSyncAccessHandle): void {
    try {
      try { h.flush(); } catch (e) {
        if (!this.evictError) {
          this.evictError = (e as { name?: string }).name === "QuotaExceededError"
            ? new VfsError("ENOSPC") : new VfsError("EBUSY");
        }
      } finally { h.close(); }
    } catch { /* already closed */ }
  }

  private key(id: string, idx: number): string {
    return `${id}.${idx}`;
  }

  private async handle(id: string, idx: number, create: boolean): Promise<FileSystemSyncAccessHandle | null> {
    const k = this.key(id, idx);
    const cached = this.pool.get(k);
    if (cached) return cached;
    let fh: FileSystemFileHandle;
    try {
      fh = await this.blobDir.getFileHandle(k, { create });
    } catch (e) {
      if ((e as { name?: string }).name === "NotFoundError") return null;
      throw new VfsError("ENOSPC", k);
    }
    let h: FileSystemSyncAccessHandle;
    try {
      h = await fh.createSyncAccessHandle();
    } catch {
      throw new VfsError("EBUSY", k);
    }
    this.pool.set(k, h);
    return h;
  }

  async read(id: string, offset: number, length: number, size: number): Promise<Uint8Array> {
    if (offset >= size || length === 0) return new Uint8Array(0);
    const end = Math.min(offset + length, size);
    const out = new Uint8Array(end - offset); // zero-initialized: sparse/absent chunks read as zeros
    const first = Math.floor(offset / this.chunkSize);
    const last = Math.floor((end - 1) / this.chunkSize);
    for (let idx = first; idx <= last; idx++) {
      const h = await this.handle(id, idx, false);
      if (!h) continue; // sparse
      const chunkStart = idx * this.chunkSize;
      const from = Math.max(offset, chunkStart);
      const to = Math.min(end, chunkStart + this.chunkSize);
      const buf = new Uint8Array(to - from);
      h.read(buf, { at: from - chunkStart });
      out.set(buf, from - offset);
    }
    return out;
  }

  async write(id: string, offset: number, data: Uint8Array): Promise<void> {
    if (data.byteLength === 0) return;
    const end = offset + data.byteLength;
    const first = Math.floor(offset / this.chunkSize);
    const last = Math.floor((end - 1) / this.chunkSize);
    for (let idx = first; idx <= last; idx++) {
      const chunkStart = idx * this.chunkSize;
      const from = Math.max(offset, chunkStart);
      const to = Math.min(end, chunkStart + this.chunkSize);
      const h = (await this.handle(id, idx, true))!;
      try {
        h.write(data.subarray(from - offset, to - offset), { at: from - chunkStart });
      } catch (e) {
        if ((e as { name?: string }).name === "QuotaExceededError") throw new VfsError("ENOSPC", id);
        throw new VfsError("EBUSY", id);
      }
    }
  }

  async truncate(id: string, size: number, prevSize: number): Promise<void> {
    const lastKeep = size === 0 ? -1 : Math.floor((size - 1) / this.chunkSize);
    const prevLast = prevSize === 0 ? -1 : Math.floor((prevSize - 1) / this.chunkSize);
    for (let idx = lastKeep + 1; idx <= prevLast; idx++) {
      this.pool.delete(this.key(id, idx), true);
      await this.blobDir.removeEntry(this.key(id, idx)).catch(() => {});
    }
    if (lastKeep >= 0) {
      const keep = size - lastKeep * this.chunkSize;
      const h = await this.handle(id, lastKeep, false);
      if (h && h.getSize() > keep) h.truncate(keep);
    }
  }

  async deleteInode(id: string, size: number): Promise<void> {
    const last = size === 0 ? -1 : Math.floor((size - 1) / this.chunkSize);
    for (let idx = 0; idx <= last; idx++) {
      this.pool.delete(this.key(id, idx), true);
      await this.blobDir.removeEntry(this.key(id, idx)).catch(() => {});
    }
  }

  /** Flush every live handle plus surface any recorded eviction-flush failure. Returns the first error or null. */
  flushAll(): VfsError | null {
    let first: VfsError | null = this.evictError;
    this.evictError = null;
    for (const k of [...this.pool.keys()]) {
      const h = this.pool.peek(k);
      try {
        h?.flush();
      } catch (e) {
        if (!first) first = (e as { name?: string }).name === "QuotaExceededError"
          ? new VfsError("ENOSPC") : new VfsError("EBUSY");
      }
    }
    return first;
  }

  closeAll(): void {
    this.pool.clear(true);
  }

  async gc(liveIds: Set<string>): Promise<void> {
    for await (const name of (this.blobDir as unknown as { keys(): AsyncIterableIterator<string> }).keys()) {
      const dot = name.lastIndexOf(".");
      const id = dot > 0 ? name.slice(0, dot) : name;
      if (!liveIds.has(id)) {
        this.pool.delete(name, false);
        await this.blobDir.removeEntry(name).catch(() => {});
      }
    }
  }
}
```

- [ ] **Step 4: Rewrite the worker lifecycle + commit machinery**

`packages/backend-opfs/src/worker.ts` (full replacement — Tasks 3–6 add op handlers into the `ops` registry this establishes):
```ts
/// <reference lib="webworker" />
import type { Attrs, NodeId, NodeKind } from "@wash/vfs";
import { VfsError, ulid } from "@wash/vfs";
import type { RpcRequest, RpcResponse } from "./rpc.js";
import {
  type Manifest, type InodeRecord,
  serializeManifest, parseManifest, selectGeneration, emptyManifest, liveIds,
} from "./manifest.js";
import { BlobStore } from "./blobs.js";

// ---- test-gated fault injection (unchanged pattern) ----
let faults: Map<string, { skip: number; times: number }> | null = null;
function maybeFault(site: string): void {
  if (!faults) return;
  const f = faults.get(site);
  if (!f) return;
  if (f.skip > 0) { f.skip--; return; }
  if (f.times <= 0) { faults.delete(site); return; }
  f.times--;
  if (f.times <= 0) faults.delete(site);
  throw new DOMException("injected fault", "QuotaExceededError");
}

// ---- DOMException → VfsError (kept) ----
function domToVfs(e: unknown, path?: string): VfsError | undefined {
  const name = (e as { name?: string } | null)?.name;
  if (name === "NotFoundError") return new VfsError("ENOENT", path);
  if (name === "InvalidModificationError") return new VfsError("ENOTEMPTY", path);
  if (name === "NoModificationAllowedError") return new VfsError("EBUSY", path);
  if (name === "TypeMismatchError") return new VfsError("ENOTDIR", path);
  if (name === "QuotaExceededError") return new VfsError("ENOSPC", path);
  return undefined;
}
export function errnoFromDom(e: unknown, path?: string): never {
  const v = domToVfs(e, path);
  if (v) throw v;
  throw e;
}
function toVfs(e: unknown, path?: string): VfsError {
  if (e instanceof VfsError) return e;
  return domToVfs(e, path) ?? new VfsError("EBUSY", path);
}

// ---- module state ----
let rootDir: FileSystemDirectoryHandle;
let blobs: BlobStore;
let mani: Manifest;
let generation = 0;
let currentSlot: "a" | "b" = "a";
let committedBytes: Uint8Array; // last successfully committed serialization
let dirty = false;
let releaseLock: (() => void) | null = null;
let poolSize = 64;

function slotName(s: "a" | "b"): string { return s === "a" ? "manifest.a" : "manifest.b"; }
function otherSlot(): "a" | "b" { return currentSlot === "a" ? "b" : "a"; }

function inode(id: NodeId): InodeRecord {
  const rec = mani.inodes[id];
  if (!rec) throw new VfsError("ENOENT");
  return rec;
}
function requireDir(id: NodeId): InodeRecord {
  const rec = inode(id);
  if (rec.kind !== "dir") throw new VfsError("ENOTDIR");
  return rec;
}
function requireFile(id: NodeId): InodeRecord {
  const rec = inode(id);
  if (rec.kind === "dir") throw new VfsError("EISDIR");
  return rec;
}
function children(id: NodeId): Record<string, { id: NodeId; kind: NodeKind }> {
  return (mani.dirents[id] ??= {});
}
function defaultMode(kind: NodeKind): number {
  return kind === "dir" ? 0o755 : kind === "symlink" ? 0o777 : 0o644;
}
function attrsOf(rec: InodeRecord): Attrs {
  return { kind: rec.kind, size: rec.size, mode: rec.mode, mtimeMs: rec.mtimeMs, ctimeMs: rec.ctimeMs, nlink: rec.nlink };
}

/** Read both manifest slots as raw bytes (null if absent/unreadable). */
async function readSlot(s: "a" | "b"): Promise<Uint8Array | null> {
  try {
    const fh = await rootDir.getFileHandle(slotName(s));
    return new Uint8Array(await (await fh.getFile()).arrayBuffer());
  } catch {
    return null;
  }
}

/** Write the current in-memory manifest as the next generation into the non-current slot. */
async function writeGeneration(): Promise<void> {
  const nextGen = generation + 1;
  const bytes = serializeManifest(mani, nextGen);
  const target = otherSlot();
  const fh = await rootDir.getFileHandle(slotName(target), { create: true });
  const h = await fh.createSyncAccessHandle();
  try {
    maybeFault("slotWrite");
    h.truncate(0);
    h.write(bytes, { at: 0 });
    h.flush();
  } finally {
    h.close();
  }
  generation = nextGen;
  currentSlot = target;
  committedBytes = bytes;
  dirty = false;
}

/**
 * Ordered fail-closed commit (spec §3.1):
 * 1. flush all dirty blob handles; on any failure → poison + roll back + throw.
 * 2. write the new manifest generation into the non-current slot.
 * On a blob-flush failure the working manifest is restored to last-committed (§3.1a).
 */
async function commit(): Promise<void> {
  try {
    maybeFault("blobFlush"); // test hook: simulate a blob-flush failure at the commit boundary
  } catch (e) {
    rollbackToCommitted();
    throw toVfs(e); // QuotaExceededError → ENOSPC
  }
  const blobErr = blobs.flushAll();
  if (blobErr) {
    rollbackToCommitted();
    throw blobErr;
  }
  if (!dirty) return;
  try {
    await writeGeneration();
  } catch (e) {
    rollbackToCommitted();
    throw toVfs(e);
  }
}

function rollbackToCommitted(): void {
  const parsed = parseManifest(committedBytes);
  mani = parsed ? parsed.manifest : emptyManifest(mani.rootId);
  dirty = false;
}

async function acquireLock(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    void navigator.locks.request(`wash-opfs:${name}`, { ifAvailable: true }, (lock) => {
      if (!lock) { resolve(false); return Promise.resolve(); }
      return new Promise<void>((release) => {
        releaseLock = () => release();
        resolve(true);
      });
    });
  });
}

type OpResult = { value: unknown };
type OpFn = (...args: never[]) => Promise<OpResult> | OpResult;
const ops: Record<string, OpFn> = {
  async open(rootDirName: string, poolSizeOpt: number, testHooks: boolean): Promise<OpResult> {
    if (testHooks) faults = new Map();
    poolSize = poolSizeOpt;
    if (!(await acquireLock(rootDirName))) throw new VfsError("EBUSY", rootDirName);
    const origin = await navigator.storage.getDirectory();
    rootDir = await origin.getDirectoryHandle(rootDirName, { create: true });
    const blobDir = await rootDir.getDirectoryHandle("blobs", { create: true });
    blobs = new BlobStore(blobDir, poolSize);
    const sel = selectGeneration(await readSlot("a"), await readSlot("b"));
    if ("state" in sel) {
      if (sel.state === "corrupt") throw new VfsError("EIO", rootDirName); // never empty-init + GC over corruption
      mani = emptyManifest(ulid());
      generation = 0;
      currentSlot = "b"; // so the first writeGeneration()'s otherSlot() is "a" — slot "a" gets gen 1
      committedBytes = serializeManifest(mani, 0);
    } else {
      mani = sel.manifest;
      generation = sel.generation;
      currentSlot = sel.currentSlot;
      committedBytes = (currentSlot === "a" ? await readSlot("a") : await readSlot("b"))!;
    }
    await blobs.gc(liveIds(mani)); // open-time GC over the committed (loaded) manifest
    return { value: mani.rootId };
  },

  async root(): Promise<OpResult> {
    return { value: mani.rootId };
  },

  async getattr(id: NodeId): Promise<OpResult> {
    return { value: attrsOf(inode(id)) };
  },

  async flush(): Promise<OpResult> {
    await commit(); // throws (mapped) on any blob-flush or slot-write failure, after rolling back
    return { value: undefined };
  },

  async close(): Promise<OpResult> {
    try { await commit(); } catch { /* best-effort on close */ }
    blobs.closeAll();
    releaseLock?.();
    releaseLock = null;
    return { value: undefined };
  },
};

function ensure(op: string): OpFn {
  return ops[op] ?? (() => { throw new VfsError("ENOSYS", op); });
}

let chain: Promise<void> = Promise.resolve();
self.onmessage = (ev: MessageEvent<RpcRequest>) => {
  const req = ev.data;
  chain = chain.then(async () => {
    try {
      const result = await ensure(req.op)(...(req.args as never[]));
      (self as unknown as Worker).postMessage({ id: req.id, ok: true, value: result.value } satisfies RpcResponse);
    } catch (e) {
      const v = e instanceof VfsError ? e : undefined;
      (self as unknown as Worker).postMessage({
        id: req.id, ok: false, errno: v?.errno, path: v?.path,
        message: e instanceof Error ? e.message : String(e),
      } satisfies RpcResponse);
    }
  }).catch(() => {});
};
```
(All op handlers in Tasks 3–6 are added directly into the in-file `ops` object; the worker exposes no other exports. `errnoFromDom` is already exported inline above for any test that imports it — do not re-export it in a trailing block, that is a duplicate-export error.)
(Note: `EIO` must exist in the `Errno` union — it does not yet. Add `"EIO"` to `packages/vfs/src/errors.ts`'s `Errno` union as part of this task, mirroring the earlier `ENOSPC` addition.)

Register the `__injectFault` op only when `testHooks` — add inside `open`, after `faults = new Map()`:
```ts
      ops.__injectFault = (site: string, skip = 0, times = 1): OpResult => {
        faults!.set(site, { skip, times });
        return { value: undefined };
      };
```

- [ ] **Step 5: Build + run to verify pass**

Run: `pnpm turbo build --filter @wash/backend-opfs && pnpm --filter @wash/backend-opfs test:browser shell`
Expected: PASS (4 shell tests: empty-mount+reopen, caps, EBUSY single-writer, ENOENT/ENOSYS). Fix any worker wiring until green.

- [ ] **Step 6: Full node + typecheck (manifest still green, sidecar gone)**

Run: `pnpm turbo build test typecheck --filter @wash/backend-opfs`
Expected: green (node: manifest tests; browser tasks run under test:browser separately).

- [ ] **Step 7: Commit**

```bash
git add -A packages/backend-opfs packages/vfs/src/errors.ts
git commit -m "feat(backend-opfs): manifest worker lifecycle — Web Lock, A/B load/commit, blob store; delete sidecar; add EIO errno"
```

---

### Task 3: Namespace ops — lookup/readdir/create/mkdir/unlink/rmdir/chmod/utimes

**Files:**
- Modify: `packages/backend-opfs/src/worker.ts` (add handlers to `ops`)
- Test: `packages/backend-opfs/test/browser/namespace.test.ts` (rewrite)

**Interfaces:**
- Consumes: Task 2 helpers (`inode`/`requireDir`/`children`/`defaultMode`/`attrsOf`/`blobs`/`commit` semantics via `dirty`).
- Produces: `lookup`, `readdir`, `create`, `unlink`, `setattr` ops. Every mutation sets `dirty = true`.

- [ ] **Step 1: Write the failing browser tests**

`packages/backend-opfs/test/browser/namespace.test.ts`:
```ts
import { describe, it, expect, afterEach } from "vitest";
import { OpfsBackend } from "@wash/backend-opfs";
import { ulid } from "@wash/vfs";

const roots: string[] = [];
function testRoot(): string { const n = `wash-test-${ulid()}`; roots.push(n); return n; }
afterEach(async () => {
  const origin = await navigator.storage.getDirectory();
  for (const n of roots.splice(0)) await origin.removeEntry(n, { recursive: true }).catch(() => {});
});

describe("OpfsBackend namespace", () => {
  it("create + lookup with default attrs; missing → null; EEXIST; ENOTDIR", async () => {
    const be = await OpfsBackend.open(testRoot());
    const root = await be.root();
    const d = ulid();
    await be.create(root, "dir", d, "dir");
    const f = ulid();
    await be.create(d, "f.txt", f, "file", { mode: 0o600 });
    expect((await be.lookup(root, "dir"))?.id).toBe(d);
    expect(await be.lookup(root, "nope")).toBeNull();
    const info = await be.lookup(d, "f.txt");
    expect(info?.attrs).toMatchObject({ kind: "file", mode: 0o600, nlink: 1, size: 0 });
    await expect(be.create(root, "dir", ulid(), "file")).rejects.toMatchObject({ errno: "EEXIST" });
    await expect(be.create(f, "x", ulid(), "file")).rejects.toMatchObject({ errno: "ENOTDIR" });
    await expect(be.readdir(f)).rejects.toMatchObject({ errno: "ENOTDIR" });
    await be.close();
  });

  it("readdir lists children sorted-insensitively; persists across reopen", async () => {
    const name = testRoot();
    const be = await OpfsBackend.open(name);
    const root = await be.root();
    for (const n of ["b", "a", "c"]) await be.create(root, n, ulid(), "file");
    expect((await be.readdir(root)).map((e) => e.name).sort()).toEqual(["a", "b", "c"]);
    await be.close();
    const be2 = await OpfsBackend.open(name);
    expect((await be2.readdir(await be2.root())).map((e) => e.name).sort()).toEqual(["a", "b", "c"]);
    await be2.close();
  });

  it("unlink removes files; dirs must be empty; ENOENT missing; chmod/utimes update", async () => {
    const be = await OpfsBackend.open(testRoot());
    const root = await be.root();
    const f = ulid();
    await be.create(root, "f", f, "file");
    await be.unlink(root, "f");
    expect(await be.lookup(root, "f")).toBeNull();
    await expect(be.getattr(f)).rejects.toMatchObject({ errno: "ENOENT" });
    await expect(be.unlink(root, "ghost")).rejects.toMatchObject({ errno: "ENOENT" });
    const d = ulid();
    await be.create(root, "d", d, "dir");
    await be.create(d, "kid", ulid(), "file");
    await expect(be.unlink(root, "d")).rejects.toMatchObject({ errno: "ENOTEMPTY" });
    const g = ulid();
    await be.create(root, "g", g, "file");
    await be.setattr(g, { mode: 0o700, mtimeMs: 999 });
    const a = await be.getattr(g);
    expect(a.mode).toBe(0o700);
    expect(a.mtimeMs).toBe(999);
    await be.close();
  });
});
```

- [ ] **Step 2: Run to verify RED**

Run: `pnpm turbo build --filter @wash/backend-opfs && pnpm --filter @wash/backend-opfs test:browser namespace`
Expected: FAIL — ops missing (ENOSYS from `lookup`/`create`/etc.).

- [ ] **Step 3: Implement (add to the `ops` object in worker.ts)**

```ts
  async lookup(parent: NodeId, name: string): Promise<OpResult> {
    requireDir(parent);
    const e = children(parent)[name];
    if (!e) return { value: null };
    return { value: { id: e.id, attrs: attrsOf(inode(e.id)) } };
  },

  async readdir(id: NodeId): Promise<OpResult> {
    requireDir(id);
    const out = Object.entries(children(id)).map(([name, e]) => ({ name, childId: e.id, kind: e.kind }));
    return { value: out };
  },

  async create(parent: NodeId, name: string, id: NodeId, kind: NodeKind, attrs?: Partial<Attrs>): Promise<OpResult> {
    const p = requireDir(parent);
    const dir = children(parent);
    if (dir[name]) throw new VfsError("EEXIST", name);
    const now = Date.now();
    mani.inodes[id] = {
      kind, size: 0, mode: attrs?.mode !== undefined ? attrs.mode & 0o777 : defaultMode(kind),
      mtimeMs: attrs?.mtimeMs ?? now, ctimeMs: attrs?.ctimeMs ?? now, nlink: 1,
    };
    if (kind === "dir") mani.dirents[id] = {};
    dir[name] = { id, kind };
    p.mtimeMs = now;
    dirty = true;
    return { value: undefined };
  },

  async unlink(parent: NodeId, name: string): Promise<OpResult> {
    const p = requireDir(parent);
    const dir = children(parent);
    const e = dir[name];
    if (!e) throw new VfsError("ENOENT", name);
    const child = inode(e.id);
    if (child.kind === "dir") {
      if (Object.keys(children(e.id)).length > 0) throw new VfsError("ENOTEMPTY", name);
      delete mani.dirents[e.id];
      delete mani.inodes[e.id];
    } else {
      child.nlink -= 1;
      if (child.nlink <= 0) {
        const size = child.size;
        delete mani.inodes[e.id];
        await blobs.deleteInode(e.id, size); // post-commit-ish blob cleanup; GC also covers it
      }
    }
    delete dir[name];
    p.mtimeMs = Date.now();
    dirty = true;
    return { value: undefined };
  },

  async setattr(id: NodeId, attrs: Partial<Pick<Attrs, "mode" | "mtimeMs" | "ctimeMs">>): Promise<OpResult> {
    const rec = inode(id);
    if (attrs.mode !== undefined) rec.mode = attrs.mode & 0o777;
    if (attrs.mtimeMs !== undefined) rec.mtimeMs = attrs.mtimeMs;
    if (attrs.ctimeMs !== undefined) rec.ctimeMs = attrs.ctimeMs;
    dirty = true;
    return { value: undefined };
  },
```
(`mkdir`/`rmdir`/`chmod`/`utimes` are the VFS façade's names; at the backend contract level they are `create(kind:"dir")` / `unlink` / `setattr` — the client already maps them. No extra worker ops needed. Confirm the client forwards `mkdir`→`create`, `rmdir`→`unlink`, `chmod`/`utimes`→`setattr`; if the client has distinct methods, they call the same worker ops.)

- [ ] **Step 4: Run to verify GREEN**

Run: `pnpm turbo build --filter @wash/backend-opfs && pnpm --filter @wash/backend-opfs test:browser namespace`
Expected: PASS (3 namespace tests).

- [ ] **Step 5: Commit**

```bash
git add packages/backend-opfs
git commit -m "feat(backend-opfs): namespace ops on the manifest (lookup/readdir/create/unlink/setattr)"
```

---

### Task 4: symlinks, hardlinks, and rename (O(1) atomic dir rename, same-inode no-op, overwrite semantics)

**Files:**
- Modify: `packages/backend-opfs/src/worker.ts`
- Test: `packages/backend-opfs/test/browser/links.test.ts` + `packages/backend-opfs/test/browser/rename.test.ts` (rewrite both)

**Interfaces:**
- Consumes: Task 3.
- Produces: `symlink`, `readlink`, `link`, `rename` ops.

- [ ] **Step 1: Write the failing tests**

`packages/backend-opfs/test/browser/links.test.ts`:
```ts
import { describe, it, expect, afterEach } from "vitest";
import { OpfsBackend } from "@wash/backend-opfs";
import { ulid } from "@wash/vfs";
const enc = new TextEncoder(), dec = new TextDecoder();
const roots: string[] = [];
function testRoot(): string { const n = `wash-test-${ulid()}`; roots.push(n); return n; }
afterEach(async () => {
  const o = await navigator.storage.getDirectory();
  for (const n of roots.splice(0)) await o.removeEntry(n, { recursive: true }).catch(() => {});
});

describe("OpfsBackend symlinks + hardlinks", () => {
  it("symlink/readlink round-trip, persists; readlink EINVAL on non-symlink", async () => {
    const name = testRoot();
    const be = await OpfsBackend.open(name);
    const root = await be.root();
    const s = ulid();
    await be.symlink(root, "ln", s, "/some/target");
    expect((await be.lookup(root, "ln"))?.attrs.kind).toBe("symlink");
    expect(await be.readlink(s)).toBe("/some/target");
    const f = ulid();
    await be.create(root, "f", f, "file");
    await expect(be.readlink(f)).rejects.toMatchObject({ errno: "EINVAL" });
    await be.close();
    const be2 = await OpfsBackend.open(name);
    const again = await be2.lookup(await be2.root(), "ln");
    expect(await be2.readlink(again!.id)).toBe("/some/target");
    await be2.close();
  });

  it("hardlink shares content + nlink; GC only at 0; EEXIST beats EPERM; EPERM on dir", async () => {
    const be = await OpfsBackend.open(testRoot());
    const root = await be.root();
    const f = ulid();
    await be.create(root, "a", f, "file");
    await be.write(f, 0, enc.encode("shared"));
    await be.link(root, "b", f);
    expect((await be.getattr(f)).nlink).toBe(2);
    await be.unlink(root, "a");
    expect(dec.decode(await be.read(f, 0, 100))).toBe("shared");
    const d = ulid();
    await be.create(root, "d", d, "dir");
    await expect(be.link(root, "b", d)).rejects.toMatchObject({ errno: "EEXIST" });
    await expect(be.link(root, "c", d)).rejects.toMatchObject({ errno: "EPERM" });
    await be.unlink(root, "b");
    await expect(be.getattr(f)).rejects.toMatchObject({ errno: "ENOENT" });
    await be.close();
  });
});
```

`packages/backend-opfs/test/browser/rename.test.ts`:
```ts
import { describe, it, expect, afterEach } from "vitest";
import { OpfsBackend } from "@wash/backend-opfs";
import { ulid } from "@wash/vfs";
const enc = new TextEncoder(), dec = new TextDecoder();
const roots: string[] = [];
function testRoot(): string { const n = `wash-test-${ulid()}`; roots.push(n); return n; }
afterEach(async () => {
  const o = await navigator.storage.getDirectory();
  for (const n of roots.splice(0)) await o.removeEntry(n, { recursive: true }).catch(() => {});
});

describe("OpfsBackend rename (O(1) atomic, id-addressed)", () => {
  it("moves files within/across dirs, id-stable, content intact; same-inode no-op", async () => {
    const be = await OpfsBackend.open(testRoot());
    const root = await be.root();
    const d = ulid();
    await be.create(root, "d", d, "dir");
    const f = ulid();
    await be.create(root, "a", f, "file");
    await be.write(f, 0, enc.encode("payload"));
    await be.rename(root, "a", root, "b");
    expect((await be.lookup(root, "b"))?.id).toBe(f);
    await be.rename(root, "b", d, "c");
    expect((await be.lookup(d, "c"))?.id).toBe(f);
    expect(await be.lookup(root, "b")).toBeNull();
    expect(dec.decode(await be.read(f, 0, 100))).toBe("payload");
    await be.link(d, "hard", f);
    await be.rename(d, "c", d, "hard"); // both name the same inode → POSIX no-op
    expect((await be.lookup(d, "c"))?.id).toBe(f);
    expect((await be.lookup(d, "hard"))?.id).toBe(f);
    expect((await be.getattr(f)).nlink).toBe(2);
    await be.close();
  });

  it("overwrite semantics: file-over-file GCs displaced; dir-over-nonempty ENOTEMPTY; file-over-dir EISDIR; dir-over-file ENOTDIR", async () => {
    const be = await OpfsBackend.open(testRoot());
    const root = await be.root();
    const f1 = ulid(), f2 = ulid();
    await be.create(root, "f1", f1, "file");
    await be.create(root, "f2", f2, "file");
    await be.rename(root, "f1", root, "f2");
    expect((await be.lookup(root, "f2"))?.id).toBe(f1);
    await expect(be.getattr(f2)).rejects.toMatchObject({ errno: "ENOENT" });
    const d1 = ulid(), d2 = ulid();
    await be.create(root, "d1", d1, "dir");
    await be.create(root, "d2", d2, "dir");
    await be.create(d2, "kid", ulid(), "file");
    await expect(be.rename(root, "d1", root, "d2")).rejects.toMatchObject({ errno: "ENOTEMPTY" });
    await expect(be.rename(root, "f2", root, "d1")).rejects.toMatchObject({ errno: "EISDIR" });
    await expect(be.rename(root, "d1", root, "f2")).rejects.toMatchObject({ errno: "ENOTDIR" });
    await be.close();
  });

  it("directory rename is O(1) and atomic: subtree ids/content unchanged", async () => {
    const name = testRoot();
    const be = await OpfsBackend.open(name);
    const root = await be.root();
    const src = ulid();
    await be.create(root, "src", src, "dir");
    const sub = ulid();
    await be.create(src, "sub", sub, "dir");
    const f = ulid();
    await be.create(sub, "deep.txt", f, "file", { mode: 0o700 });
    await be.write(f, 0, enc.encode("deep"));
    await be.rename(root, "src", root, "moved");
    expect((await be.lookup(root, "moved"))?.id).toBe(src);
    expect((await be.lookup(src, "sub"))?.id).toBe(sub);
    const deep = await be.lookup(sub, "deep.txt");
    expect(deep?.id).toBe(f);
    expect(deep?.attrs.mode).toBe(0o700);
    expect(dec.decode(await be.read(f, 0, 100))).toBe("deep");
    await be.close();
    const be2 = await OpfsBackend.open(name);
    const root2 = await be2.root();
    const moved = await be2.lookup(root2, "moved");
    const sub2 = await be2.lookup(moved!.id, "sub");
    expect(dec.decode(await be2.read((await be2.lookup(sub2!.id, "deep.txt"))!.id, 0, 100))).toBe("deep");
    await be2.close();
  });
});
```

- [ ] **Step 2: Run to verify RED**

Run: `pnpm turbo build --filter @wash/backend-opfs && pnpm --filter @wash/backend-opfs test:browser links rename`
Expected: FAIL — `symlink`/`readlink`/`link`/`rename` ENOSYS.

- [ ] **Step 3: Implement (add to `ops`)**

```ts
  async symlink(parent: NodeId, name: string, id: NodeId, target: string): Promise<OpResult> {
    const p = requireDir(parent);
    if (children(parent)[name]) throw new VfsError("EEXIST", name);
    const now = Date.now();
    mani.inodes[id] = { kind: "symlink", size: target.length, mode: 0o777, mtimeMs: now, ctimeMs: now, nlink: 1, target };
    children(parent)[name] = { id, kind: "symlink" };
    p.mtimeMs = now;
    dirty = true;
    return { value: undefined };
  },

  async readlink(id: NodeId): Promise<OpResult> {
    const rec = inode(id);
    if (rec.kind !== "symlink" || rec.target === undefined) throw new VfsError("EINVAL");
    return { value: rec.target };
  },

  async link(parent: NodeId, name: string, id: NodeId): Promise<OpResult> {
    const p = requireDir(parent);
    if (children(parent)[name]) throw new VfsError("EEXIST", name); // EEXIST before EPERM
    const rec = inode(id);
    if (rec.kind === "dir") throw new VfsError("EPERM", name);
    rec.nlink += 1;
    children(parent)[name] = { id, kind: rec.kind };
    p.mtimeMs = Date.now();
    dirty = true;
    return { value: undefined };
  },

  async rename(fromParent: NodeId, fromName: string, toParent: NodeId, toName: string): Promise<OpResult> {
    const fp = requireDir(fromParent);
    const tp = requireDir(toParent);
    const fromDir = children(fromParent);
    const moving = fromDir[fromName];
    if (!moving) throw new VfsError("ENOENT", fromName);
    const toDir = children(toParent);
    const displaced = toDir[toName];
    if (displaced) {
      if (displaced.id === moving.id) return { value: undefined }; // POSIX same-inode no-op
      const ex = inode(displaced.id);
      const mv = inode(moving.id);
      if (ex.kind === "dir") {
        if (mv.kind !== "dir") throw new VfsError("EISDIR", toName);
        if (Object.keys(children(displaced.id)).length > 0) throw new VfsError("ENOTEMPTY", toName);
        delete mani.dirents[displaced.id];
        delete mani.inodes[displaced.id];
      } else {
        if (mv.kind === "dir") throw new VfsError("ENOTDIR", toName);
        ex.nlink -= 1;
        if (ex.nlink <= 0) {
          const size = ex.size;
          delete mani.inodes[displaced.id];
          await blobs.deleteInode(displaced.id, size);
        }
      }
    }
    delete fromDir[fromName];
    toDir[toName] = moving;
    fp.mtimeMs = Date.now();
    tp.mtimeMs = fp.mtimeMs;
    dirty = true;
    return { value: undefined };
  },
```

- [ ] **Step 4: Run to verify GREEN**

Run: `pnpm turbo build --filter @wash/backend-opfs && pnpm --filter @wash/backend-opfs test:browser links rename`
Expected: PASS (2 links + 3 rename).

- [ ] **Step 5: Commit**

```bash
git add packages/backend-opfs
git commit -m "feat(backend-opfs): symlinks, hardlinks, and O(1) atomic id-addressed rename"
```

---

### Task 5: Content ops — read/write/truncate

**Files:**
- Modify: `packages/backend-opfs/src/worker.ts`
- Test: `packages/backend-opfs/test/browser/content.test.ts` (rewrite)

**Interfaces:**
- Consumes: Task 2 `blobs` (BlobStore); Task 3 inode helpers.
- Produces: `read`, `write`, `truncate` ops. Manifest `size`/`mtime` edited AFTER successful blob I/O (so a blob failure leaves the manifest untouched).

- [ ] **Step 1: Write the failing tests**

`packages/backend-opfs/test/browser/content.test.ts`:
```ts
import { describe, it, expect, afterEach } from "vitest";
import { OpfsBackend } from "@wash/backend-opfs";
import { ulid } from "@wash/vfs";
const enc = new TextEncoder(), dec = new TextDecoder();
const roots: string[] = [];
function testRoot(): string { const n = `wash-test-${ulid()}`; roots.push(n); return n; }
afterEach(async () => {
  const o = await navigator.storage.getDirectory();
  for (const n of roots.splice(0)) await o.removeEntry(n, { recursive: true }).catch(() => {});
});

async function fileFixture(chunkless = false) {
  const be = await OpfsBackend.open(testRoot(), { handlePoolSize: 4 });
  const root = await be.root();
  const f = ulid();
  await be.create(root, "f", f, "file");
  return { be, root, f };
}

describe("OpfsBackend content", () => {
  it("write/read with offsets, EOF clamp, sparse gap zero-fill", async () => {
    const { be, f } = await fileFixture();
    await be.write(f, 0, enc.encode("hello world"));
    expect(dec.decode(await be.read(f, 0, 100))).toBe("hello world");
    expect(dec.decode(await be.read(f, 6, 5))).toBe("world");
    expect((await be.read(f, 11, 10)).byteLength).toBe(0);
    await be.write(f, 20, enc.encode("far"));
    const out = await be.read(f, 0, 100);
    expect(out.byteLength).toBe(23);
    expect([...out.slice(11, 20)]).toEqual(new Array(9).fill(0));
    expect((await be.getattr(f)).size).toBe(23);
    await be.close();
  });

  it("zero-length write no-op; EISDIR on dirs; truncate shrink+sparse-extend; persists", async () => {
    const name = testRoot();
    const be = await OpfsBackend.open(name);
    const root = await be.root();
    const f = ulid();
    await be.create(root, "t", f, "file");
    await be.write(f, 0, enc.encode("0123456789"));
    const before = await be.getattr(f);
    await be.write(f, 100, new Uint8Array(0));
    expect((await be.getattr(f)).size).toBe(10);
    expect((await be.getattr(f)).mtimeMs).toBe(before.mtimeMs);
    await expect(be.write(root, 0, enc.encode("x"))).rejects.toMatchObject({ errno: "EISDIR" });
    await expect(be.read(root, 0, 1)).rejects.toMatchObject({ errno: "EISDIR" });
    await be.truncate(f, 4);
    expect(dec.decode(await be.read(f, 0, 100))).toBe("0123");
    await be.truncate(f, 6);
    const out = await be.read(f, 0, 100);
    expect(out.byteLength).toBe(6);
    expect([...out.slice(4)]).toEqual([0, 0]);
    await be.flush();
    await be.close();
    const be2 = await OpfsBackend.open(name);
    const f2 = await be2.lookup(await be2.root(), "t");
    expect((await be2.read(f2!.id, 0, 100)).byteLength).toBe(6);
    await be2.close();
  });

  it("handle pool evicts beyond capacity without corrupting content", async () => {
    const be = await OpfsBackend.open(testRoot(), { handlePoolSize: 2 });
    const root = await be.root();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const f = ulid();
      await be.create(root, `f${i}`, f, "file");
      await be.write(f, 0, enc.encode(`content-${i}`));
      ids.push(f);
    }
    for (let i = 0; i < 5; i++) expect(dec.decode(await be.read(ids[i]!, 0, 100))).toBe(`content-${i}`);
    await be.close();
  });
});
```

- [ ] **Step 2: Run to verify RED**

Run: `pnpm turbo build --filter @wash/backend-opfs && pnpm --filter @wash/backend-opfs test:browser content`
Expected: FAIL — read/write/truncate ENOSYS.

- [ ] **Step 3: Implement (add to `ops`)**

```ts
  async read(id: NodeId, offset: number, length: number): Promise<OpResult> {
    const rec = requireFile(id);
    return { value: await blobs.read(id, offset, length, rec.size) };
  },

  async write(id: NodeId, offset: number, data: Uint8Array): Promise<OpResult> {
    const rec = requireFile(id);
    if (data.byteLength === 0) return { value: undefined }; // POSIX no-op
    await blobs.write(id, offset, data); // fallible; on throw the manifest is untouched below
    const end = offset + data.byteLength;
    if (end > rec.size) rec.size = end;
    rec.mtimeMs = Date.now();
    dirty = true;
    return { value: undefined };
  },

  async truncate(id: NodeId, size: number): Promise<OpResult> {
    const rec = requireFile(id);
    await blobs.truncate(id, size, rec.size);
    rec.size = size;
    rec.mtimeMs = Date.now();
    dirty = true;
    return { value: undefined };
  },
```

- [ ] **Step 4: Run to verify GREEN**

Run: `pnpm turbo build --filter @wash/backend-opfs && pnpm --filter @wash/backend-opfs test:browser content`
Expected: PASS (3 content tests).

- [ ] **Step 5: Commit**

```bash
git add packages/backend-opfs
git commit -m "feat(backend-opfs): chunked content ops (read/write/truncate) with manifest-edit-after-blob-IO"
```

---

### Task 6: Durability & GC — ordered flush, whole-batch rollback, two-generation fallback, union GC (fault-injected)

**Files:**
- Modify: `packages/backend-opfs/src/worker.ts` (add `gc` op for tests to trigger; wire `maybeFault("slotWrite")` already present; ensure GC union-live-set uses in-memory manifest)
- Test: `packages/backend-opfs/test/browser/durability.test.ts` (new)

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces: a `gc` op (a normal op, callable any time; not `testHooks`-gated) that runs `blobs.gc(await unionLiveIds())`; `unionLiveIds()` = ids of the working manifest ∪ ids of both retained on-disk generations. The behaviors: blob-flush failure rolls back + reports; torn slot → fallback; both-invalid → EIO no-GC; union GC preserves fallback-reachable blobs.

- [ ] **Step 1: Write the failing tests**

`packages/backend-opfs/test/browser/durability.test.ts`:
```ts
import { describe, it, expect, afterEach } from "vitest";
import { OpfsBackend } from "@wash/backend-opfs";
import { ulid } from "@wash/vfs";
const enc = new TextEncoder();
const roots: string[] = [];
function testRoot(): string { const n = `wash-test-${ulid()}`; roots.push(n); return n; }
afterEach(async () => {
  const o = await navigator.storage.getDirectory();
  for (const n of roots.splice(0)) await o.removeEntry(n, { recursive: true }).catch(() => {});
});
function fault(be: unknown) {
  return (be as { call: (op: string, a: unknown[]) => Promise<unknown> }).call.bind(be) as
    (op: string, a: unknown[]) => Promise<unknown>;
}

describe("OpfsBackend durability + GC", () => {
  it("a torn manifest-slot write falls back to the prior generation on reopen", async () => {
    const name = testRoot();
    const be = await OpfsBackend.open(name, { testHooks: true });
    const root = await be.root();
    await be.create(root, "safe", ulid(), "file");
    await be.flush(); // commits generation 1 (slot a)
    const c = fault(be);
    await c("__injectFault", ["slotWrite", 0, 1]); // next generation write tears
    await be.create(root, "doomed", ulid(), "file");
    await expect(be.flush()).rejects.toBeTruthy(); // slot write fails; working rolled back
    await be.close();
    const be2 = await OpfsBackend.open(name);
    const root2 = await be2.root();
    expect((await be2.lookup(root2, "safe"))?.id).toBeTruthy(); // gen 1 intact
    expect(await be2.lookup(root2, "doomed")).toBeNull();        // torn gen 2 discarded
    await be2.close();
  });

  it("a blob-flush failure aborts the commit and rolls the working manifest back", async () => {
    const be = await OpfsBackend.open(testRoot(), { testHooks: true });
    const root = await be.root();
    const f = ulid();
    await be.create(root, "f", f, "file");
    await be.write(f, 0, enc.encode("data"));
    const c = fault(be);
    await c("__injectFault", ["blobFlush", 0, 1]); // blob flush during commit fails
    await expect(be.flush()).rejects.toMatchObject({ errno: "ENOSPC" });
    await be.flush(); // fault consumed (times:1) → clean commit succeeds
    await be.close();
  });

  it("union GC preserves a blob still referenced by a retained (fallback) generation", async () => {
    const name = testRoot();
    const be = await OpfsBackend.open(name, { testHooks: true });
    const root = await be.root();
    const x = ulid();
    await be.create(root, "x", x, "file");
    await be.write(x, 0, enc.encode("valuable"));
    await be.flush();            // gen 1 → slot a; references x
    await be.unlink(root, "x");  // working manifest drops x (deferred delete: blob NOT removed)
    await be.flush();            // gen 2 → slot b; does NOT reference x. But gen 1 (slot a) is retained.
    await fault(be)("gc", []);   // GC must keep x's blob: gen 1 (fallback) still references it
    // x's blob is still on disk (reachable from the retained gen 1)
    const origin = await navigator.storage.getDirectory();
    const blobDir = await (await origin.getDirectoryHandle(name)).getDirectoryHandle("blobs");
    const names: string[] = [];
    for await (const n of (blobDir as unknown as { keys(): AsyncIterableIterator<string> }).keys()) names.push(n);
    expect(names.some((n) => n.startsWith(x))).toBe(true);
    await be.close();
  });
});
```

- [ ] **Step 2: Run to verify RED / discover the unlink-eager-delete gap**

Run: `pnpm turbo build --filter @wash/backend-opfs && pnpm --filter @wash/backend-opfs test:browser durability`
Expected: the first two tests FAIL until wired; the third exposes that `unlink`/`rename` delete blobs EAGERLY (in-op), which destroys data that a fallback generation still references. This is the design's union-GC requirement (spec §3.3): **blob deletion must be deferred to GC, not done in-op.**

- [ ] **Step 3: Implement the deferred-blob-delete + union-GC fix**

In worker.ts, **remove the eager `await blobs.deleteInode(...)` calls from `unlink` and `rename`** (Tasks 3 and 4). An unlinked inode simply leaves the manifest; its blobs are reclaimed by GC once no retained generation references the id. Add:

```ts
async function unionLiveIds(): Promise<Set<NodeId>> {
  const live = liveIds(mani); // working manifest
  for (const s of ["a", "b"] as const) {
    const bytes = await readSlot(s);
    if (!bytes) continue;
    const parsed = parseManifest(bytes);
    if (parsed) for (const id of Object.keys(parsed.manifest.inodes)) live.add(id);
  }
  return live;
}
```
Change the `open`-time GC and add a test/maintenance op:
```ts
  async gc(): Promise<OpResult> {
    await blobs.gc(await unionLiveIds());
    return { value: undefined };
  },
```
And in `open`, replace `await blobs.gc(liveIds(mani));` with `await blobs.gc(await unionLiveIds());` (at open, working == loaded generation; both slots contribute; correct union).

Now the third durability test passes: after the torn gen-2 write, gen 1 (referencing `x`) is retained, `x`'s blob was NOT eagerly deleted (unlink no longer deletes), and reopen restores gen 1 with `x` intact. The first two tests pass once the commit path is exercised. If the third test's comment path (eager delete) was the only failure, this removal is the whole fix.

- [ ] **Step 4: Run to verify GREEN**

Run: `pnpm turbo build --filter @wash/backend-opfs && pnpm --filter @wash/backend-opfs test:browser durability content namespace links rename shell`
Expected: PASS across all rewritten browser suites (deferred-delete must not regress unlink/rename semantics — content still reads correctly because GC only reaps ids absent from the union).

- [ ] **Step 5: Add the both-slots-corrupt → EIO test and confirm no-GC**

Append to `durability.test.ts`:
```ts
  it("both manifest slots corrupt → open rejects EIO and does NOT GC blobs", async () => {
    const name = testRoot();
    const be = await OpfsBackend.open(name);
    const root = await be.root();
    const f = ulid();
    await be.create(root, "f", f, "file");
    await be.write(f, 0, enc.encode("keep"));
    await be.flush();
    await be.close();
    const origin = await navigator.storage.getDirectory();
    const dir = await origin.getDirectoryHandle(name);
    for (const slot of ["manifest.a", "manifest.b"]) {
      const fh = await dir.getFileHandle(slot, { create: true });
      const w = await fh.createSyncAccessHandle();
      w.truncate(0); w.write(enc.encode("garbage"), { at: 0 }); w.flush(); w.close();
    }
    await expect(OpfsBackend.open(name)).rejects.toMatchObject({ errno: "EIO" });
    // blobs untouched: the file's chunk still present
    const blobDir = await dir.getDirectoryHandle("blobs");
    const names: string[] = [];
    for await (const n of (blobDir as unknown as { keys(): AsyncIterableIterator<string> }).keys()) names.push(n);
    expect(names.some((n) => n.startsWith(f))).toBe(true);
  });
```
Run: `pnpm turbo build --filter @wash/backend-opfs && pnpm --filter @wash/backend-opfs test:browser durability`
Expected: PASS (open rejects EIO before any GC; blob survives).

- [ ] **Step 6: Commit**

```bash
git add packages/backend-opfs
git commit -m "fix(backend-opfs): defer blob deletion to union GC; ordered fail-closed commit + two-generation fallback; both-corrupt → EIO no-GC"
```

---

### Task 7: dump + conformance (raw + cached) + persistence gate

**Files:**
- Modify: `packages/backend-opfs/src/worker.ts` (add `dump`)
- Test: `packages/backend-opfs/test/browser/conformance.test.ts` (rewrite), `packages/backend-opfs/test/browser/warm.test.ts` (rewrite)

**Interfaces:**
- Consumes: the complete backend; `runBackendConformance` from `@wash/vfs/conformance`; `CachedBackend` from `@wash/vfs`.
- Produces: `dump` op returning `{ inodes: {id,attrs}[], dirents: {parentId,name,childId,kind}[] }` (the `BackendDump` shape) straight from the manifest. Conformance green ×2 with **hardlink + same-inode-rename cases RUNNING** and **reserved-names SKIPPING**.

- [ ] **Step 1: Implement `dump` (add to `ops`)**

```ts
  async dump(): Promise<OpResult> {
    const inodes = Object.entries(mani.inodes).map(([id, rec]) => ({ id, attrs: attrsOf(rec) }));
    const dirents: { parentId: NodeId; name: string; childId: NodeId; kind: NodeKind }[] = [];
    for (const [parentId, entries] of Object.entries(mani.dirents)) {
      for (const [name, e] of Object.entries(entries)) {
        dirents.push({ parentId, name, childId: e.id, kind: e.kind });
      }
    }
    return { value: { inodes, dirents } };
  },
```

- [ ] **Step 2: Write conformance + warm tests**

`packages/backend-opfs/test/browser/conformance.test.ts`:
```ts
import { afterAll } from "vitest";
import { runBackendConformance } from "@wash/vfs/conformance";
import { CachedBackend, ulid } from "@wash/vfs";
import { OpfsBackend } from "@wash/backend-opfs";

const roots: string[] = [];
afterAll(async () => {
  const o = await navigator.storage.getDirectory();
  for (const n of roots.splice(0)) await o.removeEntry(n, { recursive: true }).catch(() => {});
});
function freshRoot(): string { const n = `wash-conf-${ulid()}`; roots.push(n); return n; }

runBackendConformance("OpfsBackend", () => OpfsBackend.open(freshRoot()));
runBackendConformance(
  "CachedBackend(OpfsBackend, writeback)",
  async () => new CachedBackend(await OpfsBackend.open(freshRoot()), { flushDelayMs: 1 }),
);
```

`packages/backend-opfs/test/browser/warm.test.ts`:
```ts
import { describe, it, expect, afterEach } from "vitest";
import { OpfsBackend } from "@wash/backend-opfs";
import { CachedBackend, ulid } from "@wash/vfs";
const roots: string[] = [];
function testRoot(): string { const n = `wash-test-${ulid()}`; roots.push(n); return n; }
afterEach(async () => {
  const o = await navigator.storage.getDirectory();
  for (const n of roots.splice(0)) await o.removeEntry(n, { recursive: true }).catch(() => {});
});

describe("OpfsBackend dump + warm", () => {
  it("dump round-trips the namespace into a warm cache", async () => {
    const be = await OpfsBackend.open(testRoot());
    const root = await be.root();
    const d = ulid();
    await be.create(root, "src", d, "dir");
    for (let i = 0; i < 10; i++) await be.create(d, `f${i}.ts`, ulid(), "file");
    await be.symlink(root, "ln", ulid(), "/src/f0.ts");
    const dump = await be.dump();
    expect(dump.inodes.length).toBe(13); // root + dir + 10 files + symlink
    expect(dump.dirents.length).toBe(12);
    const cached = new CachedBackend(be);
    cached.warm(dump);
    expect((await cached.readdir(d)).length).toBe(10);
    expect((await cached.lookup(root, "src"))?.id).toBe(d);
    expect(await cached.lookup(d, "nope")).toBeNull();
    await be.close();
  });
});
```

- [ ] **Step 3: Iterate to green — every conformance failure is a backend bug**

Run: `pnpm turbo build --filter @wash/backend-opfs && pnpm --filter @wash/backend-opfs test:browser conformance warm`
Expected: eventually PASS — conformance ×2 green; the **hardlink** and **same-inode-rename** cases RUN and pass (caps `hardlinks:true`); the **reserved-names** case SKIPS (`reservedNames:[]`). Fix any backend nonconformance in worker.ts; do not modify the suite. Note skip counts in the commit.

- [ ] **Step 4: Full gate (both browser suites + node)**

Run: `pnpm turbo build test typecheck --filter @wash/backend-opfs && pnpm --filter @wash/backend-opfs test:browser && pnpm --filter @wash/backend-indexeddb test:browser`
Expected: all green (the vfs `EIO` errno addition must not disturb the IDB suite).

- [ ] **Step 5: Commit**

```bash
git add packages/backend-opfs
git commit -m "test(backend-opfs): dump + conformance green (raw + cached) in Chromium; hardlink/same-inode run, reserved-names skip"
```

---

### Task 8: Integration test, README, exit gate

**Files:**
- Test: `packages/backend-opfs/test/browser/integration.test.ts` (rewrite)
- Modify: `packages/backend-opfs/README.md`

**Interfaces:**
- Consumes: everything.
- Produces: end-to-end `Vfs`+`CachedBackend`+`OpfsBackend` proof; updated README; the Plan exit gate.

- [ ] **Step 1: Write the integration test**

`packages/backend-opfs/test/browser/integration.test.ts`:
```ts
import { describe, it, expect, afterEach } from "vitest";
import { Vfs, CachedBackend, MemoryBackend, ulid } from "@wash/vfs";
import { OpfsBackend } from "@wash/backend-opfs";
const roots: string[] = [];
function testRoot(): string { const n = `wash-test-${ulid()}`; roots.push(n); return n; }
afterEach(async () => {
  const o = await navigator.storage.getDirectory();
  for (const n of roots.splice(0)) await o.removeEntry(n, { recursive: true }).catch(() => {});
});

describe("Vfs + CachedBackend + OpfsBackend (manifest) end-to-end", () => {
  it("full session, reload with warming, contents + modes + hardlink intact", async () => {
    const name = testRoot();
    const be1 = await OpfsBackend.open(name);
    const vfs1 = new Vfs();
    await vfs1.mount("/", new CachedBackend(be1, { flushDelayMs: 60_000 }));
    await vfs1.mkdir("/project/src", { recursive: true });
    await vfs1.writeFile("/project/src/index.ts", "export const x = 1;\n");
    await vfs1.appendFile("/project/src/index.ts", "export const y = 2;\n");
    await vfs1.chmod("/project/src/index.ts", 0o755);
    await vfs1.link("/project/src/index.ts", "/project/hardlink.ts"); // hardlinks now supported
    await vfs1.symlink("/project/src/index.ts", "/project/main");
    await vfs1.rename("/project/src", "/project/lib"); // O(1) atomic dir rename
    await vfs1.fsync();
    await be1.close();

    const be2 = await OpfsBackend.open(name);
    const cached2 = new CachedBackend(be2, { flushDelayMs: 60_000 });
    cached2.warm(await be2.dump());
    const vfs2 = new Vfs();
    await vfs2.mount("/", cached2);
    expect(await vfs2.readTextFile("/project/lib/index.ts")).toBe("export const x = 1;\nexport const y = 2;\n");
    expect((await vfs2.stat("/project/lib/index.ts")).mode).toBe(0o755);
    expect(await vfs2.readTextFile("/project/hardlink.ts")).toBe("export const x = 1;\nexport const y = 2;\n");
    expect(await vfs2.readlink("/project/main")).toBe("/project/src/index.ts"); // POSIX stale path
    expect((await vfs2.stat("/project/lib/index.ts")).nlink).toBe(2);
    await be2.close();
  });

  it("EXDEV across a memory mount and an OPFS mount", async () => {
    const be = await OpfsBackend.open(testRoot());
    const vfs = new Vfs();
    await vfs.mount("/", new MemoryBackend());
    await vfs.mkdir("/opfs");
    await vfs.mount("/opfs", new CachedBackend(be, { flushDelayMs: 1 }));
    await vfs.writeFile("/local.txt", "x");
    await expect(vfs.rename("/local.txt", "/opfs/moved.txt")).rejects.toMatchObject({ errno: "EXDEV" });
    await vfs.writeFile("/opfs/direct.txt", "y");
    await vfs.fsync();
    expect(await vfs.readTextFile("/opfs/direct.txt")).toBe("y");
    await be.close();
  });
});
```

- [ ] **Step 2: Run to verify pass**

Run: `pnpm turbo build --filter @wash/backend-opfs && pnpm --filter @wash/backend-opfs test:browser integration`
Expected: PASS directly if Tasks 2–7 compose; any failure is a real integration bug (most likely flush/close ordering or the union-GC interaction) — fix in worker.ts.

- [ ] **Step 3: Rewrite the README**

`packages/backend-opfs/README.md` — reflect the manifest model: what the package is (OPFS backend for `@wash/vfs`, **the intended default backend**; spec §pointer to `docs/superpowers/specs/2026-07-14-opfs-manifest-backend-design.md`); the architecture (id-addressed blob store `blobs/<inodeId>.<chunk>` never moved; two-generation A/B manifest committed via sync access handles; fully-synchronous worker, no `createWritable`; single-writer Web Lock); a 12-line usage example (open → `CachedBackend` → `warm(await be.dump())` → mount); the caps table (hardlinks, atomic O(1) dir rename, no reserved names); the honest scaling note (durable commit is O(manifest size) per flush batch; size-guard threshold; log+checkpoint deferred); browser requirements (OPFS + sync access handles: Chromium/Firefox 111+/Safari 15.2+ — cite what you verify); how to run tests (`test:browser`, `pnpm exec playwright install chromium`; Node tests cover the manifest pure core).

- [ ] **Step 4: Exit gate**

Run: `pnpm turbo build test typecheck && pnpm --filter @wash/backend-opfs test:browser && pnpm --filter @wash/backend-indexeddb test:browser`
Expected: everything green in Node AND Chromium.

- [ ] **Step 5: Commit**

```bash
git add packages/backend-opfs
git commit -m "feat(backend-opfs): end-to-end integration test and manifest-model README"
```

---

### Task 9: apps/bench — chunk-size sweep + manifest scaling curve

**Files:**
- Modify: `apps/bench/bench/backends.bench.ts` (add OPFS-manifest cases behind the fake-OPFS caveat, or a browser-bench note), `apps/bench/README.md`

**Interfaces:**
- Consumes: `@wash/backend-opfs`.
- Produces: the chunk-size sweep and the manifest-size scaling curve the spec §7 requires, and the size-guard threshold set from it.

- [ ] **Step 1: Add the benches**

Extend `apps/bench/bench/backends.bench.ts` with, guarded for environments where OPFS exists (the Node bench uses fake-indexeddb, not OPFS — so the OPFS-manifest sweep is a **browser-bench**; if the bench harness is Node-only, add the cases to a new `apps/bench/bench/opfs.browser.bench.ts` run via the backend-opfs browser config, and note in the README that OPFS numbers require the browser path):
```ts
// Manifest-size scaling: namespace-mutation cost vs file count.
for (const N of [100, 1000, 10000]) {
  bench(`OPFS manifest: create+flush ${N} files then one more rename`, async () => {
    const be = await OpfsBackend.open(`bench-${ulid()}`);
    const root = await be.root();
    const d = ulid();
    await be.create(root, "d", d, "dir");
    for (let i = 0; i < N; i++) await be.create(d, `f${i}`, ulid(), "file");
    await be.flush(); // one whole-manifest write of N entries
    const t = ulid();
    await be.create(d, "extra", t, "file");
    await be.rename(d, "extra", d, "renamed"); // O(1) op; flush is O(manifest)
    await be.flush();
    await be.close();
  });
}
// Chunk-size sweep: 1 MiB write+read across candidate chunk sizes.
for (const kib of [16, 64, 256]) {
  bench(`OPFS chunkSize ${kib} KiB: 1 MiB write+read`, async () => {
    const be = await OpfsBackend.open(`sweep-${ulid()}`, { chunkSize: kib * 1024 } as never);
    const root = await be.root();
    const id = ulid();
    await be.create(root, "blob", id, "file");
    const payload = new Uint8Array(1024 * 1024);
    await be.write(id, 0, payload);
    await be.read(id, 0, payload.byteLength);
    await be.flush();
    await be.close();
  });
}
```
(If `OpfsBackendOptions` lacks `chunkSize`, add it in `client.ts`/`worker.ts` `open` args like the IDB backend's `chunkSize` option, and thread it into `new BlobStore(blobDir, poolSize, chunkSize)`.)

- [ ] **Step 2: Run the bench, record results**

Run: `pnpm --filter bench bench` (Node/relative) and/or the browser-bench path.
Expected: ops/sec for each case; fill the `apps/bench/README.md` table with the manifest scaling curve and chunk sweep, and record the chosen default chunk size + the size-guard threshold (the file count at which per-flush manifest write latency crosses an acceptability line, e.g. > ~16 ms).

- [ ] **Step 3: Set the size-guard threshold**

In `worker.ts`, add the one-time size-guard warning in `writeGeneration` using the benched threshold:
```ts
  if (bytes.byteLength > MANIFEST_SIZE_WARN_BYTES && !warnedManifestSize) {
    warnedManifestSize = true;
    console.warn(`[wash-opfs] manifest is ${bytes.byteLength} bytes; per-flush rewrite cost is O(size). Consider fewer files or a future log+checkpoint manifest.`);
  }
```
with `let warnedManifestSize = false;` and `const MANIFEST_SIZE_WARN_BYTES` set to the benched value at module scope. Default it to `2 * 1024 * 1024` (2 MiB — roughly a 15–20k-entry manifest) if Step 2's bench does not indicate a lower acceptability line; adjust to the actual crossover the bench reveals.

- [ ] **Step 4: Pipeline green**

Run: `pnpm turbo build test typecheck`
Expected: green.

- [ ] **Step 5: Commit + re-point PR #3**

```bash
git add apps/bench packages/backend-opfs
git commit -m "feat(bench): OPFS manifest scaling curve + chunk sweep; set size-guard threshold"
git push  # updates PR #3 (feat/backend-opfs) with the manifest-model rewrite
```

---

## Exit criteria

- `pnpm turbo build test typecheck` green from clean; `@wash/backend-opfs test:browser` green in Chromium; `@wash/backend-indexeddb test:browser` unaffected.
- Conformance green (raw + `CachedBackend`) with **hardlink + same-inode-rename running** and **reserved-names skipping**.
- Persistence: namespace, content, symlinks, hardlinks, modes survive close/reopen via manifest load; directory rename is O(1), atomic, id-stable.
- Durability (fault-injected): a torn manifest-slot write falls back to the prior generation; a blob-flush failure aborts the commit and rolls the working manifest back; both slots corrupt → open rejects `EIO` and performs NO GC; union GC preserves blobs reachable from the fallback generation.
- Single-writer: a second `OpfsBackend.open()` of a mounted root gets `EBUSY`.
- `dump()`/`warm()` end-to-end; `apps/bench` reports the manifest scaling curve + chunk sweep; the size-guard threshold is set from it.
- `src/sidecar.ts` and all shadow/`physDir`/generation-swap machinery are gone; PR #3 updated.

## Not in scope (per spec §11)

- Log+checkpoint manifest for very large trees (the deferred scaling lever; v1 writes a whole generation per flush batch).
- Migration from the old path-transparent/sidecar format (clean break).
- The CachedBackend failed-flush reconciliation / fsync-strict contract change (tracked pre-Plan-4 item) — the F1 dequeued-prefix cache/backend convergence depends on it, identical to the IDB backend's declared dependency.
- Concurrent multi-writer support (the Web Lock fails the second writer fast).
