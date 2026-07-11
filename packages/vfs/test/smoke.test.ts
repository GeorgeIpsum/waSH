import { describe, it, expect } from "vitest";
import { VERSION } from "../src/index.js";

describe("toolchain", () => {
  it("imports the package source", () => {
    expect(VERSION).toBe("0.0.0");
  });
});
