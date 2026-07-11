import { describe, it, expect } from "vitest";
import { VfsError } from "../src/errors.js";

describe("VfsError", () => {
  it("carries errno and path", () => {
    const e = new VfsError("ENOENT", "/missing");
    expect(e.errno).toBe("ENOENT");
    expect(e.path).toBe("/missing");
    expect(e.message).toBe("ENOENT: /missing");
    expect(e).toBeInstanceOf(Error);
  });
  it("works without a path", () => {
    expect(new VfsError("EBADF").message).toBe("EBADF");
  });
});
