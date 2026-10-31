import { internal } from "../_generated/api";
import type { MutationCtx } from "../_generated/server";

/**
 * Arm a self-rescheduling background job without ever stacking duplicates.
 *
 * Background work only runs while something needs it: callers arm the job on
 * the event that creates work (a queue join, a game commit) and the job re-arms
 * itself only while work remains. `jobState.nextRunAt` records when the armed
 * run is due; if it is still in the future the job is already pending and this
 * is a read-only no-op. A row in the past means the chain ended (or died), so
 * the next call restarts it.
 *
 * `schedule` receives the delay and must enqueue the run, e.g.
 * `(ms) => ctx.scheduler.runAfter(ms, internal.x.job, args)`.
 *
 * Returns true if a run was scheduled.
 */
export async function armJob(
  ctx: MutationCtx,
  key: string,
  delayMs: number,
  schedule: (delayMs: number) => Promise<unknown>,
  now: number = Date.now(),
): Promise<boolean> {
  const row = await ctx.db
    .query("jobState")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
  if (row && row.nextRunAt > now) return false;
  const nextRunAt = now + delayMs;
  if (row) await ctx.db.patch(row._id, { nextRunAt });
  else await ctx.db.insert("jobState", { key, nextRunAt });
  await schedule(delayMs);
  return true;
}

/** How often the presence sweep re-runs while any room is being played. */
export const PRESENCE_SWEEP_MS = 30_000;
export const PRESENCE_JOB_KEY = "presence";

/** Start (or keep) the presence sweep chain; read-only while one is pending. */
export async function armPresenceSweep(ctx: MutationCtx, now: number = Date.now()): Promise<void> {
  await armJob(
    ctx,
    PRESENCE_JOB_KEY,
    PRESENCE_SWEEP_MS,
    (delay) => ctx.scheduler.runAfter(delay, internal.cleanup.presenceTick, {}),
    now,
  );
}
