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

  it("peek reads without refreshing recency", () => {
    const evicted: string[] = [];
    const lru = new Lru<string, number>(2, (k) => evicted.push(k));
    lru.set("a", 1);
    lru.set("b", 2);
    expect(lru.peek("a")).toBe(1); // does NOT refresh a's recency
    lru.set("c", 3); // evicts a (still least-recently-used), not b
    expect(evicted).toEqual(["a"]);
    expect(lru.peek("a")).toBeUndefined();
    expect([...lru.keys()].sort()).toEqual(["b", "c"]);
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

  it("clear(true) stays consistent when onEvict throws", () => {
    const lru = new Lru<string, number>(4, (k) => {
      if (k === "a") throw new Error("evict boom");
    });
    lru.set("a", 1);
    lru.set("b", 2);
    expect(() => lru.clear(true)).toThrow("evict boom");
    expect(lru.size).toBe(0); // map already cleared before callbacks
    lru.set("c", 3); // pool reusable
    expect(lru.get("c")).toBe(3);
  });

  it("re-entrant set during clear(true) callbacks survives the clear", () => {
    const lru: Lru<string, number> = new Lru(4, (k) => {
      if (k === "a") lru.set("reentrant", 99);
    });
    lru.set("a", 1);
    lru.clear(true);
    expect(lru.get("reentrant")).toBe(99);
    expect(lru.size).toBe(1);
  });
});
