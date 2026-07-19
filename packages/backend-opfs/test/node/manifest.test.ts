import { describe, it, expect } from "vitest";
import {
  fnv1a, serializeManifest, parseManifest, selectGeneration, emptyManifest, liveIds,
  holesHas, holesAdd, holesRemove, holesClamp,
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

  it("treats a zero-length slot as absent (fresh mount survives a torn first write)", () => {
    const empty = new Uint8Array(0);
    // both slots zero-length → empty, NOT corrupt: a torn first write must not brick a fresh mount
    expect(selectGeneration(empty, empty)).toEqual({ state: "empty" });
    expect(selectGeneration(empty, null)).toEqual({ state: "empty" });
    // a zero-length slot alongside a valid one falls back to the valid generation
    const valid = serializeManifest(sample(), 5);
    expect(selectGeneration(empty, valid)).toMatchObject({ generation: 5, currentSlot: "b" });
  });

  it("emptyManifest has a root dir and no dirents; liveIds covers all inode ids", () => {
    const m = emptyManifest("ROOT");
    expect(m.inodes.ROOT.kind).toBe("dir");
    expect(m.dirents).toEqual({});
    expect(liveIds(sample())).toEqual(new Set(["R", "F", "L"]));
  });
});

describe("holes interval helpers (P1 deep — pure, gate correctness)", () => {
  describe("holesHas", () => {
    it("empty ranges: nothing is a hole", () => {
      expect(holesHas([], 0)).toBe(false);
      expect(holesHas([], 5)).toBe(false);
    });

    it("single range: inside/at-boundaries/outside", () => {
      const r: Array<[number, number]> = [[3, 6]];
      expect(holesHas(r, 2)).toBe(false);
      expect(holesHas(r, 3)).toBe(true); // start inclusive
      expect(holesHas(r, 5)).toBe(true);
      expect(holesHas(r, 6)).toBe(false); // end exclusive
      expect(holesHas(r, 100)).toBe(false);
    });

    it("multiple ranges: gaps between them are not holes", () => {
      const r: Array<[number, number]> = [[0, 2], [5, 8], [10, 11]];
      expect(holesHas(r, 0)).toBe(true);
      expect(holesHas(r, 1)).toBe(true);
      expect(holesHas(r, 2)).toBe(false);
      expect(holesHas(r, 4)).toBe(false);
      expect(holesHas(r, 5)).toBe(true);
      expect(holesHas(r, 7)).toBe(true);
      expect(holesHas(r, 8)).toBe(false);
      expect(holesHas(r, 10)).toBe(true);
      expect(holesHas(r, 11)).toBe(false);
      expect(holesHas(r, 50)).toBe(false);
    });
  });

  describe("holesAdd", () => {
    it("into empty ranges", () => {
      expect(holesAdd([], 3, 7)).toEqual([[3, 7]]);
    });

    it("no-op for an empty/inverted interval", () => {
      expect(holesAdd([[1, 2]], 5, 5)).toEqual([[1, 2]]);
      expect(holesAdd([[1, 2]], 6, 4)).toEqual([[1, 2]]);
    });

    it("merges adjacent (touching) ranges into one", () => {
      expect(holesAdd([[0, 3]], 3, 6)).toEqual([[0, 6]]); // touches from the right
      expect(holesAdd([[3, 6]], 0, 3)).toEqual([[0, 6]]); // touches from the left
    });

    it("merges overlapping ranges", () => {
      expect(holesAdd([[0, 5]], 3, 8)).toEqual([[0, 8]]);
      expect(holesAdd([[3, 8]], 0, 5)).toEqual([[0, 8]]);
      expect(holesAdd([[0, 10]], 3, 6)).toEqual([[0, 10]]); // fully contained: no-op shape
    });

    it("bridges multiple existing ranges into one merged range", () => {
      expect(holesAdd([[0, 2], [5, 8], [10, 12]], 1, 11)).toEqual([[0, 12]]);
    });

    it("leaves disjoint (non-adjacent, non-overlapping) ranges untouched", () => {
      expect(holesAdd([[0, 2], [10, 12]], 4, 6)).toEqual([[0, 2], [4, 6], [10, 12]]);
    });

    it("does not mutate the input array", () => {
      const input: Array<[number, number]> = [[0, 2]];
      const out = holesAdd(input, 5, 7);
      expect(input).toEqual([[0, 2]]);
      expect(out).toEqual([[0, 2], [5, 7]]);
    });

    it("is idempotent", () => {
      const once = holesAdd([[0, 2], [5, 8]], 2, 5);
      const twice = holesAdd(once, 2, 5);
      expect(twice).toEqual(once);
      expect(once).toEqual([[0, 8]]);
    });
  });

  describe("holesRemove", () => {
    it("from empty ranges is a no-op", () => {
      expect(holesRemove([], 2, 5)).toEqual([]);
    });

    it("no-op for an empty/inverted interval", () => {
      expect(holesRemove([[1, 5]], 3, 3)).toEqual([[1, 5]]);
      expect(holesRemove([[1, 5]], 4, 2)).toEqual([[1, 5]]);
    });

    it("removes a range entirely", () => {
      expect(holesRemove([[3, 6]], 3, 6)).toEqual([]);
      expect(holesRemove([[3, 6]], 0, 10)).toEqual([]);
    });

    it("splits a range in the middle", () => {
      expect(holesRemove([[0, 10]], 3, 6)).toEqual([[0, 3], [6, 10]]);
    });

    it("trims from the left / right without splitting", () => {
      expect(holesRemove([[0, 10]], 0, 4)).toEqual([[4, 10]]);
      expect(holesRemove([[0, 10]], 7, 10)).toEqual([[0, 7]]);
    });

    it("removes a span covering (and trimming) multiple ranges", () => {
      expect(holesRemove([[0, 2], [3, 6], [8, 12]], 1, 10)).toEqual([[0, 1], [10, 12]]);
    });

    it("leaves ranges outside the removed span untouched", () => {
      expect(holesRemove([[0, 2], [10, 12]], 4, 6)).toEqual([[0, 2], [10, 12]]);
    });

    it("does not mutate the input array", () => {
      const input: Array<[number, number]> = [[0, 10]];
      const out = holesRemove(input, 3, 6);
      expect(input).toEqual([[0, 10]]);
      expect(out).toEqual([[0, 3], [6, 10]]);
    });

    it("is idempotent", () => {
      const once = holesRemove([[0, 10]], 3, 6);
      const twice = holesRemove(once, 3, 6);
      expect(twice).toEqual(once);
    });
  });

  describe("holesClamp", () => {
    it("empty ranges stay empty", () => {
      expect(holesClamp([], 5)).toEqual([]);
    });

    it("drops ranges entirely beyond the clamp count", () => {
      expect(holesClamp([[5, 8]], 5)).toEqual([]);
      expect(holesClamp([[5, 8]], 3)).toEqual([]);
    });

    it("keeps ranges entirely within the clamp count untouched", () => {
      expect(holesClamp([[0, 3]], 5)).toEqual([[0, 3]]);
    });

    it("trims a range straddling the clamp boundary (mid-range clamp)", () => {
      expect(holesClamp([[0, 8]], 5)).toEqual([[0, 5]]);
    });

    it("clamp count 0 drops everything", () => {
      expect(holesClamp([[0, 3], [5, 8]], 0)).toEqual([]);
    });

    it("handles a mix: kept, trimmed, and dropped ranges together", () => {
      expect(holesClamp([[0, 2], [3, 8], [10, 15]], 5)).toEqual([[0, 2], [3, 5]]);
    });

    it("does not mutate the input array", () => {
      const input: Array<[number, number]> = [[0, 8]];
      const out = holesClamp(input, 5);
      expect(input).toEqual([[0, 8]]);
      expect(out).toEqual([[0, 5]]);
    });

    it("is idempotent", () => {
      const once = holesClamp([[0, 8]], 5);
      const twice = holesClamp(once, 5);
      expect(twice).toEqual(once);
    });
  });

  it("round-trips through add→remove→clamp for a representative scenario", () => {
    // Simulates: write chunks 2..5 leaves a sparse gap 0..2, then a shrink to count 4
    // clamps chunk 4 out, then chunk 3 gets written (removed from holes).
    let holes: Array<[number, number]> = [];
    holes = holesAdd(holes, 0, 2); // sparse gap chunks 0,1
    expect(holes).toEqual([[0, 2]]);
    holes = holesClamp(holes, 4); // shrink to 4 chunks: gap untouched (fully < 4)
    expect(holes).toEqual([[0, 2]]);
    holes = holesRemove(holes, 1, 2); // chunk 1 gets written
    expect(holes).toEqual([[0, 1]]);
    expect(holesHas(holes, 0)).toBe(true);
    expect(holesHas(holes, 1)).toBe(false);
  });
});
