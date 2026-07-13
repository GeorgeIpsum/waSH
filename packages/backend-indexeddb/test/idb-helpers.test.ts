import { describe, it, expect } from "vitest";
import { openDb, req, txDone, STORE_NAMES } from "../src/idb.js";
import { ulid } from "@wash/vfs";

describe("idb helpers", () => {
  it("openDb creates the four stores", async () => {
    const db = await openDb(`t-${ulid()}`);
    expect([...db.objectStoreNames].sort()).toEqual([...STORE_NAMES].sort());
    db.close();
  });

  it("req resolves with the request result and txDone resolves on commit", async () => {
    const db = await openDb(`t-${ulid()}`);
    const tx = db.transaction("meta", "readwrite");
    tx.objectStore("meta").put("world", "hello");
    const got = await req(tx.objectStore("meta").get("hello"));
    expect(got).toBe("world");
    await txDone(tx);
    db.close();
  });

  it("req rejects on a failing request", async () => {
    const db = await openDb(`t-${ulid()}`);
    const tx = db.transaction("meta", "readwrite");
    tx.objectStore("meta").add("a", "dup");
    await expect(req(tx.objectStore("meta").add("b", "dup"))).rejects.toBeTruthy();
    db.close();
  });

  it("reopening the same name preserves data (persistence smoke)", async () => {
    const name = `t-${ulid()}`;
    const db1 = await openDb(name);
    const tx1 = db1.transaction("meta", "readwrite");
    tx1.objectStore("meta").put(42, "answer");
    await txDone(tx1);
    db1.close();
    const db2 = await openDb(name);
    expect(await req(db2.transaction("meta").objectStore("meta").get("answer"))).toBe(42);
    db2.close();
  });
});
