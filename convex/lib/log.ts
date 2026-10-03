import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { GameError } from "./errors";
import { errorCodeFor } from "./metrics";

/**
 * Structured production logs. Never include secrets or full session ids.
 */
export function logEvent(
  event: string,
  fields: Record<string, string | number | boolean | null | undefined> = {},
) {
  const safe: Record<string, string | number | boolean | null> = { event };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (key === "clientId" && typeof value === "string") {
      safe.clientId = value.slice(0, 8);
      continue;
    }
    safe[key] = value;
  }
  console.log(JSON.stringify(safe));
}

/**
 * Log `mutation_ok` / `mutation_rejected` for a mutation handler and rethrow
 * rejections unchanged. A throwing mutation rolls back its writes, so this log
 * line is the only server-side record of a rejection.
 *
 * Stale rejections are skipped: `rejectStale` already logs them with the
 * versions involved.
 */
export async function withOutcomeLogging<R>(
  ctx: MutationCtx,
  fn: string,
  roomId: Id<"rooms"> | undefined,
  handler: () => Promise<R>,
): Promise<R> {
  const headSeq = roomId
    ? ((await ctx.db.get(roomId))?.eventSeq ?? null)
    : undefined;
  try {
    const result = await handler();
    logEvent("mutation_ok", { fn, headSeq });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message !== GameError.staleAction) {
      logEvent("mutation_rejected", {
        fn,
        code: errorCodeFor(message),
        headSeq,
      });
    }
    throw err;
  }
}
