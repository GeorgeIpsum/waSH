export const STORE_NAMES = ["dirents", "inodes", "data", "meta"] as const;
export type StoreName = (typeof STORE_NAMES)[number];
export const SCHEMA_VERSION = 1;

export function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB request failed"));
  });
}

/**
 * Like `req`, but for a request whose ConstraintError the caller intends to
 * catch and recover from within the same transaction (e.g. an atomic dirent
 * `add` racing a duplicate name). Per the IDB spec, an unhandled request
 * error's default action aborts the whole transaction; calling
 * `preventDefault()` suppresses that so the transaction stays alive for the
 * caller's own cleanup writes. Only ConstraintError is tolerated this way —
 * any other error still lets the transaction abort, since those are not
 * expected/recoverable here.
 */
export function reqTolerateConstraint<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = (event) => {
      if (r.error?.name === "ConstraintError") event.preventDefault();
      reject(r.error ?? new Error("IndexedDB request failed"));
    };
  });
}

export function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export function openDb(name: string, factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, SCHEMA_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of STORE_NAMES) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
}
