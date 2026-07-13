export interface SidecarEntry {
  mode?: number;
  symlink?: string;
}

export type Sidecar = Record<string, SidecarEntry>;

export function parseSidecar(text: string): Sidecar {
  if (!text.trim()) return {};
  try {
    const v: unknown = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return v as Sidecar;
  } catch {
    return {};
  }
}

export function serializeSidecar(s: Sidecar): string {
  return JSON.stringify(s);
}

export function setSidecarEntry(s: Sidecar, name: string, patch: SidecarEntry): Sidecar {
  const next: Sidecar = { ...s };
  const merged: SidecarEntry = { ...(next[name] ?? {}), ...patch };
  for (const key of Object.keys(merged) as (keyof SidecarEntry)[]) {
    if (merged[key] === undefined) delete merged[key];
  }
  if (Object.keys(merged).length === 0) delete next[name];
  else next[name] = merged;
  return next;
}

export function renameSidecarEntry(s: Sidecar, from: string, to: string): Sidecar {
  if (!(from in s)) return { ...s };
  const next: Sidecar = { ...s };
  const entry = next[from]!;
  delete next[from];
  next[to] = entry;
  return next;
}

export function isEmptySidecar(s: Sidecar): boolean {
  return Object.keys(s).length === 0;
}
