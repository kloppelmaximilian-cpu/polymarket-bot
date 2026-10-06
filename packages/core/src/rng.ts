/**
 * Deterministic random numbers. Every simulation takes an explicit seed and
 * records it on its run, so any result in the database can be reproduced
 * bit-for-bit. Math.random is never used for anything that ends up in a result.
 */

/** cyrb128 string hash → four 32-bit seeds. */
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

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  private spareNormal: number | null = null;
  readonly seed: string;

  constructor(seed: string | number) {
    this.seed = String(seed);
    [this.a, this.b, this.c, this.d] = cyrb128(this.seed);
    // Warm up so that similar seeds diverge immediately.
    for (let i = 0; i < 15; i++) this.next();
  }

  /** sfc32: uniform in [0, 1). */
  next(): number {
    this.a >>>= 0;
    this.b >>>= 0;
    this.c >>>= 0;
    this.d >>>= 0;
    let t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    t = (t + this.d) | 0;
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  /** A child generator whose stream is independent of later draws on this one. */
  fork(label: string): Rng {
    return new Rng(`${this.seed}/${label}`);
  }

  uniform(min = 0, max = 1): number {
    return min + (max - min) * this.next();
  }

  int(minInclusive: number, maxInclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }

  bernoulli(p: number): boolean {
    return this.next() < p;
  }

  normal(mean = 0, sd = 1): number {
    if (this.spareNormal !== null) {
      const z = this.spareNormal;
      this.spareNormal = null;
      return mean + sd * z;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = this.next() * 2 - 1;
      v = this.next() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const m = Math.sqrt((-2 * Math.log(s)) / s);
    this.spareNormal = v * m;
    return mean + sd * u * m;
  }

  /** Lognormal parameterised by the underlying normal's mu and sigma. */
  lognormal(mu: number, sigma: number): number {
    return Math.exp(this.normal(mu, sigma));
  }

  /** Triangular distribution on [min, max] with the given mode. */
  triangular(min: number, mode: number, max: number): number {
    if (!(min <= mode && mode <= max)) throw new RangeError(`triangular requires min <= mode <= max (${min}, ${mode}, ${max})`);
    if (max === min) return min;
    const u = this.next();
    const fc = (mode - min) / (max - min);
    if (u < fc) return min + Math.sqrt(u * (max - min) * (mode - min));
    return max - Math.sqrt((1 - u) * (max - min) * (max - mode));
  }

  /** Gamma(shape k, scale theta) — Marsaglia & Tsang (2000). */
  gamma(shape: number, scale = 1): number {
    if (shape <= 0) throw new RangeError('gamma shape must be positive');
    if (shape < 1) {
      const u = this.next();
      return this.gamma(1 + shape, scale) * Math.pow(u, 1 / shape);
    }
    const dd = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * dd);
    for (;;) {
      let x = 0;
      let v = 0;
      do {
        x = this.normal();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = this.next();
      if (u < 1 - 0.0331 * x * x * x * x) return dd * v * scale;
      if (Math.log(u) < 0.5 * x * x + dd * (1 - v + Math.log(v))) return dd * v * scale;
    }
  }

  beta(alpha: number, beta: number): number {
    const x = this.gamma(alpha);
    const y = this.gamma(beta);
    return x / (x + y);
  }

  /** Poisson: Knuth for small lambda, normal approximation for large. */
  poisson(lambda: number): number {
    if (lambda < 0) throw new RangeError('poisson lambda must be >= 0');
    if (lambda === 0) return 0;
    if (lambda < 30) {
      const limit = Math.exp(-lambda);
      let k = 0;
      let p = 1;
      do {
        k++;
        p *= this.next();
      } while (p > limit);
      return k - 1;
    }
    return Math.max(0, Math.round(this.normal(lambda, Math.sqrt(lambda))));
  }

  /**
   * Binomial(n, p). Exact inversion when the expected count is small, normal
   * approximation with continuity correction otherwise (clamped to [0, n]).
   */
  binomial(n: number, p: number): number {
    if (!Number.isInteger(n) || n < 0) throw new RangeError('binomial n must be a non-negative integer');
    if (p <= 0 || n === 0) return 0;
    if (p >= 1) return n;
    const q = Math.min(p, 1 - p);
    let k: number;
    if (n * q < 15) {
      // Inversion on the CDF of Binomial(n, q).
      const s = q / (1 - q);
      const a = (n + 1) * s;
      let r = Math.pow(1 - q, n);
      let u = this.next();
      k = 0;
      while (u > r && k < n) {
        u -= r;
        k++;
        r *= a / k - s;
      }
    } else {
      const mean = n * q;
      const sd = Math.sqrt(n * q * (1 - q));
      k = Math.round(this.normal(mean, sd));
      k = Math.min(n, Math.max(0, k));
    }
    return p <= 0.5 ? k : n - k;
  }

  choice<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('choice from empty array');
    return items[Math.floor(this.next() * items.length)] as T;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  }
}
