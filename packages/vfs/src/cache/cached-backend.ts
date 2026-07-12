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

/** Cached identity of a directory entry — never carries attrs (see class doc). */
interface LookupEntry {
  id: NodeId;
  kind: NodeKind;
}

/**
 * `attrCache` is the single source of truth for a node's Attrs; it is the
 * only map that ever stores an Attrs object, and every entry in it is a
 * live object mutated in place by write/truncate/setattr/link/unlink so
 * that all names aliasing the same node (hardlinks) observe the same
 * state. `lookupCache` therefore stores only `{ id, kind }` — never attrs —
 * so two directory entries for the same node can never hold divergent copies.
 * Callers always get a defensive copy (via `getattr`/`lookup`), so mutating
 * a returned `Attrs` can never corrupt the cache.
 */
export class CachedBackend implements WashBackend {
  readonly caps: BackendCaps;
  private lookupCache = new Map<string, LookupEntry | typeof NEG>();
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
    // Never replace the attrCache entry: mutate it in place so every other
    // name aliasing this node (existing hardlinks) observes the same nlink
    // bump instead of going stale.
    let attrs = this.attrCache.get(id);
    if (attrs) {
      attrs.nlink += 1;
    } else {
      attrs = { ...(await this.inner.getattr(id)) };
      this.attrCache.set(id, attrs);
    }
    this.lookupCache.set(this.key(parent, name), { id, kind: attrs.kind });
    this.readdirCache.get(parent)?.set(name, { name, childId: id, kind: attrs.kind });
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
    this.lookupCache.set(this.key(parent, name), { id, kind });
    this.attrCache.set(id, attrs);
    this.readdirCache.get(parent)?.set(name, { name, childId: id, kind });
  }

  /**
   * Removes a node from the caches after it loses a name (unlink, or being
   * displaced by rename). Directories can't have hardlinks, so their attr +
   * readdir entries are always dropped outright. Files/symlinks may still be
   * reachable via other names, so their cached attrs are only mutated
   * in-place (nlink decrement) and evicted once nlink drops to zero — mirrors
   * the GC semantics every WashBackend implements.
   */
  private dropVictim(id: NodeId, kind: NodeKind): void {
    if (kind === "dir") {
      this.attrCache.delete(id);
      this.readdirCache.delete(id);
      return;
    }
    const hit = this.attrCache.get(id);
    if (hit) {
      hit.nlink -= 1;
      if (hit.nlink <= 0) this.attrCache.delete(id);
    }
  }

  async root(): Promise<NodeId> {
    return this.inner.root();
  }

  async lookup(parent: NodeId, name: string): Promise<NodeInfo | null> {
    const k = this.key(parent, name);
    const hit = this.lookupCache.get(k);
    if (hit === NEG) return null;
    if (hit) {
      const attrs = await this.getattr(hit.id);
      return { id: hit.id, attrs };
    }
    const info = await this.inner.lookup(parent, name);
    this.lookupCache.set(k, info ? { id: info.id, kind: info.attrs.kind } : NEG);
    if (!info) return null;
    this.attrCache.set(info.id, { ...info.attrs });
    return { id: info.id, attrs: { ...info.attrs } };
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
    this.lookupCache.set(this.key(parent, name), NEG);
    this.readdirCache.get(parent)?.delete(name);
    if (victim) this.dropVictim(victim.id, victim.attrs.kind);
  }

  async rename(fromParent: NodeId, fromName: string, toParent: NodeId, toName: string): Promise<void> {
    const moving = await this.lookup(fromParent, fromName);
    const displaced = await this.lookup(toParent, toName);
    await this.inner.rename(fromParent, fromName, toParent, toName);
    this.lookupCache.set(this.key(fromParent, fromName), NEG);
    this.readdirCache.get(fromParent)?.delete(fromName);
    if (displaced) this.dropVictim(displaced.id, displaced.attrs.kind);
    if (moving) {
      // The moving node keeps its id and its attrCache entry untouched —
      // only the (parent, name) → id mapping moves, so there's no attrs to
      // go stale.
      this.lookupCache.set(this.key(toParent, toName), { id: moving.id, kind: moving.attrs.kind });
      this.readdirCache.get(toParent)?.set(toName, { name: toName, childId: moving.id, kind: moving.attrs.kind });
    }
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
