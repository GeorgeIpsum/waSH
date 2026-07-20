import { describe, it, expect } from "vitest";
import { assertWebLocksAvailable } from "../../src/manifest.js";

// assertWebLocksAvailable lives in manifest.ts (not worker.ts) specifically so it stays
// importable from a plain Node vitest test: worker.ts sets `self.onmessage = ...` at module
// scope, which throws under Node's `environment: "node"` runtime since `self` is undefined
// there (worker.ts is only ever loaded inside a real Worker in the browser test suite).
describe("assertWebLocksAvailable", () => {
  it("throws ENOSYS when navigator.locks is missing", () => {
    expect(() => assertWebLocksAvailable({})).toThrowError(expect.objectContaining({ errno: "ENOSYS" }));
    expect(() => assertWebLocksAvailable({ locks: undefined })).toThrowError(expect.objectContaining({ errno: "ENOSYS" }));
  });

  it("passes when navigator.locks is present", () => {
    expect(() => assertWebLocksAvailable({ locks: {} })).not.toThrow();
  });
});
