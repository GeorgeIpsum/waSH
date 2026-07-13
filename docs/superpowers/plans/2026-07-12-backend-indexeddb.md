# waSH Plan 2: @wash/backend-indexeddb Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@wash/backend-indexeddb` — the persistent IndexedDB storage backend per spec §5 — conformance-green in Node (fake-indexeddb) and real Chromium, plus metadata warming (`dump()`/`warm()`) and the first `apps/bench` benchmarks.

**Architecture:** The backend implements the `WashBackend` contract from `@wash/vfs` directly against the four-store schema (spec §5): `dirents` keyed `[parentId, name]`, `inodes` keyed by ULID, `data` keyed `[inodeId, chunkIdx]` in `CHUNK_SIZE` chunks, `meta`. The spec's #1 performance lever — "entire dirty batch in one readwrite transaction" — is delivered by a **lazy shared transaction**: modern IndexedDB keeps a transaction active across microtask-chained requests (it auto-commits only when control returns to the event loop), and `CachedBackend.flush()` replays its op queue in exactly such a chain, so one transaction spans the whole batch without any contract change. Reads and writes both use the shared txn; a txn that auto-committed at a batch boundary is detected by `TransactionInactiveError`/`InvalidStateError` on the op's first request and the whole (restartable) op retries once on a fresh txn.

**Tech Stack:** TypeScript strict/ESM (per repo), zero runtime dependencies (hand-rolled IDB promise helpers), `fake-indexeddb` for Node tests, vitest browser mode + Playwright for real-Chromium conformance, vitest `bench` for `apps/bench`.

## Global Constraints

- Zero runtime dependencies in `@wash/backend-indexeddb`; `fake-indexeddb`, `@vitest/browser`, `playwright` are devDependencies only. `@wash/vfs` is a `workspace:^` dependency (types, `VfsError`, `ulid`, `CHUNK_SIZE`, conformance suite).
- ESM-only (`"type": "module"`), TS strict, ES2022, per `tsconfig.base.json`.
- Caps exactly: `{ symlinks: "supported", hardlinks: true, atomicDirRename: true, renameCost: "O1" }`. No `reservedNames`.
- Errno parity with `MemoryBackend` (the conformance oracle), including: `lookup` returns `null` (not ENOENT) for missing names; `link` checks EEXIST **before** EPERM; `rename` between two names of the same inode is a POSIX no-op; POSIX rename overwrite semantics (EISDIR/ENOTDIR/ENOTEMPTY); unlink GC at `nlink ≤ 0`; reads past EOF return short results; sparse chunks read as zeros.
- NodeIds are ULIDs minted by the caller and passed into `create`/`symlink` (spec §4). This backend persists them, so ids are stable **across sessions** (exceeds the mount-lifetime contract; the persistence test pins it).
- Chunk size defaults to `CHUNK_SIZE` (65536) from `@wash/vfs`; constructor-overridable (`chunkSize`) for the bench sweep. Attr defaults mirror MemoryBackend: dir `0o755`, symlink `0o777`, file `0o644`, `nlink: 1`, `mtimeMs`/`ctimeMs` = `Date.now()`.
- Transactions: `durability: "relaxed"` by default (constructor-overridable to `"strict"`), passed via the options bag with a fallback for engines that reject it.
- **Microtask discipline (correctness-critical):** backend op implementations must never `await` anything that isn't an IDB request in the same transaction (no `setTimeout`, no I/O) — a macrotask yield mid-op auto-commits the shared txn and breaks op atomicity. Every op must be **restartable** (re-reads all state it depends on) because `withTx` retries once on a stale txn.
- Conformance suite must pass for: raw `IndexedDBBackend` (Node/fake-indexeddb), `CachedBackend(IndexedDBBackend, {flushDelayMs: 1})` (Node), and raw `IndexedDBBackend` in real Chromium (vitest browser mode). Node suites run in the default `test` task; browser suites run under a separate `test:browser` task (not in the default pipeline).
- Commit after every green test cycle; conventional commit messages.

---

### Task 1: Package scaffold + IDB promise helpers

**Files:**
- Create: `packages/backend-indexeddb/package.json`, `packages/backend-indexeddb/tsconfig.json`, `packages/backend-indexeddb/vitest.config.ts`, `packages/backend-indexeddb/src/idb.ts`, `packages/backend-indexeddb/src/index.ts`, `packages/backend-indexeddb/test/setup.node.ts`
- Test: `packages/backend-indexeddb/test/idb-helpers.test.ts`

**Interfaces:**
- Consumes: `@wash/vfs` (workspace dep), repo tsconfig/turbo conventions.
- Produces (used by every later task): `req<T>(r: IDBRequest<T>): Promise<T>`, `txDone(tx: IDBTransaction): Promise<void>`, `openDb(name: string, factory?: IDBFactory): Promise<IDBDatabase>`, `STORE_NAMES = ["dirents","inodes","data","meta"] as const`, `SCHEMA_VERSION = 1`. Node tests get a global `indexedDB` via the setup file.

- [ ] **Step 1: Create package files**

`packages/backend-indexeddb/package.json`:
```json
{
  "name": "@wash/backend-indexeddb",
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
    "vitest": "^3.0.0",
    "@types/node": "^22.0.0",
    "fake-indexeddb": "^6.0.0"
  }
}
```
(`vitest.browser.config.ts` and its devDeps arrive in Task 8; the script is declared now so turbo wiring is one-time.)

`packages/backend-indexeddb/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

`packages/backend-indexeddb/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { environment: "node", setupFiles: ["./test/setup.node.ts"] },
});
```

`packages/backend-indexeddb/test/setup.node.ts`:
```ts
// Installs a fresh in-memory indexedDB global for Node test runs.
import "fake-indexeddb/auto";
```

`packages/backend-indexeddb/src/index.ts`:
```ts
export { req, txDone, openDb, STORE_NAMES, SCHEMA_VERSION } from "./idb.js";
```

- [ ] **Step 2: Write the failing tests**

`packages/backend-indexeddb/test/idb-helpers.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { openDb, req, txDone, STORE_NAMES } from "../src/idb.js";
import { ulid } from "@wash/vfs";

describe("idb helpers", () => {
  it("openDb creates the four stores", async () => {
    const db = await openDb(`t-${ulid()}`);
    expect([...db.objectStoreNames].sort()).toEqual([...STORE_NAMES].sort());
    db.close();
  });

  it("req resolves with the request result and txDone resolves on commit", async () => {
    const db = await openDb(`t-${ulid()}`);
    const tx = db.transaction("meta", "readwrite");
    tx.objectStore("meta").put("world", "hello");
    const got = await req(tx.objectStore("meta").get("hello"));
    expect(got).toBe("world");
    await txDone(tx);
    db.close();
  });

  it("req rejects on a failing request", async () => {
    const db = await openDb(`t-${ulid()}`);
    const tx = db.transaction("meta", "readwrite");
    tx.objectStore("meta").add("a", "dup");
    await expect(req(tx.objectStore("meta").add("b", "dup"))).rejects.toBeTruthy();
    db.close();
  });

  it("reopening the same name preserves data (persistence smoke)", async () => {
    const name = `t-${ulid()}`;
    const db1 = await openDb(name);
    const tx1 = db1.transaction("meta", "readwrite");
    tx1.objectStore("meta").put(42, "answer");
    await txDone(tx1);
    db1.close();
    const db2 = await openDb(name);
    expect(await req(db2.transaction("meta").objectStore("meta").get("answer"))).toBe(42);
    db2.close();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm install && pnpm --filter @wash/backend-indexeddb test`
Expected: FAIL — `../src/idb.js` does not exist.

- [ ] **Step 4: Implement**

`packages/backend-indexeddb/src/idb.ts`:
```ts
export const STORE_NAMES = ["dirents", "inodes", "data", "meta"] as const;
export type StoreName = (typeof STORE_NAMES)[number];
export const SCHEMA_VERSION = 1;

export function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB request failed"));
  });
}

export function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export function openDb(name: string, factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, SCHEMA_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of STORE_NAMES) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @wash/backend-indexeddb test`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/backend-indexeddb pnpm-lock.yaml
git commit -m "feat(backend-indexeddb): package scaffold and IDB promise helpers"
```

---

### Task 2: Backend shell — open/root bootstrap, shared-transaction host, getattr/setattr, flush

**Files:**
- Create: `packages/backend-indexeddb/src/backend.ts`
- Modify: `packages/backend-indexeddb/src/index.ts`
- Test: `packages/backend-indexeddb/test/backend-shell.test.ts`

**Interfaces:**
- Consumes: Task 1 helpers; `WashBackend`, `BackendCaps`, `Attrs`, `NodeId`, `NodeKind`, `VfsError`, `ulid`, `CHUNK_SIZE` from `@wash/vfs`.
- Produces: `class IndexedDBBackend implements WashBackend` with `static async open(dbName: string, opts?: IndexedDBBackendOptions): Promise<IndexedDBBackend>`, `close(): void`, `root()`, `getattr`, `setattr`, `flush`, and the private machinery every later op uses: `withTx<T>(fn: (tx: IDBTransaction) => Promise<T>): Promise<T>` (shared-txn + retry-once-on-stale), `getInode(tx, id)` (ENOENT), `requireDir(tx, id)` (ENOTDIR), `defaultMode(kind)`. `IndexedDBBackendOptions = { durability?: "relaxed" | "strict"; factory?: IDBFactory; chunkSize?: number }`. Internal record types: `DirentRecord { name; childId; kind }`, `InodeRecord extends Attrs { target?: string }`.

- [ ] **Step 1: Write the failing tests**

`packages/backend-indexeddb/test/backend-shell.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { IndexedDBBackend } from "../src/backend.js";
import { ulid } from "@wash/vfs";

describe("IndexedDBBackend shell", () => {
  it("open bootstraps a root dir inode and persists it across reopen", async () => {
    const name = `sh-${ulid()}`;
    const be = await IndexedDBBackend.open(name);
    const root = await be.root();
    const attrs = await be.getattr(root);
    expect(attrs.kind).toBe("dir");
    expect(attrs.mode).toBe(0o755);
    be.close();
    const be2 = await IndexedDBBackend.open(name);
    expect(await be2.root()).toBe(root); // ids stable across sessions
    be2.close();
  });

  it("declares the required caps", async () => {
    const be = await IndexedDBBackend.open(`sh-${ulid()}`);
    expect(be.caps).toEqual({
      symlinks: "supported",
      hardlinks: true,
      atomicDirRename: true,
      renameCost: "O1",
    });
    be.close();
  });

  it("getattr of an unknown id throws ENOENT; setattr updates mode and mtime", async () => {
    const be = await IndexedDBBackend.open(`sh-${ulid()}`);
    await expect(be.getattr(ulid())).rejects.toMatchObject({ errno: "ENOENT" });
    const root = await be.root();
    await be.setattr(root, { mode: 0o700, mtimeMs: 12345 });
    const attrs = await be.getattr(root);
    expect(attrs.mode).toBe(0o700);
    expect(attrs.mtimeMs).toBe(12345);
    be.close();
  });

  it("flush resolves after pending work commits", async () => {
    const be = await IndexedDBBackend.open(`sh-${ulid()}`);
    await be.setattr(await be.root(), { mtimeMs: 1 });
    await be.flush();
    await be.flush(); // idempotent
    be.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @wash/backend-indexeddb test backend-shell`
Expected: FAIL — `../src/backend.js` missing.

- [ ] **Step 3: Implement**

`packages/backend-indexeddb/src/backend.ts`:
```ts
import type {
  Attrs, BackendCaps, Dirent, NodeId, NodeInfo, NodeKind, WashBackend,
} from "@wash/vfs";
import { CHUNK_SIZE, VfsError, ulid } from "@wash/vfs";
import { STORE_NAMES, SCHEMA_VERSION, openDb, req, txDone } from "./idb.js";

interface DirentRecord {
  name: string;
  childId: NodeId;
  kind: NodeKind;
}

interface InodeRecord extends Attrs {
  target?: string; // symlink target
}

export interface IndexedDBBackendOptions {
  durability?: "relaxed" | "strict";
  factory?: IDBFactory;
  chunkSize?: number;
}

export class IndexedDBBackend implements WashBackend {
  readonly caps: BackendCaps = {
    symlinks: "supported",
    hardlinks: true,
    atomicDirRename: true,
    renameCost: "O1",
  };

  private tx: IDBTransaction | null = null;
  private txCompletion: Promise<void> | null = null;

  private constructor(
    private readonly db: IDBDatabase,
    private readonly rootId: NodeId,
    private readonly durability: "relaxed" | "strict",
    readonly chunkSize: number,
  ) {}

  static async open(dbName: string, opts: IndexedDBBackendOptions = {}): Promise<IndexedDBBackend> {
    const db = await openDb(dbName, opts.factory ?? indexedDB);
    const tx = db.transaction(["inodes", "meta"], "readwrite");
    const meta = tx.objectStore("meta");
    let rootId = (await req(meta.get("rootId"))) as NodeId | undefined;
    if (!rootId) {
      rootId = ulid();
      const now = Date.now();
      const rootAttrs: InodeRecord = { kind: "dir", size: 0, mode: 0o755, mtimeMs: now, ctimeMs: now, nlink: 1 };
      tx.objectStore("inodes").put(rootAttrs, rootId);
      meta.put(rootId, "rootId");
      meta.put(SCHEMA_VERSION, "schemaVersion");
    }
    await txDone(tx);
    return new IndexedDBBackend(db, rootId, opts.durability ?? "relaxed", opts.chunkSize ?? CHUNK_SIZE);
  }

  close(): void {
    this.tx = null;
    this.db.close();
  }

  async root(): Promise<NodeId> {
    return this.rootId;
  }

  /**
   * Lazy shared readwrite transaction (spec §5: one txn per flush batch).
   * IndexedDB auto-commits a transaction only when control returns to the
   * event loop with no pending requests; CachedBackend's flush loop chains
   * ops through microtasks only, so one txn spans the whole batch.
   */
  private currentTx(): IDBTransaction {
    if (this.tx) return this.tx;
    let tx: IDBTransaction;
    try {
      tx = this.db.transaction(
        STORE_NAMES as unknown as string[],
        "readwrite",
        { durability: this.durability } as IDBTransactionOptions,
      );
    } catch {
      tx = this.db.transaction(STORE_NAMES as unknown as string[], "readwrite");
    }
    this.tx = tx;
    const completion = txDone(tx).finally(() => {
      if (this.tx === tx) this.tx = null;
      if (this.txCompletion === completion) this.txCompletion = null;
    });
    completion.catch(() => {}); // observed via flush(); avoid unhandled rejection
    this.txCompletion = completion;
    return tx;
  }

  /**
   * Run one contract op against the shared transaction. If the cached txn
   * already auto-committed (batch boundary), the op's first request throws
   * TransactionInactiveError/InvalidStateError — reset and retry the WHOLE
   * op once on a fresh txn. Ops must be restartable and must never await
   * anything but IDB requests (see plan Global Constraints).
   */
  private async withTx<T>(fn: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const tx = this.currentTx();
      try {
        return await fn(tx);
      } catch (e) {
        const errName = (e as { name?: string } | null)?.name;
        if (attempt === 0 && (errName === "TransactionInactiveError" || errName === "InvalidStateError")) {
          if (this.tx === tx) this.tx = null;
          continue;
        }
        throw e;
      }
    }
  }

  async flush(): Promise<void> {
    const completion = this.txCompletion;
    this.tx = null; // stop reusing; the pending txn auto-commits
    if (completion) await completion;
  }

  private async getInode(tx: IDBTransaction, id: NodeId): Promise<InodeRecord> {
    const rec = (await req(tx.objectStore("inodes").get(id))) as InodeRecord | undefined;
    if (!rec) throw new VfsError("ENOENT");
    return rec;
  }

  private async requireDir(tx: IDBTransaction, id: NodeId): Promise<InodeRecord> {
    const rec = await this.getInode(tx, id);
    if (rec.kind !== "dir") throw new VfsError("ENOTDIR");
    return rec;
  }

  private defaultMode(kind: NodeKind): number {
    return kind === "dir" ? 0o755 : kind === "symlink" ? 0o777 : 0o644;
  }

  private stripTarget(rec: InodeRecord): Attrs {
    const { target: _target, ...attrs } = rec;
    return attrs;
  }

  async getattr(id: NodeId): Promise<Attrs> {
    return this.withTx(async (tx) => this.stripTarget(await this.getInode(tx, id)));
  }

  async setattr(id: NodeId, attrs: Partial<Pick<Attrs, "mode" | "mtimeMs" | "ctimeMs">>): Promise<void> {
    return this.withTx(async (tx) => {
      const rec = await this.getInode(tx, id);
      Object.assign(rec, attrs);
      await req(tx.objectStore("inodes").put(rec, id));
    });
  }

  // Remaining contract ops land in Tasks 3–5.
  async lookup(): Promise<NodeInfo | null> { throw new VfsError("ENOSYS"); }
  async readdir(): Promise<Dirent[]> { throw new VfsError("ENOSYS"); }
  async read(): Promise<Uint8Array> { throw new VfsError("ENOSYS"); }
  async write(): Promise<void> { throw new VfsError("ENOSYS"); }
  async truncate(): Promise<void> { throw new VfsError("ENOSYS"); }
  async create(): Promise<void> { throw new VfsError("ENOSYS"); }
  async unlink(): Promise<void> { throw new VfsError("ENOSYS"); }
  async rename(): Promise<void> { throw new VfsError("ENOSYS"); }
}
```

Add to `packages/backend-indexeddb/src/index.ts`:
```ts
export { IndexedDBBackend } from "./backend.js";
export type { IndexedDBBackendOptions } from "./backend.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @wash/backend-indexeddb test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/backend-indexeddb
git commit -m "feat(backend-indexeddb): backend shell — root bootstrap, shared-txn host, getattr/setattr"
```

---

### Task 3: Namespace ops — create/lookup/readdir/readdirPlus

**Files:**
- Modify: `packages/backend-indexeddb/src/backend.ts`
- Test: `packages/backend-indexeddb/test/backend-namespace.test.ts`

**Interfaces:**
- Consumes: Task 2's `withTx`/`getInode`/`requireDir`/`defaultMode`/`stripTarget`.
- Produces: working `create(parent, name, id, kind, attrs?)` (EEXIST; ENOTDIR on file parent), `lookup` (null for missing), `readdir`, `readdirPlus`, plus the private key helpers every remaining op uses: `direntKey(parent, name): [NodeId, string]` and `direntRange(parent): IDBKeyRange` (compound-key range: lower `[parent]`, upper `[parent, []]` — IDB sorts arrays after strings, so this brackets exactly the `[parent, <string>]` keys; spec §5's readdir-in-one-round-trip lever).

- [ ] **Step 1: Write the failing tests**

`packages/backend-indexeddb/test/backend-namespace.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { IndexedDBBackend } from "../src/backend.js";
import { ulid } from "@wash/vfs";

describe("IndexedDBBackend namespace", () => {
  let be: IndexedDBBackend;
  let root: string;
  beforeEach(async () => {
    be = await IndexedDBBackend.open(`ns-${ulid()}`);
    root = await be.root();
  });

  it("creates and looks up a file with default attrs", async () => {
    const id = ulid();
    await be.create(root, "a.txt", id, "file");
    const info = await be.lookup(root, "a.txt");
    expect(info?.id).toBe(id);
    expect(info?.attrs).toMatchObject({ kind: "file", size: 0, mode: 0o644, nlink: 1 });
  });

  it("lookup of a missing name returns null; EEXIST on duplicate create; ENOTDIR on file parent", async () => {
    expect(await be.lookup(root, "nope")).toBeNull();
    const f = ulid();
    await be.create(root, "f", f, "file");
    await expect(be.create(root, "f", ulid(), "file")).rejects.toMatchObject({ errno: "EEXIST" });
    await expect(be.create(f, "child", ulid(), "file")).rejects.toMatchObject({ errno: "ENOTDIR" });
    await expect(be.readdir(f)).rejects.toMatchObject({ errno: "ENOTDIR" });
  });

  it("readdir returns the whole directory in one shot", async () => {
    const d = ulid();
    await be.create(root, "dir", d, "dir");
    for (const n of ["x", "y", "z"]) await be.create(d, n, ulid(), "file");
    expect((await be.readdir(d)).map((e) => e.name).sort()).toEqual(["x", "y", "z"]);
    expect(await be.readdir(root)).toHaveLength(1);
  });

  it("readdir range does not bleed across sibling directories", async () => {
    const d1 = ulid();
    const d2 = ulid();
    await be.create(root, "d1", d1, "dir");
    await be.create(root, "d2", d2, "dir");
    await be.create(d1, "only-in-d1", ulid(), "file");
    expect(await be.readdir(d2)).toEqual([]);
  });

  it("readdirPlus returns entries with attrs", async () => {
    await be.create(root, "f", ulid(), "file");
    const plus = await be.readdirPlus!(root);
    expect(plus).toHaveLength(1);
    expect(plus[0]!.name).toBe("f");
    expect(plus[0]!.attrs.kind).toBe("file");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @wash/backend-indexeddb test backend-namespace`
Expected: FAIL — ENOSYS from Task 2 stubs.

- [ ] **Step 3: Implement (replace the create/lookup/readdir stubs; add readdirPlus + helpers)**

```ts
  private direntKey(parent: NodeId, name: string): [NodeId, string] {
    return [parent, name];
  }

  /** All dirent keys of one directory. IDB array-key ordering: [parent] sorts
   * before every [parent, <string>], and [parent, []] sorts after (arrays sort
   * after strings), so this range brackets exactly the directory's entries. */
  private direntRange(parent: NodeId): IDBKeyRange {
    return IDBKeyRange.bound([parent], [parent, []]);
  }

  async lookup(parent: NodeId, name: string): Promise<NodeInfo | null> {
    return this.withTx(async (tx) => {
      await this.requireDir(tx, parent);
      const d = (await req(tx.objectStore("dirents").get(this.direntKey(parent, name)))) as DirentRecord | undefined;
      if (!d) return null;
      return { id: d.childId, attrs: this.stripTarget(await this.getInode(tx, d.childId)) };
    });
  }

  async readdir(id: NodeId): Promise<Dirent[]> {
    return this.withTx(async (tx) => {
      await this.requireDir(tx, id);
      const vals = (await req(tx.objectStore("dirents").getAll(this.direntRange(id)))) as DirentRecord[];
      return vals.map((v) => ({ name: v.name, childId: v.childId, kind: v.kind }));
    });
  }

  async readdirPlus(id: NodeId): Promise<(Dirent & { attrs: Attrs })[]> {
    return this.withTx(async (tx) => {
      await this.requireDir(tx, id);
      const vals = (await req(tx.objectStore("dirents").getAll(this.direntRange(id)))) as DirentRecord[];
      const out: (Dirent & { attrs: Attrs })[] = [];
      for (const v of vals) {
        out.push({ name: v.name, childId: v.childId, kind: v.kind, attrs: this.stripTarget(await this.getInode(tx, v.childId)) });
      }
      return out;
    });
  }

  async create(parent: NodeId, name: string, id: NodeId, kind: NodeKind, attrs?: Partial<Attrs>): Promise<void> {
    return this.withTx(async (tx) => {
      await this.requireDir(tx, parent);
      const existing = await req(tx.objectStore("dirents").get(this.direntKey(parent, name)));
      if (existing) throw new VfsError("EEXIST", name);
      const now = Date.now();
      const rec: InodeRecord = {
        kind, size: 0, mode: this.defaultMode(kind), mtimeMs: now, ctimeMs: now, nlink: 1, ...attrs,
      };
      await req(tx.objectStore("inodes").put(rec, id));
      const dirent: DirentRecord = { name, childId: id, kind };
      await req(tx.objectStore("dirents").put(dirent, this.direntKey(parent, name)));
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @wash/backend-indexeddb test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/backend-indexeddb
git commit -m "feat(backend-indexeddb): namespace ops with compound-key dirent ranges"
```

---

### Task 4: Content ops — chunked read/write/truncate

**Files:**
- Modify: `packages/backend-indexeddb/src/backend.ts`
- Test: `packages/backend-indexeddb/test/backend-content.test.ts`

**Interfaces:**
- Consumes: Tasks 2–3.
- Produces: `read(id, offset, length)` (short at EOF; sparse chunks read as zeros), `write(id, offset, data)` (chunk-aligned read-modify-write, full-chunk overwrites skip the read, size/mtime maintained, zero-length writes still touch mtime), `truncate(id, size)` (range-delete dropped chunks, trim boundary chunk, sparse extend), private `chunkRange(id, first?, last?)` and `requireFile(tx, id)` (EISDIR). All content addressed at `this.chunkSize` granularity.

- [ ] **Step 1: Write the failing tests**

`packages/backend-indexeddb/test/backend-content.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { IndexedDBBackend } from "../src/backend.js";
import { ulid } from "@wash/vfs";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("IndexedDBBackend content (small chunkSize to exercise boundaries)", () => {
  let be: IndexedDBBackend;
  let root: string;
  let file: string;
  beforeEach(async () => {
    be = await IndexedDBBackend.open(`ct-${ulid()}`, { chunkSize: 8 });
    root = await be.root();
    file = ulid();
    await be.create(root, "f", file, "file");
  });

  it("writes and reads across chunk boundaries", async () => {
    await be.write(file, 0, enc.encode("0123456789abcdef-tail")); // 21 bytes over 8-byte chunks
    expect(dec.decode(await be.read(file, 0, 100))).toBe("0123456789abcdef-tail");
    expect(dec.decode(await be.read(file, 6, 6))).toBe("6789ab"); // straddles chunk 0→1
    expect((await be.getattr(file)).size).toBe(21);
  });

  it("offset write past EOF zero-fills the gap (sparse chunks read as zeros)", async () => {
    await be.write(file, 20, enc.encode("end")); // chunks 0-1 never written
    const out = await be.read(file, 0, 23);
    expect(out.byteLength).toBe(23);
    expect([...out.slice(0, 20)]).toEqual(new Array(20).fill(0));
    expect(dec.decode(out.slice(20))).toBe("end");
  });

  it("read past EOF returns short result; empty file reads empty", async () => {
    await be.write(file, 0, enc.encode("hi"));
    expect((await be.read(file, 1, 100)).byteLength).toBe(1);
    expect((await be.read(file, 5, 100)).byteLength).toBe(0);
  });

  it("partial mid-file overwrite preserves surrounding bytes", async () => {
    await be.write(file, 0, enc.encode("aaaaaaaaaaaaaaaa")); // 2 full chunks
    await be.write(file, 7, enc.encode("XY")); // straddles the boundary
    expect(dec.decode(await be.read(file, 0, 100))).toBe("aaaaaaaXYaaaaaaa");
  });

  it("truncate shrinks (trimming the boundary chunk) and extends sparsely", async () => {
    await be.write(file, 0, enc.encode("0123456789abcdef"));
    await be.truncate(file, 10);
    expect(dec.decode(await be.read(file, 0, 100))).toBe("0123456789");
    await be.truncate(file, 12);
    const out = await be.read(file, 0, 100);
    expect(out.byteLength).toBe(12);
    expect([...out.slice(10)]).toEqual([0, 0]);
  });

  it("truncate to zero then rewrite works; read/write on a dir throws EISDIR", async () => {
    await be.write(file, 0, enc.encode("data"));
    await be.truncate(file, 0);
    expect((await be.read(file, 0, 100)).byteLength).toBe(0);
    await be.write(file, 0, enc.encode("new"));
    expect(dec.decode(await be.read(file, 0, 100))).toBe("new");
    await expect(be.read(root, 0, 1)).rejects.toMatchObject({ errno: "EISDIR" });
    await expect(be.write(root, 0, enc.encode("x"))).rejects.toMatchObject({ errno: "EISDIR" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @wash/backend-indexeddb test backend-content`
Expected: FAIL — ENOSYS stubs.

- [ ] **Step 3: Implement (replace read/write/truncate stubs; add helpers)**

```ts
  private chunkRange(id: NodeId, first = 0, last: number = Infinity): IDBKeyRange {
    return IDBKeyRange.bound([id, first], [id, last]);
  }

  private async requireFile(tx: IDBTransaction, id: NodeId): Promise<InodeRecord> {
    const rec = await this.getInode(tx, id);
    if (rec.kind === "dir") throw new VfsError("EISDIR");
    return rec;
  }

  async read(id: NodeId, offset: number, length: number): Promise<Uint8Array> {
    return this.withTx(async (tx) => {
      const rec = await this.requireFile(tx, id);
      if (offset >= rec.size || length === 0) return new Uint8Array(0);
      const end = Math.min(offset + length, rec.size);
      const out = new Uint8Array(end - offset); // zero-initialized: sparse chunks stay zeros
      const first = Math.floor(offset / this.chunkSize);
      const last = Math.floor((end - 1) / this.chunkSize);
      const store = tx.objectStore("data");
      const range = this.chunkRange(id, first, last);
      const keysReq = store.getAllKeys(range);
      const valsReq = store.getAll(range);
      const keys = (await req(keysReq)) as [NodeId, number][];
      const vals = (await req(valsReq)) as Uint8Array[];
      for (let i = 0; i < keys.length; i++) {
        const idx = keys[i]![1];
        const chunk = vals[i]!;
        const chunkStart = idx * this.chunkSize;
        const from = Math.max(offset, chunkStart);
        const to = Math.min(end, chunkStart + chunk.byteLength);
        if (to > from) out.set(chunk.subarray(from - chunkStart, to - chunkStart), from - offset);
      }
      return out;
    });
  }

  async write(id: NodeId, offset: number, data: Uint8Array): Promise<void> {
    return this.withTx(async (tx) => {
      const rec = await this.requireFile(tx, id);
      const store = tx.objectStore("data");
      const end = offset + data.byteLength;
      if (data.byteLength > 0) {
        const first = Math.floor(offset / this.chunkSize);
        const last = Math.floor((end - 1) / this.chunkSize);
        for (let idx = first; idx <= last; idx++) {
          const chunkStart = idx * this.chunkSize;
          const from = Math.max(offset, chunkStart);
          const to = Math.min(end, chunkStart + this.chunkSize);
          const slice = data.subarray(from - offset, to - offset);
          let chunk: Uint8Array;
          if (slice.byteLength === this.chunkSize) {
            chunk = slice.slice(); // full-chunk overwrite: skip the read
          } else {
            const existing = (await req(store.get([id, idx]))) as Uint8Array | undefined;
            const size = Math.max(existing?.byteLength ?? 0, to - chunkStart);
            chunk = new Uint8Array(size);
            if (existing) chunk.set(existing, 0);
            chunk.set(slice, from - chunkStart);
          }
          await req(store.put(chunk, [id, idx]));
        }
      }
      if (end > rec.size) rec.size = end;
      rec.mtimeMs = Date.now();
      await req(tx.objectStore("inodes").put(rec, id));
    });
  }

  async truncate(id: NodeId, size: number): Promise<void> {
    return this.withTx(async (tx) => {
      const rec = await this.requireFile(tx, id);
      const store = tx.objectStore("data");
      if (size < rec.size) {
        const lastKeep = size === 0 ? -1 : Math.floor((size - 1) / this.chunkSize);
        await req(store.delete(this.chunkRange(id, lastKeep + 1)));
        if (lastKeep >= 0) {
          const boundary = (await req(store.get([id, lastKeep]))) as Uint8Array | undefined;
          const keep = size - lastKeep * this.chunkSize;
          if (boundary && boundary.byteLength > keep) {
            await req(store.put(boundary.slice(0, keep), [id, lastKeep]));
          }
        }
      }
      rec.size = size; // extend is sparse: missing chunks read as zeros
      rec.mtimeMs = Date.now();
      await req(tx.objectStore("inodes").put(rec, id));
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @wash/backend-indexeddb test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/backend-indexeddb
git commit -m "feat(backend-indexeddb): chunked content ops with sparse support"
```

---

### Task 5: unlink + GC, POSIX rename, hardlinks and symlinks

**Files:**
- Modify: `packages/backend-indexeddb/src/backend.ts`
- Test: `packages/backend-indexeddb/test/backend-links.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces: `unlink` (ENOENT / ENOTEMPTY; nlink decrement; inode + chunk-range GC at 0), `rename` (same-inode no-op; EISDIR/ENOTDIR/ENOTEMPTY overwrite semantics; displaced-node GC; single-dirent O(1)), `link` (**EEXIST before EPERM**; nlink++), `symlink`/`readlink` (target stored on the inode record; EINVAL on non-symlink). Private `dirHasChildren(tx, id)` (limit-1 getAllKeys) and `gcInode(tx, id, rec)`.

- [ ] **Step 1: Write the failing tests**

`packages/backend-indexeddb/test/backend-links.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { IndexedDBBackend } from "../src/backend.js";
import { ulid } from "@wash/vfs";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("IndexedDBBackend unlink/rename/links", () => {
  let be: IndexedDBBackend;
  let root: string;
  beforeEach(async () => {
    be = await IndexedDBBackend.open(`ln-${ulid()}`, { chunkSize: 8 });
    root = await be.root();
  });

  it("unlink GCs the inode and its chunks; ENOTEMPTY for full dirs", async () => {
    const f = ulid();
    await be.create(root, "f", f, "file");
    await be.write(f, 0, enc.encode("0123456789")); // 2 chunks
    await be.unlink(root, "f");
    expect(await be.lookup(root, "f")).toBeNull();
    await expect(be.getattr(f)).rejects.toMatchObject({ errno: "ENOENT" });
    const d = ulid();
    await be.create(root, "d", d, "dir");
    await be.create(d, "kid", ulid(), "file");
    await expect(be.unlink(root, "d")).rejects.toMatchObject({ errno: "ENOTEMPTY" });
    await be.unlink(d, "kid");
    await be.unlink(root, "d"); // empty now
    expect(await be.lookup(root, "d")).toBeNull();
  });

  it("hardlinks share content; GC only at nlink 0; EEXIST beats EPERM on double-fault link", async () => {
    const f = ulid();
    await be.create(root, "a", f, "file");
    await be.write(f, 0, enc.encode("shared"));
    await be.link!(root, "b", f);
    expect((await be.getattr(f)).nlink).toBe(2);
    await be.unlink(root, "a");
    expect(dec.decode(await be.read(f, 0, 100))).toBe("shared");
    const d = ulid();
    await be.create(root, "d", d, "dir");
    await expect(be.link!(root, "b", d)).rejects.toMatchObject({ errno: "EEXIST" }); // name taken AND dir target
    await expect(be.link!(root, "c", d)).rejects.toMatchObject({ errno: "EPERM" });
    await be.unlink(root, "b");
    await expect(be.getattr(f)).rejects.toMatchObject({ errno: "ENOENT" });
  });

  it("rename moves a dirent; same-inode rename is a POSIX no-op", async () => {
    const f = ulid();
    await be.create(root, "a", f, "file");
    await be.link!(root, "b", f);
    await be.rename(root, "a", root, "b");
    expect((await be.lookup(root, "a"))?.id).toBe(f);
    expect((await be.lookup(root, "b"))?.id).toBe(f);
    expect((await be.getattr(f)).nlink).toBe(2);
    await be.rename(root, "a", root, "c");
    expect(await be.lookup(root, "a")).toBeNull();
    expect((await be.lookup(root, "c"))?.id).toBe(f);
  });

  it("rename overwrite semantics: file over file GCs displaced; dir-over-nonempty ENOTEMPTY; file-over-dir EISDIR; dir-over-file ENOTDIR", async () => {
    const f1 = ulid();
    const f2 = ulid();
    await be.create(root, "f1", f1, "file");
    await be.create(root, "f2", f2, "file");
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
  });

  it("symlink stores target on the inode; readlink EINVAL on non-symlink", async () => {
    const s = ulid();
    await be.symlink!(root, "ln", s, "/target");
    expect((await be.lookup(root, "ln"))?.attrs.kind).toBe("symlink");
    expect(await be.readlink!(s)).toBe("/target");
    const f = ulid();
    await be.create(root, "f", f, "file");
    await expect(be.readlink!(f)).rejects.toMatchObject({ errno: "EINVAL" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @wash/backend-indexeddb test backend-links`
Expected: FAIL — ENOSYS / missing optional methods.

- [ ] **Step 3: Implement (replace unlink/rename stubs; add link/symlink/readlink + helpers)**

```ts
  private async dirHasChildren(tx: IDBTransaction, id: NodeId): Promise<boolean> {
    const keys = await req(tx.objectStore("dirents").getAllKeys(this.direntRange(id), 1));
    return keys.length > 0;
  }

  private async gcInode(tx: IDBTransaction, id: NodeId, rec: InodeRecord): Promise<void> {
    rec.nlink -= 1;
    if (rec.nlink <= 0) {
      await req(tx.objectStore("inodes").delete(id));
      await req(tx.objectStore("data").delete(this.chunkRange(id)));
    } else {
      await req(tx.objectStore("inodes").put(rec, id));
    }
  }

  async unlink(parent: NodeId, name: string): Promise<void> {
    return this.withTx(async (tx) => {
      await this.requireDir(tx, parent);
      const d = (await req(tx.objectStore("dirents").get(this.direntKey(parent, name)))) as DirentRecord | undefined;
      if (!d) throw new VfsError("ENOENT", name);
      const child = await this.getInode(tx, d.childId);
      if (child.kind === "dir") {
        if (await this.dirHasChildren(tx, d.childId)) throw new VfsError("ENOTEMPTY", name);
        await req(tx.objectStore("inodes").delete(d.childId));
      } else {
        await this.gcInode(tx, d.childId, child);
      }
      await req(tx.objectStore("dirents").delete(this.direntKey(parent, name)));
    });
  }

  async rename(fromParent: NodeId, fromName: string, toParent: NodeId, toName: string): Promise<void> {
    return this.withTx(async (tx) => {
      await this.requireDir(tx, fromParent);
      await this.requireDir(tx, toParent);
      const dirents = tx.objectStore("dirents");
      const moving = (await req(dirents.get(this.direntKey(fromParent, fromName)))) as DirentRecord | undefined;
      if (!moving) throw new VfsError("ENOENT", fromName);
      const displaced = (await req(dirents.get(this.direntKey(toParent, toName)))) as DirentRecord | undefined;
      if (displaced) {
        if (displaced.childId === moving.childId) return; // POSIX same-inode no-op
        const exNode = await this.getInode(tx, displaced.childId);
        const mvNode = await this.getInode(tx, moving.childId);
        if (exNode.kind === "dir") {
          if (mvNode.kind !== "dir") throw new VfsError("EISDIR", toName);
          if (await this.dirHasChildren(tx, displaced.childId)) throw new VfsError("ENOTEMPTY", toName);
          await req(tx.objectStore("inodes").delete(displaced.childId));
        } else {
          if (mvNode.kind === "dir") throw new VfsError("ENOTDIR", toName);
          await this.gcInode(tx, displaced.childId, exNode);
        }
      }
      await req(dirents.delete(this.direntKey(fromParent, fromName)));
      const next: DirentRecord = { ...moving, name: toName };
      await req(dirents.put(next, this.direntKey(toParent, toName)));
    });
  }

  async symlink(parent: NodeId, name: string, id: NodeId, target: string): Promise<void> {
    return this.withTx(async (tx) => {
      await this.requireDir(tx, parent);
      const existing = await req(tx.objectStore("dirents").get(this.direntKey(parent, name)));
      if (existing) throw new VfsError("EEXIST", name);
      const now = Date.now();
      const rec: InodeRecord = {
        kind: "symlink", size: target.length, mode: 0o777, mtimeMs: now, ctimeMs: now, nlink: 1, target,
      };
      await req(tx.objectStore("inodes").put(rec, id));
      const dirent: DirentRecord = { name, childId: id, kind: "symlink" };
      await req(tx.objectStore("dirents").put(dirent, this.direntKey(parent, name)));
    });
  }

  async readlink(id: NodeId): Promise<string> {
    return this.withTx(async (tx) => {
      const rec = await this.getInode(tx, id);
      if (rec.kind !== "symlink" || rec.target === undefined) throw new VfsError("EINVAL");
      return rec.target;
    });
  }

  async link(parent: NodeId, name: string, id: NodeId): Promise<void> {
    return this.withTx(async (tx) => {
      await this.requireDir(tx, parent);
      const existing = await req(tx.objectStore("dirents").get(this.direntKey(parent, name)));
      if (existing) throw new VfsError("EEXIST", name); // EEXIST before EPERM (contract precedence)
      const rec = await this.getInode(tx, id);
      if (rec.kind === "dir") throw new VfsError("EPERM", name);
      rec.nlink += 1;
      await req(tx.objectStore("inodes").put(rec, id));
      const dirent: DirentRecord = { name, childId: id, kind: rec.kind };
      await req(tx.objectStore("dirents").put(dirent, this.direntKey(parent, name)));
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @wash/backend-indexeddb test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/backend-indexeddb
git commit -m "feat(backend-indexeddb): unlink GC, POSIX rename, hardlinks and symlinks"
```

---

### Task 6: Conformance (Node) + persistence-across-reopen

**Files:**
- Create: `packages/backend-indexeddb/test/conformance-idb.test.ts`, `packages/backend-indexeddb/test/persistence.test.ts`

**Interfaces:**
- Consumes: the published conformance suite (`@wash/vfs/conformance` → `runBackendConformance`), `CachedBackend` from `@wash/vfs`, the complete backend from Tasks 2–5.
- Produces: the Plan-2 conformance gate — raw and CachedBackend-wrapped variants green in Node; a persistence test pinning cross-session id stability and content survival. Any conformance failure is fixed **in the backend** in this task (the suite is the contract).

- [ ] **Step 1: Write the conformance runner**

`packages/backend-indexeddb/test/conformance-idb.test.ts`:
```ts
import { runBackendConformance } from "@wash/vfs/conformance";
import { CachedBackend, ulid } from "@wash/vfs";
import { IndexedDBBackend } from "../src/backend.js";

runBackendConformance("IndexedDBBackend", () => IndexedDBBackend.open(`conf-${ulid()}`));

runBackendConformance(
  "CachedBackend(IndexedDBBackend, writeback)",
  async () => new CachedBackend(await IndexedDBBackend.open(`confc-${ulid()}`), { flushDelayMs: 1 }),
);
```

- [ ] **Step 2: Run it; fix any backend nonconformance until green**

Run: `pnpm --filter @wash/backend-indexeddb test conformance-idb`
Expected: eventually PASS (2 × full suite; the reserved-names case skips — this backend declares none). Every failure is a backend bug: fix it in `src/backend.ts` and note each fix in the commit message. Do not weaken the suite.

- [ ] **Step 3: Write the persistence tests**

`packages/backend-indexeddb/test/persistence.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { IndexedDBBackend } from "../src/backend.js";
import { ulid } from "@wash/vfs";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("persistence across reopen", () => {
  it("namespace, content, links, and ids survive close/reopen", async () => {
    const name = `persist-${ulid()}`;
    const be = await IndexedDBBackend.open(name, { chunkSize: 8 });
    const root = await be.root();
    const d = ulid();
    const f = ulid();
    await be.create(root, "dir", d, "dir");
    await be.create(d, "file.txt", f, "file");
    await be.write(f, 0, enc.encode("persisted content"));
    await be.link!(d, "hard", f);
    await be.symlink!(root, "ln", ulid(), "/dir/file.txt");
    await be.flush();
    be.close();

    const be2 = await IndexedDBBackend.open(name, { chunkSize: 8 });
    expect(await be2.root()).toBe(root);
    expect((await be2.lookup(root, "dir"))?.id).toBe(d);
    expect((await be2.lookup(d, "file.txt"))?.id).toBe(f);
    expect(dec.decode(await be2.read(f, 0, 100))).toBe("persisted content");
    expect((await be2.getattr(f)).nlink).toBe(2);
    expect(await be2.readlink!((await be2.lookup(root, "ln"))!.id)).toBe("/dir/file.txt");
    be2.close();
  });

  it("uncommitted shared-txn work still lands once control returns to the event loop", async () => {
    const name = `persist2-${ulid()}`;
    const be = await IndexedDBBackend.open(name);
    const root = await be.root();
    await be.create(root, "x", ulid(), "file");
    // no explicit flush(): the shared txn auto-commits at the macrotask boundary
    await new Promise((r) => setTimeout(r, 0));
    be.close();
    const be2 = await IndexedDBBackend.open(name);
    expect((await be2.lookup(root, "x"))?.attrs.kind).toBe("file");
    be2.close();
  });
});
```

- [ ] **Step 4: Run the full package suite**

Run: `pnpm --filter @wash/backend-indexeddb test && pnpm turbo build test typecheck`
Expected: all green (conformance ×2, persistence, all prior tasks; monorepo pipeline green).

- [ ] **Step 5: Commit**

```bash
git add packages/backend-indexeddb
git commit -m "test(backend-indexeddb): conformance suite green (raw + cached) and persistence coverage"
```

---

### Task 7: Metadata warming — `dump()` on the backend, `warm()` on CachedBackend

**Files:**
- Modify: `packages/vfs/src/types.ts`, `packages/vfs/src/cache/cached-backend.ts`, `packages/vfs/src/index.ts`, `packages/backend-indexeddb/src/backend.ts`
- Test: `packages/vfs/test/cached-warm.test.ts`, `packages/backend-indexeddb/test/warm.test.ts`

**Interfaces:**
- Consumes: everything prior.
- Produces (spec §5 performance lever #2):
  - `@wash/vfs` `types.ts`: `interface BackendDump { inodes: { id: NodeId; attrs: Attrs }[]; dirents: { parentId: NodeId; name: string; childId: NodeId; kind: NodeKind }[] }`, and optional `dump?(): Promise<BackendDump>` on `WashBackend`. Export `BackendDump` from the index.
  - `CachedBackend.warm(dump: BackendDump): void` — bulk-primes attrCache, lookupCache, and readdirCache (empty dirs get empty maps, so warmed readdirs never touch inner). Throws `VfsError("EINVAL")` if the cache is not clean (`pendingOps() > 0` or dirty buffers exist) — warm is a mount-time operation.
  - `IndexedDBBackend.dump()` — two `getAll` + two `getAllKeys` bulk reads (one txn).

- [ ] **Step 1: Write the failing tests**

`packages/vfs/test/cached-warm.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { CachedBackend } from "../src/cache/cached-backend.js";
import { MemoryBackend } from "../src/backend/memory.js";
import { ulid } from "../src/ulid.js";
import type { BackendDump } from "../src/types.js";

describe("CachedBackend.warm", () => {
  it("primes all caches so metadata reads never touch inner", async () => {
    const inner = new MemoryBackend();
    const root = await inner.root();
    const d = ulid();
    const f = ulid();
    await inner.create(root, "dir", d, "dir");
    await inner.create(d, "f.txt", f, "file");
    const dump: BackendDump = {
      inodes: [
        { id: root, attrs: await inner.getattr(root) },
        { id: d, attrs: await inner.getattr(d) },
        { id: f, attrs: await inner.getattr(f) },
      ],
      dirents: [
        { parentId: root, name: "dir", childId: d, kind: "dir" },
        { parentId: d, name: "f.txt", childId: f, kind: "file" },
      ],
    };
    const be = new CachedBackend(inner);
    be.warm(dump);
    const lookupSpy = vi.spyOn(inner, "lookup");
    const getattrSpy = vi.spyOn(inner, "getattr");
    const readdirSpy = vi.spyOn(inner, "readdir");
    expect((await be.lookup(root, "dir"))?.id).toBe(d);
    expect((await be.getattr(f)).kind).toBe("file");
    expect((await be.readdir(d)).map((x) => x.name)).toEqual(["f.txt"]);
    expect(await be.readdir(f).catch((e) => e)).toMatchObject({ errno: "ENOTDIR" });
    expect(await be.lookup(root, "ghost")).toBeNull(); // warmed dirs are complete → negative without inner
    expect(lookupSpy).toHaveBeenCalledTimes(0);
    expect(getattrSpy).toHaveBeenCalledTimes(0);
    expect(readdirSpy).toHaveBeenCalledTimes(0);
  });

  it("refuses to warm a dirty cache", async () => {
    const inner = new MemoryBackend();
    const be = new CachedBackend(inner, { flushDelayMs: 60_000 });
    const root = await be.root();
    await be.create(root, "pending", ulid(), "file");
    expect(() => be.warm({ inodes: [], dirents: [] })).toThrowError(/EINVAL/);
  });
});
```

Note the fifth assertion: `lookup(root, "ghost")` must return `null` with zero inner calls — warming marks every dumped directory's readdir map as **complete**, so a name absent from a complete map is a definitive miss. Implement that by having `lookup()` consult the parent's `readdirCache` map before falling through to inner: if the parent's map exists and lacks the name, cache and return the negative without an inner call. (This is also a small win for the non-warm path and must not break any existing cached-read test.)

`packages/backend-indexeddb/test/warm.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { IndexedDBBackend } from "../src/backend.js";
import { CachedBackend, ulid } from "@wash/vfs";

describe("IndexedDBBackend.dump + CachedBackend.warm", () => {
  it("dump round-trips the full namespace into a warm cache", async () => {
    const be = await IndexedDBBackend.open(`warm-${ulid()}`);
    const root = await be.root();
    const d = ulid();
    await be.create(root, "src", d, "dir");
    for (let i = 0; i < 25; i++) await be.create(d, `file-${i}.ts`, ulid(), "file");
    const dump = await be.dump!();
    expect(dump.inodes.length).toBe(27); // root + dir + 25 files
    expect(dump.dirents.length).toBe(26);
    const cached = new CachedBackend(be);
    cached.warm(dump);
    expect((await cached.readdir(d)).length).toBe(25);
    expect((await cached.lookup(root, "src"))?.id).toBe(d);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @wash/vfs test cached-warm`
Expected: FAIL — `warm` does not exist / `BackendDump` not exported.

- [ ] **Step 3: Implement**

`packages/vfs/src/types.ts` — add:
```ts
export interface BackendDump {
  inodes: { id: NodeId; attrs: Attrs }[];
  dirents: { parentId: NodeId; name: string; childId: NodeId; kind: NodeKind }[];
}
```
and to `WashBackend`:
```ts
  /** Optional bulk namespace export for mount-time cache warming (spec §5). */
  dump?(): Promise<BackendDump>;
```

`packages/vfs/src/cache/cached-backend.ts` — add (adapt private-name references to the file's actual fields; `key()` is the existing parent+"\0"+name helper):
```ts
  /**
   * Bulk-prime all metadata caches from a backend dump (mount-time warming,
   * spec §5). After warming, every lookup/getattr/readdir — including
   * negative lookups in dumped directories — is served from memory.
   */
  warm(dump: BackendDump): void {
    if (this.queue.length > 0 || this.dirtyData.size > 0) {
      throw new VfsError("EINVAL", "warm() requires a clean cache");
    }
    for (const { id, attrs } of dump.inodes) {
      this.attrCache.set(id, { ...attrs });
      if (attrs.kind === "dir" && !this.readdirCache.has(id)) {
        this.readdirCache.set(id, new Map());
      }
    }
    for (const d of dump.dirents) {
      this.lookupCache.set(this.key(d.parentId, d.name), { id: d.childId, kind: d.kind });
      this.readdirCache.get(d.parentId)?.set(d.name, { name: d.name, childId: d.childId, kind: d.kind });
    }
  }
```
And in `lookup()`, before the inner fall-through on a cache miss: if `this.readdirCache.get(parent)` exists and does not contain `name`, set the negative entry and return `null` (a complete directory map is authoritative for absences).

`packages/vfs/src/index.ts`: ensure `BackendDump` is exported (it is if `export * from "./types.js"` already exists — verify).

`packages/backend-indexeddb/src/backend.ts` — add:
```ts
  async dump(): Promise<BackendDump> {
    return this.withTx(async (tx) => {
      const inodeStore = tx.objectStore("inodes");
      const direntStore = tx.objectStore("dirents");
      const inodeKeysReq = inodeStore.getAllKeys();
      const inodeValsReq = inodeStore.getAll();
      const direntKeysReq = direntStore.getAllKeys();
      const direntValsReq = direntStore.getAll();
      const inodeKeys = (await req(inodeKeysReq)) as NodeId[];
      const inodeVals = (await req(inodeValsReq)) as InodeRecord[];
      const direntKeys = (await req(direntKeysReq)) as [NodeId, string][];
      const direntVals = (await req(direntValsReq)) as DirentRecord[];
      return {
        inodes: inodeKeys.map((id, i) => ({ id, attrs: this.stripTarget(inodeVals[i]!) })),
        dirents: direntKeys.map((k, i) => ({
          parentId: k[0], name: k[1], childId: direntVals[i]!.childId, kind: direntVals[i]!.kind,
        })),
      };
    });
  }
```
(with `BackendDump` added to the `@wash/vfs` type imports).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm turbo build test typecheck`
Expected: all green — including every pre-existing `@wash/vfs` test (the lookup change must not regress the spy tests).

- [ ] **Step 5: Commit**

```bash
git add packages/vfs packages/backend-indexeddb
git commit -m "feat(vfs,backend-indexeddb): mount-time metadata warming via dump()/warm()"
```

---

### Task 8: Real-browser conformance — vitest browser mode (Chromium)

**Files:**
- Create: `packages/backend-indexeddb/vitest.browser.config.ts`
- Modify: `packages/backend-indexeddb/package.json` (devDeps), `turbo.json`
- Test: existing suites, executed in Chromium.

**Interfaces:**
- Consumes: all package tests (they use only `indexedDB`, `crypto`, TextEncoder — browser-safe; the Node-only `setup.node.ts` is excluded here so real `indexedDB` is used).
- Produces: `pnpm --filter @wash/backend-indexeddb test:browser` running the full test directory (helpers, backend, conformance ×2, persistence, warm) against real Chromium IndexedDB; a `test:browser` turbo task outside the default pipeline.

- [ ] **Step 1: Add dev dependencies and config**

Run: `pnpm --filter @wash/backend-indexeddb add -D @vitest/browser playwright && pnpm exec playwright install chromium`

`packages/backend-indexeddb/vitest.browser.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    browser: {
      enabled: true,
      headless: true,
      provider: "playwright",
      instances: [{ browser: "chromium" }],
    },
  },
});
```
(No `setupFiles` — the browser has real `indexedDB`. If the installed vitest 3.x minor rejects `instances`, use the equivalent `browser.name: "chromium"` form per the vitest 3 docs — note which form was used in the commit message.)

`turbo.json` — add to `tasks`:
```json
    "test:browser": { "dependsOn": ["^build"], "cache": false }
```

- [ ] **Step 2: Run in Chromium**

Run: `pnpm --filter @wash/backend-indexeddb test:browser`
Expected: PASS — same counts as the Node run. If a test passes in Node but fails in Chromium, the difference is a real backend bug against real IDB semantics (most likely transaction-lifetime related): fix it in `src/backend.ts`, re-run BOTH `test` and `test:browser`, and document the divergence in the commit message.

- [ ] **Step 3: Verify the default pipeline is unaffected**

Run: `pnpm turbo build test typecheck`
Expected: green; `test:browser` is not part of it.

- [ ] **Step 4: Commit**

```bash
git add packages/backend-indexeddb turbo.json pnpm-lock.yaml
git commit -m "test(backend-indexeddb): real-Chromium conformance via vitest browser mode"
```

---

### Task 9: apps/bench — first benchmark matrix + chunk-size sweep

**Files:**
- Create: `apps/bench/package.json`, `apps/bench/tsconfig.json`, `apps/bench/vitest.config.ts`, `apps/bench/test/setup.node.ts`, `apps/bench/bench/backends.bench.ts`, `apps/bench/README.md`
- Modify: `turbo.json`

**Interfaces:**
- Consumes: `@wash/vfs` (MemoryBackend, CachedBackend, ulid), `@wash/backend-indexeddb`.
- Produces: `pnpm --filter bench bench` — ops/sec comparisons (Memory vs IDB vs Cached(IDB)) for the spec-§5 hot paths, and the chunk-size sweep the spec requires before freezing 64 KB. Node/fake-indexeddb numbers are *relative* (real-browser absolute numbers come later via the browser rig); the README states this caveat and records results.

- [ ] **Step 1: Create the package**

`apps/bench/package.json`:
```json
{
  "name": "bench",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "bench": "vitest bench --run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@wash/vfs": "workspace:^",
    "@wash/backend-indexeddb": "workspace:^"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^3.0.0",
    "@types/node": "^22.0.0",
    "fake-indexeddb": "^6.0.0"
  }
}
```

`apps/bench/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true },
  "include": ["bench", "test"]
}
```

`apps/bench/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { environment: "node", setupFiles: ["./test/setup.node.ts"] },
});
```

`apps/bench/test/setup.node.ts`:
```ts
import "fake-indexeddb/auto";
```

`turbo.json` — add to `tasks`:
```json
    "bench": { "dependsOn": ["^build"], "cache": false }
```

- [ ] **Step 2: Write the benchmarks**

`apps/bench/bench/backends.bench.ts`:
```ts
import { bench, describe } from "vitest";
import { CachedBackend, MemoryBackend, ulid, type WashBackend } from "@wash/vfs";
import { IndexedDBBackend } from "@wash/backend-indexeddb";

const enc = new TextEncoder();
const FILES = 200;

async function populated(be: WashBackend): Promise<{ be: WashBackend; root: string; dir: string; ids: string[] }> {
  const root = await be.root();
  const dir = ulid();
  await be.create(root, "src", dir, "dir");
  const ids: string[] = [];
  for (let i = 0; i < FILES; i++) {
    const id = ulid();
    await be.create(dir, `file-${i}.ts`, id, "file");
    ids.push(id);
  }
  await be.flush();
  return { be, root, dir, ids };
}

const memory = await populated(new MemoryBackend());
const idb = await populated(await IndexedDBBackend.open(`bench-${ulid()}`));
const cachedIdb = await populated(new CachedBackend(await IndexedDBBackend.open(`benchc-${ulid()}`), { flushDelayMs: 50 }));

for (const [label, ctx] of [["MemoryBackend", memory], ["IndexedDBBackend", idb], ["CachedBackend(IDB)", cachedIdb]] as const) {
  describe(`${label}: metadata hot paths`, () => {
    bench("lookup hit", async () => {
      await ctx.be.lookup(ctx.dir, "file-42.ts");
    });
    bench("lookup miss (PATH-probe shape)", async () => {
      await ctx.be.lookup(ctx.dir, "no-such-command");
    });
    bench(`readdir (${FILES} entries)`, async () => {
      await ctx.be.readdir(ctx.dir);
    });
    bench("getattr", async () => {
      await ctx.be.getattr(ctx.ids[7]!);
    });
  });

  describe(`${label}: create+unlink cycle`, () => {
    bench("create then unlink", async () => {
      const id = ulid();
      await ctx.be.create(ctx.root, `tmp-${id}`, id, "file");
      await ctx.be.unlink(ctx.root, `tmp-${id}`);
    });
  });
}

describe("IDB chunk-size sweep: 1 MiB sequential write+read", () => {
  const payload = new Uint8Array(1024 * 1024).map((_, i) => i & 0xff);
  for (const kib of [16, 64, 256]) {
    bench(`chunkSize ${kib} KiB`, async () => {
      const be = await IndexedDBBackend.open(`sweep-${ulid()}`, { chunkSize: kib * 1024 });
      const root = await be.root();
      const id = ulid();
      await be.create(root, "blob", id, "file");
      await be.write(id, 0, payload);
      await be.read(id, 0, payload.byteLength);
      await be.flush();
      be.close();
    });
  }
  bench("append 4 KiB x64 (log-writer shape, 64 KiB chunks)", async () => {
    const be = await IndexedDBBackend.open(`sweep-${ulid()}`);
    const root = await be.root();
    const id = ulid();
    await be.create(root, "log", id, "file");
    const line = enc.encode("x".repeat(4096));
    for (let i = 0; i < 64; i++) await be.write(id, i * 4096, line);
    await be.flush();
    be.close();
  });
});
```

`apps/bench/README.md`:
```markdown
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
| (fill on first run) | node/fake-idb | | | | |
```

- [ ] **Step 3: Run the benchmarks**

Run: `pnpm install && pnpm --filter bench bench`
Expected: bench report prints ops/sec for every case; no errors. Fill the README table with the sweep numbers from this run.

- [ ] **Step 4: Verify pipeline**

Run: `pnpm turbo build test typecheck`
Expected: green (bench has no `test`/`build` tasks; typecheck covers it).

- [ ] **Step 5: Commit**

```bash
git add apps/bench turbo.json pnpm-lock.yaml
git commit -m "feat(bench): backend benchmark matrix and chunk-size sweep"
```

---

### Task 10: Integration test, README, exports polish

**Files:**
- Create: `packages/backend-indexeddb/test/integration.test.ts`, `packages/backend-indexeddb/README.md`

**Interfaces:**
- Consumes: everything.
- Produces: an end-to-end proof that the backend composes with the full `@wash/vfs` stack (Vfs façade + CachedBackend + warming + persistence across a simulated reload), and the package README.

- [ ] **Step 1: Write the integration test**

`packages/backend-indexeddb/test/integration.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { Vfs, CachedBackend, MemoryBackend, ulid } from "@wash/vfs";
import { IndexedDBBackend } from "../src/backend.js";

describe("Vfs + CachedBackend + IndexedDBBackend end-to-end", () => {
  it("full session: tree, content, links, fsync, simulated reload with warming", async () => {
    const dbName = `e2e-${ulid()}`;

    // Session 1
    const be1 = await IndexedDBBackend.open(dbName);
    const cached1 = new CachedBackend(be1, { flushDelayMs: 60_000 });
    const vfs1 = new Vfs();
    await vfs1.mount("/", cached1);
    await vfs1.mkdir("/project/src", { recursive: true });
    await vfs1.writeFile("/project/src/index.ts", "export const x = 1;\n");
    await vfs1.appendFile("/project/src/index.ts", "export const y = 2;\n");
    await vfs1.symlink("/project/src/index.ts", "/project/main");
    await vfs1.rename("/project/src/index.ts", "/project/src/main.ts");
    await vfs1.fsync();
    be1.close();

    // Session 2 (simulated reload): reopen, warm, verify
    const be2 = await IndexedDBBackend.open(dbName);
    const cached2 = new CachedBackend(be2, { flushDelayMs: 60_000 });
    cached2.warm(await be2.dump!());
    const vfs2 = new Vfs();
    await vfs2.mount("/", cached2);
    expect(await vfs2.readTextFile("/project/src/main.ts")).toBe("export const x = 1;\nexport const y = 2;\n");
    expect(await vfs2.readlink("/project/main")).toBe("/project/src/index.ts"); // symlink target is a path string, unaffected by the rename
    expect((await vfs2.readdir("/project")).map((d) => d.name)).toEqual(["main", "src"]);
    be2.close();
  });

  it("EXDEV across a memory mount and an IDB mount", async () => {
    const be = await IndexedDBBackend.open(`e2e-${ulid()}`);
    const vfs = new Vfs();
    await vfs.mount("/", new MemoryBackend());
    await vfs.mkdir("/idb");
    await vfs.mount("/idb", new CachedBackend(be, { flushDelayMs: 1 }));
    await vfs.writeFile("/local.txt", "x");
    await expect(vfs.rename("/local.txt", "/idb/moved.txt")).rejects.toMatchObject({ errno: "EXDEV" });
    await vfs.writeFile("/idb/direct.txt", "y");
    await vfs.fsync();
    expect(await vfs.readTextFile("/idb/direct.txt")).toBe("y");
    be.close();
  });
});
```

- [ ] **Step 2: Run to verify it fails / passes**

Run: `pnpm --filter @wash/backend-indexeddb test integration`
Expected: PASS directly if Tasks 2–7 are correct — if anything fails, it's a real integration bug to fix in this task (most likely in flush/close ordering).

- [ ] **Step 3: Write the README**

`packages/backend-indexeddb/README.md` — short: what the package is (persistent IndexedDB backend for `@wash/vfs`, spec §5 pointer), the schema table (four stores, key shapes), a 12-line usage example (open → wrap in `CachedBackend` → `warm(await be.dump())` → mount on a `Vfs`), the durability/chunkSize options, the shared-transaction batching note ("one IndexedDB transaction per write-back flush batch; `flush()` is the durability point"), and how to run the conformance suite (`@wash/vfs/conformance`) and the browser tests (`test:browser`, requires `playwright install chromium`).

- [ ] **Step 4: Full pipeline + browser pass (Plan 2 exit gate)**

Run: `pnpm turbo build test typecheck && pnpm --filter @wash/backend-indexeddb test:browser`
Expected: everything green in Node AND Chromium.

- [ ] **Step 5: Commit**

```bash
git add packages/backend-indexeddb
git commit -m "feat(backend-indexeddb): end-to-end integration test and README"
```

---

## Plan 2 exit criteria

- `pnpm turbo build test typecheck` green from clean; `pnpm --filter @wash/backend-indexeddb test:browser` green in real Chromium.
- Conformance suite passes for: raw `IndexedDBBackend` (Node + Chromium) and `CachedBackend(IndexedDBBackend, {flushDelayMs: 1})` (Node).
- Persistence pinned: ids, namespace, content, hardlinks, symlinks survive close/reopen.
- Warming shipped end-to-end: `IndexedDBBackend.dump()` + `CachedBackend.warm()` with the complete-directory negative-lookup property, exported from `@wash/vfs` (`BackendDump`).
- `apps/bench` runs the metadata matrix + chunk-size sweep; README caveats Node/fake-idb relativity and records the sweep table.
- Not in scope (deferred): real-browser bench numbers (rig exists; run recorded later), IDB schema migrations beyond v1 scaffolding (`versionchange` path exists in `openDb`; first real migration writes the test), multi-tab collision handling (spec v1: Web-Locks single-writer at the Vfs layer), F4 open-fd-after-unlink (tracked pre-Plan-4 spec gap).
- **Known deviation from spec §5, accepted for v1**: the spec wants background flushes at `durability: "relaxed"` and explicit fsync at `"strict"`, but the `WashBackend.flush()` contract has no mode parameter — v1 ships durability as a per-backend constructor option (default `"relaxed"`). Upgrading fsync to per-call strict durability requires a contract extension (`flush(opts?: { strict?: boolean })`); revisit alongside the F4 contract work before Plan 4.
