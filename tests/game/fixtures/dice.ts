/** Deterministic 32-bit PRNG (mulberry32). Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type DiceSource = () => number;

export function seededDice(seed: number): DiceSource {
  const rng = mulberry32(seed);
  return () => 1 + Math.floor(rng() * 6);
}

/** Replays `values` in order; throws when exhausted so scripts stay explicit. */
export function scriptedDice(values: number[]): DiceSource {
  const queue = [...values];
  return () => {
    const next = queue.shift();
    if (next === undefined) throw new Error("scripted dice exhausted");
    return next;
  };
}

/**
 * A Math.random() value that makes `rollFairDice` return `value` whether or
 * not the yard anti-stall weighting applies.
 */
export function randomForFace(value: number): number {
  if (value === 6) return 0.9;
  return ((value - 1) / 6 + value / 7) / 2;
}
