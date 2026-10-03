import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * Fixed-window counters in `authAttempts`. Reads happen before password
 * hashing as a cheap reject; the authoritative check and increment run inside
 * the mutation that would create a session, so concurrent attempts conflict on
 * the same row and Convex OCC counts each one exactly once.
 */
export type LimitPolicy = {
  limit: number;
  windowMs: number;
  /** When set, reaching `limit` locks the key for this long. */
  lockMs?: number;
};

const MINUTE = 60_000;

export const LIMITS = {
  /** Primary login limit: one IP guessing one username. Reset on success. */
  ipUser: { limit: 5, windowMs: 15 * MINUTE, lockMs: 15 * MINUTE },
  /** One IP spraying across usernames. */
  ip: { limit: 30, windowMs: 15 * MINUTE, lockMs: 15 * MINUTE },
  /** Distributed guessing against one username from many IPs. */
  user: { limit: 20, windowMs: 15 * MINUTE, lockMs: 15 * MINUTE },
  signupIp: { limit: 5, windowMs: 60 * MINUTE },
  sessionCreate: { limit: 5, windowMs: 10 * MINUTE },
} satisfies Record<string, LimitPolicy>;

/** Rows idle longer than this are purged by cleanup. */
export const ATTEMPT_ROW_TTL_MS = 2 * 60 * MINUTE;

export const limitKeys = {
  ipUser: (ipHash: string, username: string) => `ipuser:${ipHash}:${username}`,
  ip: (ipHash: string) => `ip:${ipHash}`,
  user: (username: string) => `user:${username}`,
  signupIp: (ipHash: string) => `signup-ip:${ipHash}`,
  session: (accountId: string) => `session:${accountId}`,
};

export async function getAttempt(
  ctx: QueryCtx | MutationCtx,
  key: string,
): Promise<Doc<"authAttempts"> | null> {
  return await ctx.db
    .query("authAttempts")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
}

/** Milliseconds until the key may be used again, or null if it is open. */
export function blockedFor(
  row: Doc<"authAttempts"> | null,
  policy: LimitPolicy,
  now: number,
): number | null {
  if (!row) return null;
  if (row.lockedUntil !== undefined && row.lockedUntil > now) {
    return row.lockedUntil - now;
  }
  const windowEnd = row.windowStart + policy.windowMs;
  if (windowEnd > now && row.count >= policy.limit) return windowEnd - now;
  return null;
}

export async function checkLimit(
  ctx: QueryCtx | MutationCtx,
  key: string,
  policy: LimitPolicy,
  now: number,
): Promise<number | null> {
  return blockedFor(await getAttempt(ctx, key), policy, now);
}

/** Longest wait among several keys, or null when every key is open. */
export async function checkLimits(
  ctx: QueryCtx | MutationCtx,
  checks: Array<[string, LimitPolicy]>,
  now: number,
): Promise<number | null> {
  let worst: number | null = null;
  for (const [key, policy] of checks) {
    const wait = await checkLimit(ctx, key, policy, now);
    if (wait !== null && (worst === null || wait > worst)) worst = wait;
  }
  return worst;
}

export async function recordAttempt(
  ctx: MutationCtx,
  key: string,
  policy: LimitPolicy,
  now: number,
): Promise<void> {
  const row = await getAttempt(ctx, key);
  if (!row || row.windowStart + policy.windowMs <= now) {
    const lockedUntil =
      policy.lockMs !== undefined && policy.limit <= 1 ? now + policy.lockMs : undefined;
    if (row) {
      await ctx.db.patch(row._id, { windowStart: now, count: 1, lockedUntil });
    } else {
      await ctx.db.insert("authAttempts", {
        key,
        windowStart: now,
        count: 1,
        ...(lockedUntil !== undefined ? { lockedUntil } : {}),
      });
    }
    return;
  }
  const count = row.count + 1;
  const lock = policy.lockMs !== undefined && count >= policy.limit;
  await ctx.db.patch(row._id, {
    count,
    ...(lock ? { lockedUntil: now + policy.lockMs! } : {}),
  });
}

export async function resetAttempts(ctx: MutationCtx, key: string): Promise<void> {
  const row = await getAttempt(ctx, key);
  if (row) await ctx.db.delete(row._id);
}
