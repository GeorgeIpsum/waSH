import { describe, it, expect, vi } from "vitest";
import { Lru } from "../../src/lru.js";

describe("Lru", () => {
  it("evicts least-recently-used past capacity, calling onEvict", () => {
    const evicted: string[] = [];
    const lru = new Lru<string, number>(2, (k) => evicted.push(k));
    lru.set("a", 1);
    lru.set("b", 2);
    expect(lru.get("a")).toBe(1); // refresh a
    lru.set("c", 3); // evicts b, not a
    expect(evicted).toEqual(["b"]);
    expect(lru.get("b")).toBeUndefined();
    expect([...lru.keys()].sort()).toEqual(["a", "c"]);
  });

  it("delete and clear control eviction callbacks explicitly", () => {
    const onEvict = vi.fn();
    const lru = new Lru<string, number>(4, onEvict);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.delete("a"); // silent
    lru.delete("b", true); // calls onEvict
    expect(onEvict).toHaveBeenCalledTimes(1);
    lru.set("c", 3);
    lru.clear(true);
    expect(onEvict).toHaveBeenCalledTimes(2);
    expect(lru.size).toBe(0);
  });
});
