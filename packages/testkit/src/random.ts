/**
 * Seeded pseudo-random numbers for reproducible test data.
 *
 * `Math.random` can't be seeded, and the fake tenant must be byte-for-byte identical on every
 * machine and Node version, so a failing test can be replayed from its seed. This is sfc32
 * (Small Fast Counting, from PractRand) seeded through cyrb128. Both use only 32-bit integer
 * arithmetic, which JavaScript defines exactly, so results never depend on the platform.
 *
 * NOT for cryptography: the output is predictable by design.
 */
export class Random {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: string) {
    [this.a, this.b, this.c, this.d] = cyrb128(seed);
    // Discard early output, which is weakly mixed for similar seeds.
    for (let i = 0; i < 15; i++) this.next();
  }

  /** A float in [0, 1). */
  next(): number {
    this.a |= 0;
    this.b |= 0;
    this.c |= 0;
    this.d |= 0;
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  /** An integer in [min, max], both inclusive. */
  int(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
      throw new RangeError(`bad integer range [${min}, ${max}]`);
    }
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError("pick from an empty list");
    return items[Math.floor(this.next() * items.length)] as T;
  }

  /** Picks by weight. Weights must be non-negative with a positive sum. */
  weighted<T>(entries: readonly (readonly [T, number])[]): T {
    const total = entries.reduce((sum, [, w]) => sum + w, 0);
    if (!(total > 0)) throw new RangeError("weights must have a positive sum");
    let r = this.next() * total;
    for (const [value, weight] of entries) {
      r -= weight;
      if (r < 0) return value;
    }
    return (entries.at(-1) as readonly [T, number])[0];
  }

  /** `count` distinct items, in random order (Fisher-Yates on a copy). */
  sample<T>(items: readonly T[], count: number): T[] {
    const copy = [...items];
    const n = Math.min(count, copy.length);
    for (let i = 0; i < n; i++) {
      const j = i + Math.floor(this.next() * (copy.length - i));
      [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
    }
    return copy.slice(0, n);
  }

  /**
   * A child generator seeded from this generator's next value and `label`. It is deterministic
   * for a given seed and call order, and drawing from the child never disturbs the parent.
   */
  fork(label: string): Random {
    return new Random(`${this.int(0, 0x7fffffff)}:${label}`);
  }
}

/** cyrb128 string hash (public domain, bryc): four 32-bit words of seed material. */
function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}
