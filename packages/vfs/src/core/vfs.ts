import type { Attrs, NodeId, WashBackend } from "../types.js";
import { VfsError } from "../errors.js";
import { normalize, split } from "./path.js";
import { ulid } from "../ulid.js";
import type { Dirent } from "../types.js";
import { CHUNK_SIZE } from "../types.js";
import { FdTable, canRead, canWrite, isAppend, type OpenFlag } from "./fd.js";

const MAX_SYMLINK_HOPS = 40;

interface Mount { path: string; backend: WashBackend; rootId: NodeId; release?: () => void; }

interface LockManagerLike {
  request(name: string, opts: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<unknown>): Promise<unknown>;
}

function acquireLock(locks: LockManagerLike, name: string): Promise<(() => void) | undefined> {
  return new Promise((resolveAcq, rejectAcq) => {
    locks
      .request(name, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolveAcq(undefined);
          return Promise.resolve();
        }
        return new Promise<void>((releaseLock) => {
          resolveAcq(() => releaseLock());
        });
      })
      .catch(rejectAcq);
  });
}

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
  private fds = new FdTable();

  async mount(path: string, backend: WashBackend, opts: { exclusive?: boolean } = {}): Promise<void> {
    const p = normalize(path);
    if (this.mounts.length === 0 && p !== "/") throw new VfsError("EINVAL", "first mount must be /");
    if (this.mounts.some((m) => m.path === p)) throw new VfsError("EEXIST", p);
    if (p !== "/") await this.resolve(p); // mountpoint must exist on parent mount
    let release: (() => void) | undefined;
    const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
    if (opts.exclusive && locks) {
      release = await acquireLock(locks, `wash-mount:${p}`);
      if (!release) throw new VfsError("EPERM", p);
    }
    try {
      this.mounts.push({ path: p, backend, rootId: await backend.root(), release });
      this.mounts.sort((a, b) => b.path.length - a.path.length);
    } catch (e) {
      release?.();
      throw e;
    }
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

  private async resolveParent(path: string): Promise<{ backend: WashBackend; dirId: NodeId; name: string; mountPath: string; parentRealPath: string }> {
    const p = normalize(path);
    if (p === "/") throw new VfsError("EINVAL", "/");
    const idx = p.lastIndexOf("/");
    const parentPath = idx === 0 ? "/" : p.slice(0, idx);
    const name = p.slice(idx + 1);
    const parent = await this.resolve(parentPath);
    if (parent.attrs.kind !== "dir") throw new VfsError("ENOTDIR", parentPath);
    return { backend: parent.backend, dirId: parent.id, name, mountPath: parent.mountPath, parentRealPath: parent.realPath };
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
    const src = await this.resolveParent(f);
    const dst = await this.resolveParent(t);
    if (src.mountPath !== dst.mountPath) throw new VfsError("EXDEV", to);
    const moving = await this.resolve(f, { followLast: false });
    if (
      dst.parentRealPath === moving.realPath ||
      dst.parentRealPath.startsWith(moving.realPath === "/" ? "/" : moving.realPath + "/")
    ) {
      throw new VfsError("EINVAL", to);
    }
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
    // O_APPEND affects writes only (write() re-derives EOF per call);
    // "a+" fds read from the start, so only write-only append flags seed pos.
    if (flags === "a" || flags === "ax") file.pos = (await target.backend.getattr(target.id)).size;
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
    const m = this.mounts.find((x) => x.path === p);
    if (!m) throw new VfsError("ENOENT", p);
    await m.backend.flush();
    const i = this.mounts.indexOf(m);
    if (i < 0) throw new VfsError("ENOENT", p);
    this.mounts.splice(i, 1);
    m.release?.();
  }
}
