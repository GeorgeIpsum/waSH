# @wash/vfs

The storage backend API for waSH: a Linux-VFS-style split between a generic
core (mount table, path resolution, symlinks, fd table, write-back caching,
fsync) and a narrow, id-addressed `WashBackend` storage contract that backend
authors implement. See spec §4 (`docs/superpowers/specs/2026-07-11-wash-monorepo-design.md`)
for the full design rationale.

## Usage

```ts
import { Vfs, MemoryBackend, CachedBackend } from "@wash/vfs";

const vfs = new Vfs();
await vfs.mount("/", new CachedBackend(new MemoryBackend(), { flushDelayMs: 250 }));

await vfs.mkdir("/projects");
await vfs.writeFile("/projects/hello.txt", "hello, waSH");
console.log(await vfs.readTextFile("/projects/hello.txt")); // "hello, waSH"

// Streaming for large files:
const rs = await vfs.createReadStream("/projects/hello.txt");
const ws = await vfs.createWriteStream("/projects/copy.txt");
await rs.pipeTo(ws);

// Force the write-back cache to the underlying backend:
await vfs.fsync();
```

`Vfs` exposes a POSIX-ish async surface (`open`/`read`/`write`/`stat`/`readdir`/
`mkdir`/`unlink`/`rename`/`symlink`/`chmod`/`utimes`/`mount`/`unmount`/…) on top
of any number of mounted backends. Mounting with `{ exclusive: true }` takes a
Web Lock (`navigator.locks`) named `wash-mount:<path>` when available, so a
second tab/session attempting the same exclusive mount gets `VfsError("EPERM")`
instead of silently sharing state; it's a no-op where Web Locks aren't present
(e.g. Node).

## Writing a backend

Implement the `WashBackend` interface (id-addressed `root`/`lookup`/`getattr`/
`readdir`/`read`/`write`/`truncate`/`create`/`unlink`/`rename`/`setattr`/`flush`,
plus optional `symlink`/`readlink`/`link`/`readdirPlus` gated by `caps`) and run
the shared conformance suite against it:

```ts
import { runBackendConformance } from "@wash/vfs/conformance";
import { MyBackend } from "./my-backend.js";

runBackendConformance("MyBackend", () => new MyBackend());
```

The suite runs the same operation sequences used against the in-memory
reference backend (`MemoryBackend`), so a passing run is a strong guarantee
your backend behaves like the rest of the fleet — including capability-gated
cases that skip automatically based on `backend.caps`.

## Reference

Full design rationale, the backend contract, and out-of-scope-for-v1 notes
live in the spec: `docs/superpowers/specs/2026-07-11-wash-monorepo-design.md`
(§4 `@wash/vfs`).
