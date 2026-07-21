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
  readonly caps: BackendCaps = { symlinks: "supported", hardlinks: true, atomicDirRename: true, renameCost: "O1" };
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
    if (data.byteLength === 0) return;
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

  async flush(_opts?: { strict?: boolean }): Promise<void> {}
}
