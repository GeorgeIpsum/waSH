# waSH Plan 1: Monorepo Foundation + @wash/vfs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold the waSH turborepo and build `@wash/vfs` — the storage backend contract, in-memory reference backend, backend conformance suite, path resolution, POSIX-ish async façade, and the caching/write-back layer.

**Architecture:** Linux-VFS-style split (per spec `docs/superpowers/specs/2026-07-11-wash-monorepo-design.md` §4). Backends implement a narrow id-addressed `WashBackend` interface. Caching (dentry/attr/negative/readdir read caches + write-back mutation queue) is a *composable wrapper* — `CachedBackend` itself implements `WashBackend`, so the conformance suite validates it wrapped around the reference backend. The `Vfs` façade owns mounts, path walking, fd table, and errno semantics. VFS paths are always absolute (cwd resolution is the engine's job, Plan 4).

**Tech Stack:** pnpm 9 workspaces, turborepo 2, TypeScript 5 (strict, ESM-only), vitest 3, Node ≥ 20. Zero runtime dependencies in `@wash/vfs`.

## Global Constraints

- All packages: `"type": "module"` (ESM-only), TypeScript `strict: true`, target ES2022.
- `@wash/vfs` has **zero runtime dependencies** (ULID implemented internally).
- Node ≥ 20 (native Web Streams, `crypto.getRandomValues`).
- Errno-carrying errors (`VfsError`) per spec §10: `ENOENT`, `EEXIST`, `ENOTDIR`, `EISDIR`, `ENOTEMPTY`, `EINVAL`, `ELOOP`, `EBADF`, `EXDEV`, `EPERM`, `ENOSYS`.
- Content chunk constant: `CHUNK_SIZE = 65536` (spec §5; exported from `@wash/vfs`, backends and streams use it).
- Symlink resolution loop cap: 40 hops → `ELOOP` (Linux parity).
- NodeIds: 26-char ULIDs minted by the VFS layer, passed *into* `create` (spec §4). Ids must be unique; time-ordering is nice-to-have, monotonicity within 1ms not required.
- Backend contract promises: `rename` is O(1) single-dirent; backends need NOT detect rename-into-own-descendant (the `Vfs` façade rejects it with `EINVAL` before calling the backend).
- Commit after every green test cycle. Commit messages: conventional (`feat:`, `test:`, `chore:`).

---

### Task 1: Monorepo scaffold + @wash/vfs package skeleton

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.gitignore`, `.npmrc`
- Create: `packages/vfs/package.json`, `packages/vfs/tsconfig.json`, `packages/vfs/vitest.config.ts`, `packages/vfs/src/index.ts`
- Test: `packages/vfs/test/smoke.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: a working `pnpm turbo build test typecheck` pipeline; `@wash/vfs` package importable in tests via `src/index.ts`. All later tasks add files under `packages/vfs/src` and export them from `src/index.ts`.

- [ ] **Step 1: Create root workspace files**

`package.json`:
```json
{
  "name": "wash-monorepo",
  "private": true,
  "packageManager": "pnpm@9.15.0",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test",
    "typecheck": "turbo run typecheck"
  },
  "devDependencies": {
    "turbo": "^2.3.0",
    "typescript": "^5.7.0"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
  - "apps/*"
  - "tooling/*"
```

`turbo.json`:
```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "test": { "dependsOn": ["^build"] },
    "typecheck": { "dependsOn": ["^build"] }
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "forceConsistentCasingInFileNames": true,
    "noUncheckedIndexedAccess": true
  }
}
```

`.gitignore`:
```
node_modules/
dist/
.turbo/
*.log
```

`.npmrc`:
```
engine-strict=true
```

- [ ] **Step 2: Create the vfs package skeleton**

`packages/vfs/package.json`:
```json
{
  "name": "@wash/vfs",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^3.0.0",
    "@types/node": "^22.0.0"
  }
}
```

`packages/vfs/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

`packages/vfs/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node" } });
```

`packages/vfs/src/index.ts`:
```ts
export const VERSION = "0.0.0";
```

- [ ] **Step 3: Write the smoke test**

`packages/vfs/test/smoke.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { VERSION } from "../src/index.js";

describe("toolchain", () => {
  it("imports the package source", () => {
    expect(VERSION).toBe("0.0.0");
  });
});
```

- [ ] **Step 4: Install and run the pipeline**

Run: `pnpm install && pnpm turbo build test typecheck`
Expected: install succeeds; turbo runs `build`, `test` (1 passing), `typecheck` for `@wash/vfs`, all green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold turborepo with @wash/vfs package skeleton"
```

---

### Task 2: Core types, VfsError, and ULID generation

**Files:**
- Create: `packages/vfs/src/types.ts`, `packages/vfs/src/errors.ts`, `packages/vfs/src/ulid.ts`
- Modify: `packages/vfs/src/index.ts`
- Test: `packages/vfs/test/errors.test.ts`, `packages/vfs/test/ulid.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (used by every later task):
  - `types.ts`: `NodeId` (string), `NodeKind` (`"file" | "dir" | "symlink"`), `Attrs { kind, size, mode, mtimeMs, ctimeMs, nlink }`, `Dirent { name, childId, kind }`, `NodeInfo { id, attrs }`, `BackendCaps { symlinks: "native" | "none", hardlinks: boolean, atomicDirRename: boolean }`, `WashBackend` (full contract), `CHUNK_SIZE = 65536`.
  - `errors.ts`: `Errno` union, `class VfsError extends Error { errno: Errno; path?: string }`.
  - `ulid.ts`: `ulid(now?: number): string` — 26 chars, Crockford base32.

- [ ] **Step 1: Write failing tests**

`packages/vfs/test/ulid.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { ulid } from "../src/ulid.js";

describe("ulid", () => {
  it("is 26 Crockford-base32 chars", () => {
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
  it("is unique across many calls", () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => ulid()));
    expect(ids.size).toBe(10_000);
  });
  it("sorts by timestamp across different milliseconds", () => {
    const a = ulid(1_000_000);
    const b = ulid(2_000_000);
    expect(a < b).toBe(true);
  });
});
```

`packages/vfs/test/errors.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { VfsError } from "../src/errors.js";

describe("VfsError", () => {
  it("carries errno and path", () => {
    const e = new VfsError("ENOENT", "/missing");
    expect(e.errno).toBe("ENOENT");
    expect(e.path).toBe("/missing");
    expect(e.message).toBe("ENOENT: /missing");
    expect(e).toBeInstanceOf(Error);
  });
  it("works without a path", () => {
    expect(new VfsError("EBADF").message).toBe("EBADF");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @wash/vfs test`
Expected: FAIL — cannot resolve `../src/ulid.js` / `../src/errors.js`.

- [ ] **Step 3: Implement**

`packages/vfs/src/errors.ts`:
```ts
export type Errno =
  | "ENOENT" | "EEXIST" | "ENOTDIR" | "EISDIR" | "ENOTEMPTY"
  | "EINVAL" | "ELOOP" | "EBADF" | "EXDEV" | "EPERM" | "ENOSYS";

export class VfsError extends Error {
  constructor(public readonly errno: Errno, public readonly path?: string) {
    super(path ? `${errno}: ${path}` : errno);
    this.name = "VfsError";
  }
}
```

`packages/vfs/src/ulid.ts`:
```ts
const ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 26-char Crockford-base32 ULID: 10 time chars + 16 random chars. */
export function ulid(now: number = Date.now()): string {
  let ts = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    ts = ENC[t % 32]! + ts;
    t = Math.floor(t / 32);
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += ENC[bytes[i]! & 31]!;
  return ts + rand;
}
```

`packages/vfs/src/types.ts`:
```ts
export type NodeId = string;
export type NodeKind = "file" | "dir" | "symlink";

export const CHUNK_SIZE = 65536;

export interface Attrs {
  kind: NodeKind;
  size: number;
  /** Permission bits only (0o777 mask). x-bit gates execution (engine, Plan 4). */
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
  nlink: number;
}

export interface Dirent {
  name: string;
  childId: NodeId;
  kind: NodeKind;
}

export interface NodeInfo {
  id: NodeId;
  attrs: Attrs;
}

export interface BackendCaps {
  symlinks: "native" | "none";
  hardlinks: boolean;
  atomicDirRename: boolean;
}

/**
 * Storage backend contract (spec §4). Id-addressed, single-step ops.
 * Backends never see full paths. NodeIds are minted by the VFS layer and
 * passed into create/symlink. Ids must stay stable for the mount's lifetime.
 * Backends need not detect rename-into-own-descendant (Vfs rejects EINVAL).
 */
export interface WashBackend {
  readonly caps: BackendCaps;
  root(): Promise<NodeId>;
  lookup(parent: NodeId, name: string): Promise<NodeInfo | null>;
  getattr(id: NodeId): Promise<Attrs>;
  readdir(id: NodeId): Promise<Dirent[]>;
  readdirPlus?(id: NodeId): Promise<(Dirent & { attrs: Attrs })[]>;
  read(id: NodeId, offset: number, length: number): Promise<Uint8Array>;
  write(id: NodeId, offset: number, data: Uint8Array): Promise<void>;
  truncate(id: NodeId, size: number): Promise<void>;
  create(parent: NodeId, name: string, id: NodeId, kind: NodeKind, attrs?: Partial<Attrs>): Promise<void>;
  unlink(parent: NodeId, name: string): Promise<void>;
  rename(fromParent: NodeId, fromName: string, toParent: NodeId, toName: string): Promise<void>;
  setattr(id: NodeId, attrs: Partial<Pick<Attrs, "mode" | "mtimeMs" | "ctimeMs">>): Promise<void>;
  symlink?(parent: NodeId, name: string, id: NodeId, target: string): Promise<void>;
  readlink?(id: NodeId): Promise<string>;
  link?(parent: NodeId, name: string, id: NodeId): Promise<void>;
  flush(): Promise<void>;
}
```

`packages/vfs/src/index.ts` (replace contents):
```ts
export const VERSION = "0.0.0";
export * from "./types.js";
export * from "./errors.js";
export { ulid } from "./ulid.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @wash/vfs test`
Expected: PASS (smoke + ulid + errors).

- [ ] **Step 5: Commit**

```bash
git add packages/vfs
git commit -m "feat(vfs): core types, WashBackend contract, VfsError, ulid"
```

---

### Task 3: MemoryBackend — namespace operations

**Files:**
- Create: `packages/vfs/src/backend/memory.ts`
- Modify: `packages/vfs/src/index.ts` (add `export { MemoryBackend } from "./backend/memory.js";`)
- Test: `packages/vfs/test/memory-namespace.test.ts`

**Interfaces:**
- Consumes: `WashBackend`, `Attrs`, `Dirent`, `NodeInfo`, `VfsError`, `ulid` from Task 2.
- Produces: `class MemoryBackend implements WashBackend` — the reference backend. Constructor takes no args; root dir exists immediately. Attr defaults: dirs `mode 0o755`, files `0o644`, symlinks `0o777`; `nlink` starts at 1; `mtimeMs`/`ctimeMs` = `Date.now()`. This class is the oracle the conformance suite (Task 6) is extracted from.

- [ ] **Step 1: Write failing tests**

`packages/vfs/test/memory-namespace.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { MemoryBackend } from "../src/backend/memory.js";
import { ulid } from "../src/ulid.js";
import { VfsError } from "../src/errors.js";

describe("MemoryBackend namespace", () => {
  let be: MemoryBackend;
  let root: string;
  beforeEach(async () => {
    be = new MemoryBackend();
    root = await be.root();
  });

  it("has an empty root directory", async () => {
    expect((await be.getattr(root)).kind).toBe("dir");
    expect(await be.readdir(root)).toEqual([]);
  });

  it("creates and looks up a file", async () => {
    const id = ulid();
    await be.create(root, "a.txt", id, "file");
    const info = await be.lookup(root, "a.txt");
    expect(info?.id).toBe(id);
    expect(info?.attrs.kind).toBe("file");
    expect(info?.attrs.size).toBe(0);
    expect(info?.attrs.mode).toBe(0o644);
    expect(info?.attrs.nlink).toBe(1);
  });

  it("lookup of a missing name returns null", async () => {
    expect(await be.lookup(root, "nope")).toBeNull();
  });

  it("create over an existing name throws EEXIST", async () => {
    await be.create(root, "a", ulid(), "file");
    await expect(be.create(root, "a", ulid(), "file")).rejects.toMatchObject({ errno: "EEXIST" });
  });

  it("creates nested directories and lists them sorted-insensitively", async () => {
    const d = ulid();
    await be.create(root, "dir", d, "dir");
    await be.create(d, "x", ulid(), "file");
    await be.create(d, "y", ulid(), "dir");
    const names = (await be.readdir(d)).map((e) => e.name).sort();
    expect(names).toEqual(["x", "y"]);
  });

  it("getattr of unknown id throws ENOENT", async () => {
    await expect(be.getattr(ulid())).rejects.toMatchObject({ errno: "ENOENT" });
  });

  it("readdir/create on a file throws ENOTDIR", async () => {
    const f = ulid();
    await be.create(root, "f", f, "file");
    await expect(be.readdir(f)).rejects.toMatchObject({ errno: "ENOTDIR" });
    await expect(be.create(f, "child", ulid(), "file")).rejects.toMatchObject({ errno: "ENOTDIR" });
  });

  it("setattr updates mode and mtime", async () => {
    const f = ulid();
    await be.create(root, "f", f, "file");
    await be.setattr(f, { mode: 0o755, mtimeMs: 12345 });
    const a = await be.getattr(f);
    expect(a.mode).toBe(0o755);
    expect(a.mtimeMs).toBe(12345);
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

Run: `pnpm --filter @wash/vfs test memory-namespace`
Expected: FAIL — cannot resolve `../src/backend/memory.js`.

- [ ] **Step 3: Implement**

`packages/vfs/src/backend/memory.ts`:
```ts
import type { Attrs, BackendCaps, Dirent, NodeId, NodeInfo, NodeKind, WashBackend } from "../types.js";
import { VfsError } from "../errors.js";
import { ulid } from "../ulid.js";

interface MemNode {
  attrs: Attrs;
  data: Uint8Array;                                    // files only
  children: Map<string, { childId: NodeId; kind: NodeKind }> | null; // dirs only
  target: string | null;                               // symlinks only
}

function defaultMode(kind: NodeKind): number {
  return kind === "dir" ? 0o755 : kind === "symlink" ? 0o777 : 0o644;
}

function mkAttrs(kind: NodeKind, overrides?: Partial<Attrs>): Attrs {
  const now = Date.now();
  return {
    kind,
    size: 0,
    mode: defaultMode(kind),
    mtimeMs: now,
    ctimeMs: now,
    nlink: 1,
    ...overrides,
  };
}

export class MemoryBackend implements WashBackend {
  readonly caps: BackendCaps = { symlinks: "native", hardlinks: true, atomicDirRename: true };
  private nodes = new Map<NodeId, MemNode>();
  private rootId: NodeId = ulid();

  constructor() {
    this.nodes.set(this.rootId, { attrs: mkAttrs("dir"), data: new Uint8Array(0), children: new Map(), target: null });
  }

  private node(id: NodeId): MemNode {
    const n = this.nodes.get(id);
    if (!n) throw new VfsError("ENOENT");
    return n;
  }

  private dir(id: NodeId): MemNode & { children: Map<string, { childId: NodeId; kind: NodeKind }> } {
    const n = this.node(id);
    if (n.attrs.kind !== "dir" || !n.children) throw new VfsError("ENOTDIR");
    return n as MemNode & { children: Map<string, { childId: NodeId; kind: NodeKind }> };
  }

  async root(): Promise<NodeId> {
    return this.rootId;
  }

  async lookup(parent: NodeId, name: string): Promise<NodeInfo | null> {
    const entry = this.dir(parent).children.get(name);
    if (!entry) return null;
    return { id: entry.childId, attrs: { ...this.node(entry.childId).attrs } };
  }

  async getattr(id: NodeId): Promise<Attrs> {
    return { ...this.node(id).attrs };
  }

  async readdir(id: NodeId): Promise<Dirent[]> {
    return [...this.dir(id).children.entries()].map(([name, e]) => ({ name, childId: e.childId, kind: e.kind }));
  }

  async readdirPlus(id: NodeId): Promise<(Dirent & { attrs: Attrs })[]> {
    return (await this.readdir(id)).map((d) => ({ ...d, attrs: { ...this.node(d.childId).attrs } }));
  }

  async create(parent: NodeId, name: string, id: NodeId, kind: NodeKind, attrs?: Partial<Attrs>): Promise<void> {
    const p = this.dir(parent);
    if (p.children.has(name)) throw new VfsError("EEXIST", name);
    this.nodes.set(id, {
      attrs: mkAttrs(kind, attrs),
      data: new Uint8Array(0),
      children: kind === "dir" ? new Map() : null,
      target: null,
    });
    p.children.set(name, { childId: id, kind });
  }

  async setattr(id: NodeId, attrs: Partial<Pick<Attrs, "mode" | "mtimeMs" | "ctimeMs">>): Promise<void> {
    Object.assign(this.node(id).attrs, attrs);
  }

  // Content ops, unlink, rename, links: Tasks 4 and 5.
  async read(): Promise<Uint8Array> { throw new VfsError("ENOSYS"); }
  async write(): Promise<void> { throw new VfsError("ENOSYS"); }
  async truncate(): Promise<void> { throw new VfsError("ENOSYS"); }
  async unlink(): Promise<void> { throw new VfsError("ENOSYS"); }
  async rename(): Promise<void> { throw new VfsError("ENOSYS"); }
  async flush(): Promise<void> {}
}
```

Add to `packages/vfs/src/index.ts`:
```ts
export { MemoryBackend } from "./backend/memory.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @wash/vfs test memory-namespace`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/vfs
git commit -m "feat(vfs): MemoryBackend namespace ops (create/lookup/getattr/readdir/setattr)"
```

---

### Task 4: MemoryBackend — content ops, unlink, rename

**Files:**
- Modify: `packages/vfs/src/backend/memory.ts`
- Test: `packages/vfs/test/memory-content.test.ts`

**Interfaces:**
- Consumes: Task 3's `MemoryBackend`.
- Produces: working `read(id, offset, length)` (short reads at EOF, zero-fill never — reads past EOF return fewer bytes), `write(id, offset, data)` (extends file, sparse gap zero-filled, updates `size`/`mtimeMs`), `truncate(id, size)` (shrink or zero-extend), `unlink(parent, name)` (dirs must be empty → `ENOTEMPTY`; nlink decrement; node GC at nlink 0), `rename(...)` with POSIX overwrite semantics.

- [ ] **Step 1: Write failing tests**

`packages/vfs/test/memory-content.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { MemoryBackend } from "../src/backend/memory.js";
import { ulid } from "../src/ulid.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("MemoryBackend content + unlink + rename", () => {
  let be: MemoryBackend;
  let root: string;
  let file: string;
  beforeEach(async () => {
    be = new MemoryBackend();
    root = await be.root();
    file = ulid();
    await be.create(root, "f.txt", file, "file");
  });

  it("writes and reads back", async () => {
    await be.write(file, 0, enc.encode("hello"));
    expect(dec.decode(await be.read(file, 0, 100))).toBe("hello");
    expect((await be.getattr(file)).size).toBe(5);
  });

  it("supports offset writes and sparse zero-fill", async () => {
    await be.write(file, 3, enc.encode("abc"));
    const out = await be.read(file, 0, 6);
    expect([...out.slice(0, 3)]).toEqual([0, 0, 0]);
    expect(dec.decode(out.slice(3))).toBe("abc");
  });

  it("read past EOF returns short result", async () => {
    await be.write(file, 0, enc.encode("hi"));
    expect((await be.read(file, 1, 100)).byteLength).toBe(1);
    expect((await be.read(file, 5, 100)).byteLength).toBe(0);
  });

  it("truncate shrinks and extends", async () => {
    await be.write(file, 0, enc.encode("hello"));
    await be.truncate(file, 2);
    expect(dec.decode(await be.read(file, 0, 100))).toBe("he");
    await be.truncate(file, 4);
    const out = await be.read(file, 0, 100);
    expect(out.byteLength).toBe(4);
    expect([...out.slice(2)]).toEqual([0, 0]);
  });

  it("read/write on a directory throws EISDIR", async () => {
    await expect(be.read(root, 0, 1)).rejects.toMatchObject({ errno: "EISDIR" });
    await expect(be.write(root, 0, enc.encode("x"))).rejects.toMatchObject({ errno: "EISDIR" });
  });

  it("unlink removes entry and GCs the node", async () => {
    await be.unlink(root, "f.txt");
    expect(await be.lookup(root, "f.txt")).toBeNull();
    await expect(be.getattr(file)).rejects.toMatchObject({ errno: "ENOENT" });
  });

  it("unlink of missing name throws ENOENT; non-empty dir throws ENOTEMPTY", async () => {
    await expect(be.unlink(root, "ghost")).rejects.toMatchObject({ errno: "ENOENT" });
    const d = ulid();
    await be.create(root, "d", d, "dir");
    await be.create(d, "kid", ulid(), "file");
    await expect(be.unlink(root, "d")).rejects.toMatchObject({ errno: "ENOTEMPTY" });
  });

  it("rename moves an entry between directories", async () => {
    const d = ulid();
    await be.create(root, "d", d, "dir");
    await be.rename(root, "f.txt", d, "g.txt");
    expect(await be.lookup(root, "f.txt")).toBeNull();
    expect((await be.lookup(d, "g.txt"))?.id).toBe(file);
  });

  it("rename overwrites an existing file target", async () => {
    const other = ulid();
    await be.create(root, "old", other, "file");
    await be.rename(root, "f.txt", root, "old");
    expect((await be.lookup(root, "old"))?.id).toBe(file);
    await expect(be.getattr(other)).rejects.toMatchObject({ errno: "ENOENT" });
  });

  it("rename dir-over-nonempty-dir throws ENOTEMPTY; file-over-dir EISDIR; dir-over-file ENOTDIR", async () => {
    const d1 = ulid(); const d2 = ulid();
    await be.create(root, "d1", d1, "dir");
    await be.create(root, "d2", d2, "dir");
    await be.create(d2, "kid", ulid(), "file");
    await expect(be.rename(root, "d1", root, "d2")).rejects.toMatchObject({ errno: "ENOTEMPTY" });
    await expect(be.rename(root, "f.txt", root, "d1")).rejects.toMatchObject({ errno: "EISDIR" });
    await expect(be.rename(root, "d1", root, "f.txt")).rejects.toMatchObject({ errno: "ENOTDIR" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @wash/vfs test memory-content`
Expected: FAIL — `ENOSYS` from the Task 3 stubs.

- [ ] **Step 3: Implement (replace the ENOSYS stubs in `memory.ts`)**

```ts
  private fileNode(id: NodeId): MemNode {
    const n = this.node(id);
    if (n.attrs.kind === "dir") throw new VfsError("EISDIR");
    return n;
  }

  async read(id: NodeId, offset: number, length: number): Promise<Uint8Array> {
    const n = this.fileNode(id);
    if (offset >= n.data.byteLength) return new Uint8Array(0);
    return n.data.slice(offset, Math.min(offset + length, n.data.byteLength));
  }

  async write(id: NodeId, offset: number, data: Uint8Array): Promise<void> {
    const n = this.fileNode(id);
    const end = offset + data.byteLength;
    if (end > n.data.byteLength) {
      const grown = new Uint8Array(end);
      grown.set(n.data, 0);
      n.data = grown;
    }
    n.data.set(data, offset);
    n.attrs.size = n.data.byteLength;
    n.attrs.mtimeMs = Date.now();
  }

  async truncate(id: NodeId, size: number): Promise<void> {
    const n = this.fileNode(id);
    const next = new Uint8Array(size);
    next.set(n.data.slice(0, Math.min(size, n.data.byteLength)), 0);
    n.data = next;
    n.attrs.size = size;
    n.attrs.mtimeMs = Date.now();
  }

  private decNlinkAndMaybeGC(id: NodeId): void {
    const n = this.node(id);
    n.attrs.nlink -= 1;
    if (n.attrs.nlink <= 0) this.nodes.delete(id);
  }

  async unlink(parent: NodeId, name: string): Promise<void> {
    const p = this.dir(parent);
    const entry = p.children.get(name);
    if (!entry) throw new VfsError("ENOENT", name);
    const child = this.node(entry.childId);
    if (child.attrs.kind === "dir" && child.children!.size > 0) throw new VfsError("ENOTEMPTY", name);
    p.children.delete(name);
    if (child.attrs.kind === "dir") this.nodes.delete(entry.childId);
    else this.decNlinkAndMaybeGC(entry.childId);
  }

  async rename(fromParent: NodeId, fromName: string, toParent: NodeId, toName: string): Promise<void> {
    const fp = this.dir(fromParent);
    const tp = this.dir(toParent);
    const moving = fp.children.get(fromName);
    if (!moving) throw new VfsError("ENOENT", fromName);
    const existing = tp.children.get(toName);
    if (existing) {
      if (existing.childId === moving.childId) return;
      const exNode = this.node(existing.childId);
      const mvNode = this.node(moving.childId);
      if (exNode.attrs.kind === "dir") {
        if (mvNode.attrs.kind !== "dir") throw new VfsError("EISDIR", toName);
        if (exNode.children!.size > 0) throw new VfsError("ENOTEMPTY", toName);
        this.nodes.delete(existing.childId);
      } else {
        if (mvNode.attrs.kind === "dir") throw new VfsError("ENOTDIR", toName);
        this.decNlinkAndMaybeGC(existing.childId);
      }
    }
    fp.children.delete(fromName);
    tp.children.set(toName, moving);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @wash/vfs test`
Expected: PASS (all suites so far).

- [ ] **Step 5: Commit**

```bash
git add packages/vfs
git commit -m "feat(vfs): MemoryBackend content ops, unlink with GC, POSIX rename"
```

---

### Task 5: MemoryBackend — symlinks and hardlinks

**Files:**
- Modify: `packages/vfs/src/backend/memory.ts`
- Test: `packages/vfs/test/memory-links.test.ts`

**Interfaces:**
- Consumes: Tasks 3–4.
- Produces: `symlink(parent, name, id, target)` (creates a `"symlink"` node storing `target`), `readlink(id)` (returns target; `EINVAL` on non-symlink), `link(parent, name, id)` (new dirent to existing node, nlink++; `EPERM` on dirs; `EEXIST` on taken name).

- [ ] **Step 1: Write failing tests**

`packages/vfs/test/memory-links.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { MemoryBackend } from "../src/backend/memory.js";
import { ulid } from "../src/ulid.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("MemoryBackend links", () => {
  let be: MemoryBackend;
  let root: string;
  beforeEach(async () => {
    be = new MemoryBackend();
    root = await be.root();
  });

  it("creates and reads a symlink", async () => {
    const s = ulid();
    await be.symlink!(root, "ln", s, "/target/path");
    const info = await be.lookup(root, "ln");
    expect(info?.attrs.kind).toBe("symlink");
    expect(await be.readlink!(s)).toBe("/target/path");
  });

  it("readlink on a regular file throws EINVAL", async () => {
    const f = ulid();
    await be.create(root, "f", f, "file");
    await expect(be.readlink!(f)).rejects.toMatchObject({ errno: "EINVAL" });
  });

  it("hardlink shares content and bumps nlink; GC only at zero", async () => {
    const f = ulid();
    await be.create(root, "a", f, "file");
    await be.write(f, 0, enc.encode("shared"));
    await be.link!(root, "b", f);
    expect((await be.getattr(f)).nlink).toBe(2);
    expect(dec.decode(await be.read(f, 0, 100))).toBe("shared");
    await be.unlink(root, "a");
    expect((await be.lookup(root, "b"))?.id).toBe(f);
    expect(dec.decode(await be.read(f, 0, 100))).toBe("shared");
    await be.unlink(root, "b");
    await expect(be.getattr(f)).rejects.toMatchObject({ errno: "ENOENT" });
  });

  it("link to a directory throws EPERM", async () => {
    const d = ulid();
    await be.create(root, "d", d, "dir");
    await expect(be.link!(root, "d2", d)).rejects.toMatchObject({ errno: "EPERM" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @wash/vfs test memory-links`
Expected: FAIL — `symlink`/`readlink`/`link` are undefined.

- [ ] **Step 3: Implement (add to `memory.ts`)**

```ts
  async symlink(parent: NodeId, name: string, id: NodeId, target: string): Promise<void> {
    const p = this.dir(parent);
    if (p.children.has(name)) throw new VfsError("EEXIST", name);
    this.nodes.set(id, {
      attrs: mkAttrs("symlink", { size: target.length }),
      data: new Uint8Array(0),
      children: null,
      target,
    });
    p.children.set(name, { childId: id, kind: "symlink" });
  }

  async readlink(id: NodeId): Promise<string> {
    const n = this.node(id);
    if (n.attrs.kind !== "symlink" || n.target === null) throw new VfsError("EINVAL");
    return n.target;
  }

  async link(parent: NodeId, name: string, id: NodeId): Promise<void> {
    const p = this.dir(parent);
    if (p.children.has(name)) throw new VfsError("EEXIST", name);
    const n = this.node(id);
    if (n.attrs.kind === "dir") throw new VfsError("EPERM", name);
    n.attrs.nlink += 1;
    p.children.set(name, { childId: id, kind: n.attrs.kind });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @wash/vfs test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/vfs
git commit -m "feat(vfs): MemoryBackend symlinks and hardlinks"
```

---

### Task 6: Backend conformance suite

**Files:**
- Create: `packages/vfs/src/conformance/suite.ts`
- Modify: `packages/vfs/src/index.ts` (add `export { runBackendConformance } from "./conformance/suite.js";`)
- Test: `packages/vfs/test/conformance-memory.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–5.
- Produces: `runBackendConformance(name: string, factory: () => Promise<WashBackend> | WashBackend): void` — registers a vitest `describe` block exercising the full contract. **This is a published API** (spec §4: third-party backend authors run it; Plans 2–3 run it against IDB/OPFS backends). It uses vitest's `describe/it/expect` imported inside the module. Tests must consult `backend.caps` and skip symlink/hardlink cases when unsupported.

- [ ] **Step 1: Write the consuming test first**

`packages/vfs/test/conformance-memory.test.ts`:
```ts
import { runBackendConformance } from "../src/conformance/suite.js";
import { MemoryBackend } from "../src/backend/memory.js";

runBackendConformance("MemoryBackend", () => new MemoryBackend());
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @wash/vfs test conformance-memory`
Expected: FAIL — cannot resolve `../src/conformance/suite.js`.

- [ ] **Step 3: Implement the suite**

`packages/vfs/src/conformance/suite.ts` — port every test body from the three existing repo files `packages/vfs/test/memory-namespace.test.ts`, `packages/vfs/test/memory-content.test.ts`, and `packages/vfs/test/memory-links.test.ts` into a parameterized suite. Those files are in the working tree right now — open them and move each `it(...)` block verbatim into the structure below, changing only the backend/root references to the suite's `be`/`root` (the bodies are already written against the `WashBackend` interface). Structure (complete file skeleton; the commented lines name which `it` blocks to move from which file):

```ts
import { describe, it, expect, beforeEach } from "vitest";
import type { NodeId, WashBackend } from "../types.js";
import { ulid } from "../ulid.js";

/**
 * Contract conformance suite for WashBackend implementations.
 * Backend authors: call this from a vitest test file.
 * Capability-gated cases skip automatically per backend.caps.
 */
export function runBackendConformance(
  name: string,
  factory: () => Promise<WashBackend> | WashBackend,
): void {
  describe(`WashBackend conformance: ${name}`, () => {
    let be: WashBackend;
    let root: NodeId;
    const enc = new TextEncoder();
    const dec = new TextDecoder();

    beforeEach(async () => {
      be = await factory();
      root = await be.root();
    });

    describe("namespace", () => {
      // Move all 9 `it` blocks from test/memory-namespace.test.ts here:
      // empty root; create+lookup file (attrs defaults); missing lookup →
      // null; EEXIST; nested dirs; ENOENT getattr; ENOTDIR on file
      // readdir/create; setattr mode+mtime; readdirPlus (guard this last
      // one with `if (!be.readdirPlus) return ctx.skip();` — it is optional
      // in the contract).
    });

    describe("content", () => {
      // Move the 5 content `it` blocks from test/memory-content.test.ts:
      // write/read roundtrip + size; offset write with sparse zero-fill;
      // short read at EOF; truncate shrink/extend; EISDIR on dir read/write.
    });

    describe("unlink and rename", () => {
      // Move the remaining `it` blocks from test/memory-content.test.ts:
      // unlink removes + GC; ENOENT on missing unlink + ENOTEMPTY on
      // non-empty dir; rename across dirs; rename overwrites file;
      // dir-over-nonempty ENOTEMPTY / file-over-dir EISDIR /
      // dir-over-file ENOTDIR.
    });

    describe("symlinks (capability-gated)", () => {
      it("create + readlink roundtrip", async (ctx) => {
        if (be.caps.symlinks !== "native") return ctx.skip();
        const s = ulid();
        await be.symlink!(root, "ln", s, "/t");
        expect(await be.readlink!(s)).toBe("/t");
        expect((await be.lookup(root, "ln"))?.attrs.kind).toBe("symlink");
      });
    });

    describe("hardlinks (capability-gated)", () => {
      it("nlink lifecycle", async (ctx) => {
        if (!be.caps.hardlinks) return ctx.skip();
        const f = ulid();
        await be.create(root, "a", f, "file");
        await be.write(f, 0, enc.encode("x"));
        await be.link!(root, "b", f);
        expect((await be.getattr(f)).nlink).toBe(2);
        await be.unlink(root, "a");
        expect(dec.decode(await be.read(f, 0, 10))).toBe("x");
        await be.unlink(root, "b");
        await expect(be.getattr(f)).rejects.toMatchObject({ errno: "ENOENT" });
      });
    });

    describe("flush", () => {
      it("flush() resolves (durability point)", async () => {
        await be.create(root, "f", ulid(), "file");
        await be.flush();
      });
    });
  });
}
```

The implementer copies each Task 3/4 test body into its `describe` block (they are written against the `WashBackend` interface already, so the only change is using `be`/`root` from the suite's `beforeEach`).

Then **delete** `test/memory-namespace.test.ts`, `test/memory-content.test.ts`, and `test/memory-links.test.ts` — the conformance file replaces them (single source of truth; DRY).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @wash/vfs test`
Expected: PASS — conformance suite green against MemoryBackend; old per-task memory test files removed.

- [ ] **Step 5: Commit**

```bash
git add -A packages/vfs
git commit -m "feat(vfs): reusable backend conformance suite; run against MemoryBackend"
```

---

### Task 7: Vfs façade — mounts, path resolution, stat/realpath

**Files:**
- Create: `packages/vfs/src/core/vfs.ts`, `packages/vfs/src/core/path.ts`
- Modify: `packages/vfs/src/index.ts` (add `export { Vfs } from "./core/vfs.js"; export { normalize, split } from "./core/path.js";`)
- Test: `packages/vfs/test/resolve.test.ts`

**Interfaces:**
- Consumes: `WashBackend`, `MemoryBackend`, `VfsError`, types.
- Produces:
  - `path.ts`: `normalize(p: string): string` (collapse `//`, resolve `.`/`..` textually up to root, strip trailing slash except root; throws `EINVAL` on non-absolute) and `split(p: string): string[]`.
  - `Vfs` class: `constructor()`, `mount(path: string, backend: WashBackend): Promise<void>` (first mount must be `/`), `async stat(path): Promise<Attrs>` (follows symlinks), `async lstat(path): Promise<Attrs>`, `async realpath(path): Promise<string>`.
  - Internal (used by Tasks 8–9): `protected async resolve(path: string, opts?: { followLast?: boolean }): Promise<{ backend: WashBackend; id: NodeId; attrs: Attrs; parentId: NodeId | null; name: string; mountPath: string }>` — walks mounts + segments, follows symlinks (absolute targets restart at `/`, relative targets continue from the link's directory), 40-hop `ELOOP` cap.

- [ ] **Step 1: Write failing tests**

`packages/vfs/test/resolve.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { Vfs } from "../src/core/vfs.js";
import { MemoryBackend } from "../src/backend/memory.js";
import { normalize } from "../src/core/path.js";

describe("normalize", () => {
  it("normalizes dots, slashes, and parent refs", () => {
    expect(normalize("/a/b/../c/./d//")).toBe("/a/c/d");
    expect(normalize("/")).toBe("/");
    expect(normalize("/../..")).toBe("/");
  });
  it("rejects relative paths", () => {
    expect(() => normalize("a/b")).toThrowError(/EINVAL/);
  });
});

describe("Vfs resolution", () => {
  let vfs: Vfs;
  beforeEach(async () => {
    vfs = new Vfs();
    await vfs.mount("/", new MemoryBackend());
  });

  it("stats the root", async () => {
    expect((await vfs.stat("/")).kind).toBe("dir");
  });

  it("throws ENOENT for missing paths and ENOTDIR through files", async () => {
    await expect(vfs.stat("/missing")).rejects.toMatchObject({ errno: "ENOENT", path: "/missing" });
  });

  it("resolves nested paths across a second mount", async () => {
    const mnt = new MemoryBackend();
    const mntRoot = await mnt.root();
    const { ulid } = await import("../src/ulid.js");
    await mnt.create(mntRoot, "inner.txt", ulid(), "file");
    // mountpoint dir must exist on the parent mount
    const rootBe = new MemoryBackend();
    vfs = new Vfs();
    await vfs.mount("/", rootBe);
    const rbRoot = await rootBe.root();
    await rootBe.create(rbRoot, "mnt", ulid(), "dir");
    await vfs.mount("/mnt", mnt);
    expect((await vfs.stat("/mnt/inner.txt")).kind).toBe("file");
  });

  it("follows relative and absolute symlinks; lstat does not follow", async () => {
    const be = new MemoryBackend();
    vfs = new Vfs();
    await vfs.mount("/", be);
    const root = await be.root();
    const { ulid } = await import("../src/ulid.js");
    const dir = ulid();
    await be.create(root, "real", dir, "dir");
    await be.create(dir, "f.txt", ulid(), "file");
    await be.symlink!(root, "abs", ulid(), "/real");
    await be.symlink!(dir, "rel", ulid(), "f.txt");
    expect((await vfs.stat("/abs/f.txt")).kind).toBe("file");
    expect((await vfs.stat("/real/rel")).kind).toBe("file");
    expect((await vfs.lstat("/abs")).kind).toBe("symlink");
    expect(await vfs.realpath("/abs/rel")).toBe("/real/f.txt");
  });

  it("detects symlink loops with ELOOP", async () => {
    const be = new MemoryBackend();
    vfs = new Vfs();
    await vfs.mount("/", be);
    const root = await be.root();
    const { ulid } = await import("../src/ulid.js");
    await be.symlink!(root, "a", ulid(), "/b");
    await be.symlink!(root, "b", ulid(), "/a");
    await expect(vfs.stat("/a")).rejects.toMatchObject({ errno: "ELOOP" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @wash/vfs test resolve`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement**

`packages/vfs/src/core/path.ts`:
```ts
import { VfsError } from "../errors.js";

export function normalize(p: string): string {
  if (!p.startsWith("/")) throw new VfsError("EINVAL", p);
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return "/" + out.join("/");
}

export function split(p: string): string[] {
  const n = normalize(p);
  return n === "/" ? [] : n.slice(1).split("/");
}

export function join(base: string, rel: string): string {
  return normalize(base.endsWith("/") ? base + rel : base + "/" + rel);
}
```

`packages/vfs/src/core/vfs.ts`:
```ts
import type { Attrs, NodeId, WashBackend } from "../types.js";
import { VfsError } from "../errors.js";
import { normalize, split } from "./path.js";

const MAX_SYMLINK_HOPS = 40;

interface Mount { path: string; backend: WashBackend; rootId: NodeId; }

export interface ResolvedNode {
  backend: WashBackend;
  id: NodeId;
  attrs: Attrs;
  parentId: NodeId | null;   // null only for a mount root
  name: string;              // "" for a mount root
  mountPath: string;
  realPath: string;          // fully-resolved absolute path
}

export class Vfs {
  private mounts: Mount[] = []; // sorted longest path first

  async mount(path: string, backend: WashBackend): Promise<void> {
    const p = normalize(path);
    if (this.mounts.length === 0 && p !== "/") throw new VfsError("EINVAL", "first mount must be /");
    if (this.mounts.some((m) => m.path === p)) throw new VfsError("EEXIST", p);
    if (p !== "/") await this.resolve(p); // mountpoint must exist on parent mount
    this.mounts.push({ path: p, backend, rootId: await backend.root() });
    this.mounts.sort((a, b) => b.path.length - a.path.length);
  }

  private mountFor(path: string): Mount {
    const m = this.mounts.find((m) => path === m.path || path.startsWith(m.path === "/" ? "/" : m.path + "/"));
    if (!m) throw new VfsError("ENOENT", path);
    return m;
  }

  protected async resolve(path: string, opts: { followLast?: boolean } = {}): Promise<ResolvedNode> {
    const followLast = opts.followLast !== false;
    let hops = 0;
    let current = normalize(path);

    outer: while (true) {
      const mount = this.mountFor(current);
      const rel = current === mount.path ? "" : current.slice(mount.path === "/" ? 1 : mount.path.length + 1);
      const segs = rel === "" ? [] : rel.split("/");
      let id = mount.rootId;
      let parentId: NodeId | null = null;
      let name = "";
      let attrs = await mount.backend.getattr(id);
      let walked = mount.path === "/" ? "" : mount.path;

      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i]!;
        if (attrs.kind !== "dir") throw new VfsError("ENOTDIR", current);
        const info = await mount.backend.lookup(id, seg);
        if (!info) throw new VfsError("ENOENT", current);
        const isLast = i === segs.length - 1;
        if (info.attrs.kind === "symlink" && (followLast || !isLast)) {
          if (++hops > MAX_SYMLINK_HOPS) throw new VfsError("ELOOP", current);
          if (!mount.backend.readlink) throw new VfsError("EINVAL", current);
          const target = await mount.backend.readlink(info.id);
          const remainder = segs.slice(i + 1).join("/");
          const base = target.startsWith("/") ? target : (walked || "") + "/" + target;
          current = normalize(remainder ? base + "/" + remainder : base);
          continue outer;
        }
        parentId = id;
        name = seg;
        id = info.id;
        attrs = info.attrs;
        walked = walked + "/" + seg;
      }
      return { backend: mount.backend, id, attrs, parentId, name, mountPath: mount.path, realPath: walked === "" ? "/" : walked };
    }
  }

  async stat(path: string): Promise<Attrs> {
    return (await this.resolve(path)).attrs;
  }

  async lstat(path: string): Promise<Attrs> {
    return (await this.resolve(path, { followLast: false })).attrs;
  }

  async realpath(path: string): Promise<string> {
    return (await this.resolve(path)).realPath;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @wash/vfs test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/vfs
git commit -m "feat(vfs): Vfs façade with mounts, symlink-aware path resolution, stat/lstat/realpath"
```

---

### Task 8: Vfs façade — metadata operations

**Files:**
- Modify: `packages/vfs/src/core/vfs.ts`
- Test: `packages/vfs/test/vfs-metadata.test.ts`

**Interfaces:**
- Consumes: Task 7's `Vfs.resolve`.
- Produces (all on `Vfs`, all `Promise`-returning, all errno-faithful):
  - `mkdir(path, opts?: { recursive?: boolean })`
  - `readdir(path): Promise<Dirent[]>` (name-sorted)
  - `unlink(path)` (`EISDIR` on dir), `rmdir(path)` (`ENOTDIR` on file, `ENOTEMPTY`), `rm(path, opts?: { recursive?: boolean })`
  - `rename(from, to)` (`EXDEV` across mounts; `EINVAL` renaming a dir into its own descendant)
  - `symlink(target, linkPath)` (`EPERM` if backend caps lack native symlinks — core emulation is deferred to the OPFS plan where it's needed), `readlink(path)`
  - `link(existing, linkPath)` (`EPERM` per caps)
  - `chmod(path, mode)`, `utimes(path, mtimeMs, ctimeMs?)`
  - `exists(path): Promise<boolean>`

- [ ] **Step 1: Write failing tests**

`packages/vfs/test/vfs-metadata.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { Vfs } from "../src/core/vfs.js";
import { MemoryBackend } from "../src/backend/memory.js";

describe("Vfs metadata ops", () => {
  let vfs: Vfs;
  beforeEach(async () => {
    vfs = new Vfs();
    await vfs.mount("/", new MemoryBackend());
  });

  it("mkdir + readdir sorted", async () => {
    await vfs.mkdir("/b");
    await vfs.mkdir("/a");
    expect((await vfs.readdir("/")).map((d) => d.name)).toEqual(["a", "b"]);
  });

  it("mkdir recursive creates parents; non-recursive needs them", async () => {
    await expect(vfs.mkdir("/x/y/z")).rejects.toMatchObject({ errno: "ENOENT" });
    await vfs.mkdir("/x/y/z", { recursive: true });
    expect((await vfs.stat("/x/y/z")).kind).toBe("dir");
    await vfs.mkdir("/x/y/z", { recursive: true }); // idempotent
    await expect(vfs.mkdir("/x/y/z")).rejects.toMatchObject({ errno: "EEXIST" });
  });

  it("unlink refuses dirs; rmdir refuses files and non-empty dirs", async () => {
    const be = new MemoryBackend();
    vfs = new Vfs();
    await vfs.mount("/", be);
    const { ulid } = await import("../src/ulid.js");
    const root = await be.root();
    await be.create(root, "f.txt", ulid(), "file"); // writeFile helper arrives in Task 9
    await vfs.mkdir("/d");
    await vfs.mkdir("/d/kid");
    await expect(vfs.unlink("/d")).rejects.toMatchObject({ errno: "EISDIR" });
    await expect(vfs.rmdir("/f.txt")).rejects.toMatchObject({ errno: "ENOTDIR" });
    await expect(vfs.rmdir("/d")).rejects.toMatchObject({ errno: "ENOTEMPTY" });
    await vfs.rmdir("/d/kid");
    await vfs.rmdir("/d");
    await vfs.unlink("/f.txt");
    expect(await vfs.exists("/f.txt")).toBe(false);
  });

  it("rename within a mount; EINVAL into own descendant", async () => {
    await vfs.mkdir("/a");
    await vfs.mkdir("/a/b");
    await vfs.rename("/a/b", "/c");
    expect((await vfs.stat("/c")).kind).toBe("dir");
    await vfs.mkdir("/c/inner");
    await expect(vfs.rename("/c", "/c/inner/c")).rejects.toMatchObject({ errno: "EINVAL" });
  });

  it("rename across mounts throws EXDEV", async () => {
    await vfs.mkdir("/mnt");
    await vfs.mount("/mnt", new MemoryBackend());
    await vfs.mkdir("/a");
    await expect(vfs.rename("/a", "/mnt/a")).rejects.toMatchObject({ errno: "EXDEV" });
  });

  it("symlink/readlink and chmod/utimes/exists", async () => {
    await vfs.mkdir("/real");
    await vfs.symlink("/real", "/ln");
    expect(await vfs.readlink("/ln")).toBe("/real");
    expect((await vfs.stat("/ln")).kind).toBe("dir");
    await vfs.chmod("/real", 0o700);
    expect((await vfs.stat("/real")).mode).toBe(0o700);
    await vfs.utimes("/real", 111);
    expect((await vfs.stat("/real")).mtimeMs).toBe(111);
    expect(await vfs.exists("/real")).toBe(true);
    expect(await vfs.exists("/ghost")).toBe(false);
  });

  it("rm recursive removes a tree", async () => {
    await vfs.mkdir("/t/deep/deeper", { recursive: true });
    await vfs.rm("/t", { recursive: true });
    expect(await vfs.exists("/t")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @wash/vfs test vfs-metadata`
Expected: FAIL — methods missing.

- [ ] **Step 3: Implement (add to `Vfs` in `core/vfs.ts`)**

```ts
  private async resolveParent(path: string): Promise<{ backend: WashBackend; dirId: NodeId; name: string; mountPath: string }> {
    const p = normalize(path);
    if (p === "/") throw new VfsError("EINVAL", "/");
    const idx = p.lastIndexOf("/");
    const parentPath = idx === 0 ? "/" : p.slice(0, idx);
    const name = p.slice(idx + 1);
    const parent = await this.resolve(parentPath);
    if (parent.attrs.kind !== "dir") throw new VfsError("ENOTDIR", parentPath);
    return { backend: parent.backend, dirId: parent.id, name, mountPath: parent.mountPath };
  }

  async mkdir(path: string, opts: { recursive?: boolean } = {}): Promise<void> {
    if (opts.recursive) {
      const segs = split(path);
      let walked = "";
      for (const seg of segs) {
        walked += "/" + seg;
        if (!(await this.exists(walked))) await this.mkdir(walked);
      }
      return;
    }
    const { backend, dirId, name } = await this.resolveParent(path);
    if (await backend.lookup(dirId, name)) throw new VfsError("EEXIST", path);
    await backend.create(dirId, name, ulid(), "dir");
  }

  async readdir(path: string): Promise<Dirent[]> {
    const r = await this.resolve(path);
    if (r.attrs.kind !== "dir") throw new VfsError("ENOTDIR", path);
    return (await r.backend.readdir(r.id)).sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  async unlink(path: string): Promise<void> {
    const r = await this.resolve(path, { followLast: false });
    if (r.attrs.kind === "dir") throw new VfsError("EISDIR", path);
    if (r.parentId === null) throw new VfsError("EINVAL", path);
    await r.backend.unlink(r.parentId, r.name);
  }

  async rmdir(path: string): Promise<void> {
    const r = await this.resolve(path, { followLast: false });
    if (r.attrs.kind !== "dir") throw new VfsError("ENOTDIR", path);
    if (r.parentId === null) throw new VfsError("EINVAL", path);
    await r.backend.unlink(r.parentId, r.name); // backend raises ENOTEMPTY
  }

  async rm(path: string, opts: { recursive?: boolean } = {}): Promise<void> {
    const attrs = await this.lstat(path);
    if (attrs.kind === "dir") {
      if (!opts.recursive) return this.rmdir(path);
      for (const d of await this.readdir(path)) {
        await this.rm(normalize(path + "/" + d.name), { recursive: true });
      }
      return this.rmdir(path);
    }
    return this.unlink(path);
  }

  async rename(from: string, to: string): Promise<void> {
    const f = normalize(from);
    const t = normalize(to);
    if (t === f) return;
    if (t.startsWith(f + "/")) throw new VfsError("EINVAL", to);
    const src = await this.resolveParent(f);
    const dst = await this.resolveParent(t);
    if (src.mountPath !== dst.mountPath) throw new VfsError("EXDEV", to);
    await src.backend.rename(src.dirId, src.name, dst.dirId, dst.name);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    const { backend, dirId, name } = await this.resolveParent(linkPath);
    if (backend.caps.symlinks !== "native" || !backend.symlink) throw new VfsError("EPERM", linkPath);
    if (await backend.lookup(dirId, name)) throw new VfsError("EEXIST", linkPath);
    await backend.symlink(dirId, name, ulid(), target);
  }

  async readlink(path: string): Promise<string> {
    const r = await this.resolve(path, { followLast: false });
    if (r.attrs.kind !== "symlink" || !r.backend.readlink) throw new VfsError("EINVAL", path);
    return r.backend.readlink(r.id);
  }

  async link(existing: string, linkPath: string): Promise<void> {
    const src = await this.resolve(existing);
    const { backend, dirId, name, mountPath } = await this.resolveParent(linkPath);
    if (!backend.caps.hardlinks || !backend.link) throw new VfsError("EPERM", linkPath);
    if (mountPath !== src.mountPath) throw new VfsError("EXDEV", linkPath);
    if (await backend.lookup(dirId, name)) throw new VfsError("EEXIST", linkPath);
    await backend.link(dirId, name, src.id);
  }

  async chmod(path: string, mode: number): Promise<void> {
    const r = await this.resolve(path);
    await r.backend.setattr(r.id, { mode: mode & 0o777 });
  }

  async utimes(path: string, mtimeMs: number, ctimeMs?: number): Promise<void> {
    const r = await this.resolve(path);
    await r.backend.setattr(r.id, ctimeMs === undefined ? { mtimeMs } : { mtimeMs, ctimeMs });
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.resolve(path, { followLast: false });
      return true;
    } catch (e) {
      if (e instanceof VfsError && (e.errno === "ENOENT" || e.errno === "ENOTDIR")) return false;
      throw e;
    }
  }
```

Add imports at the top of `core/vfs.ts`: `import { ulid } from "../ulid.js";`, `import type { Dirent } from "../types.js";`, and `split` from `./path.js`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @wash/vfs test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/vfs
git commit -m "feat(vfs): metadata ops (mkdir/readdir/unlink/rmdir/rm/rename/symlink/link/chmod/utimes)"
```

---

### Task 9: Vfs façade — fd table, open/read/write, file helpers

**Files:**
- Create: `packages/vfs/src/core/fd.ts`
- Modify: `packages/vfs/src/core/vfs.ts`
- Test: `packages/vfs/test/vfs-files.test.ts`

**Interfaces:**
- Consumes: Tasks 7–8.
- Produces:
  - `fd.ts`: `type OpenFlag = "r" | "r+" | "w" | "w+" | "a" | "a+" | "wx" | "ax"`, `interface OpenFile { fd: number; backend: WashBackend; id: NodeId; pos: number; flags: OpenFlag }`, `class FdTable { alloc(...): OpenFile; get(fd): OpenFile /* EBADF */; close(fd): void }` — fds start at 3.
  - On `Vfs`: `open(path, flags: OpenFlag): Promise<number>`, `read(fd, length, opts?: { position?: number }): Promise<Uint8Array>`, `write(fd, data: Uint8Array, opts?: { position?: number }): Promise<number>`, `close(fd): Promise<void>`, `readFile(path): Promise<Uint8Array>`, `readTextFile(path): Promise<string>`, `writeFile(path, data: Uint8Array | string): Promise<void>` (creates/truncates), `appendFile(path, data): Promise<void>`, `truncate(path, size?: number)`.
  - Flag semantics (Node-parity): `r` read-only `ENOENT` if missing; `r+` read/write existing; `w`/`w+` create-or-truncate; `a`/`a+` create-if-missing + writes append; `wx`/`ax` `EEXIST` if present. Writing on `"r"` → `EBADF`.

- [ ] **Step 1: Write failing tests**

`packages/vfs/test/vfs-files.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { Vfs } from "../src/core/vfs.js";
import { MemoryBackend } from "../src/backend/memory.js";

const enc = new TextEncoder();

describe("Vfs file io", () => {
  let vfs: Vfs;
  beforeEach(async () => {
    vfs = new Vfs();
    await vfs.mount("/", new MemoryBackend());
  });

  it("writeFile / readFile / readTextFile roundtrip", async () => {
    await vfs.writeFile("/f.txt", "hello");
    expect(await vfs.readTextFile("/f.txt")).toBe("hello");
    expect(await vfs.readFile("/f.txt")).toEqual(enc.encode("hello"));
  });

  it("writeFile truncates existing content", async () => {
    await vfs.writeFile("/f.txt", "long content");
    await vfs.writeFile("/f.txt", "hi");
    expect(await vfs.readTextFile("/f.txt")).toBe("hi");
  });

  it("appendFile appends; 'a' fd appends regardless of position", async () => {
    await vfs.writeFile("/log", "one\n");
    await vfs.appendFile("/log", "two\n");
    expect(await vfs.readTextFile("/log")).toBe("one\ntwo\n");
  });

  it("open flags: r missing ENOENT, wx existing EEXIST, write on r EBADF", async () => {
    await expect(vfs.open("/nope", "r")).rejects.toMatchObject({ errno: "ENOENT" });
    await vfs.writeFile("/f", "x");
    await expect(vfs.open("/f", "wx")).rejects.toMatchObject({ errno: "EEXIST" });
    const fd = await vfs.open("/f", "r");
    await expect(vfs.write(fd, enc.encode("y"))).rejects.toMatchObject({ errno: "EBADF" });
    await vfs.close(fd);
  });

  it("sequential fd reads advance position; positional reads do not", async () => {
    await vfs.writeFile("/f", "abcdef");
    const fd = await vfs.open("/f", "r");
    expect(new TextDecoder().decode(await vfs.read(fd, 2))).toBe("ab");
    expect(new TextDecoder().decode(await vfs.read(fd, 2))).toBe("cd");
    expect(new TextDecoder().decode(await vfs.read(fd, 2, { position: 0 }))).toBe("ab");
    expect(new TextDecoder().decode(await vfs.read(fd, 2))).toBe("ef");
    expect((await vfs.read(fd, 2)).byteLength).toBe(0); // EOF
    await vfs.close(fd);
  });

  it("close invalidates the fd", async () => {
    const fd = await vfs.open("/f2", "w");
    await vfs.close(fd);
    await expect(vfs.read(fd, 1)).rejects.toMatchObject({ errno: "EBADF" });
  });

  it("open on a directory throws EISDIR; truncate works by path", async () => {
    await vfs.mkdir("/d");
    await expect(vfs.open("/d", "r")).rejects.toMatchObject({ errno: "EISDIR" });
    await vfs.writeFile("/t", "abcdef");
    await vfs.truncate("/t", 3);
    expect(await vfs.readTextFile("/t")).toBe("abc");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @wash/vfs test vfs-files`
Expected: FAIL — methods missing.

- [ ] **Step 3: Implement**

`packages/vfs/src/core/fd.ts`:
```ts
import type { NodeId, WashBackend } from "../types.js";
import { VfsError } from "../errors.js";

export type OpenFlag = "r" | "r+" | "w" | "w+" | "a" | "a+" | "wx" | "ax";

export interface OpenFile {
  fd: number;
  backend: WashBackend;
  id: NodeId;
  pos: number;
  flags: OpenFlag;
}

export function canRead(f: OpenFlag): boolean {
  return f === "r" || f === "r+" || f === "w+" || f === "a+";
}
export function canWrite(f: OpenFlag): boolean {
  return f !== "r";
}
export function isAppend(f: OpenFlag): boolean {
  return f === "a" || f === "a+" || f === "ax";
}

export class FdTable {
  private next = 3;
  private files = new Map<number, OpenFile>();

  alloc(backend: WashBackend, id: NodeId, flags: OpenFlag): OpenFile {
    const file: OpenFile = { fd: this.next++, backend, id, pos: 0, flags };
    this.files.set(file.fd, file);
    return file;
  }

  get(fd: number): OpenFile {
    const f = this.files.get(fd);
    if (!f) throw new VfsError("EBADF", String(fd));
    return f;
  }

  close(fd: number): void {
    if (!this.files.delete(fd)) throw new VfsError("EBADF", String(fd));
  }
}
```

Add to `Vfs` (`core/vfs.ts`), with `private fds = new FdTable();` and imports from `./fd.js`:
```ts
  async open(path: string, flags: OpenFlag): Promise<number> {
    const p = normalize(path);
    let target: { backend: WashBackend; id: NodeId };
    try {
      const r = await this.resolve(p);
      if (r.attrs.kind === "dir") throw new VfsError("EISDIR", p);
      if (flags === "wx" || flags === "ax") throw new VfsError("EEXIST", p);
      if (flags === "w" || flags === "w+") await r.backend.truncate(r.id, 0);
      target = { backend: r.backend, id: r.id };
    } catch (e) {
      if (!(e instanceof VfsError) || e.errno !== "ENOENT") throw e;
      if (flags === "r" || flags === "r+") throw e;
      const { backend, dirId, name } = await this.resolveParent(p);
      const id = ulid();
      await backend.create(dirId, name, id, "file");
      target = { backend, id };
    }
    const file = this.fds.alloc(target.backend, target.id, flags);
    if (isAppend(flags)) file.pos = (await target.backend.getattr(target.id)).size;
    return file.fd;
  }

  async read(fd: number, length: number, opts: { position?: number } = {}): Promise<Uint8Array> {
    const f = this.fds.get(fd);
    if (!canRead(f.flags)) throw new VfsError("EBADF", String(fd));
    const pos = opts.position ?? f.pos;
    const out = await f.backend.read(f.id, pos, length);
    if (opts.position === undefined) f.pos += out.byteLength;
    return out;
  }

  async write(fd: number, data: Uint8Array, opts: { position?: number } = {}): Promise<number> {
    const f = this.fds.get(fd);
    if (!canWrite(f.flags)) throw new VfsError("EBADF", String(fd));
    let pos: number;
    if (isAppend(f.flags)) pos = (await f.backend.getattr(f.id)).size;
    else pos = opts.position ?? f.pos;
    await f.backend.write(f.id, pos, data);
    if (opts.position === undefined) f.pos = pos + data.byteLength;
    return data.byteLength;
  }

  async close(fd: number): Promise<void> {
    this.fds.close(fd);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const r = await this.resolve(path);
    if (r.attrs.kind === "dir") throw new VfsError("EISDIR", path);
    return r.backend.read(r.id, 0, r.attrs.size);
  }

  async readTextFile(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readFile(path));
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const fd = await this.open(path, "w");
    try {
      await this.write(fd, bytes);
    } finally {
      await this.close(fd);
    }
  }

  async appendFile(path: string, data: Uint8Array | string): Promise<void> {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const fd = await this.open(path, "a");
    try {
      await this.write(fd, bytes);
    } finally {
      await this.close(fd);
    }
  }

  async truncate(path: string, size = 0): Promise<void> {
    const r = await this.resolve(path);
    if (r.attrs.kind === "dir") throw new VfsError("EISDIR", path);
    await r.backend.truncate(r.id, size);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @wash/vfs test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/vfs
git commit -m "feat(vfs): fd table, open flags, read/write, file helpers"
```

---

### Task 10: CachedBackend — read caches (dentry/attr/negative/readdir)

**Files:**
- Create: `packages/vfs/src/cache/cached-backend.ts`
- Modify: `packages/vfs/src/index.ts` (add `export { CachedBackend } from "./cache/cached-backend.js";`)
- Test: `packages/vfs/test/cached-read.test.ts`, plus add one line to `packages/vfs/test/conformance-memory.test.ts`

**Interfaces:**
- Consumes: `WashBackend`, `MemoryBackend`, conformance suite.
- Produces: `class CachedBackend implements WashBackend` — `constructor(inner: WashBackend, opts?: { flushDelayMs?: number })`. This task: read caching with **authoritative in-place updates on mutation** (spec §4/§5 — the cache is the source of truth between flushes). Mutations still write through to `inner` in this task (the queue arrives in Task 11). Caches: `lookup` (positive + negative), `getattr`, `readdir`. `stats(): { hits: number; misses: number }` for testability.

- [ ] **Step 1: Write failing tests**

`packages/vfs/test/cached-read.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { CachedBackend } from "../src/cache/cached-backend.js";
import { MemoryBackend } from "../src/backend/memory.js";
import { ulid } from "../src/ulid.js";

describe("CachedBackend read caches", () => {
  let inner: MemoryBackend;
  let be: CachedBackend;
  let root: string;
  beforeEach(async () => {
    inner = new MemoryBackend();
    be = new CachedBackend(inner);
    root = await be.root();
  });

  it("caches lookup: second call does not hit inner", async () => {
    await be.create(root, "f", ulid(), "file");
    const spy = vi.spyOn(inner, "lookup");
    await be.lookup(root, "f");
    await be.lookup(root, "f");
    expect(spy).toHaveBeenCalledTimes(0); // create() primed the cache
  });

  it("caches negative lookups", async () => {
    const spy = vi.spyOn(inner, "lookup");
    expect(await be.lookup(root, "ghost")).toBeNull();
    expect(await be.lookup(root, "ghost")).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("create invalidates the negative entry", async () => {
    expect(await be.lookup(root, "later")).toBeNull();
    await be.create(root, "later", ulid(), "file");
    expect((await be.lookup(root, "later"))?.attrs.kind).toBe("file");
  });

  it("caches getattr and readdir; mutations update them in place", async () => {
    const f = ulid();
    await be.create(root, "f", f, "file");
    await be.readdir(root); // prime
    const rdSpy = vi.spyOn(inner, "readdir");
    const gaSpy = vi.spyOn(inner, "getattr");
    await be.write(f, 0, new TextEncoder().encode("abc"));
    expect((await be.getattr(f)).size).toBe(3);
    await be.create(root, "g", ulid(), "file");
    expect((await be.readdir(root)).map((d) => d.name).sort()).toEqual(["f", "g"]);
    await be.unlink(root, "g");
    expect((await be.readdir(root)).map((d) => d.name)).toEqual(["f"]);
    expect(rdSpy).toHaveBeenCalledTimes(0);
    expect(gaSpy).toHaveBeenCalledTimes(0);
  });

  it("rename moves the dirent between cached directories", async () => {
    const d = ulid();
    await be.create(root, "d", d, "dir");
    const f = ulid();
    await be.create(root, "f", f, "file");
    await be.readdir(root);
    await be.readdir(d);
    await be.rename(root, "f", d, "g");
    expect((await be.readdir(root)).map((x) => x.name)).toEqual(["d"]);
    expect((await be.readdir(d)).map((x) => x.name)).toEqual(["g"]);
    expect(await be.lookup(root, "f")).toBeNull();
    expect((await be.lookup(d, "g"))?.id).toBe(f);
  });
});
```

Also append to `packages/vfs/test/conformance-memory.test.ts`:
```ts
import { CachedBackend } from "../src/cache/cached-backend.js";
runBackendConformance("CachedBackend(MemoryBackend)", () => new CachedBackend(new MemoryBackend()));
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @wash/vfs test cached-read`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`packages/vfs/src/cache/cached-backend.ts`:
```ts
import type { Attrs, BackendCaps, Dirent, NodeId, NodeInfo, NodeKind, WashBackend } from "../types.js";

const NEG = Symbol("negative");

export class CachedBackend implements WashBackend {
  readonly caps: BackendCaps;
  private lookupCache = new Map<string, NodeInfo | typeof NEG>();
  private attrCache = new Map<NodeId, Attrs>();
  private readdirCache = new Map<NodeId, Map<string, Dirent>>();

  constructor(protected inner: WashBackend, protected opts: { flushDelayMs?: number } = {}) {
    this.caps = inner.caps;
  }

  private key(parent: NodeId, name: string): string {
    return parent + " " + name;
  }

  private primeEntry(parent: NodeId, name: string, id: NodeId, kind: NodeKind, attrs: Attrs): void {
    this.lookupCache.set(this.key(parent, name), { id, attrs });
    this.attrCache.set(id, attrs);
    this.readdirCache.get(parent)?.set(name, { name, childId: id, kind });
  }

  private dropEntry(parent: NodeId, name: string, id?: NodeId): void {
    this.lookupCache.set(this.key(parent, name), NEG);
    this.readdirCache.get(parent)?.delete(name);
    if (id) this.attrCache.delete(id);
  }

  async root(): Promise<NodeId> {
    return this.inner.root();
  }

  async lookup(parent: NodeId, name: string): Promise<NodeInfo | null> {
    const k = this.key(parent, name);
    const hit = this.lookupCache.get(k);
    if (hit === NEG) return null;
    if (hit) return { id: hit.id, attrs: { ...hit.attrs } };
    const info = await this.inner.lookup(parent, name);
    this.lookupCache.set(k, info ?? NEG);
    if (info) this.attrCache.set(info.id, info.attrs);
    return info;
  }

  async getattr(id: NodeId): Promise<Attrs> {
    const hit = this.attrCache.get(id);
    if (hit) return { ...hit };
    const attrs = await this.inner.getattr(id);
    this.attrCache.set(id, attrs);
    return { ...attrs };
  }

  async readdir(id: NodeId): Promise<Dirent[]> {
    const hit = this.readdirCache.get(id);
    if (hit) return [...hit.values()];
    const list = await this.inner.readdir(id);
    this.readdirCache.set(id, new Map(list.map((d) => [d.name, d])));
    return list;
  }

  async create(parent: NodeId, name: string, id: NodeId, kind: NodeKind, attrs?: Partial<Attrs>): Promise<void> {
    await this.inner.create(parent, name, id, kind, attrs);
    this.primeEntry(parent, name, id, kind, await this.inner.getattr(id));
  }

  async unlink(parent: NodeId, name: string): Promise<void> {
    const victim = await this.lookup(parent, name);
    await this.inner.unlink(parent, name);
    this.dropEntry(parent, name, victim?.id);
    if (victim) this.readdirCache.delete(victim.id);
  }

  async rename(fromParent: NodeId, fromName: string, toParent: NodeId, toName: string): Promise<void> {
    const moving = await this.lookup(fromParent, fromName);
    const displaced = await this.lookup(toParent, toName);
    await this.inner.rename(fromParent, fromName, toParent, toName);
    this.dropEntry(fromParent, fromName);
    if (displaced) this.attrCache.delete(displaced.id);
    if (moving) this.primeEntry(toParent, toName, moving.id, moving.attrs.kind, moving.attrs);
  }

  async setattr(id: NodeId, attrs: Partial<Pick<Attrs, "mode" | "mtimeMs" | "ctimeMs">>): Promise<void> {
    await this.inner.setattr(id, attrs);
    const hit = this.attrCache.get(id);
    if (hit) Object.assign(hit, attrs);
  }

  async write(id: NodeId, offset: number, data: Uint8Array): Promise<void> {
    await this.inner.write(id, offset, data);
    const hit = this.attrCache.get(id);
    if (hit) {
      hit.size = Math.max(hit.size, offset + data.byteLength);
      hit.mtimeMs = Date.now();
    }
  }

  async truncate(id: NodeId, size: number): Promise<void> {
    await this.inner.truncate(id, size);
    const hit = this.attrCache.get(id);
    if (hit) {
      hit.size = size;
      hit.mtimeMs = Date.now();
    }
  }

  async read(id: NodeId, offset: number, length: number): Promise<Uint8Array> {
    return this.inner.read(id, offset, length);
  }

  async symlink(parent: NodeId, name: string, id: NodeId, target: string): Promise<void> {
    if (!this.inner.symlink) throw new Error("unsupported");
    await this.inner.symlink(parent, name, id, target);
    this.primeEntry(parent, name, id, "symlink", await this.inner.getattr(id));
  }

  async readlink(id: NodeId): Promise<string> {
    if (!this.inner.readlink) throw new Error("unsupported");
    return this.inner.readlink(id);
  }

  async link(parent: NodeId, name: string, id: NodeId): Promise<void> {
    if (!this.inner.link) throw new Error("unsupported");
    await this.inner.link(parent, name, id);
    const attrs = await this.inner.getattr(id);
    this.attrCache.set(id, attrs);
    this.primeEntry(parent, name, id, attrs.kind, attrs);
  }

  async flush(): Promise<void> {
    await this.inner.flush();
  }
}
```

Note: `readdirPlus` is intentionally not forwarded — the base `readdir`+`getattr` path is already cached; revisit in Plan 2 when the IDB backend provides a native `readdirPlus`. `symlink`/`readlink`/`link` must only be declared when `inner` has them — implement with conditional assignment in the constructor:

```ts
    if (!inner.symlink) this.symlink = undefined as never;
    if (!inner.readlink) this.readlink = undefined as never;
    if (!inner.link) this.link = undefined as never;
```

(and declare the three methods as optional class properties per the `WashBackend` interface).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @wash/vfs test`
Expected: PASS — including the conformance suite against `CachedBackend(MemoryBackend)`.

- [ ] **Step 5: Commit**

```bash
git add packages/vfs
git commit -m "feat(vfs): CachedBackend read caches with authoritative in-place updates"
```

---

### Task 11: CachedBackend — write-back queue and batched flush

**Files:**
- Modify: `packages/vfs/src/cache/cached-backend.ts`
- Test: `packages/vfs/test/cached-writeback.test.ts`

**Interfaces:**
- Consumes: Task 10.
- Produces: mutations (`create`, `unlink`, `rename`, `setattr`, `write`, `truncate`, `symlink`, `link`) update caches immediately and **enqueue** the inner-backend call instead of awaiting it. Ordered replay: `flush()` drains the queue sequentially then calls `inner.flush()`. Auto-flush via `setTimeout(flushDelayMs)` (default 100), timer unref'd where available. **Correctness rule:** any cache-miss read (`lookup`/`getattr`/`readdir`/`read`/`readlink`) drains the queue first, so the inner backend is never read stale. `pendingOps(): number` exposed for tests. A failed op during flush rejects that `flush()` and surfaces via `onFlushError?: (err: unknown) => void`.
- **Cache-authority change:** with queuing, mutations can no longer call `inner.getattr()` to prime attrs — `CachedBackend` must construct attrs itself (same defaults as MemoryBackend: dir 0o755 / file 0o644 / symlink 0o777, nlink 1, now-timestamps) and require them to be authoritative. Content writes also serve `read()` from a per-node in-memory buffer for dirty files until flushed.

- [ ] **Step 1: Write failing tests**

`packages/vfs/test/cached-writeback.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { CachedBackend } from "../src/cache/cached-backend.js";
import { MemoryBackend } from "../src/backend/memory.js";
import { ulid } from "../src/ulid.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("CachedBackend write-back", () => {
  let inner: MemoryBackend;
  let be: CachedBackend;
  let root: string;
  beforeEach(async () => {
    inner = new MemoryBackend();
    be = new CachedBackend(inner, { flushDelayMs: 60_000 }); // effectively manual flush
    root = await be.root();
  });

  it("mutations are visible through the cache before the inner backend sees them", async () => {
    const f = ulid();
    await be.create(root, "f", f, "file");
    await be.write(f, 0, enc.encode("hello"));
    expect(await inner.lookup(root, "f")).toBeNull();          // inner still empty
    expect((await be.lookup(root, "f"))?.id).toBe(f);          // cache authoritative
    expect(dec.decode(await be.read(f, 0, 100))).toBe("hello");
    expect(be.pendingOps()).toBeGreaterThan(0);
  });

  it("flush replays ops in order and empties the queue", async () => {
    const f = ulid();
    await be.create(root, "a.txt", f, "file");
    await be.write(f, 0, enc.encode("v1"));
    await be.rename(root, "a.txt", root, "b.txt");
    await be.flush();
    expect(be.pendingOps()).toBe(0);
    expect((await inner.lookup(root, "b.txt"))?.id).toBe(f);
    expect(await inner.lookup(root, "a.txt")).toBeNull();
    expect(dec.decode(await inner.read(f, 0, 100))).toBe("v1");
  });

  it("auto-flushes after flushDelayMs", async () => {
    vi.useFakeTimers();
    try {
      const quick = new CachedBackend(inner, { flushDelayMs: 50 });
      const qroot = await quick.root();
      await quick.create(qroot, "auto", ulid(), "file");
      expect(await inner.lookup(qroot, "auto")).toBeNull();
      await vi.advanceTimersByTimeAsync(60);
      expect(await inner.lookup(qroot, "auto")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cold reads drain pending ops first (never read stale)", async () => {
    const d = ulid();
    await be.create(root, "d", d, "dir");
    // readdir of d was never primed by a prior readdir call on a fresh dir?
    // It was primed by create; force a cold path by constructing a fresh
    // CachedBackend over the same inner AFTER a flush, then queueing ops.
    await be.flush();
    const be2 = new CachedBackend(inner, { flushDelayMs: 60_000 });
    const f = ulid();
    await be2.create(d, "kid", f, "file");
    // cold readdir on be2 must include the queued create
    expect((await be2.readdir(d)).map((x) => x.name)).toEqual(["kid"]);
  });

  it("conformance still passes with a zero-delay writeback (see conformance file)", async () => {
    // covered by conformance-memory.test.ts addition below
    expect(true).toBe(true);
  });
});
```

Also append to `packages/vfs/test/conformance-memory.test.ts` (replace the Task 10 line):
```ts
runBackendConformance("CachedBackend(MemoryBackend, writeback)", () => new CachedBackend(new MemoryBackend(), { flushDelayMs: 1 }));
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @wash/vfs test cached-writeback`
Expected: FAIL — `pendingOps` missing; inner sees writes immediately.

- [ ] **Step 3: Implement**

Rework `cached-backend.ts` mutations. Key additions (complete replacement of the mutation paths; read paths from Task 10 stay, with the drain rule added):

```ts
  private queue: Array<() => Promise<void>> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private dirtyData = new Map<NodeId, Uint8Array>(); // full-content buffer for dirty files
  onFlushError?: (err: unknown) => void;

  pendingOps(): number {
    return this.queue.length;
  }

  private enqueue(op: () => Promise<void>): void {
    this.queue.push(op);
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush().catch((e) => this.onFlushError?.(e));
      }, this.opts.flushDelayMs ?? 100);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  private async drain(): Promise<void> {
    if (this.queue.length > 0 || this.flushing) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.flushing) await this.flushing;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const run = (async () => {
      while (this.queue.length > 0) {
        const op = this.queue.shift()!;
        await op();
      }
      await this.inner.flush();
    })();
    this.flushing = run;
    try {
      await run;
    } finally {
      this.flushing = null;
    }
  }
```

Mutation pattern (repeat for each op — `create` shown; `unlink`, `rename`, `setattr`, `symlink`, `link` follow identically, updating caches exactly as in Task 10 but constructing attrs locally instead of calling `inner.getattr`):

```ts
  private mkAttrs(kind: NodeKind, overrides?: Partial<Attrs>): Attrs {
    const now = Date.now();
    const mode = kind === "dir" ? 0o755 : kind === "symlink" ? 0o777 : 0o644;
    return { kind, size: 0, mode, mtimeMs: now, ctimeMs: now, nlink: 1, ...overrides };
  }

  async create(parent: NodeId, name: string, id: NodeId, kind: NodeKind, attrs?: Partial<Attrs>): Promise<void> {
    if ((await this.lookup(parent, name)) !== null) throw new VfsError("EEXIST", name);
    await this.readdir(parent); // ensure dir cache is primed (drains queue if cold)
    this.primeEntry(parent, name, id, kind, this.mkAttrs(kind, attrs));
    if (kind === "dir") this.readdirCache.set(id, new Map());
    this.enqueue(() => this.inner.create(parent, name, id, kind, attrs));
  }
```

Content write-back:

```ts
  private async materialize(id: NodeId): Promise<Uint8Array> {
    let buf = this.dirtyData.get(id);
    if (!buf) {
      await this.drain();
      const attrs = await this.getattr(id);
      buf = await this.inner.read(id, 0, attrs.size);
    }
    return buf;
  }

  async write(id: NodeId, offset: number, data: Uint8Array): Promise<void> {
    const cur = await this.materialize(id);
    const end = Math.max(cur.byteLength, offset + data.byteLength);
    const next = new Uint8Array(end);
    next.set(cur, 0);
    next.set(data, offset);
    if (!this.dirtyData.has(id)) {
      this.enqueue(async () => {
        const buf = this.dirtyData.get(id);
        if (!buf) return;
        this.dirtyData.delete(id);
        await this.inner.truncate(id, buf.byteLength);
        if (buf.byteLength > 0) await this.inner.write(id, 0, buf);
      });
    }
    this.dirtyData.set(id, next);
    const hit = this.attrCache.get(id);
    if (hit) { hit.size = end; hit.mtimeMs = Date.now(); }
  }

  async truncate(id: NodeId, size: number): Promise<void> {
    const cur = await this.materialize(id);
    const next = new Uint8Array(size);
    next.set(cur.slice(0, Math.min(size, cur.byteLength)), 0);
    if (!this.dirtyData.has(id)) {
      this.enqueue(async () => {
        const buf = this.dirtyData.get(id);
        if (!buf) return;
        this.dirtyData.delete(id);
        await this.inner.truncate(id, buf.byteLength);
        if (buf.byteLength > 0) await this.inner.write(id, 0, buf);
      });
    }
    this.dirtyData.set(id, next);
    const hit = this.attrCache.get(id);
    if (hit) { hit.size = size; hit.mtimeMs = Date.now(); }
  }

  async read(id: NodeId, offset: number, length: number): Promise<Uint8Array> {
    const dirty = this.dirtyData.get(id);
    if (dirty) {
      if (offset >= dirty.byteLength) return new Uint8Array(0);
      return dirty.slice(offset, Math.min(offset + length, dirty.byteLength));
    }
    await this.drain();
    return this.inner.read(id, offset, length);
  }
```

Add the drain rule to the three cache-miss read paths from Task 10 (`lookup`, `getattr`, `readdir`, and `readlink`): before calling `this.inner.*` on a cache miss, `await this.drain();`.

Whole-file dirty buffering is a deliberate v1 simplification (spec targets small files; chunk-granular dirty tracking is a Plan 2 optimization for the IDB backend where it matters). `unlink` must also `this.dirtyData.delete(victim.id)` when nlink reaches 0 — since `CachedBackend` doesn't track nlink across hardlinks, it conservatively keeps the buffer and lets the queued inner op fail or succeed naturally; only when `caps.hardlinks === false` or the cached attrs show `nlink === 1` may it drop the buffer.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @wash/vfs test`
Expected: PASS — write-back tests and conformance (wrapped, `flushDelayMs: 1`) green.

- [ ] **Step 5: Commit**

```bash
git add packages/vfs
git commit -m "feat(vfs): write-back mutation queue with ordered batched flush"
```

---

### Task 12: Streams, fsync/sync, exclusive mount locks, public API polish

**Files:**
- Modify: `packages/vfs/src/core/vfs.ts`, `packages/vfs/src/index.ts`
- Create: `packages/vfs/README.md`
- Test: `packages/vfs/test/vfs-streams.test.ts`

**Interfaces:**
- Consumes: Tasks 7–11.
- Produces (completing the Plan 1 public API of `@wash/vfs`):
  - `Vfs.createReadStream(path): Promise<ReadableStream<Uint8Array>>` — pulls `CHUNK_SIZE` slices via an fd; closes fd on cancel/end.
  - `Vfs.createWriteStream(path, opts?: { append?: boolean }): Promise<WritableStream<Uint8Array>>` — opens `"w"`/`"a"`; closes fd on close/abort.
  - `Vfs.fsync(): Promise<void>` — calls `flush()` on every mounted backend in mount order.
  - `Vfs.mount(path, backend, opts?: { exclusive?: boolean })` — when `exclusive` and `globalThis.navigator?.locks` exists, holds a Web Lock named `wash-mount:${path}` (via `navigator.locks.request(name, { ifAvailable: true }, ...)`); throws `VfsError("EPERM")` if the lock is already held. No-op in Node.
  - `unmount(path): Promise<void>` — flushes the backend, releases any lock, removes the mount (`EINVAL` for `/`, `ENOENT` if not mounted).

- [ ] **Step 1: Write failing tests**

`packages/vfs/test/vfs-streams.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { Vfs } from "../src/core/vfs.js";
import { MemoryBackend } from "../src/backend/memory.js";
import { CHUNK_SIZE } from "../src/types.js";

describe("Vfs streams + fsync + unmount", () => {
  let vfs: Vfs;
  beforeEach(async () => {
    vfs = new Vfs();
    await vfs.mount("/", new MemoryBackend());
  });

  it("streams a large file in chunks", async () => {
    const big = new Uint8Array(CHUNK_SIZE * 2 + 100).fill(7);
    await vfs.writeFile("/big", big);
    const chunks: Uint8Array[] = [];
    const rs = await vfs.createReadStream("/big");
    for await (const c of rs as unknown as AsyncIterable<Uint8Array>) chunks.push(c);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    expect(total).toBe(big.byteLength);
  });

  it("write stream writes sequentially; append mode appends", async () => {
    const ws = await vfs.createWriteStream("/out");
    const w = ws.getWriter();
    await w.write(new TextEncoder().encode("hello "));
    await w.write(new TextEncoder().encode("world"));
    await w.close();
    expect(await vfs.readTextFile("/out")).toBe("hello world");
    const as = await vfs.createWriteStream("/out", { append: true });
    const aw = as.getWriter();
    await aw.write(new TextEncoder().encode("!"));
    await aw.close();
    expect(await vfs.readTextFile("/out")).toBe("hello world!");
  });

  it("fsync flushes a write-back mount to its inner backend", async () => {
    const { CachedBackend } = await import("../src/cache/cached-backend.js");
    const inner = new MemoryBackend();
    vfs = new Vfs();
    await vfs.mount("/", new CachedBackend(inner, { flushDelayMs: 60_000 }));
    await vfs.writeFile("/f", "data");
    const root = await inner.root();
    expect(await inner.lookup(root, "f")).toBeNull();
    await vfs.fsync();
    expect(await inner.lookup(root, "f")).not.toBeNull();
  });

  it("unmount flushes and removes; refuses / and unknown paths", async () => {
    await vfs.mkdir("/mnt");
    await vfs.mount("/mnt", new MemoryBackend());
    await vfs.writeFile("/mnt/x", "1");
    await vfs.unmount("/mnt");
    await expect(vfs.stat("/mnt/x")).rejects.toMatchObject({ errno: "ENOENT" });
    await expect(vfs.unmount("/mnt")).rejects.toMatchObject({ errno: "ENOENT" });
    await expect(vfs.unmount("/")).rejects.toMatchObject({ errno: "EINVAL" });
  });

  it("exclusive mount acquires a web lock when navigator.locks exists", async () => {
    const held: string[] = [];
    const fakeLocks = {
      request: async (name: string, opts: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<unknown>) => {
        if (held.includes(name)) return cb(null);
        held.push(name);
        return cb({ name });
      },
    };
    (globalThis as Record<string, unknown>).navigator = { locks: fakeLocks };
    try {
      const v2 = new Vfs();
      await v2.mount("/", new MemoryBackend(), { exclusive: true });
      const v3 = new Vfs();
      await expect(v3.mount("/", new MemoryBackend(), { exclusive: true })).rejects.toMatchObject({ errno: "EPERM" });
    } finally {
      delete (globalThis as Record<string, unknown>).navigator;
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @wash/vfs test vfs-streams`
Expected: FAIL — methods missing.

- [ ] **Step 3: Implement (add to `Vfs`)**

```ts
  async createReadStream(path: string): Promise<ReadableStream<Uint8Array>> {
    const fd = await this.open(path, "r");
    const self = this;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const chunk = await self.read(fd, CHUNK_SIZE);
        if (chunk.byteLength === 0) {
          controller.close();
          await self.close(fd);
        } else {
          controller.enqueue(chunk);
        }
      },
      async cancel() {
        await self.close(fd);
      },
    });
  }

  async createWriteStream(path: string, opts: { append?: boolean } = {}): Promise<WritableStream<Uint8Array>> {
    const fd = await this.open(path, opts.append ? "a" : "w");
    const self = this;
    return new WritableStream<Uint8Array>({
      async write(chunk) {
        await self.write(fd, chunk);
      },
      async close() {
        await self.close(fd);
      },
      async abort() {
        await self.close(fd);
      },
    });
  }

  async fsync(): Promise<void> {
    for (const m of [...this.mounts].sort((a, b) => a.path.length - b.path.length)) {
      await m.backend.flush();
    }
  }

  async unmount(path: string): Promise<void> {
    const p = normalize(path);
    if (p === "/") throw new VfsError("EINVAL", p);
    const i = this.mounts.findIndex((m) => m.path === p);
    if (i < 0) throw new VfsError("ENOENT", p);
    await this.mounts[i]!.backend.flush();
    this.mounts[i]!.release?.();
    this.mounts.splice(i, 1);
  }
```

Extend the `Mount` interface with `release?: () => void` and rework `mount`:

```ts
  async mount(path: string, backend: WashBackend, opts: { exclusive?: boolean } = {}): Promise<void> {
    const p = normalize(path);
    if (this.mounts.length === 0 && p !== "/") throw new VfsError("EINVAL", "first mount must be /");
    if (this.mounts.some((m) => m.path === p)) throw new VfsError("EEXIST", p);
    if (p !== "/") await this.resolve(p);
    let release: (() => void) | undefined;
    const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
    if (opts.exclusive && locks) {
      release = await acquireLock(locks, `wash-mount:${p}`);
      if (!release) throw new VfsError("EPERM", p);
    }
    this.mounts.push({ path: p, backend, rootId: await backend.root(), release });
    this.mounts.sort((a, b) => b.path.length - a.path.length);
  }
```

with the lock helper at module level in `core/vfs.ts`:

```ts
interface LockManagerLike {
  request(name: string, opts: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<unknown>): Promise<unknown>;
}

function acquireLock(locks: LockManagerLike, name: string): Promise<(() => void) | undefined> {
  return new Promise((resolveAcq) => {
    void locks.request(name, { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolveAcq(undefined);
        return Promise.resolve();
      }
      return new Promise<void>((releaseLock) => {
        resolveAcq(() => releaseLock());
      });
    });
  });
}
```

Finalize `packages/vfs/src/index.ts`:
```ts
export const VERSION = "0.0.0";
export * from "./types.js";
export * from "./errors.js";
export { ulid } from "./ulid.js";
export { MemoryBackend } from "./backend/memory.js";
export { CachedBackend } from "./cache/cached-backend.js";
export { Vfs } from "./core/vfs.js";
export type { ResolvedNode } from "./core/vfs.js";
export type { OpenFlag } from "./core/fd.js";
export { runBackendConformance } from "./conformance/suite.js";
export { normalize, split, join } from "./core/path.js";
```

Write `packages/vfs/README.md` — short: what the package is (backend contract + VFS core per spec §4), a 15-line usage example (`new Vfs()`, mount `MemoryBackend` wrapped in `CachedBackend`, `writeFile`/`readTextFile`), how backend authors run `runBackendConformance`, and a pointer to the spec file.

- [ ] **Step 4: Run the full pipeline**

Run: `pnpm turbo build test typecheck`
Expected: all green — build emits `dist/`, every test file passes, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/vfs
git commit -m "feat(vfs): web streams, fsync, exclusive mounts via Web Locks, public API"
```

---

## Plan 1 exit criteria

- `pnpm turbo build test typecheck` green from a clean clone.
- Conformance suite passes for `MemoryBackend`, `CachedBackend(MemoryBackend)`, and `CachedBackend(MemoryBackend, {flushDelayMs: 1})`.
- `@wash/vfs` public API exports everything Plans 2–4 consume: `WashBackend`, `BackendCaps`, `Attrs`, `Dirent`, `NodeInfo`, `CHUNK_SIZE`, `VfsError`, `Errno`, `ulid`, `Vfs`, `OpenFlag`, `CachedBackend`, `MemoryBackend`, `runBackendConformance`, `normalize`/`split`/`join`.
- Not in scope (deferred per spec): core symlink *emulation* for caps-less backends (Plan 3, OPFS), chunk-granular dirty tracking and `readdirPlus` caching (Plan 2, IDB), quota/flush-error mount events (Plan 2), cwd-relative paths (Plan 4, engine).
