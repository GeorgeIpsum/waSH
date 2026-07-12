import type { Attrs, BackendCaps, Dirent, NodeId, NodeInfo, NodeKind, WashBackend } from "../types.js";

const NEG = Symbol("negative");

function defaultMode(kind: NodeKind): number {
  return kind === "dir" ? 0o755 : kind === "symlink" ? 0o777 : 0o644;
}

/**
 * Synthesizes the Attrs a fresh node must have, without round-tripping to
 * `inner.getattr()`. The size/mode/nlink defaults mirror the invariants the
 * shared conformance suite locks in for every WashBackend (spec §4): a
 * freshly created file is mode 0o644, size 0, nlink 1 unless overridden by
 * the caller-supplied `attrs`. This keeps `create()` a single round trip to
 * `inner`, as required for the cache to stay authoritative in place.
 */
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

export class CachedBackend implements WashBackend {
  readonly caps: BackendCaps;
  private lookupCache = new Map<string, NodeInfo | typeof NEG>();
  private attrCache = new Map<NodeId, Attrs>();
  private readdirCache = new Map<NodeId, Map<string, Dirent>>();

  // Optional per WashBackend — only present on the instance when `inner` has them
  // (conditional assignment in the constructor below).
  symlink?: (parent: NodeId, name: string, id: NodeId, target: string) => Promise<void> = async (
    parent,
    name,
    id,
    target,
  ): Promise<void> => {
    if (!this.inner.symlink) throw new Error("unsupported");
    await this.inner.symlink(parent, name, id, target);
    this.primeEntry(parent, name, id, "symlink", await this.inner.getattr(id));
  };

  readlink?: (id: NodeId) => Promise<string> = async (id): Promise<string> => {
    if (!this.inner.readlink) throw new Error("unsupported");
    return this.inner.readlink(id);
  };

  link?: (parent: NodeId, name: string, id: NodeId) => Promise<void> = async (parent, name, id): Promise<void> => {
    if (!this.inner.link) throw new Error("unsupported");
    await this.inner.link(parent, name, id);
    const attrs = await this.inner.getattr(id);
    this.attrCache.set(id, attrs);
    this.primeEntry(parent, name, id, attrs.kind, attrs);
  };

  constructor(protected inner: WashBackend, protected opts: { flushDelayMs?: number } = {}) {
    this.caps = inner.caps;
    if (!inner.symlink) this.symlink = undefined as never;
    if (!inner.readlink) this.readlink = undefined as never;
    if (!inner.link) this.link = undefined as never;
  }

  private key(parent: NodeId, name: string): string {
    return parent + "\0" + name;
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
    this.primeEntry(parent, name, id, kind, mkAttrs(kind, attrs));
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

  async flush(): Promise<void> {
    await this.inner.flush();
  }
}
