/** Bounded most-recently-used map; Map iteration order provides recency. */
export class Lru<K, V> {
  private map = new Map<K, V>();

  constructor(
    private readonly capacity: number,
    private readonly onEvict: (k: K, v: V) => void,
  ) {}

  get size(): number {
    return this.map.size;
  }

  get(k: K): V | undefined {
    if (!this.map.has(k)) return undefined;
    const v = this.map.get(k)!;
    this.map.delete(k);
    this.map.set(k, v);
    return v;
  }

  set(k: K, v: V): void {
    this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.capacity) {
      const [oldK, oldV] = this.map.entries().next().value as [K, V];
      this.map.delete(oldK);
      this.onEvict(oldK, oldV);
    }
  }

  delete(k: K, callEvict = false): void {
    if (!this.map.has(k)) return;
    const v = this.map.get(k)!;
    this.map.delete(k);
    if (callEvict) this.onEvict(k, v);
  }

  clear(callEvict = false): void {
    const entries = callEvict ? [...this.map] : null;
    this.map.clear();
    if (entries) {
      for (const [k, v] of entries) this.onEvict(k, v);
    }
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }
}
