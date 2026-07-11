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
