import { VfsError } from "../errors.js";

export function normalize(p: string): string {
  if (!p.startsWith("/")) throw new VfsError("EINVAL", p);
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return "/" + out.join("/");
}

export function split(p: string): string[] {
  const n = normalize(p);
  return n === "/" ? [] : n.slice(1).split("/");
}

export function join(base: string, rel: string): string {
  return normalize(base.endsWith("/") ? base + rel : base + "/" + rel);
}
