import { CHUNK_SIZE, VfsError } from "@wash/vfs";
import { Lru } from "./lru.js";
import type { Manifest } from "./manifest.js";

/** Matches a versioned chunk filename "<inodeId>.<chunkIdx>.<gen>". Inode ids are ULIDs
 *  (no dots), so the greedy `(.+)` correctly backtracks to the last two dot-delimited,
 *  purely-numeric segments. */
const VERSIONED_NAME_RE = /^(.+)\.(\d+)\.(\d+)$/;

/**
 * Chunked content store over blobs/<inodeId>.<chunkIdx>.<gen> — copy-on-write versioned
 * chunks, sync-access-handle backed.
 *
 * A chunk version `<id>.<chunk>.<g>` is immutable once generation `g` is committed.
 * Mutations always COW into `<id>.<chunk>.<stagedGen>` (stagedGen = committed generation + 1,
 * supplied by the caller) — the committed versions are never touched in place, so the prior
 * generation's content is always intact on disk even if a commit crashes or is rolled back.
 * There is no in-memory undo-log: rollback just discards the staged-gen files.
 */
export class BlobStore {
  private pool: Lru<string, FileSystemSyncAccessHandle>;
  /** An eviction that fails to flush loses data silently; record it so the next flushAll surfaces it. */
  private evictError: VfsError | null = null;

  /** key "<id>.<idx>" -> the chunk version (generation) the working view reads/writes. */
  private chunkVersion = new Map<string, number>();
  /**
   * Per-batch rollback bookkeeping (key = "<id>.<idx>") -> the chunk's PRE-BATCH version, or
   * `null` if it did not exist pre-batch. Populated on a chunk's first mutation this batch
   * (in `cow()` and in `truncate()`'s tail-drop loop). Cleared on both rollback and commit.
   */
  private staged = new Map<string, number | null>();
  /**
   * The generation this batch's mutations are staged into. Constant within a batch (the
   * worker only advances `generation` on a successful commit), so a single scalar — set by
   * every `write`/`truncate` call — is enough for `rollbackBatch` to find and delete each
   * staged-gen file, even for chunks a same-batch truncate later dropped from `chunkVersion`.
   */
  private stagedGen: number | null = null;

  constructor(
    private readonly blobDir: FileSystemDirectoryHandle,
    poolSize: number,
    readonly chunkSize: number = CHUNK_SIZE,
    /** Test-gated fault hook (same instance as the worker's `maybeFault`); a no-op when no
     *  fault is registered, so this is zero-cost in production. */
    private readonly maybeFault: (site: string) => void = () => {},
  ) {
    this.pool = new Lru(poolSize, (_k, h) => this.onEvict(h));
  }

  private onEvict(h: FileSystemSyncAccessHandle): void {
    try {
      try { h.flush(); } catch (e) {
        if (!this.evictError) {
          this.evictError = (e as { name?: string }).name === "QuotaExceededError"
            ? new VfsError("ENOSPC") : new VfsError("EBUSY");
        }
      } finally { h.close(); }
    } catch { /* already closed */ }
  }

  private key(id: string, idx: number): string {
    return `${id}.${idx}`;
  }

  private versionedName(id: string, idx: number, gen: number): string {
    return `${id}.${idx}.${gen}`;
  }

  /** Acquire (optionally creating) the pooled sync access handle for a FULL versioned chunk file. */
  private async handleVersioned(id: string, idx: number, gen: number, create: boolean): Promise<FileSystemSyncAccessHandle | null> {
    const name = this.versionedName(id, idx, gen);
    const cached = this.pool.get(name);
    if (cached) return cached;
    let fh: FileSystemFileHandle;
    try {
      fh = await this.blobDir.getFileHandle(name, { create });
    } catch (e) {
      if ((e as { name?: string }).name === "NotFoundError") return null;
      throw new VfsError("ENOSPC", name);
    }
    let h: FileSystemSyncAccessHandle;
    try {
      h = await fh.createSyncAccessHandle();
    } catch {
      throw new VfsError("EBUSY", name);
    }
    this.pool.set(name, h);
    return h;
  }

  /**
   * Ensure <id>.<idx> has a writable staged-gen version this batch, copying the committed
   * bytes forward ONCE on first mutation so unmutated parts of the chunk survive. NEVER
   * mutates a committed version in place. Returns the staged (mutable) handle.
   */
  private async cow(id: string, idx: number, stagedGen: number): Promise<FileSystemSyncAccessHandle> {
    const key = this.key(id, idx);
    const cur = this.chunkVersion.get(key);
    if (cur === stagedGen) {
      // already staged this batch → mutate the staged version directly
      return (await this.handleVersioned(id, idx, stagedGen, true))!;
    }
    // first mutation this batch: record rollback info, create the staged version from the committed one
    if (!this.staged.has(key)) this.staged.set(key, cur ?? null);
    // Read the committed source bytes INTO MEMORY FIRST (only one live handle at a time), so
    // acquiring the staged handle below can't evict a still-needed source handle under a
    // handlePoolSize: 1 pool (the source open would otherwise evict+close the not-yet-acquired
    // staged handle, or vice versa).
    let srcBytes: Uint8Array | null = null;
    if (cur !== undefined) {
      const src = await this.handleVersioned(id, idx, cur, false);
      if (src) {
        const size = src.getSize();
        if (size > 0) {
          srcBytes = new Uint8Array(size);
          src.read(srcBytes, { at: 0 });
        }
      }
    }
    const staged = (await this.handleVersioned(id, idx, stagedGen, true))!;
    // Reset the staged version to exactly the committed source (or empty when there is none),
    // ALWAYS — not just when srcBytes is non-null. `handleVersioned(create:true)` can reopen a
    // file that lingered from a swallowed rollback `removeEntry`; without this truncate a reused
    // version (especially a sparse/empty-source chunk) could leak stale bytes into a later
    // partial write. truncate(0) on a fresh handle is a no-op.
    staged.truncate(srcBytes ? srcBytes.byteLength : 0);
    if (srcBytes) {
      const n = staged.write(srcBytes, { at: 0 }); // copy committed bytes forward so unmutated parts survive
      // A short copy-forward is an internal integrity failure (not caller-facing pressure like a
      // partial content write) — the staged version would silently diverge from the committed one.
      if (n < srcBytes.byteLength) throw new VfsError("EIO", key);
    }
    this.chunkVersion.set(key, stagedGen);
    return staged;
  }

  async read(id: string, offset: number, length: number, size: number): Promise<Uint8Array> {
    if (offset >= size || length === 0) return new Uint8Array(0);
    const end = Math.min(offset + length, size);
    const out = new Uint8Array(end - offset); // zero-initialized: sparse/absent chunks read as zeros
    const first = Math.floor(offset / this.chunkSize);
    const last = Math.floor((end - 1) / this.chunkSize);
    for (let idx = first; idx <= last; idx++) {
      const v = this.chunkVersion.get(this.key(id, idx));
      if (v === undefined) continue; // sparse: no version resolves for this chunk
      const h = await this.handleVersioned(id, idx, v, false);
      if (!h) continue; // sparse (defensive: map claimed a version but file is gone)
      const chunkStart = idx * this.chunkSize;
      const from = Math.max(offset, chunkStart);
      const to = Math.min(end, chunkStart + this.chunkSize);
      const buf = new Uint8Array(to - from);
      h.read(buf, { at: from - chunkStart });
      out.set(buf, from - offset);
    }
    return out;
  }

  /** `stagedGen` = the generation this batch will commit (committed generation + 1). */
  async write(id: string, offset: number, data: Uint8Array, stagedGen: number): Promise<void> {
    if (data.byteLength === 0) return;
    this.stagedGen = stagedGen;
    const end = offset + data.byteLength;
    const first = Math.floor(offset / this.chunkSize);
    const last = Math.floor((end - 1) / this.chunkSize);
    for (let idx = first; idx <= last; idx++) {
      const chunkStart = idx * this.chunkSize;
      const from = Math.max(offset, chunkStart);
      const to = Math.min(end, chunkStart + this.chunkSize);
      const h = await this.cow(id, idx, stagedGen); // COW: write always targets the staged, mutable version
      const slice = data.subarray(from - offset, to - offset);
      try {
        this.maybeFault("blobWrite"); // test-only: fail AFTER the chunk is staged, BEFORE the byte write
        const n = h.write(slice, { at: from - chunkStart });
        // A short (non-throwing) write under pressure must not be treated as success — it would
        // let the worker commit a manifest size the blob doesn't actually back.
        if (n < slice.byteLength) throw new VfsError("ENOSPC", id);
      } catch (e) {
        if (e instanceof VfsError) throw e;
        if ((e as { name?: string }).name === "QuotaExceededError") throw new VfsError("ENOSPC", id);
        throw new VfsError("EBUSY", id);
      }
    }
  }

  async truncate(id: string, size: number, prevSize: number, stagedGen: number): Promise<void> {
    this.stagedGen = stagedGen;
    const lastKeep = size === 0 ? -1 : Math.floor((size - 1) / this.chunkSize);
    const prevLast = prevSize === 0 ? -1 : Math.floor((prevSize - 1) / this.chunkSize);
    for (let idx = lastKeep + 1; idx <= prevLast; idx++) {
      const key = this.key(id, idx);
      const cur = this.chunkVersion.get(key);
      if (cur === undefined) continue; // already sparse in the working view
      if (!this.staged.has(key)) this.staged.set(key, cur);
      // Working view drops the chunk (size gates it out) — do NOT delete the physical file:
      // a retained prior generation may still resolve to it; GC reclaims once unreferenced.
      this.chunkVersion.delete(key);
    }
    if (lastKeep >= 0) {
      const key = this.key(id, lastKeep);
      const cur = this.chunkVersion.get(key);
      if (cur !== undefined) {
        const keep = size - lastKeep * this.chunkSize;
        const existing = await this.handleVersioned(id, lastKeep, cur, false);
        if (existing && existing.getSize() > keep) {
          // COW-first so the committed boundary version is untouched, then physically shorten
          // the STAGED version so a later extend reads zeros in the gap.
          const h = await this.cow(id, lastKeep, stagedGen);
          h.truncate(keep);
        }
      }
    }
  }

  /** Flush every live handle plus surface any recorded eviction-flush failure. Returns the first error or null. */
  flushAll(): VfsError | null {
    let first: VfsError | null = this.evictError;
    this.evictError = null;
    for (const k of [...this.pool.keys()]) {
      const h = this.pool.peek(k);
      try {
        h?.flush();
      } catch (e) {
        if (!first) first = (e as { name?: string }).name === "QuotaExceededError"
          ? new VfsError("ENOSPC") : new VfsError("EBUSY");
      }
    }
    return first;
  }

  closeAll(): void {
    this.pool.clear(true);
  }

  /**
   * Discard every chunk version staged this batch and revert `chunkVersion` to its pre-batch
   * state. Committed versions were NEVER touched (COW wrote only to `<id>.<chunk>.<stagedGen>`),
   * so there are no bytes to restore — just delete the staged-gen files (best-effort; a missing
   * file, e.g. a chunk only ever dropped by truncate and never COW'd, is a harmless no-op) and
   * revert the map.
   */
  async rollbackBatch(): Promise<void> {
    const sg = this.stagedGen;
    for (const [key, prevVersion] of this.staged) {
      try {
        if (sg !== null) {
          const name = `${key}.${sg}`;
          const h = this.pool.peek(name);
          if (h) { try { h.close(); } catch { /* already closed */ } }
          this.pool.delete(name, false);
          await this.blobDir.removeEntry(name).catch(() => {});
        }
        if (prevVersion === null) this.chunkVersion.delete(key);
        else this.chunkVersion.set(key, prevVersion);
      } catch { /* pathological double-fault; best-effort */ }
    }
    this.staged.clear();
    this.stagedGen = null;
  }

  /** Discard staged-batch bookkeeping after a durable commit — the staged-gen files are now the committed versions. */
  commitBatch(): void {
    this.staged.clear();
    this.stagedGen = null;
  }

  /**
   * Scan `blobs/` and resolve, per chunk key "<id>.<idx>", the highest version `<= selectedGen`.
   * Used both to build the live working-view map at open (`buildVersionMap`) and to resolve an
   * arbitrary retained on-disk generation's view for union GC (`unionLiveChunkFiles` in worker.ts).
   * Names with every version `> selectedGen` are ignored (orphans from a torn/crashed commit) —
   * they simply resolve to no version for that view and are later reclaimed by GC.
   */
  async resolveGenerationVersions(selectedGen: number): Promise<Map<string, number>> {
    const versions = new Map<string, number>();
    for await (const name of (this.blobDir as unknown as { keys(): AsyncIterableIterator<string> }).keys()) {
      const m = VERSIONED_NAME_RE.exec(name);
      if (!m) continue;
      const gen = Number(m[3]);
      if (gen > selectedGen) continue;
      const key = `${m[1]}.${m[2]}`;
      const cur = versions.get(key);
      if (cur === undefined || gen > cur) versions.set(key, gen);
    }
    return versions;
  }

  /**
   * At open: resolve the working `chunkVersion` map from disk for the selected generation,
   * SIZE-GATED to each file inode's current size in `manifest`. A chunk beyond an inode's size
   * must NOT resurface in the working view even if a versioned file for it still exists on disk
   * (e.g. a shrink+flush keeps the old physical tail chunk around for GC/fallback) — otherwise a
   * later extend or sparse write would COW those stale bytes into what should read as a
   * zero-filled gap, resurrecting truncated-away data. This only narrows the WORKING map; GC's
   * union-live-set computation (`unionLiveChunkFiles`/`resolveGenerationVersions`) is unaffected
   * and still keeps a fallback generation's in-its-size chunks live independently.
   */
  async buildVersionMap(selectedGen: number, manifest: Manifest): Promise<void> {
    const available = await this.resolveGenerationVersions(selectedGen);
    const map = new Map<string, number>();
    for (const [id, rec] of Object.entries(manifest.inodes)) {
      if (rec.kind !== "file") continue;
      const chunkCount = rec.size === 0 ? 0 : Math.ceil(rec.size / this.chunkSize);
      for (let chunk = 0; chunk < chunkCount; chunk++) {
        const key = `${id}.${chunk}`;
        const v = available.get(key);
        if (v !== undefined) map.set(key, v);
      }
    }
    this.chunkVersion = map;
  }

  /** A read-only snapshot of the current in-session working-view chunk versions (for union GC). */
  chunkVersionSnapshot(): ReadonlyMap<string, number> {
    return new Map(this.chunkVersion);
  }

  /** Reclaim every physical chunk file whose FULL versioned name is not in `liveFiles`. */
  async gc(liveFiles: Set<string>): Promise<void> {
    for await (const name of (this.blobDir as unknown as { keys(): AsyncIterableIterator<string> }).keys()) {
      if (!liveFiles.has(name)) {
        // Version-aware GC can target a superseded committed version that is still pooled —
        // close its open sync access handle first (same pattern as rollbackBatch), otherwise
        // an open handle blocks removeEntry and leaks the handle.
        const h = this.pool.peek(name);
        if (h) { try { h.close(); } catch { /* already closed */ } }
        this.pool.delete(name, false);
        await this.blobDir.removeEntry(name).catch(() => {});
      }
    }
  }
}
