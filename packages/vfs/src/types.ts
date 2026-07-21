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

/** Bulk namespace export for mount-time cache warming (spec §5). */
export interface BackendDump {
  inodes: { id: NodeId; attrs: Attrs }[];
  dirents: { parentId: NodeId; name: string; childId: NodeId; kind: NodeKind }[];
}

export interface BackendCaps {
  symlinks: "supported" | "none";
  hardlinks: boolean;
  atomicDirRename: boolean;
  /** Cost class of this backend's `rename` — O(1) rename vs. a subtree copy/walk. */
  renameCost: "O1" | "subtree";
  /**
   * Names hidden from `readdir`/`lookup` and rejected with EPERM on user
   * mutation — enforced by backends that declare it.
   */
  reservedNames?: string[];
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
  /** Durability barrier. `strict: true` REJECTS if the batch cannot be made durable
   *  (honored by CachedBackend; raw backends are inherently strict and ignore opts). */
  flush(opts?: { strict?: boolean }): Promise<void>;
  /** Optional bulk namespace export for mount-time cache warming (spec §5). */
  dump?(): Promise<BackendDump>;
}
