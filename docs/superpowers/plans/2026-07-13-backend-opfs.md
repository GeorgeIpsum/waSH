# waSH Plan 3: @wash/backend-opfs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@wash/backend-opfs` — the Origin Private File System backend per spec §6, intended to become the **default** waSH backend (the `wash` package in Plan 6 will mount OPFS by default with IndexedDB as fallback) — conformance-green in real Chromium.

**Architecture:** `OpfsBackend` (implements `WashBackend`) is a thin async RPC client; ALL filesystem state lives in a backend-owned **storage worker** (`FileSystemSyncAccessHandle` is worker-only): the session-scoped NodeId→handle tables, the per-directory dentry maps, the lazily-loaded `.wash-attrs` sidecar cache, and a bounded LRU pool of open sync handles. The worker processes ops **strictly sequentially** (a promise chain), which gives raw-backend mutation atomicity for free (the class of concurrent-create/RMW findings Codex raised on the IDB backend cannot occur). Directory rename is the spec's documented recursive fallback (`renameCost: "subtree"`, non-atomic) with NodeIds rebound during the move so caller-visible ids stay stable. `.wash-attrs` is the first real consumer of `caps.reservedNames`: hidden from reads, `EPERM` on user mutation — the conformance suite's reserved-names case finally runs instead of skipping.

**Tech Stack:** TypeScript strict/ESM, zero runtime deps beyond `@wash/vfs` (workspace), Web Worker + MessageChannel-style RPC over `postMessage` with transferable buffers, vitest browser mode + Playwright Chromium (the Plan-2 rig pattern). Node vitest only for the two pure modules (sidecar codec, LRU).

## Global Constraints

- Caps exactly: `{ symlinks: "supported", hardlinks: false, atomicDirRename: false, renameCost: "subtree", reservedNames: [".wash-attrs"] }`.
- **Browser-first testing:** OPFS does not exist in Node. All behavioral tests run under `test:browser` (Chromium, headless, Playwright provider — same rig as `@wash/backend-indexeddb`). Browser tests import the **built package** (`@wash/backend-opfs`, resolved to `dist/` via exports; `test:browser` `dependsOn ^build`) — NOT `../src` — so Vite never has to transform the worker-URL construction and we always test the shippable artifact. Node tests (`test/node/`) cover only `sidecar.ts` and `lru.ts` (pure logic, imported from `../../src/`).
- The worker is emitted by plain `tsc` as `dist/worker.js`; the client constructs it with `new Worker(new URL("./worker.js", import.meta.url), { type: "module" })` — the standard bundler-visible pattern.
- **Worker op discipline:** ops execute strictly sequentially via a promise chain (`chain = chain.then(...)`); handlers never post out-of-order responses. Errors cross the RPC boundary as `{ errno, path, message }` and are reconstructed as `VfsError` client-side.
- NodeIds: minted by the caller for `create`/`symlink` (contract); minted by the worker (`ulid`) for entries discovered on disk. Ids are **session-scoped** and stable for the mount lifetime, including across `rename` (subtree moves rebind handles, never ids).
- Sidecar `.wash-attrs`: per-directory JSON, deviations-only (`{ [name]: { mode?, symlink? } }`); a directory containing only its sidecar counts as **empty** for `unlink`/`rmdir`/rename-overwrite purposes; the sidecar file is removed when its object becomes empty.
- Known & documented OPFS limitations (accepted per spec §6): explicit `utimes` on files persist only for the session (reopen re-reads `File.lastModified`); directory mtimes are session-scoped; hardlinks unsupported (`link` absent, suite cases skip); directory rename is non-atomic.
- POSIX parity oracle: the `@wash/vfs/conformance` suite (capability-gated), plus errno mapping — `NotFoundError→ENOENT`, `InvalidModificationError→ENOTEMPTY`, `NoModificationAllowedError→EBUSY`, `TypeMismatchError→ENOTDIR`, `QuotaExceededError→ENOSPC` (**new Errno member added in Task 1**). Zero-length writes are POSIX no-ops.
- Zero runtime dependencies; ESM-only, TS strict, ES2022; conventional commits after every green cycle.
- Browser tests create ulid-named OPFS root directories and remove them in `afterEach`/`afterAll` (`navigator.storage.getDirectory()` → `removeEntry(name, { recursive: true })`) so origin storage never accumulates.

---

### Task 1: Scaffold, RPC plumbing, minimal client+worker (open/root/getattr/close), browser rig

**Files:**
- Create: `packages/backend-opfs/package.json`, `packages/backend-opfs/tsconfig.json`, `packages/backend-opfs/vitest.config.ts`, `packages/backend-opfs/vitest.browser.config.ts`, `packages/backend-opfs/src/rpc.ts`, `packages/backend-opfs/src/client.ts`, `packages/backend-opfs/src/worker.ts`, `packages/backend-opfs/src/index.ts`
- Modify: `packages/vfs/src/errors.ts` (add `"ENOSPC"` to the `Errno` union)
- Test: `packages/backend-opfs/test/browser/shell.test.ts`

**Interfaces:**
- Consumes: `@wash/vfs` types (`WashBackend`, `BackendCaps`, `Attrs`, `Dirent`, `NodeId`, `NodeInfo`, `NodeKind`, `BackendDump`, `VfsError`, `ulid`), the Plan-2 browser-rig conventions.
- Produces (all later tasks build on these): `rpc.ts` message types; `OpfsBackend` with `static async open(rootDirName: string, opts?: OpfsBackendOptions): Promise<OpfsBackend>` (`OpfsBackendOptions = { handlePoolSize?: number }`), `close(): Promise<void>`, `root()`, `getattr()`, RPC `call(op, args, transfer?)`; worker skeleton with the sequential op chain, the `nodes: Map<NodeId, NodeRec>` table, `errnoFromDom`, and op registry `ops: Record<string, (...args) => Promise<{ value: unknown; transfer?: Transferable[] } | { value: unknown }>>` where unimplemented ops throw `ENOSYS`.

- [ ] **Step 1: Create package files**

`packages/backend-opfs/package.json`:
```json
{
  "name": "@wash/backend-opfs",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:browser": "vitest run --config vitest.browser.config.ts",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@wash/vfs": "workspace:^"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "3.2.7",
    "@vitest/browser": "3.2.7",
    "playwright": "^1.49.0",
    "@types/node": "^22.0.0"
  }
}
```
(Pin `vitest`/`@vitest/browser` in lockstep exactly as `backend-indexeddb` does — copy its pinned versions if they differ from the above; check its package.json first.)

`packages/backend-opfs/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src", "lib": ["ES2022", "DOM", "DOM.Iterable", "WebWorker"] },
  "include": ["src"]
}
```

`packages/backend-opfs/vitest.config.ts` (Node — pure modules only, later tasks add the files):
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { environment: "node", include: ["test/node/**/*.test.ts"] },
});
```

`packages/backend-opfs/vitest.browser.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["test/browser/**/*.test.ts"],
    browser: {
      enabled: true,
      headless: true,
      provider: "playwright",
      instances: [{ browser: "chromium" }],
    },
  },
});
```
(Adapt the `instances` form to whatever `backend-indexeddb/vitest.browser.config.ts` uses — copy it.)

- [ ] **Step 2: Add ENOSPC to the contract errno union**

In `packages/vfs/src/errors.ts`, extend the `Errno` union with `| "ENOSPC"` (quota exhaustion; the OPFS and IDB backends map `QuotaExceededError` to it).

- [ ] **Step 3: Write the RPC types and minimal client/worker**

`packages/backend-opfs/src/rpc.ts`:
```ts
import type { Errno } from "@wash/vfs";

export interface RpcRequest {
  id: number;
  op: string;
  args: unknown[];
}

export interface RpcOk {
  id: number;
  ok: true;
  value: unknown;
}

export interface RpcErr {
  id: number;
  ok: false;
  errno?: Errno;
  path?: string;
  message: string;
}

export type RpcResponse = RpcOk | RpcErr;
```

`packages/backend-opfs/src/client.ts`:
```ts
import type {
  Attrs, BackendCaps, BackendDump, Dirent, NodeId, NodeInfo, NodeKind, WashBackend,
} from "@wash/vfs";
import { VfsError } from "@wash/vfs";
import type { RpcRequest, RpcResponse } from "./rpc.js";

export const SIDECAR_NAME = ".wash-attrs";

export interface OpfsBackendOptions {
  handlePoolSize?: number;
}

export class OpfsBackend implements WashBackend {
  readonly caps: BackendCaps = {
    symlinks: "supported",
    hardlinks: false,
    atomicDirRename: false,
    renameCost: "subtree",
    reservedNames: [SIDECAR_NAME],
  };

  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private rootId: NodeId = "";

  private constructor(private readonly worker: Worker) {
    worker.onmessage = (ev: MessageEvent<RpcResponse>) => this.dispatch(ev.data);
  }

  static async open(rootDirName: string, opts: OpfsBackendOptions = {}): Promise<OpfsBackend> {
    const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    const be = new OpfsBackend(worker);
    be.rootId = (await be.call("open", [rootDirName, opts.handlePoolSize ?? 64])) as NodeId;
    return be;
  }

  private dispatch(res: RpcResponse): void {
    const entry = this.pending.get(res.id);
    if (!entry) return;
    this.pending.delete(res.id);
    if (res.ok) entry.resolve(res.value);
    else entry.reject(res.errno ? new VfsError(res.errno, res.path) : new Error(res.message));
  }

  private call(op: string, args: unknown[], transfer: Transferable[] = []): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, op, args } satisfies RpcRequest, transfer);
    });
  }

  async close(): Promise<void> {
    await this.call("close", []);
    this.worker.terminate();
  }

  async root(): Promise<NodeId> {
    return this.rootId;
  }

  async getattr(id: NodeId): Promise<Attrs> {
    return (await this.call("getattr", [id])) as Attrs;
  }

  async lookup(parent: NodeId, name: string): Promise<NodeInfo | null> {
    return (await this.call("lookup", [parent, name])) as NodeInfo | null;
  }

  async readdir(id: NodeId): Promise<Dirent[]> {
    return (await this.call("readdir", [id])) as Dirent[];
  }

  async setattr(id: NodeId, attrs: Partial<Pick<Attrs, "mode" | "mtimeMs" | "ctimeMs">>): Promise<void> {
    await this.call("setattr", [id, attrs]);
  }

  async create(parent: NodeId, name: string, id: NodeId, kind: NodeKind, attrs?: Partial<Attrs>): Promise<void> {
    await this.call("create", [parent, name, id, kind, attrs]);
  }

  async unlink(parent: NodeId, name: string): Promise<void> {
    await this.call("unlink", [parent, name]);
  }

  async rename(fromParent: NodeId, fromName: string, toParent: NodeId, toName: string): Promise<void> {
    await this.call("rename", [fromParent, fromName, toParent, toName]);
  }

  async read(id: NodeId, offset: number, length: number): Promise<Uint8Array> {
    const buf = (await this.call("read", [id, offset, length])) as ArrayBuffer;
    return new Uint8Array(buf);
  }

  async write(id: NodeId, offset: number, data: Uint8Array): Promise<void> {
    const copy = data.slice(); // caller may reuse its buffer; transfer a private copy
    await this.call("write", [id, offset, copy.buffer], [copy.buffer]);
  }

  async truncate(id: NodeId, size: number): Promise<void> {
    await this.call("truncate", [id, size]);
  }

  async symlink(parent: NodeId, name: string, id: NodeId, target: string): Promise<void> {
    await this.call("symlink", [parent, name, id, target]);
  }

  async readlink(id: NodeId): Promise<string> {
    return (await this.call("readlink", [id])) as string;
  }

  async dump(): Promise<BackendDump> {
    return (await this.call("dump", [])) as BackendDump;
  }

  async flush(): Promise<void> {
    await this.call("flush", []);
  }
}
```
(No `link` method — `caps.hardlinks: false`.)

`packages/backend-opfs/src/worker.ts` (Task-1 skeleton; later tasks replace the ENOSYS stubs):
```ts
/// <reference lib="webworker" />
import type { Attrs, NodeId, NodeKind } from "@wash/vfs";
import { VfsError, ulid } from "@wash/vfs";
import type { RpcRequest, RpcResponse } from "./rpc.js";

export const SIDECAR_NAME = ".wash-attrs";

interface NodeRec {
  kind: NodeKind;
  parentId: NodeId | null; // null only for the mount root
  name: string; // "" for the root
  dir?: FileSystemDirectoryHandle; // dirs
  file?: FileSystemFileHandle; // files and symlink marker files
  target?: string; // symlinks
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
  children?: Map<string, { id: NodeId; kind: NodeKind }>; // dirs (excludes the sidecar)
  childrenComplete?: boolean;
  sidecar?: Record<string, { mode?: number; symlink?: string }>; // dirs, lazy
}

const nodes = new Map<NodeId, NodeRec>();
let rootId: NodeId = "";
let poolSize = 64;

function defaultMode(kind: NodeKind): number {
  return kind === "dir" ? 0o755 : kind === "symlink" ? 0o777 : 0o644;
}

function node(id: NodeId): NodeRec {
  const rec = nodes.get(id);
  if (!rec) throw new VfsError("ENOENT");
  return rec;
}

export function errnoFromDom(e: unknown, path?: string): never {
  const name = (e as { name?: string } | null)?.name;
  if (name === "NotFoundError") throw new VfsError("ENOENT", path);
  if (name === "InvalidModificationError") throw new VfsError("ENOTEMPTY", path);
  if (name === "NoModificationAllowedError") throw new VfsError("EBUSY", path);
  if (name === "TypeMismatchError") throw new VfsError("ENOTDIR", path);
  if (name === "QuotaExceededError") throw new VfsError("ENOSPC", path);
  throw e;
}

type OpResult = { value: unknown; transfer?: Transferable[] };
type OpFn = (...args: never[]) => Promise<OpResult>;

const ops: Record<string, OpFn> = {
  async open(rootDirName: string, poolSizeOpt: number): Promise<OpResult> {
    poolSize = poolSizeOpt;
    const origin = await navigator.storage.getDirectory();
    const dir = await origin.getDirectoryHandle(rootDirName, { create: true });
    rootId = ulid();
    const now = Date.now();
    nodes.set(rootId, {
      kind: "dir", parentId: null, name: "", dir,
      mode: 0o755, mtimeMs: now, ctimeMs: now,
    });
    return { value: rootId };
  },

  async getattr(id: NodeId): Promise<OpResult> {
    const rec = node(id);
    const attrs = await attrsOf(rec);
    return { value: attrs };
  },

  async flush(): Promise<OpResult> {
    return { value: undefined }; // pooled-handle flushing arrives in Task 5
  },

  async close(): Promise<OpResult> {
    return { value: undefined }; // pool teardown arrives in Task 5
  },
};

async function attrsOf(rec: NodeRec): Promise<Attrs> {
  let size = 0;
  let mtimeMs = rec.mtimeMs;
  if (rec.kind === "file" && rec.file) {
    const f = await rec.file.getFile();
    size = f.size;
    mtimeMs = rec.mtimeMs > f.lastModified ? rec.mtimeMs : f.lastModified;
  } else if (rec.kind === "symlink") {
    size = rec.target?.length ?? 0;
  }
  return { kind: rec.kind, size, mode: rec.mode, mtimeMs, ctimeMs: rec.ctimeMs, nlink: 1 };
}

function ensure(op: string): OpFn {
  const fn = ops[op];
  if (fn) return fn;
  return async () => {
    throw new VfsError("ENOSYS", op);
  };
}

let chain: Promise<void> = Promise.resolve();

self.onmessage = (ev: MessageEvent<RpcRequest>) => {
  const req = ev.data;
  chain = chain
    .then(async () => {
      try {
        const result = await ensure(req.op)(...(req.args as never[]));
        const res: RpcResponse = { id: req.id, ok: true, value: result.value };
        (self as unknown as Worker).postMessage(res, { transfer: result.transfer ?? [] });
      } catch (e) {
        const res: RpcResponse = {
          id: req.id,
          ok: false,
          errno: e instanceof VfsError ? e.errno : undefined,
          path: e instanceof VfsError ? e.path : undefined,
          message: e instanceof Error ? e.message : String(e),
        };
        (self as unknown as Worker).postMessage(res);
      }
    })
    .catch(() => {});
};

export { nodes, node, attrsOf, ops, defaultMode };
```

`packages/backend-opfs/src/index.ts`:
```ts
export { OpfsBackend, SIDECAR_NAME } from "./client.js";
export type { OpfsBackendOptions } from "./client.js";
```

- [ ] **Step 4: Write the failing browser smoke test**

`packages/backend-opfs/test/browser/shell.test.ts`:
```ts
import { describe, it, expect, afterEach } from "vitest";
import { OpfsBackend, SIDECAR_NAME } from "@wash/backend-opfs";
import { ulid } from "@wash/vfs";

const roots: string[] = [];
export function testRoot(): string {
  const name = `wash-test-${ulid()}`;
  roots.push(name);
  return name;
}
afterEach(async () => {
  const origin = await navigator.storage.getDirectory();
  for (const name of roots.splice(0)) {
    await origin.removeEntry(name, { recursive: true }).catch(() => {});
  }
});

describe("OpfsBackend shell", () => {
  it("opens, exposes a dir root, and closes", async () => {
    const be = await OpfsBackend.open(testRoot());
    const root = await be.root();
    const attrs = await be.getattr(root);
    expect(attrs.kind).toBe("dir");
    expect(attrs.mode).toBe(0o755);
    expect(attrs.nlink).toBe(1);
    await be.close();
  });

  it("declares the required caps", async () => {
    const be = await OpfsBackend.open(testRoot());
    expect(be.caps).toEqual({
      symlinks: "supported",
      hardlinks: false,
      atomicDirRename: false,
      renameCost: "subtree",
      reservedNames: [SIDECAR_NAME],
    });
    await be.close();
  });

  it("unimplemented ops reject with ENOSYS across the RPC boundary", async () => {
    const be = await OpfsBackend.open(testRoot());
    await expect(be.readdir(await be.root())).rejects.toMatchObject({ errno: "ENOSYS" });
    await be.close();
  });
});
```
(Note: this file exports `testRoot` — later browser test files copy the same tiny helper block locally rather than importing across test files; duplication of 10 setup lines beats cross-file test coupling.)

- [ ] **Step 5: Install, build, run**

Run: `pnpm install && pnpm turbo build && pnpm --filter @wash/backend-opfs test:browser`
Expected: first run FAILS while wiring is incomplete; iterate until the 3 smoke tests PASS in Chromium. Then `pnpm turbo build test typecheck` (Node suite is empty for this package until Task 2 — vitest exits green on no tests with `--passWithNoTests`; add that flag to the `test` script if vitest errors on empty).

Known wiring risk to expect here: `dist/worker.js` contains a bare `import ... from "@wash/vfs"`. Vite (which serves vitest browser mode) processes linked workspace packages through its transform pipeline and bundles `new Worker(new URL("./worker.js", import.meta.url))` targets, so this normally Just Works. If the worker fails to boot with a module-resolution error instead: (a) try adding `optimizeDeps.exclude: ["@wash/backend-opfs", "@wash/vfs"]` / `server.fs.allow` tweaks in `vitest.browser.config.ts`; (b) if Vite still won't bundle the worker's bare import, make `worker.ts` self-contained — inline the tiny bits it uses from `@wash/vfs` (`VfsError`, `ulid` are both < 30 lines; types are erased) and drop the import. Option (b) is an acceptable permanent shape (document it in the README if taken); do NOT add a bundler devDependency for this.

- [ ] **Step 6: Commit**

```bash
git add packages/backend-opfs packages/vfs/src/errors.ts pnpm-lock.yaml
git commit -m "feat(backend-opfs): scaffold, worker RPC plumbing, browser rig, ENOSPC errno"
```

---

### Task 2: Pure modules — sidecar codec and LRU handle pool (Node-tested)

**Files:**
- Create: `packages/backend-opfs/src/sidecar.ts`, `packages/backend-opfs/src/lru.ts`
- Test: `packages/backend-opfs/test/node/sidecar.test.ts`, `packages/backend-opfs/test/node/lru.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `sidecar.ts`: `type SidecarEntry = { mode?: number; symlink?: string }`, `type Sidecar = Record<string, SidecarEntry>`, `parseSidecar(text: string): Sidecar` (tolerates empty/corrupt input → `{}`), `serializeSidecar(s: Sidecar): string`, `setSidecarEntry(s: Sidecar, name: string, patch: SidecarEntry): Sidecar` (merges; drops keys set to `undefined`; deletes the name when its entry becomes empty), `renameSidecarEntry(s: Sidecar, from: string, to: string): Sidecar`, `isEmptySidecar(s: Sidecar): boolean`.
  - `lru.ts`: `class Lru<K, V> { constructor(capacity: number, onEvict: (k: K, v: V) => void); get(k): V | undefined; set(k, v): void; delete(k, callEvict?: boolean): void; clear(callEvict?: boolean): void; get size(): number; keys(): IterableIterator<K> }` — `get` refreshes recency; `set` evicts least-recent past capacity via `onEvict`.

- [ ] **Step 1: Write the failing tests**

`packages/backend-opfs/test/node/sidecar.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  parseSidecar, serializeSidecar, setSidecarEntry, renameSidecarEntry, isEmptySidecar,
} from "../../src/sidecar.js";

describe("sidecar codec", () => {
  it("round-trips and tolerates garbage", () => {
    const s = setSidecarEntry({}, "f.txt", { mode: 0o755 });
    expect(parseSidecar(serializeSidecar(s))).toEqual({ "f.txt": { mode: 0o755 } });
    expect(parseSidecar("")).toEqual({});
    expect(parseSidecar("not json{{{")).toEqual({});
    expect(parseSidecar("[1,2,3]")).toEqual({});
  });

  it("merges patches and drops empty entries", () => {
    let s = setSidecarEntry({}, "ln", { symlink: "/target" });
    s = setSidecarEntry(s, "ln", { mode: 0o700 });
    expect(s.ln).toEqual({ symlink: "/target", mode: 0o700 });
    s = setSidecarEntry(s, "ln", { symlink: undefined, mode: undefined });
    expect(s.ln).toBeUndefined();
    expect(isEmptySidecar(s)).toBe(true);
  });

  it("renames entries", () => {
    const s = renameSidecarEntry(setSidecarEntry({}, "a", { mode: 0o700 }), "a", "b");
    expect(s).toEqual({ b: { mode: 0o700 } });
    expect(renameSidecarEntry({}, "ghost", "x")).toEqual({});
  });
});
```

`packages/backend-opfs/test/node/lru.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { Lru } from "../../src/lru.js";

describe("Lru", () => {
  it("evicts least-recently-used past capacity, calling onEvict", () => {
    const evicted: string[] = [];
    const lru = new Lru<string, number>(2, (k) => evicted.push(k));
    lru.set("a", 1);
    lru.set("b", 2);
    expect(lru.get("a")).toBe(1); // refresh a
    lru.set("c", 3); // evicts b, not a
    expect(evicted).toEqual(["b"]);
    expect(lru.get("b")).toBeUndefined();
    expect([...lru.keys()].sort()).toEqual(["a", "c"]);
  });

  it("delete and clear control eviction callbacks explicitly", () => {
    const onEvict = vi.fn();
    const lru = new Lru<string, number>(4, onEvict);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.delete("a"); // silent
    lru.delete("b", true); // calls onEvict
    expect(onEvict).toHaveBeenCalledTimes(1);
    lru.set("c", 3);
    lru.clear(true);
    expect(onEvict).toHaveBeenCalledTimes(2);
    expect(lru.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @wash/backend-opfs test`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement**

`packages/backend-opfs/src/sidecar.ts`:
```ts
export interface SidecarEntry {
  mode?: number;
  symlink?: string;
}

export type Sidecar = Record<string, SidecarEntry>;

export function parseSidecar(text: string): Sidecar {
  if (!text.trim()) return {};
  try {
    const v: unknown = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return v as Sidecar;
  } catch {
    return {};
  }
}

export function serializeSidecar(s: Sidecar): string {
  return JSON.stringify(s);
}

export function setSidecarEntry(s: Sidecar, name: string, patch: SidecarEntry): Sidecar {
  const next: Sidecar = { ...s };
  const merged: SidecarEntry = { ...(next[name] ?? {}), ...patch };
  for (const key of Object.keys(merged) as (keyof SidecarEntry)[]) {
    if (merged[key] === undefined) delete merged[key];
  }
  if (Object.keys(merged).length === 0) delete next[name];
  else next[name] = merged;
  return next;
}

export function renameSidecarEntry(s: Sidecar, from: string, to: string): Sidecar {
  if (!(from in s)) return { ...s };
  const next: Sidecar = { ...s };
  const entry = next[from]!;
  delete next[from];
  next[to] = entry;
  return next;
}

export function isEmptySidecar(s: Sidecar): boolean {
  return Object.keys(s).length === 0;
}
```

`packages/backend-opfs/src/lru.ts`:
```ts
/** Bounded most-recently-used map; Map iteration order provides recency. */
export class Lru<K, V> {
  private map = new Map<K, V>();

  constructor(
    private readonly capacity: number,
    private readonly onEvict: (k: K, v: V) => void,
  ) {}

  get size(): number {
    return this.map.size;
  }

  get(k: K): V | undefined {
    if (!this.map.has(k)) return undefined;
    const v = this.map.get(k)!;
    this.map.delete(k);
    this.map.set(k, v);
    return v;
  }

  set(k: K, v: V): void {
    this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.capacity) {
      const [oldK, oldV] = this.map.entries().next().value as [K, V];
      this.map.delete(oldK);
      this.onEvict(oldK, oldV);
    }
  }

  delete(k: K, callEvict = false): void {
    if (!this.map.has(k)) return;
    const v = this.map.get(k)!;
    this.map.delete(k);
    if (callEvict) this.onEvict(k, v);
  }

  clear(callEvict = false): void {
    if (callEvict) for (const [k, v] of this.map) this.onEvict(k, v);
    this.map.clear();
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @wash/backend-opfs test && pnpm turbo build test typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/backend-opfs
git commit -m "feat(backend-opfs): sidecar codec and LRU handle pool (pure modules)"
```

---

### Task 3: Worker namespace reads — dentry tables, sidecar loading, lookup/readdir/setattr

**Files:**
- Modify: `packages/backend-opfs/src/worker.ts`
- Test: `packages/backend-opfs/test/browser/namespace.test.ts`

**Interfaces:**
- Consumes: Task 1 worker skeleton (`nodes`, `node`, `attrsOf`, `ops`, `defaultMode`, `errnoFromDom`), Task 2 pure modules.
- Produces (worker-internal helpers all later tasks use): `requireDir(rec): asserts dir` (ENOTDIR), `ensureSidecar(rec): Promise<Sidecar>` (lazy load from the dir's `.wash-attrs`, tolerant), `writeSidecarFile(rec): Promise<void>` (serialize; delete the file when empty), `ensureChildren(id, rec): Promise<Map<string, {id, kind}>>` (full listing: iterates `rec.dir.entries()`, skips `SIDECAR_NAME`, classifies symlinks via sidecar, registers `NodeRec`s with worker-minted ulids, sets `childrenComplete`), `registerChild(parentId, rec, name, kind, handles, id?)`. Implemented ops: `lookup` (reserved name → `null`; missing → `null`), `readdir` (sidecar hidden), `setattr` (mode persisted to the PARENT dir's sidecar entry — root mode is session-only; mtime/ctime session fields).

- [ ] **Step 1: Write the failing browser tests**

`packages/backend-opfs/test/browser/namespace.test.ts`:
```ts
import { describe, it, expect, afterEach } from "vitest";
import { OpfsBackend, SIDECAR_NAME } from "@wash/backend-opfs";
import { ulid } from "@wash/vfs";

const roots: string[] = [];
function testRoot(): string {
  const name = `wash-test-${ulid()}`;
  roots.push(name);
  return name;
}
afterEach(async () => {
  const origin = await navigator.storage.getDirectory();
  for (const name of roots.splice(0)) {
    await origin.removeEntry(name, { recursive: true }).catch(() => {});
  }
});

describe("OpfsBackend namespace reads", () => {
  it("sees pre-existing OPFS content with stable session ids", async () => {
    const rootName = testRoot();
    // seed the directory directly through OPFS APIs
    const origin = await navigator.storage.getDirectory();
    const seed = await origin.getDirectoryHandle(rootName, { create: true });
    const sub = await seed.getDirectoryHandle("src", { create: true });
    await sub.getFileHandle("main.ts", { create: true });

    const be = await OpfsBackend.open(rootName);
    const root = await be.root();
    const dir = await be.lookup(root, "src");
    expect(dir?.attrs.kind).toBe("dir");
    const again = await be.lookup(root, "src");
    expect(again?.id).toBe(dir?.id); // session-stable ids for discovered entries
    const file = await be.lookup(dir!.id, "main.ts");
    expect(file?.attrs.kind).toBe("file");
    expect((await be.readdir(dir!.id)).map((d) => d.name)).toEqual(["main.ts"]);
    await be.close();
  });

  it("hides the sidecar from readdir and lookup", async () => {
    const rootName = testRoot();
    const origin = await navigator.storage.getDirectory();
    const seed = await origin.getDirectoryHandle(rootName, { create: true });
    const sidecar = await seed.getFileHandle(SIDECAR_NAME, { create: true });
    const w = await sidecar.createWritable();
    await w.write(JSON.stringify({ "f.txt": { mode: 0o700 } }));
    await w.close();
    await seed.getFileHandle("f.txt", { create: true });

    const be = await OpfsBackend.open(rootName);
    const root = await be.root();
    expect((await be.readdir(root)).map((d) => d.name)).toEqual(["f.txt"]);
    expect(await be.lookup(root, SIDECAR_NAME)).toBeNull();
    const f = await be.lookup(root, "f.txt");
    expect(f?.attrs.mode).toBe(0o700); // sidecar mode applied
    await be.close();
  });

  it("setattr persists mode via the sidecar across reopen; times update in-session", async () => {
    const rootName = testRoot();
    const be = await OpfsBackend.open(rootName);
    const root = await be.root();
    // create via raw OPFS seeding is not available post-open; use worker create in Task 4 —
    // for THIS task, seed before open:
    await be.close();
    const origin = await navigator.storage.getDirectory();
    const seed = await origin.getDirectoryHandle(rootName, { create: true });
    await seed.getFileHandle("script.sh", { create: true });

    const be2 = await OpfsBackend.open(rootName);
    const root2 = await be2.root();
    const f = await be2.lookup(root2, "script.sh");
    await be2.setattr(f!.id, { mode: 0o755, mtimeMs: 12345 });
    const a = await be2.getattr(f!.id);
    expect(a.mode).toBe(0o755);
    expect(a.mtimeMs).toBe(12345);
    await be2.close();

    const be3 = await OpfsBackend.open(rootName);
    const root3 = await be3.root();
    const f3 = await be3.lookup(root3, "script.sh");
    expect(f3?.attrs.mode).toBe(0o755); // sidecar persisted the mode
    await be3.close();
  });

  it("readdir on a file throws ENOTDIR; getattr of unknown id ENOENT", async () => {
    const rootName = testRoot();
    const origin = await navigator.storage.getDirectory();
    const seed = await origin.getDirectoryHandle(rootName, { create: true });
    await seed.getFileHandle("f", { create: true });
    const be = await OpfsBackend.open(rootName);
    const root = await be.root();
    const f = await be.lookup(root, "f");
    await expect(be.readdir(f!.id)).rejects.toMatchObject({ errno: "ENOTDIR" });
    await expect(be.getattr(ulid())).rejects.toMatchObject({ errno: "ENOENT" });
    await be.close();
  });
});
```

- [ ] **Step 2: Run to verify RED**

Run: `pnpm turbo build && pnpm --filter @wash/backend-opfs test:browser`
Expected: new file fails with ENOSYS rejections.

- [ ] **Step 3: Implement in `worker.ts`**

Add imports: `import { parseSidecar, serializeSidecar, setSidecarEntry, renameSidecarEntry, isEmptySidecar, type Sidecar } from "./sidecar.js";` and `Dirent`, `NodeInfo` types.

```ts
function requireDir(rec: NodeRec): asserts rec is NodeRec & { dir: FileSystemDirectoryHandle } {
  if (rec.kind !== "dir" || !rec.dir) throw new VfsError("ENOTDIR");
}

async function ensureSidecar(rec: NodeRec & { dir: FileSystemDirectoryHandle }): Promise<Sidecar> {
  if (rec.sidecar) return rec.sidecar;
  try {
    const fh = await rec.dir.getFileHandle(SIDECAR_NAME);
    rec.sidecar = parseSidecar(await (await fh.getFile()).text());
  } catch {
    rec.sidecar = {};
  }
  return rec.sidecar;
}

async function writeSidecarFile(rec: NodeRec & { dir: FileSystemDirectoryHandle }): Promise<void> {
  const sidecar = rec.sidecar ?? {};
  if (isEmptySidecar(sidecar)) {
    await rec.dir.removeEntry(SIDECAR_NAME).catch(() => {});
    return;
  }
  const fh = await rec.dir.getFileHandle(SIDECAR_NAME, { create: true });
  const handle = await fh.createSyncAccessHandle();
  try {
    const bytes = new TextEncoder().encode(serializeSidecar(sidecar));
    handle.truncate(0);
    handle.write(bytes, { at: 0 });
    handle.flush();
  } finally {
    handle.close();
  }
}

function registerChild(
  parentId: NodeId,
  name: string,
  kind: NodeKind,
  handles: { dir?: FileSystemDirectoryHandle; file?: FileSystemFileHandle },
  opts: { id?: NodeId; mode?: number; target?: string } = {},
): NodeId {
  const id = opts.id ?? ulid();
  const now = Date.now();
  nodes.set(id, {
    kind, parentId, name,
    dir: handles.dir, file: handles.file,
    target: opts.target,
    mode: opts.mode ?? defaultMode(kind),
    mtimeMs: now, ctimeMs: now,
  });
  const parent = node(parentId);
  parent.children ??= new Map();
  parent.children.set(name, { id, kind });
  return id;
}

async function ensureChildren(id: NodeId, rec: NodeRec & { dir: FileSystemDirectoryHandle }): Promise<Map<string, { id: NodeId; kind: NodeKind }>> {
  if (rec.childrenComplete && rec.children) return rec.children;
  const sidecar = await ensureSidecar(rec);
  rec.children ??= new Map();
  for await (const [name, handle] of rec.dir.entries()) {
    if (name === SIDECAR_NAME) continue;
    if (rec.children.has(name)) continue;
    const meta = sidecar[name];
    if (handle.kind === "directory") {
      registerChild(id, name, "dir", { dir: handle as FileSystemDirectoryHandle }, { mode: meta?.mode });
    } else if (meta?.symlink !== undefined) {
      registerChild(id, name, "symlink", { file: handle as FileSystemFileHandle }, { mode: meta.mode, target: meta.symlink });
    } else {
      registerChild(id, name, "file", { file: handle as FileSystemFileHandle }, { mode: meta?.mode });
    }
  }
  rec.childrenComplete = true;
  return rec.children;
}
```

Replace/add ops:
```ts
  async lookup(parent: NodeId, name: string): Promise<OpResult> {
    const rec = node(parent);
    requireDir(rec);
    if (name === SIDECAR_NAME) return { value: null };
    const children = await ensureChildren(parent, rec);
    const entry = children.get(name);
    if (!entry) return { value: null };
    return { value: { id: entry.id, attrs: await attrsOf(node(entry.id)) } };
  },

  async readdir(id: NodeId): Promise<OpResult> {
    const rec = node(id);
    requireDir(rec);
    const children = await ensureChildren(id, rec);
    const out: Dirent[] = [];
    for (const [name, e] of children) out.push({ name, childId: e.id, kind: e.kind });
    return { value: out };
  },

  async setattr(id: NodeId, attrs: Partial<Pick<Attrs, "mode" | "mtimeMs" | "ctimeMs">>): Promise<OpResult> {
    const rec = node(id);
    if (attrs.mtimeMs !== undefined) rec.mtimeMs = attrs.mtimeMs;
    if (attrs.ctimeMs !== undefined) rec.ctimeMs = attrs.ctimeMs;
    if (attrs.mode !== undefined) {
      rec.mode = attrs.mode & 0o777;
      if (rec.parentId !== null) {
        const parent = node(rec.parentId);
        requireDir(parent);
        await ensureSidecar(parent);
        parent.sidecar = setSidecarEntry(parent.sidecar!, rec.name, {
          mode: rec.mode === defaultMode(rec.kind) ? undefined : rec.mode,
        });
        await writeSidecarFile(parent);
      }
    }
    return { value: undefined };
  },
```

`attrsOf` mtime note: with an explicit `setattr` mtime the session field must win even if smaller than `File.lastModified` — add a `mtimeExplicit?: boolean` flag on `NodeRec`, set it in `setattr`, and in `attrsOf` use `rec.mtimeMs` unconditionally when the flag is set.

- [ ] **Step 4: Run to verify GREEN**

Run: `pnpm turbo build && pnpm --filter @wash/backend-opfs test:browser`
Expected: PASS (shell + namespace files).

- [ ] **Step 5: Commit**

```bash
git add packages/backend-opfs
git commit -m "feat(backend-opfs): namespace reads — dentry tables, sidecar attrs, lookup/readdir/setattr"
```

---

### Task 4: create + unlink

**Files:**
- Modify: `packages/backend-opfs/src/worker.ts`
- Test: `packages/backend-opfs/test/browser/mutate.test.ts`

**Interfaces:**
- Consumes: Task 3 helpers.
- Produces: `create(parent, name, id, kind, attrs?)` — caller-supplied id honored; `kind`/`nlink` cannot be overridden by `attrs`; EEXIST on taken names; ENOTDIR on file parents; **EPERM on the reserved name**; non-default `attrs.mode` persisted to the parent sidecar; parent mtime bumped. `unlink(parent, name)` — ENOENT missing; EPERM reserved; for dirs: a dir whose only real entry is its own sidecar counts as EMPTY (sidecar removed, then `removeEntry`), otherwise ENOTEMPTY; for files/symlinks: pooled-handle closed first (hook exists as `closePooled(id)` no-op until Task 5), `removeEntry`, sidecar entry dropped, dentry+node dropped.

- [ ] **Step 1: Write the failing browser tests**

`packages/backend-opfs/test/browser/mutate.test.ts`:
```ts
import { describe, it, expect, afterEach } from "vitest";
import { OpfsBackend, SIDECAR_NAME } from "@wash/backend-opfs";
import { ulid } from "@wash/vfs";

const roots: string[] = [];
function testRoot(): string {
  const name = `wash-test-${ulid()}`;
  roots.push(name);
  return name;
}
afterEach(async () => {
  const origin = await navigator.storage.getDirectory();
  for (const name of roots.splice(0)) {
    await origin.removeEntry(name, { recursive: true }).catch(() => {});
  }
});

describe("OpfsBackend create/unlink", () => {
  it("creates dirs and files with caller ids and default attrs", async () => {
    const be = await OpfsBackend.open(testRoot());
    const root = await be.root();
    const d = ulid();
    await be.create(root, "dir", d, "dir");
    const f = ulid();
    await be.create(d, "f.txt", f, "file", { mode: 0o600 });
    expect((await be.lookup(root, "dir"))?.id).toBe(d);
    const info = await be.lookup(d, "f.txt");
    expect(info?.id).toBe(f);
    expect(info?.attrs).toMatchObject({ kind: "file", mode: 0o600, nlink: 1, size: 0 });
    await expect(be.create(root, "dir", ulid(), "file")).rejects.toMatchObject({ errno: "EEXIST" });
    await expect(be.create(f, "x", ulid(), "file")).rejects.toMatchObject({ errno: "ENOTDIR" });
    await be.close();
  });

  it("rejects reserved-name mutations with EPERM", async () => {
    const be = await OpfsBackend.open(testRoot());
    const root = await be.root();
    await expect(be.create(root, SIDECAR_NAME, ulid(), "file")).rejects.toMatchObject({ errno: "EPERM" });
    await expect(be.unlink(root, SIDECAR_NAME)).rejects.toMatchObject({ errno: "EPERM" });
    await be.close();
  });

  it("unlink removes files; dirs must be empty — but a sidecar-only dir counts as empty", async () => {
    const be = await OpfsBackend.open(testRoot());
    const root = await be.root();
    const d = ulid();
    await be.create(root, "d", d, "dir");
    const f = ulid();
    await be.create(d, "kid", f, "file", { mode: 0o700 }); // mode → sidecar exists in d
    await expect(be.unlink(root, "d")).rejects.toMatchObject({ errno: "ENOTEMPTY" });
    await be.unlink(d, "kid");
    // d now contains ONLY its .wash-attrs sidecar — POSIX-empty:
    await be.unlink(root, "d");
    expect(await be.lookup(root, "d")).toBeNull();
    await expect(be.unlink(root, "ghost")).rejects.toMatchObject({ errno: "ENOENT" });
    await be.close();
  });

  it("created entries persist across reopen", async () => {
    const rootName = testRoot();
    const be = await OpfsBackend.open(rootName);
    const root = await be.root();
    const d = ulid();
    await be.create(root, "keep", d, "dir");
    await be.create(d, "file", ulid(), "file");
    await be.close();

    const be2 = await OpfsBackend.open(rootName);
    const root2 = await be2.root();
    const dir = await be2.lookup(root2, "keep");
    expect(dir?.attrs.kind).toBe("dir");
    expect((await be2.readdir(dir!.id)).map((x) => x.name)).toEqual(["file"]);
    await be2.close();
  });
});
```

- [ ] **Step 2: RED**

Run: `pnpm turbo build && pnpm --filter @wash/backend-opfs test:browser`
Expected: mutate file fails with ENOSYS.

- [ ] **Step 3: Implement (add to `ops` in worker.ts)**

```ts
  async create(parent: NodeId, name: string, id: NodeId, kind: NodeKind, attrs?: Partial<Attrs>): Promise<OpResult> {
    const rec = node(parent);
    requireDir(rec);
    if (name === SIDECAR_NAME) throw new VfsError("EPERM", name);
    const children = await ensureChildren(parent, rec);
    if (children.has(name)) throw new VfsError("EEXIST", name);
    let handles: { dir?: FileSystemDirectoryHandle; file?: FileSystemFileHandle };
    try {
      handles = kind === "dir"
        ? { dir: await rec.dir.getDirectoryHandle(name, { create: true }) }
        : { file: await rec.dir.getFileHandle(name, { create: true }) };
    } catch (e) {
      errnoFromDom(e, name);
    }
    const mode = attrs?.mode !== undefined ? attrs.mode & 0o777 : defaultMode(kind);
    registerChild(parent, name, kind, handles, { id, mode });
    if (attrs?.mtimeMs !== undefined) node(id).mtimeMs = attrs.mtimeMs;
    if (attrs?.ctimeMs !== undefined) node(id).ctimeMs = attrs.ctimeMs;
    if (mode !== defaultMode(kind)) {
      await ensureSidecar(rec);
      rec.sidecar = setSidecarEntry(rec.sidecar!, name, { mode });
      await writeSidecarFile(rec);
    }
    rec.mtimeMs = Date.now();
    return { value: undefined };
  },

  async unlink(parent: NodeId, name: string): Promise<OpResult> {
    const rec = node(parent);
    requireDir(rec);
    if (name === SIDECAR_NAME) throw new VfsError("EPERM", name);
    const children = await ensureChildren(parent, rec);
    const entry = children.get(name);
    if (!entry) throw new VfsError("ENOENT", name);
    const child = node(entry.id);
    if (child.kind === "dir") {
      requireDir(child);
      const grand = await ensureChildren(entry.id, child);
      if (grand.size > 0) throw new VfsError("ENOTEMPTY", name);
      await child.dir.removeEntry(SIDECAR_NAME).catch(() => {}); // sidecar-only dir is empty
    } else {
      closePooled(entry.id);
    }
    try {
      await rec.dir.removeEntry(name);
    } catch (e) {
      errnoFromDom(e, name);
    }
    await ensureSidecar(rec);
    if (rec.sidecar![name]) {
      rec.sidecar = setSidecarEntry(rec.sidecar!, name, { mode: undefined, symlink: undefined });
      await writeSidecarFile(rec);
    }
    children.delete(name);
    nodes.delete(entry.id);
    rec.mtimeMs = Date.now();
    return { value: undefined };
  },
```

Add the Task-5 hook as a no-op for now:
```ts
function closePooled(_id: NodeId): void {
  // sync-handle pool arrives in Task 5
}
```

- [ ] **Step 4: GREEN**

Run: `pnpm turbo build && pnpm --filter @wash/backend-opfs test:browser`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/backend-opfs
git commit -m "feat(backend-opfs): create and unlink with sidecar-aware empty-dir semantics"
```

---

### Task 5: Content ops — sync-access-handle pool, read/write/truncate/flush

**Files:**
- Modify: `packages/backend-opfs/src/worker.ts`
- Test: `packages/backend-opfs/test/browser/content.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4 (`Lru`, `closePooled` hook, node tables).
- Produces: a worker-level `pool: Lru<NodeId, FileSystemSyncAccessHandle>` (capacity = `poolSize` from `open`; eviction flushes+closes); `acquireHandle(rec, id): Promise<FileSystemSyncAccessHandle>`; real `closePooled(id)`; ops `read` (clamped short reads, transferable result), `write` (zero-length no-op; OPFS zero-fills offset gaps natively; mtime bump), `truncate`, `flush` (flush every pooled handle), `close` (clear pool with flush+close, then respond). `attrsOf` uses `pool`'s `getSize()` when a handle is open (fresher than `getFile()` for unflushed writes).

- [ ] **Step 1: Write the failing browser tests**

`packages/backend-opfs/test/browser/content.test.ts`:
```ts
import { describe, it, expect, afterEach } from "vitest";
import { OpfsBackend } from "@wash/backend-opfs";
import { ulid } from "@wash/vfs";

const enc = new TextEncoder();
const dec = new TextDecoder();
const roots: string[] = [];
function testRoot(): string {
  const name = `wash-test-${ulid()}`;
  roots.push(name);
  return name;
}
afterEach(async () => {
  const origin = await navigator.storage.getDirectory();
  for (const name of roots.splice(0)) {
    await origin.removeEntry(name, { recursive: true }).catch(() => {});
  }
});

async function fileFixture() {
  const be = await OpfsBackend.open(testRoot(), { handlePoolSize: 4 });
  const root = await be.root();
  const f = ulid();
  await be.create(root, "f", f, "file");
  return { be, root, f };
}

describe("OpfsBackend content", () => {
  it("write/read roundtrip with offsets, EOF clamps, gap zero-fill", async () => {
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

  it("zero-length writes are POSIX no-ops; EISDIR on dirs", async () => {
    const { be, root, f } = await fileFixture();
    await be.write(f, 0, enc.encode("abc"));
    const before = await be.getattr(f);
    await be.write(f, 100, new Uint8Array(0));
    const after = await be.getattr(f);
    expect(after.size).toBe(3);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    await expect(be.write(root, 0, enc.encode("x"))).rejects.toMatchObject({ errno: "EISDIR" });
    await expect(be.read(root, 0, 1)).rejects.toMatchObject({ errno: "EISDIR" });
    await be.close();
  });

  it("truncate shrinks and sparse-extends; flush persists across reopen", async () => {
    const rootName = testRoot();
    const be = await OpfsBackend.open(rootName);
    const root = await be.root();
    const f = ulid();
    await be.create(root, "t", f, "file");
    await be.write(f, 0, enc.encode("0123456789"));
    await be.truncate(f, 4);
    expect(dec.decode(await be.read(f, 0, 100))).toBe("0123");
    await be.truncate(f, 6);
    const out = await be.read(f, 0, 100);
    expect(out.byteLength).toBe(6);
    expect([...out.slice(4)]).toEqual([0, 0]);
    await be.flush();
    await be.close();

    const be2 = await OpfsBackend.open(rootName);
    const root2 = await be2.root();
    const f2 = await be2.lookup(root2, "t");
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
    for (let i = 0; i < 5; i++) {
      expect(dec.decode(await be.read(ids[i]!, 0, 100))).toBe(`content-${i}`);
    }
    await be.close();
  });
});
```

- [ ] **Step 2: RED**

Run: `pnpm turbo build && pnpm --filter @wash/backend-opfs test:browser`
Expected: content file fails with ENOSYS.

- [ ] **Step 3: Implement (worker.ts)**

```ts
import { Lru } from "./lru.js";

let pool: Lru<NodeId, FileSystemSyncAccessHandle> = new Lru(64, (_id, h) => {
  try { h.flush(); h.close(); } catch { /* already closed */ }
});
```
In `open`: after setting `poolSize`, `pool = new Lru(poolSize, (_id, h) => { try { h.flush(); h.close(); } catch {} });`.

```ts
function requireFile(rec: NodeRec): asserts rec is NodeRec & { file: FileSystemFileHandle } {
  if (rec.kind === "dir") throw new VfsError("EISDIR");
  if (!rec.file) throw new VfsError("ENOENT");
}

async function acquireHandle(id: NodeId, rec: NodeRec & { file: FileSystemFileHandle }): Promise<FileSystemSyncAccessHandle> {
  const existing = pool.get(id);
  if (existing) return existing;
  let handle: FileSystemSyncAccessHandle;
  try {
    handle = await rec.file.createSyncAccessHandle();
  } catch (e) {
    errnoFromDom(e, rec.name);
  }
  pool.set(id, handle);
  return handle;
}

function closePooled(id: NodeId): void {
  pool.delete(id, true);
}
```
(Replace the Task-4 no-op `closePooled`.)

Ops:
```ts
  async read(id: NodeId, offset: number, length: number): Promise<OpResult> {
    const rec = node(id);
    requireFile(rec);
    const handle = await acquireHandle(id, rec);
    const size = handle.getSize();
    if (offset >= size || length === 0) return { value: new ArrayBuffer(0) };
    const end = Math.min(offset + length, size);
    const buf = new Uint8Array(end - offset);
    handle.read(buf, { at: offset });
    return { value: buf.buffer, transfer: [buf.buffer] };
  },

  async write(id: NodeId, offset: number, data: ArrayBuffer): Promise<OpResult> {
    const rec = node(id);
    requireFile(rec);
    const bytes = new Uint8Array(data);
    if (bytes.byteLength === 0) return { value: undefined }; // POSIX no-op
    const handle = await acquireHandle(id, rec);
    try {
      handle.write(bytes, { at: offset }); // OPFS zero-fills any gap past EOF
    } catch (e) {
      errnoFromDom(e, rec.name);
    }
    rec.mtimeMs = Date.now();
    rec.mtimeExplicit = false;
    return { value: undefined };
  },

  async truncate(id: NodeId, size: number): Promise<OpResult> {
    const rec = node(id);
    requireFile(rec);
    const handle = await acquireHandle(id, rec);
    try {
      handle.truncate(size);
    } catch (e) {
      errnoFromDom(e, rec.name);
    }
    rec.mtimeMs = Date.now();
    rec.mtimeExplicit = false;
    return { value: undefined };
  },
```
Replace `flush`/`close`:
```ts
  async flush(): Promise<OpResult> {
    for (const id of [...pool.keys()]) {
      const h = pool.get(id);
      try { h?.flush(); } catch { /* closed under us */ }
    }
    return { value: undefined };
  },

  async close(): Promise<OpResult> {
    pool.clear(true);
    return { value: undefined };
  },
```
And in `attrsOf`, for files: `const pooled = pool.get(<id>)` — `attrsOf` currently takes only `rec`; change its signature to `attrsOf(id: NodeId, rec: NodeRec)` (update the Task-1/3 call sites: `getattr`, `lookup`) and use `pooled.getSize()` for `size` when a handle is open, falling back to `getFile()`.

- [ ] **Step 4: GREEN**

Run: `pnpm turbo build && pnpm --filter @wash/backend-opfs test:browser`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/backend-opfs
git commit -m "feat(backend-opfs): sync-access-handle pool and content ops"
```

---

### Task 6: symlink/readlink via sidecar

**Files:**
- Modify: `packages/backend-opfs/src/worker.ts`
- Test: `packages/backend-opfs/test/browser/links.test.ts`

**Interfaces:**
- Consumes: Tasks 3–5.
- Produces: `symlink(parent, name, id, target)` — EPERM reserved, EEXIST taken; creates a **zero-byte marker file** plus a sidecar entry `{ symlink: target }`; registers a `"symlink"` NodeRec with the caller id. `readlink(id)` — EINVAL on non-symlinks. Symlinks survive reopen (classified from the sidecar during `ensureChildren` — already implemented in Task 3; this task proves it).

- [ ] **Step 1: Write the failing browser tests**

`packages/backend-opfs/test/browser/links.test.ts`:
```ts
import { describe, it, expect, afterEach } from "vitest";
import { OpfsBackend } from "@wash/backend-opfs";
import { ulid } from "@wash/vfs";

const roots: string[] = [];
function testRoot(): string {
  const name = `wash-test-${ulid()}`;
  roots.push(name);
  return name;
}
afterEach(async () => {
  const origin = await navigator.storage.getDirectory();
  for (const name of roots.splice(0)) {
    await origin.removeEntry(name, { recursive: true }).catch(() => {});
  }
});

describe("OpfsBackend symlinks", () => {
  it("creates, reads, lists, unlinks, and persists symlinks", async () => {
    const rootName = testRoot();
    const be = await OpfsBackend.open(rootName);
    const root = await be.root();
    const s = ulid();
    await be.symlink(root, "ln", s, "/some/target");
    const info = await be.lookup(root, "ln");
    expect(info?.id).toBe(s);
    expect(info?.attrs.kind).toBe("symlink");
    expect(info?.attrs.size).toBe("/some/target".length);
    expect(await be.readlink(s)).toBe("/some/target");
    expect((await be.readdir(root)).map((d) => `${d.name}:${d.kind}`)).toEqual(["ln:symlink"]);
    await expect(be.symlink(root, "ln", ulid(), "/x")).rejects.toMatchObject({ errno: "EEXIST" });
    await be.close();

    const be2 = await OpfsBackend.open(rootName);
    const root2 = await be2.root();
    const again = await be2.lookup(root2, "ln");
    expect(again?.attrs.kind).toBe("symlink");
    expect(await be2.readlink(again!.id)).toBe("/some/target");
    await be2.unlink(root2, "ln");
    expect(await be2.lookup(root2, "ln")).toBeNull();
    await be2.close();
  });

  it("readlink on a file throws EINVAL", async () => {
    const be = await OpfsBackend.open(testRoot());
    const root = await be.root();
    const f = ulid();
    await be.create(root, "f", f, "file");
    await expect(be.readlink(f)).rejects.toMatchObject({ errno: "EINVAL" });
    await be.close();
  });
});
```

- [ ] **Step 2: RED**

Run: `pnpm turbo build && pnpm --filter @wash/backend-opfs test:browser`
Expected: links file fails with ENOSYS.

- [ ] **Step 3: Implement (worker.ts ops)**

```ts
  async symlink(parent: NodeId, name: string, id: NodeId, target: string): Promise<OpResult> {
    const rec = node(parent);
    requireDir(rec);
    if (name === SIDECAR_NAME) throw new VfsError("EPERM", name);
    const children = await ensureChildren(parent, rec);
    if (children.has(name)) throw new VfsError("EEXIST", name);
    let file: FileSystemFileHandle;
    try {
      file = await rec.dir.getFileHandle(name, { create: true }); // zero-byte marker
    } catch (e) {
      errnoFromDom(e, name);
    }
    await ensureSidecar(rec);
    rec.sidecar = setSidecarEntry(rec.sidecar!, name, { symlink: target });
    await writeSidecarFile(rec);
    registerChild(parent, name, "symlink", { file }, { id, target });
    rec.mtimeMs = Date.now();
    return { value: undefined };
  },

  async readlink(id: NodeId): Promise<OpResult> {
    const rec = node(id);
    if (rec.kind !== "symlink" || rec.target === undefined) throw new VfsError("EINVAL");
    return { value: rec.target };
  },
```

- [ ] **Step 4: GREEN**

Run: `pnpm turbo build && pnpm --filter @wash/backend-opfs test:browser`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/backend-opfs
git commit -m "feat(backend-opfs): sidecar-backed symlinks"
```

---

### Task 7: rename — file `move()`, directory subtree fallback with id rebinding

**Files:**
- Modify: `packages/backend-opfs/src/worker.ts`
- Test: `packages/backend-opfs/test/browser/rename.test.ts`

**Interfaces:**
- Consumes: everything prior.
- Produces: `rename(fromParent, fromName, toParent, toName)` with POSIX overwrite semantics (EISDIR/ENOTDIR/ENOTEMPTY; displaced entries removed incl. pooled-handle close), reserved-name EPERM on either name, sidecar entry transported (mode/symlink follow the entry), parent mtimes bumped, and **caller-visible ids stable**: file/symlink moves rebind `NodeRec.file`/`parentId`/`name`; directory moves run `moveTree` — create dest dir, move each child (files/symlinks via `FileSystemFileHandle.move(destDir, name)`, subdirs recursively), move the sidecar file itself, remove the emptied source dir — rebinding every descendant `NodeRec` handle as it goes (`renameCost: "subtree"`, non-atomic, documented). All pooled handles under the moved subtree are closed before moving (sync handles lock their files).

- [ ] **Step 1: Write the failing browser tests**

`packages/backend-opfs/test/browser/rename.test.ts`:
```ts
import { describe, it, expect, afterEach } from "vitest";
import { OpfsBackend } from "@wash/backend-opfs";
import { ulid } from "@wash/vfs";

const enc = new TextEncoder();
const dec = new TextDecoder();
const roots: string[] = [];
function testRoot(): string {
  const name = `wash-test-${ulid()}`;
  roots.push(name);
  return name;
}
afterEach(async () => {
  const origin = await navigator.storage.getDirectory();
  for (const name of roots.splice(0)) {
    await origin.removeEntry(name, { recursive: true }).catch(() => {});
  }
});

describe("OpfsBackend rename", () => {
  it("renames files within and across directories, id-stable, content intact", async () => {
    const be = await OpfsBackend.open(testRoot());
    const root = await be.root();
    const d = ulid();
    await be.create(root, "dst", d, "dir");
    const f = ulid();
    await be.create(root, "a.txt", f, "file");
    await be.write(f, 0, enc.encode("payload"));
    await be.rename(root, "a.txt", root, "b.txt");
    expect((await be.lookup(root, "b.txt"))?.id).toBe(f);
    await be.rename(root, "b.txt", d, "c.txt");
    expect((await be.lookup(d, "c.txt"))?.id).toBe(f);
    expect(await be.lookup(root, "b.txt")).toBeNull();
    expect(dec.decode(await be.read(f, 0, 100))).toBe("payload"); // id + content survive
    await be.close();
  });

  it("overwrite semantics: file-over-file replaces; dir-over-nonempty ENOTEMPTY; file-over-dir EISDIR; dir-over-file ENOTDIR", async () => {
    const be = await OpfsBackend.open(testRoot());
    const root = await be.root();
    const f1 = ulid();
    const f2 = ulid();
    await be.create(root, "f1", f1, "file");
    await be.create(root, "f2", f2, "file");
    await be.write(f1, 0, enc.encode("one"));
    await be.rename(root, "f1", root, "f2");
    expect((await be.lookup(root, "f2"))?.id).toBe(f1);
    await expect(be.getattr(f2)).rejects.toMatchObject({ errno: "ENOENT" });
    const d1 = ulid();
    const d2 = ulid();
    await be.create(root, "d1", d1, "dir");
    await be.create(root, "d2", d2, "dir");
    await be.create(d2, "kid", ulid(), "file");
    await expect(be.rename(root, "d1", root, "d2")).rejects.toMatchObject({ errno: "ENOTEMPTY" });
    await expect(be.rename(root, "f2", root, "d1")).rejects.toMatchObject({ errno: "EISDIR" });
    await expect(be.rename(root, "d1", root, "f2")).rejects.toMatchObject({ errno: "ENOTDIR" });
    await be.close();
  });

  it("directory rename moves the whole subtree with stable descendant ids, sidecar attrs, and open handles", async () => {
    const rootName = testRoot();
    const be = await OpfsBackend.open(rootName);
    const root = await be.root();
    const src = ulid();
    await be.create(root, "src", src, "dir");
    const sub = ulid();
    await be.create(src, "sub", sub, "dir");
    const f = ulid();
    await be.create(sub, "deep.txt", f, "file", { mode: 0o700 });
    await be.write(f, 0, enc.encode("deep-content")); // pooled handle open on f
    const ln = ulid();
    await be.symlink(src, "ln", ln, "/x");

    await be.rename(root, "src", root, "moved");
    expect((await be.lookup(root, "moved"))?.id).toBe(src); // dir id stable
    expect((await be.lookup(src, "sub"))?.id).toBe(sub);
    const deep = await be.lookup(sub, "deep.txt");
    expect(deep?.id).toBe(f);
    expect(deep?.attrs.mode).toBe(0o700); // sidecar transported
    expect(dec.decode(await be.read(f, 0, 100))).toBe("deep-content");
    expect(await be.readlink(ln)).toBe("/x");
    await be.close();

    const be2 = await OpfsBackend.open(rootName); // persisted layout
    const root2 = await be2.root();
    const moved = await be2.lookup(root2, "moved");
    const sub2 = await be2.lookup(moved!.id, "sub");
    const deep2 = await be2.lookup(sub2!.id, "deep.txt");
    expect(deep2?.attrs.mode).toBe(0o700);
    expect(dec.decode(await be2.read(deep2!.id, 0, 100))).toBe("deep-content");
    await be2.close();
  });
});
```

- [ ] **Step 2: RED**

Run: `pnpm turbo build && pnpm --filter @wash/backend-opfs test:browser`
Expected: rename file fails with ENOSYS.

- [ ] **Step 3: Implement (worker.ts)**

```ts
type MovableFileHandle = FileSystemFileHandle & {
  move?: (dest: FileSystemDirectoryHandle, name: string) => Promise<void>;
};

async function moveFileEntry(
  rec: NodeRec & { file: FileSystemFileHandle },
  id: NodeId,
  destDir: FileSystemDirectoryHandle,
  newName: string,
): Promise<void> {
  closePooled(id); // sync handles lock the file
  const movable = rec.file as MovableFileHandle;
  if (typeof movable.move === "function") {
    await movable.move(destDir, newName);
    rec.file = await destDir.getFileHandle(newName);
  } else {
    // copy+delete fallback for engines without FileSystemFileHandle.move
    const data = new Uint8Array(await (await rec.file.getFile()).arrayBuffer());
    const destHandle = await destDir.getFileHandle(newName, { create: true });
    const h = await destHandle.createSyncAccessHandle();
    try {
      h.truncate(0);
      if (data.byteLength > 0) h.write(data, { at: 0 });
      h.flush();
    } finally {
      h.close();
    }
    const oldParent = rec.parentId !== null ? node(rec.parentId) : null;
    if (oldParent?.dir) await oldParent.dir.removeEntry(rec.name).catch(() => {});
    rec.file = destHandle;
  }
}

async function moveTree(
  rec: NodeRec & { dir: FileSystemDirectoryHandle },
  id: NodeId,
  destParent: FileSystemDirectoryHandle,
  newName: string,
): Promise<void> {
  const destDir = await destParent.getDirectoryHandle(newName, { create: true });
  const children = await ensureChildren(id, rec);
  for (const [childName, entry] of children) {
    const child = node(entry.id);
    if (child.kind === "dir") {
      requireDir(child);
      await moveTree(child, entry.id, destDir, childName);
    } else {
      requireFile(child);
      await moveFileEntry(child, entry.id, destDir, childName);
    }
    child.parentId = id; // unchanged parent NODE; only handles moved
  }
  // transport the sidecar file itself
  await ensureSidecar(rec);
  const srcDirOld = rec.dir;
  rec.dir = destDir;
  if (!isEmptySidecar(rec.sidecar!)) await writeSidecarFile(rec);
  await srcDirOld.removeEntry(SIDECAR_NAME).catch(() => {});
  // remove the emptied source directory
  const oldParent = rec.parentId !== null ? node(rec.parentId) : null;
  if (oldParent?.dir) await oldParent.dir.removeEntry(rec.name).catch(() => {});
}
```
(Note `moveTree` removes the source dir via the OLD parent handle using the OLD `rec.name` — call it BEFORE reassigning `rec.name`/`rec.parentId` in the `rename` op below, and pass the destination through arguments only.)

The `rename` op:
```ts
  async rename(fromParent: NodeId, fromName: string, toParent: NodeId, toName: string): Promise<OpResult> {
    const fp = node(fromParent);
    requireDir(fp);
    const tp = node(toParent);
    requireDir(tp);
    if (fromName === SIDECAR_NAME || toName === SIDECAR_NAME) {
      throw new VfsError("EPERM", fromName === SIDECAR_NAME ? fromName : toName);
    }
    const fromChildren = await ensureChildren(fromParent, fp);
    const moving = fromChildren.get(fromName);
    if (!moving) throw new VfsError("ENOENT", fromName);
    const toChildren = await ensureChildren(toParent, tp);
    const displaced = toChildren.get(toName);
    const movingRec = node(moving.id);

    if (displaced) {
      const dispRec = node(displaced.id);
      if (dispRec.kind === "dir") {
        if (movingRec.kind !== "dir") throw new VfsError("EISDIR", toName);
        requireDir(dispRec);
        const grand = await ensureChildren(displaced.id, dispRec);
        if (grand.size > 0) throw new VfsError("ENOTEMPTY", toName);
        await dispRec.dir.removeEntry(SIDECAR_NAME).catch(() => {});
        await tp.dir.removeEntry(toName);
        nodes.delete(displaced.id);
      } else {
        if (movingRec.kind === "dir") throw new VfsError("ENOTDIR", toName);
        closePooled(displaced.id);
        await tp.dir.removeEntry(toName);
        nodes.delete(displaced.id);
      }
      toChildren.delete(toName);
    }

    if (movingRec.kind === "dir") {
      requireDir(movingRec);
      await moveTree(movingRec, moving.id, tp.dir, toName);
    } else {
      requireFile(movingRec);
      await moveFileEntry(movingRec, moving.id, tp.dir, toName);
    }

    // transport the entry's OWN sidecar record (mode/symlink) between parents
    await ensureSidecar(fp);
    const entryMeta = fp.sidecar![fromName];
    if (entryMeta) {
      fp.sidecar = setSidecarEntry(fp.sidecar!, fromName, { mode: undefined, symlink: undefined });
      await writeSidecarFile(fp);
      await ensureSidecar(tp);
      tp.sidecar = setSidecarEntry(tp.sidecar!, toName, entryMeta);
      await writeSidecarFile(tp);
    }

    fromChildren.delete(fromName);
    toChildren.set(toName, moving);
    movingRec.parentId = toParent;
    movingRec.name = toName;
    fp.mtimeMs = Date.now();
    tp.mtimeMs = Date.now();
    return { value: undefined };
  },
```
Note the ordering trap called out inline: `moveTree` uses `rec.parentId`/`rec.name` to delete the old source directory, so the `movingRec.parentId = toParent; movingRec.name = toName;` reassignment must come AFTER the move calls (as written above). Same-parent renames work because `moveTree`'s removeEntry targets the OLD name and the dest dir was created under the NEW name first.

- [ ] **Step 4: GREEN**

Run: `pnpm turbo build && pnpm --filter @wash/backend-opfs test:browser`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/backend-opfs
git commit -m "feat(backend-opfs): POSIX rename — file move and subtree fallback with stable ids"
```

---

### Task 8: dump(), conformance ×2, persistence — the contract gate

**Files:**
- Modify: `packages/backend-opfs/src/worker.ts` (add `dump`)
- Test: `packages/backend-opfs/test/browser/conformance.test.ts`, `packages/backend-opfs/test/browser/warm.test.ts`

**Interfaces:**
- Consumes: the complete backend; `runBackendConformance` from `@wash/vfs/conformance`; `CachedBackend` from `@wash/vfs`.
- Produces: `dump()` — full recursive walk (ensureChildren + attrs per node) returning `BackendDump`; conformance green for raw `OpfsBackend` and `CachedBackend(OpfsBackend, {flushDelayMs: 1})` in Chromium — **including the reserved-names case actually running** (first backend to declare the cap) and hardlink cases skipping. Any failure is a backend bug: fix in `worker.ts`, document each fix. Do not modify the suite.

- [ ] **Step 1: Add `dump` to the worker**

```ts
  async dump(): Promise<OpResult> {
    const inodes: { id: NodeId; attrs: Attrs }[] = [];
    const dirents: { parentId: NodeId; name: string; childId: NodeId; kind: NodeKind }[] = [];
    async function walk(id: NodeId): Promise<void> {
      const rec = node(id);
      inodes.push({ id, attrs: await attrsOf(id, rec) });
      if (rec.kind !== "dir") return;
      requireDir(rec);
      const children = await ensureChildren(id, rec);
      for (const [name, entry] of children) {
        dirents.push({ parentId: id, name, childId: entry.id, kind: entry.kind });
        await walk(entry.id);
      }
    }
    await walk(rootId);
    return { value: { inodes, dirents } };
  },
```

- [ ] **Step 2: Write the conformance + warm tests**

`packages/backend-opfs/test/browser/conformance.test.ts`:
```ts
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
```

`packages/backend-opfs/test/browser/warm.test.ts`:
```ts
import { describe, it, expect, afterEach } from "vitest";
import { OpfsBackend } from "@wash/backend-opfs";
import { CachedBackend, ulid } from "@wash/vfs";

const roots: string[] = [];
function testRoot(): string {
  const name = `wash-test-${ulid()}`;
  roots.push(name);
  return name;
}
afterEach(async () => {
  const origin = await navigator.storage.getDirectory();
  for (const name of roots.splice(0)) {
    await origin.removeEntry(name, { recursive: true }).catch(() => {});
  }
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
    expect(await cached.lookup(d, "nope")).toBeNull(); // complete-dir negative, no worker call
    await be.close();
  });
});
```

- [ ] **Step 3: Run — iterate on backend fixes until green**

Run: `pnpm turbo build && pnpm --filter @wash/backend-opfs test:browser`
Expected: eventually PASS. Conformance expectations: symlink cases RUN (`caps.symlinks: "supported"`); hardlink cases SKIP (`hardlinks: false`); the reserved-names case RUNS and must pass (EPERM on create of `.wash-attrs`, hidden from readdir/lookup); zero-length-write no-op case runs. Every failure is a `worker.ts` bug — fix and document in the commit message. Do not modify the suite.

- [ ] **Step 4: Full gate**

Run: `pnpm turbo build test typecheck && pnpm --filter @wash/backend-opfs test:browser && pnpm --filter @wash/backend-indexeddb test:browser`
Expected: all green (the vfs ENOSPC change must not disturb the IDB suites).

- [ ] **Step 5: Commit**

```bash
git add packages/backend-opfs
git commit -m "test(backend-opfs): conformance green (raw + cached) in Chromium; dump/warm"
```

---

### Task 9: Integration, README, exit gate

**Files:**
- Create: `packages/backend-opfs/test/browser/integration.test.ts`, `packages/backend-opfs/README.md`

**Interfaces:**
- Consumes: everything.
- Produces: end-to-end proof (Vfs + CachedBackend + OpfsBackend across simulated reload with warming; a dual-mount EXDEV check against `MemoryBackend`), the package README, and the Plan-3 exit gate.

- [ ] **Step 1: Write the integration test**

`packages/backend-opfs/test/browser/integration.test.ts`:
```ts
import { describe, it, expect, afterEach } from "vitest";
import { Vfs, CachedBackend, MemoryBackend, ulid } from "@wash/vfs";
import { OpfsBackend } from "@wash/backend-opfs";

const roots: string[] = [];
function testRoot(): string {
  const name = `wash-test-${ulid()}`;
  roots.push(name);
  return name;
}
afterEach(async () => {
  const origin = await navigator.storage.getDirectory();
  for (const name of roots.splice(0)) {
    await origin.removeEntry(name, { recursive: true }).catch(() => {});
  }
});

describe("Vfs + CachedBackend + OpfsBackend end-to-end", () => {
  it("full session, reload with warming, contents intact", async () => {
    const rootName = testRoot();

    const be1 = await OpfsBackend.open(rootName);
    const vfs1 = new Vfs();
    await vfs1.mount("/", new CachedBackend(be1, { flushDelayMs: 60_000 }));
    await vfs1.mkdir("/project/src", { recursive: true });
    await vfs1.writeFile("/project/src/index.ts", "export const x = 1;\n");
    await vfs1.appendFile("/project/src/index.ts", "export const y = 2;\n");
    await vfs1.chmod("/project/src/index.ts", 0o755);
    await vfs1.symlink("/project/src/index.ts", "/project/main");
    await vfs1.rename("/project/src", "/project/lib");
    await vfs1.fsync();
    await be1.close();

    const be2 = await OpfsBackend.open(rootName);
    const cached2 = new CachedBackend(be2, { flushDelayMs: 60_000 });
    cached2.warm(await be2.dump());
    const vfs2 = new Vfs();
    await vfs2.mount("/", cached2);
    expect(await vfs2.readTextFile("/project/lib/index.ts")).toBe("export const x = 1;\nexport const y = 2;\n");
    expect((await vfs2.stat("/project/lib/index.ts")).mode).toBe(0o755); // sidecar survived the dir rename
    expect(await vfs2.readlink("/project/main")).toBe("/project/src/index.ts"); // POSIX: stale path string
    expect((await vfs2.readdir("/project")).map((d) => d.name)).toEqual(["lib", "main"]);
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

- [ ] **Step 2: Run**

Run: `pnpm turbo build && pnpm --filter @wash/backend-opfs test:browser`
Expected: PASS directly if Tasks 1–8 compose; any failure is a real integration bug — investigate and fix (most likely sidecar transport during rename or flush/close ordering).

- [ ] **Step 3: Write the README**

`packages/backend-opfs/README.md` — short: what the package is (OPFS backend for `@wash/vfs`, spec §6 pointer; **the intended default backend for the `wash` package** — Plan 6 mounts OPFS by default with `@wash/backend-indexeddb` as the fallback where OPFS is unavailable); the worker architecture (sync access handles are worker-only; all state lives in the backend-owned storage worker; strictly sequential ops); a 12-line usage example (open → `CachedBackend` → `warm(await be.dump())` → mount); the caps table with the honest limitations (no hardlinks; `renameCost: "subtree"` non-atomic directory renames; session-scoped explicit utimes; reserved name `.wash-attrs`); browser requirements (OPFS + sync access handles: Chromium, Firefox 111+, Safari 15.2+ — verify current support lines and cite what you verified); how to run tests (`test:browser`, requires `pnpm exec playwright install chromium`; Node suite covers pure modules only).

- [ ] **Step 4: Exit gate**

Run: `pnpm turbo build test typecheck && pnpm --filter @wash/backend-opfs test:browser && pnpm --filter @wash/backend-indexeddb test:browser`
Expected: everything green.

- [ ] **Step 5: Commit**

```bash
git add packages/backend-opfs
git commit -m "feat(backend-opfs): end-to-end integration test and README"
```

---

## Plan 3 exit criteria

- `pnpm turbo build test typecheck` green from clean; `pnpm --filter @wash/backend-opfs test:browser` green in Chromium; the IDB browser suite unaffected.
- Conformance passes for raw `OpfsBackend` and `CachedBackend(OpfsBackend, {flushDelayMs: 1})` — with symlink and **reserved-names** cases running (first backend to exercise the cap) and hardlink cases skipping.
- Persistence pinned: namespace, content, symlinks, and sidecar modes survive close/reopen; directory rename transports subtrees + sidecars with session-stable ids.
- `dump()`/`warm()` work end-to-end (the default-backend path gets mount-time warming).
- Not in scope (deferred): OPFS entries in `apps/bench` (needs the browser bench rig — record as a bench-app follow-up); cross-tab collision behavior beyond Web-Locks single-writer; Safari-specific quirks beyond the documented support floor; the consolidated pre-Plan-4 contract items (F4 open-fds, CachedBackend journaling, fsync-strict).
