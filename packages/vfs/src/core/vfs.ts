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
