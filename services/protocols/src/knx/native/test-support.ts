/** Deterministic PRNG (mulberry32) so fuzz/property failures are reproducible from a seed. */
export function makeRng(seed: number): { next(): number; int(maxExclusive: number): number; bytes(n: number): Buffer } {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    bytes: (n) => Buffer.from(Array.from({ length: n }, () => Math.floor(next() * 256))),
  };
}
