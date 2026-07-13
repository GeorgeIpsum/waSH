export type Errno =
  | "ENOENT" | "EEXIST" | "ENOTDIR" | "EISDIR" | "ENOTEMPTY"
  | "EINVAL" | "ELOOP" | "EBADF" | "EXDEV" | "EPERM" | "ENOSYS" | "EBUSY" | "ENOSPC";

export class VfsError extends Error {
  constructor(public readonly errno: Errno, public readonly path?: string) {
    super(path ? `${errno}: ${path}` : errno);
    this.name = "VfsError";
  }
}
