# waSH — Design Spec

**Date:** 2026-07-11
**Status:** Approved pending user review
**Repo:** turborepo monorepo, all TypeScript, pnpm workspaces

## 1. What waSH is

waSH is a published npm library family: an xterm.js-based terminal emulator with a
bash-compatible interactive shell that runs entirely in the browser, built around two
first-class extension surfaces:

1. **A pluggable filesystem storage backend API** (`@wash/vfs`), with two shipped
   backends: OPFS and IndexedDB.
2. **A plugins API** (`@wash/plugins`) for adding shell commands implemented as bash
   script text, WASI wasm modules, or JavaScript functions — all with full process
   semantics (streaming stdio, argv/env/cwd, exit codes, signals, FS access).

Out of the box it ships JS coreutils (`ls`, `cat`, `grep`, …) and `curl`/`wget`.

## 2. Engine decision (the load-bearing choice)

**waSH implements its own bash-compatible interpreter in TypeScript**, parsing with
mvdan-sh (the JS build of mvdan/sh — real bash grammar, powers shfmt) and evaluating
with an async TS tree-walker.

### Why not a real bash binary

Researched and rejected (2026-07-11):

- **bahamas10/bash-wasm** (the project that inspired waSH): Emscripten build of bash
  5.3, MEMFS, exported `FS` mount API — but **no fork/exec/wait, therefore no pipes
  and no external commands at all** (Emscripten has no fork). A 4-day April Fools'
  demo; not on npm; binaries not committed; GPLv3.
- **@wasmer/sdk (WASIX bash)**: real fork/pipes/bash in workers over SharedArrayBuffer,
  but both waSH extension points are blocked at its JS boundary: the only mountable FS
  is an in-memory `Directory` (no JS-callback filesystem → OPFS/IDB could only be
  snapshot/sync, not live backends), and JS-implemented commands are impossible (the
  Rust `register_builtin_command` hook is not exported; no JS host imports). Thin,
  bursty maintenance (their newest bash package currently fails on their newest SDK);
  no JS API for terminal resize; 6.3 MB runtime + ~2 MB bash webc cold start.
- **Forking wasmer-js** to export those hooks: 100% fidelity, but we own a Rust/
  wasm-bindgen fork forever, and every FS syscall pays a cross-worker Atomics round
  trip — structurally the *worst* case for the FS-performance goal.
- **VM routes (CheerpX/WebVM, v86)**: full Linux, but backends would sit under a block
  device/proprietary engine, not a JS API.

### Why TS wins for waSH specifically

Startup (<1 MB vs 4–6 MB + wasm compile), process spawn (object construction vs
memory-copy fork into a worker), and FS I/O (direct async calls into our VFS vs
cross-worker syscall bridging) — the dimensions that define interactive feel and the
IndexedDB performance goal. Trade-off accepted: bash semantics are reimplemented
(high fidelity, never byte-perfect); raw CPU-bound text crunching is slower in JS
coreutils, mitigated by wasm plugin commands.

### Fidelity strategy

- **Compatibility scoreboard as a first-class, published artifact**: run a curated
  subset of bash's own test suite (`tests/*.tests` + `.right` golden files) and the
  Oils/OSH spec tests (thousands of cases recording actual bash/dash/mksh/zsh
  behavior side by side, built specifically for bash reimplementations) in Node CI;
  publish the passing percentage.
- **Differential testing**: CI runs the same scripts under real bash and waSH (Node)
  and diffs stdout/stderr/exit codes; extensible to fuzzed inputs.
- Non-goals: behaviors that don't translate to a browser (real PIDs, OS signals to
  foreign processes, ulimits).

## 3. Monorepo layout

```
waSH/  (turborepo + pnpm, TypeScript)
├── packages/
│   ├── wash                # batteries-included terminal component (xterm.js) + session wiring
│   ├── engine              # @wash/engine — bash-compatible interpreter
│   ├── vfs                 # @wash/vfs — backend contract, VFS core, caches, in-memory reference backend
│   ├── backend-opfs        # @wash/backend-opfs
│   ├── backend-indexeddb   # @wash/backend-indexeddb
│   ├── plugins             # @wash/plugins — plugin/command API + WASI wasm runner
│   ├── coreutils           # @wash/coreutils — JS coreutils as plugin commands
│   └── plugin-net          # @wash/plugin-net — curl + wget
├── apps/
│   ├── playground          # Vite demo app / dev harness / deployed live demo
│   ├── docs                # docs site with embedded live demo
│   └── bench               # FS backend benchmark suite (ops/sec matrices)
└── tooling/
    └── compat              # bash-suite + Oils spec-test harness, differential runner, scoreboard
```

Dependency direction (no cycles): `wash` → everything; `engine` → `vfs` (interface
only); backends → `vfs`; `coreutils`/`plugin-net` → `plugins`. The engine knows
nothing about xterm.js or storage and runs headless in Node.

npm scope: `@wash/*` used throughout this spec; actual scope availability is checked
at implementation time and is purely a find-and-replace concern.

## 4. `@wash/vfs` — the storage backend API

Linux-VFS-style split: the core owns everything generic; backends implement a narrow,
**id-addressed** storage contract.

### Layering

```
commands/engine → POSIX-ish async façade (open/read/write/stat/readdir/mkdir/unlink/
                  rename/symlink/chmod/utimes/…)
→ VFS core: mount table · path resolution (symlinks, cwd) · fd table · permission
  checks · dentry/attr cache (incl. negative dentries) · write-back page cache
  (dirty tracking, batched ordered flush, fsync, rename barriers)
→ backend contract
```

### Backend contract

```ts
interface WashBackend {
  readonly caps: BackendCaps;   // symlinks (native|emulated|none), hardlinks,
                                // atomicDirRename, durability model, maxFileSize…
  root(): Promise<NodeId>;
  lookup(parent: NodeId, name: string): Promise<NodeInfo | null>;
  getattr(id: NodeId): Promise<Attrs>;          // kind, size, mode, mtime, ctime, nlink
  readdir(id: NodeId): Promise<Dirent[]>;
  readdirPlus?(id: NodeId): Promise<(Dirent & Attrs)[]>;   // optional, for ls -l patterns
  read(id: NodeId, offset: number, length: number): Promise<Uint8Array>;
  write(id: NodeId, offset: number, data: Uint8Array): Promise<void>;
  truncate(id: NodeId, size: number): Promise<void>;
  create(parent: NodeId, name: string, id: NodeId, kind: NodeKind,
         attrs: Partial<Attrs>): Promise<void>;            // id minted by VFS core (ULID)
  unlink(parent: NodeId, name: string): Promise<void>;
  rename(fromParent: NodeId, fromName: string,
         toParent: NodeId, toName: string): Promise<void>; // O(1) by contract
  setattr(id: NodeId, attrs: Partial<Attrs>): Promise<void>;
  readlink?/symlink?/link?                                  // per caps
  flush(): Promise<void>;                                   // durability point
}
```

Key decisions:

- **Id-addressed, single-step ops.** Path walking + caching live in the core, written
  once for all backends. Rename is O(1) regardless of subtree size.
- **NodeIds are ULIDs minted by the VFS core** and passed into `create` — namespace
  ops are write-back cacheable without a backend round trip to allocate ids.
  Contract requirement: ids stable for the lifetime of a mount (not across sessions).
- **Write-back cache** (user decision): writes land in memory and flush to the backend
  batched and ordered; visibility-establishing metadata ops (create/rename) act as
  barriers so a crash never exposes inconsistent states. `fsync`/`sync` force flush.
  Accepted risk: a tab crash loses the last few seconds of writes.
- **Capabilities, not lowest-common-denominator**: unsupported ops fail with clear
  errnos (`EPERM`) per mount; symlinks are core-emulated when a backend lacks them.
- **Metadata model**: single-user Unix-ish. Mode bits real (x-bit gates PATH lookup
  and `./script`), size, mtime/ctime, nlink. No uid/gid in v1.
- **Concurrency (v1)**: one session owns a writable mount, enforced with Web Locks;
  second tab gets read-only or a clear error. Cross-tab sharing out of scope for v1.
- Ships the **in-memory reference backend** + a reusable backend conformance suite
  (same op sequences run against reference and backend under test; third-party
  backend authors run it too).

## 5. `@wash/backend-indexeddb`

Optimized for dev-project-like workloads (user decision): thousands of small files,
deep trees, hot stat/readdir. Goal: metadata at memory speed after mount; IDB
round-trips paid in bulk, never per-file.

### Schema (one database per mount)

```
dirents   key: [parentId, name]     val: { childId, kind }
inodes    key: inodeId (ULID)       val: { kind, size, mode, mtime, ctime, nlink }
data      key: [inodeId, chunkIdx]  val: Uint8Array (64 KB chunks)
meta      key: string               val: fs metadata, schema version
```

### Operation → IDB feature map

| Operation | Implementation | Feature exploited |
|---|---|---|
| lookup | `get([parentId, name])` | exact compound-key get, O(1) |
| readdir | one `getAll(bound([id,''],[id,'￿']))` | key-range getAll: whole directory in one round-trip, name-sorted |
| ls -l | `readdirPlus`: dirent range-read + inode gets in one txn | gets pipelined within a transaction |
| rename | delete + put one dirent | O(1) |
| read | `getAll` over `[id,firstChunk]..[id,lastChunk]` | range reads; files ≤64 KB are one record |
| delete file | delete inode + `delete(bound([id,0],[id,∞]))` | range delete |
| flush | entire dirty batch in **one readwrite transaction** | commit cost (~ms) amortized over hundreds of ops |

### Performance levers (in impact order)

1. **One transaction per flush batch**; background flushes use
   `durability: 'relaxed'`, explicit fsync uses `'strict'`.
2. **Metadata warming at mount**: two bulk `getAll`s load the whole namespace into
   the dentry/attr cache (10k files ≈ few MB, tens of ms); afterwards every
   stat/lookup/readdir/glob/PATH search is pure memory. Default on below a
   configurable entry threshold.
3. **Negative dentry caching** (core feature; IDB profits most — PATH probing storms
   never re-hit IDB).

Other decisions: hardlinks supported (dirents/inodes already separate); 64 KB chunk
size validated empirically in `apps/bench` before freezing; sparse files free
(missing chunk = zeros); migrations via IDB `versionchange` + version mirror in
`meta`. Crash safety: IDB transactions are atomic → crash mid-flush loses the whole
batch, never half; FS always consistent, possibly seconds stale (matches write-back
contract).

## 6. `@wash/backend-opfs`

OPFS is hierarchical already; three real decisions:

1. **Content I/O via `FileSystemSyncAccessHandle` in a backend-owned storage worker**
   (async `createWritable` copy-rewrites whole files — rejected). RPC over
   MessageChannel; works regardless of host context. Sync handles hold exclusive
   per-file locks → bounded **LRU pool of open handles** (~64).
2. **Session-scoped NodeIds** (contract-compliant): OPFS has no inodes; backend mints
   ids at lookup/create and keeps an id→handle map in the worker.
3. **Sidecars, not lies**: per-directory hidden `.wash-attrs` entry (JSON: name →
   {mode, symlink target}, deviations-from-default only) provides mode bits and
   emulated symlinks; hardlinks declared unsupported; mtime free via
   `File.lastModified`. **Directory rename**: OPFS `move()` is file-only today →
   recursive copy+delete fallback, non-atomic, `caps.atomicDirRename = false`,
   documented loudly (IDB backend is O(1) here — honest docs data point).

`flush()` = `handle.flush()` on dirty handles; write-back cache mainly coalesces.

## 7. `@wash/engine`

- **Parser**: mvdan-sh wrapped behind thin waSH AST types (swappable if the ~1 MB
  GopherJS bundle becomes a problem).
- **Evaluator**: async TS tree-walker. Word expansion pipeline in bash's exact order
  (brace → tilde → parameter → command subst → arithmetic → splitting → globbing →
  quote removal) — the main fidelity surface. Shell state: scoped variables,
  functions, aliases, set/shopt options, traps.
- **Process model**: every invocation gets a `Process` context — argv, env, cwd,
  stdin/stdout/stderr as Web Streams, AbortSignal (SIGINT/SIGTERM), exit-code
  promise. Builtins, JS plugins, functions, wasm commands implement the same
  interface. Pipelines = TransformStreams with backpressure (EPIPE semantics work).
  Subshells/command substitution = deep-copy of shell state, no fork. Jobs: `&` →
  job table; `jobs`/`fg`/`bg`/`wait`; Ctrl+C aborts foreground job.
- **Runs anywhere**: session Web Worker by default (xterm on main thread, stdio +
  control over MessagePort); main-thread optional; Node for tests/compat.
- **Headers requirement scoped down**: base waSH (JS/bash commands, both backends)
  needs **no COOP/COEP**. Only wasm plugin commands need cross-origin isolation
  (sync WASI syscalls bridged over SAB/Atomics from a per-command worker). JSPI
  noted as a future no-headers path.
- **Interactive layer**: TS readline — history (HISTFILE on VFS), emacs keys, tab
  completion wired to shell state and VFS (compgen-style providers). xterm renders.

## 8. `@wash/plugins`

One interface; a plugin is a package of commands; all three kinds compile to the
`Process` contract:

```ts
definePlugin({ name, commands: [
  defineJsCommand({ name, exec(ctx) {...} }),        // full process context
  defineScriptCommand({ name, source }),             // bash text, own shell instance
  defineWasmCommand({ name, module: () => import(...) }), // WASI preview1
]})
```

- JS commands: streaming stdio, abort, VFS, env/cwd; `simple()` buffered sugar for
  one-liners (same interface underneath).
- Wasm commands: instantiate per invocation in own worker; preopens map to the VFS;
  the one cross-origin-isolation feature.
- **Commands are files**: registered commands materialize as executable stubs on a
  read-only virtual mount `/usr/wash/bin` (on PATH) → `which`, `type -a`, completion,
  `ls` all work; user-dropped `.wasm`/shebang files in `~/bin` execute identically.
  Symmetry between plugin-provided and user-created commands is a design invariant.
- **Lazy by default**: implementations load on first invocation.

### Shipped plugins

- `@wash/coreutils` (JS), v1 set: ls, cat, grep, mkdir, rmdir, rm, cp, mv, head,
  tail, wc, echo, printf, touch, ln, pwd, basename, dirname, env, sleep, true,
  false, which, clear, date, tee, sort, uniq, cut, tr, xargs, chmod, stat, du, find.
  Additions beyond this set are plugin territory, not core scope.
- `@wash/plugin-net`: `curl`/`wget` as JS commands with curl-compatible flag parsing
  (curlconverter's MIT TS parser as prior art/basis). Transport tiered: `fetch()`
  default (zero payload, CORS-bound); if the user configures a Wisp proxy URL, the
  command lazily loads **libcurl.js** (LGPL, ~550 KB gz, maintained) for real-TLS,
  CORS-free requests over a WebSocket proxy — identical CLI in both modes.
  (Rejected: nonexistent `curl-wasm` npm package; WASIX curl — stale, heavy,
  drags in COOP/COEP.)

## 9. `wash` package + apps

- `wash`: framework-agnostic terminal component — xterm.js + fit/webgl addons,
  theming, `createWashTerminal({ mounts, plugins })` one-liner wiring terminal ↔
  session worker ↔ VFS ↔ plugins. React/Vue wrappers as subpath exports.
- `apps/playground`: Vite app, dev harness + deployed live demo.
- `apps/docs`: docs site (guides, API reference, embedded live demo).
- `apps/bench`: backend benchmark matrix — ops/sec for read/write/stat/readdir across
  file sizes/counts/backends; validates chunk size and cache decisions; regression
  guard for the IDB performance goal.

## 10. Error handling

- VFS errors are errno-carrying (`ENOENT`, `EPERM`, `EXDEV`, …); commands map them to
  bash-style messages and exit codes.
- Backend capability violations fail per-op with clear errnos, never silently degrade.
- Write-back flush failures (quota, eviction): surface as async mount-level events +
  fail subsequent fsync; quota preflight via `navigator.storage.estimate()` in docs
  and playground.
- Engine parse/runtime errors follow bash conventions (exit 2 for syntax, 127 command
  not found, 126 not executable, 130 SIGINT).

## 11. Testing

1. **Unit** (vitest, Node): engine evaluator, VFS core, plugin API.
2. **Backend conformance suite** (from `@wash/vfs`): identical op sequences against
   in-memory reference vs OPFS/IDB backends — real browsers via Playwright (OPFS
   sync handles and IDB don't exist meaningfully in jsdom).
3. **Compat scoreboard** (`tooling/compat`): curated bash test suite + Oils spec
   tests + differential runs vs real bash; percentage published (badge/docs page).
4. **Benchmarks** (`apps/bench`): tracked over time; perf regressions are failures.

## 12. Out of scope for v1

- Cross-tab shared writable mounts (single-writer via Web Locks instead).
- uid/gid, multi-user permissions.
- Real network sockets beyond curl/wget's fetch/Wisp transports.
- Terminal multiplexing, ssh, persistence of shell sessions across reloads
  (history persists via HISTFILE; running processes don't).
- 100% bash fidelity (tracked, scored, asymptotic — not promised).
