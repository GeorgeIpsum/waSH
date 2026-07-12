import type { Attrs, NodeId, WashBackend } from "../types.js";
import { VfsError } from "../errors.js";
import { normalize, split } from "./path.js";
import { ulid } from "../ulid.js";
import type { Dirent } from "../types.js";

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
}
