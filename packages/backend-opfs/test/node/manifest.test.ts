import { describe, it, expect } from "vitest";
import {
  fnv1a, serializeManifest, parseManifest, selectGeneration, emptyManifest, liveIds,
  type Manifest,
} from "../../src/manifest.js";

const enc = new TextEncoder();

function sample(rootId = "R"): Manifest {
  return {
    rootId,
    inodes: {
      R: { kind: "dir", size: 0, mode: 0o755, mtimeMs: 1, ctimeMs: 1, nlink: 1 },
      F: { kind: "file", size: 3, mode: 0o644, mtimeMs: 2, ctimeMs: 2, nlink: 1 },
      L: { kind: "symlink", size: 4, mode: 0o777, mtimeMs: 3, ctimeMs: 3, nlink: 1, target: "/f" },
    },
    dirents: { R: { "f.txt": { id: "F", kind: "file" }, ln: { id: "L", kind: "symlink" } } },
  };
}

describe("manifest core", () => {
  it("fnv1a is deterministic and differs on change", () => {
    expect(fnv1a(enc.encode("hello"))).toBe(fnv1a(enc.encode("hello")));
    expect(fnv1a(enc.encode("hello"))).not.toBe(fnv1a(enc.encode("hellp")));
  });

  it("round-trips a manifest with its generation", () => {
    const bytes = serializeManifest(sample(), 7);
    const parsed = parseManifest(bytes);
    expect(parsed?.generation).toBe(7);
    expect(parsed?.manifest).toEqual(sample());
  });

  it("rejects a truncated body (checksum mismatch)", () => {
    const bytes = serializeManifest(sample(), 1);
    const truncated = bytes.slice(0, bytes.byteLength - 5);
    expect(parseManifest(truncated)).toBeNull();
  });

  it("rejects garbage and an empty buffer", () => {
    expect(parseManifest(enc.encode("not a manifest"))).toBeNull();
    expect(parseManifest(new Uint8Array(0))).toBeNull();
  });

  it("selectGeneration picks the highest valid; falls back when newest is corrupt", () => {
    const a = serializeManifest({ ...sample(), rootId: "A" }, 10);
    const b = serializeManifest({ ...sample(), rootId: "B" }, 11);
    expect(selectGeneration(a, b)).toMatchObject({ generation: 11, currentSlot: "b" });
    const bCorrupt = b.slice(0, b.byteLength - 4);
    expect(selectGeneration(a, bCorrupt)).toMatchObject({ generation: 10, currentSlot: "a" });
  });

  it("selectGeneration reports empty (both absent) vs corrupt (present, none valid)", () => {
    expect(selectGeneration(null, null)).toEqual({ state: "empty" });
    const garbage = enc.encode("xxxx");
    expect(selectGeneration(garbage, null)).toEqual({ state: "corrupt" });
    expect(selectGeneration(garbage, garbage)).toEqual({ state: "corrupt" });
  });

  it("emptyManifest has a root dir and no dirents; liveIds covers all inode ids", () => {
    const m = emptyManifest("ROOT");
    expect(m.inodes.ROOT.kind).toBe("dir");
    expect(m.dirents).toEqual({});
    expect(liveIds(sample())).toEqual(new Set(["R", "F", "L"]));
  });
});
