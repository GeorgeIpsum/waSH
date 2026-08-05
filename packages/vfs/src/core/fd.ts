import type { NodeId, WashBackend } from "../types.js";
import { VfsError } from "../errors.js";

export type OpenFlag = "r" | "r+" | "w" | "w+" | "a" | "a+" | "wx" | "ax";

export interface OpenFile {
  fd: number;
  backend: WashBackend;
  id: NodeId;
  pos: number;
  flags: OpenFlag;
}

export function canRead(f: OpenFlag): boolean {
  return f === "r" || f === "r+" || f === "w+" || f === "a+";
}
export function canWrite(f: OpenFlag): boolean {
  return f !== "r";
}
export function isAppend(f: OpenFlag): boolean {
  return f === "a" || f === "a+" || f === "ax";
}

export class FdTable {
  private next = 3;
  private files = new Map<number, OpenFile>();

  alloc(backend: WashBackend, id: NodeId, flags: OpenFlag): OpenFile {
    const file: OpenFile = { fd: this.next++, backend, id, pos: 0, flags };
    this.files.set(file.fd, file);
    return file;
  }

  get(fd: number): OpenFile {
    const f = this.files.get(fd);
    if (!f) throw new VfsError("EBADF", String(fd));
    return f;
  }

  close(fd: number): OpenFile {
    const f = this.files.get(fd);
    if (!f) throw new VfsError("EBADF", String(fd));
    this.files.delete(fd);
    return f;
  }
}
