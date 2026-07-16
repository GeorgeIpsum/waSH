import { CHUNK_SIZE, VfsError } from "@wash/vfs";
import { Lru } from "./lru.js";

/** Chunked content store over blobs/<inodeId>.<chunkIdx>, sync-access-handle backed. */
export class BlobStore {
  private pool: Lru<string, FileSystemSyncAccessHandle>;
  /** An eviction that fails to flush loses data silently; record it so the next flushAll surfaces it. */
  private evictError: VfsError | null = null;
  constructor(
    private readonly blobDir: FileSystemDirectoryHandle,
    poolSize: number,
    readonly chunkSize: number = CHUNK_SIZE,
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

  private async handle(id: string, idx: number, create: boolean): Promise<FileSystemSyncAccessHandle | null> {
    const k = this.key(id, idx);
    const cached = this.pool.get(k);
    if (cached) return cached;
    let fh: FileSystemFileHandle;
    try {
      fh = await this.blobDir.getFileHandle(k, { create });
    } catch (e) {
      if ((e as { name?: string }).name === "NotFoundError") return null;
      throw new VfsError("ENOSPC", k);
    }
    let h: FileSystemSyncAccessHandle;
    try {
      h = await fh.createSyncAccessHandle();
    } catch {
      throw new VfsError("EBUSY", k);
    }
    this.pool.set(k, h);
    return h;
  }

  async read(id: string, offset: number, length: number, size: number): Promise<Uint8Array> {
    if (offset >= size || length === 0) return new Uint8Array(0);
    const end = Math.min(offset + length, size);
    const out = new Uint8Array(end - offset); // zero-initialized: sparse/absent chunks read as zeros
    const first = Math.floor(offset / this.chunkSize);
    const last = Math.floor((end - 1) / this.chunkSize);
    for (let idx = first; idx <= last; idx++) {
      const h = await this.handle(id, idx, false);
      if (!h) continue; // sparse
      const chunkStart = idx * this.chunkSize;
      const from = Math.max(offset, chunkStart);
      const to = Math.min(end, chunkStart + this.chunkSize);
      const buf = new Uint8Array(to - from);
      h.read(buf, { at: from - chunkStart });
      out.set(buf, from - offset);
    }
    return out;
  }

  async write(id: string, offset: number, data: Uint8Array): Promise<void> {
    if (data.byteLength === 0) return;
    const end = offset + data.byteLength;
    const first = Math.floor(offset / this.chunkSize);
    const last = Math.floor((end - 1) / this.chunkSize);
    for (let idx = first; idx <= last; idx++) {
      const chunkStart = idx * this.chunkSize;
      const from = Math.max(offset, chunkStart);
      const to = Math.min(end, chunkStart + this.chunkSize);
      const h = (await this.handle(id, idx, true))!;
      try {
        h.write(data.subarray(from - offset, to - offset), { at: from - chunkStart });
      } catch (e) {
        if ((e as { name?: string }).name === "QuotaExceededError") throw new VfsError("ENOSPC", id);
        throw new VfsError("EBUSY", id);
      }
    }
  }

  async truncate(id: string, size: number, prevSize: number): Promise<void> {
    const lastKeep = size === 0 ? -1 : Math.floor((size - 1) / this.chunkSize);
    const prevLast = prevSize === 0 ? -1 : Math.floor((prevSize - 1) / this.chunkSize);
    for (let idx = lastKeep + 1; idx <= prevLast; idx++) {
      this.pool.delete(this.key(id, idx), true);
      await this.blobDir.removeEntry(this.key(id, idx)).catch(() => {});
    }
    if (lastKeep >= 0) {
      const keep = size - lastKeep * this.chunkSize;
      const h = await this.handle(id, lastKeep, false);
      if (h && h.getSize() > keep) h.truncate(keep);
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

  async gc(liveIds: Set<string>): Promise<void> {
    for await (const name of (this.blobDir as unknown as { keys(): AsyncIterableIterator<string> }).keys()) {
      const dot = name.lastIndexOf(".");
      const id = dot > 0 ? name.slice(0, dot) : name;
      if (!liveIds.has(id)) {
        this.pool.delete(name, false);
        await this.blobDir.removeEntry(name).catch(() => {});
      }
    }
  }
}
