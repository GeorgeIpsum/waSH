import { describe, it, expect } from "vitest";
import {
  parseSidecar, serializeSidecar, setSidecarEntry, renameSidecarEntry, isEmptySidecar,
} from "../../src/sidecar.js";

describe("sidecar codec", () => {
  it("round-trips and tolerates garbage", () => {
    const s = setSidecarEntry({}, "f.txt", { mode: 0o755 });
    expect(parseSidecar(serializeSidecar(s))).toEqual({ "f.txt": { mode: 0o755 } });
    expect(parseSidecar("")).toEqual({});
    expect(parseSidecar("not json{{{")).toEqual({});
    expect(parseSidecar("[1,2,3]")).toEqual({});
  });

  it("merges patches and drops empty entries", () => {
    let s = setSidecarEntry({}, "ln", { symlink: "/target" });
    s = setSidecarEntry(s, "ln", { mode: 0o700 });
    expect(s.ln).toEqual({ symlink: "/target", mode: 0o700 });
    s = setSidecarEntry(s, "ln", { symlink: undefined, mode: undefined });
    expect(s.ln).toBeUndefined();
    expect(isEmptySidecar(s)).toBe(true);
  });

  it("renames entries", () => {
    const s = renameSidecarEntry(setSidecarEntry({}, "a", { mode: 0o700 }), "a", "b");
    expect(s).toEqual({ b: { mode: 0o700 } });
    expect(renameSidecarEntry({}, "ghost", "x")).toEqual({});
  });
});
