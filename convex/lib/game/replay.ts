import type { LudoEvent } from "./eventValidators";
import { reduce } from "./reducer";
import { createEmptyState, type GameState } from "./state";

export type ReplayError = {
  seq: number;
  eventType: string;
  reason: string;
  stateBefore: GameState;
};

export type ReplayOptions = {
  /** Expected sequence number of the first event (default 1). */
  firstSeq?: number;
};

type Step =
  | { ok: true; state: GameState }
  | { ok: false; error: ReplayError };

/** Validate one event's position in the log, then reduce it. Never throws. */
function step(
  state: GameState,
  event: LudoEvent,
  index: number,
  firstSeq: number,
  prevSeq: number,
  gameId: string | undefined,
): Step {
  const fail = (reason: string): Step => ({
    ok: false,
    error: replayErr(event?.seq ?? prevSeq + 1, String(event?.eventType), reason, state),
  });
  if (typeof event !== "object" || event === null) return fail("Event is not an object");
  if (index === 0 && event.seq !== firstSeq) return fail("First seq mismatch");
  if (event.seq !== prevSeq + 1) return fail("Seq not contiguous");
  if (gameId !== undefined && event.gameId !== gameId) {
    return fail(`gameId mismatch: expected ${gameId}, got ${String(event.gameId)}`);
  }
  if (event.eventId !== `${event.gameId}:${event.seq}`) return fail("eventId mismatch");
  const atGameStart = index === 0 && state.phase === "lobby" && state.seats.length === 0;
  if (atGameStart !== (event.eventType === "GAME_CREATED")) {
    return fail("GAME_CREATED must be exactly the first event");
  }
  let result: ReturnType<typeof reduce>;
  try {
    result = reduce(state, event);
  } catch (e) {
    return fail(`Malformed event: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!result.ok) return fail(result.error.message);
  return { ok: true, state: result.state };
}

function pendingSettleError(state: GameState, lastSeq: number): ReplayError | null {
  if (state.settle === null) return null;
  return replayErr(lastSeq, "settle", "Replay ended with pending settle", state);
}

export function replayGame(
  initialState: GameState,
  events: LudoEvent[],
  opts?: ReplayOptions,
): { state: GameState; applied: number } {
  const trace = replayWithTrace(initialState, events, opts);
  if (trace.error) throw trace.error;
  return { state: trace.states[trace.states.length - 1]!, applied: events.length };
}

function replayErr(
  seq: number,
  eventType: string,
  reason: string,
  stateBefore: GameState,
): ReplayError {
  return { seq, eventType, reason, stateBefore };
}

/**
 * Replay keeping every intermediate state. On failure `states` stops at the
 * last good event and `error` says why; a log that ends mid-move is an error.
 */
export function replayWithTrace(
  initialState: GameState,
  events: LudoEvent[],
  opts?: ReplayOptions,
): { states: GameState[]; error?: ReplayError } {
  const states: GameState[] = [initialState];
  const firstSeq = opts?.firstSeq ?? 1;
  const gameId = events[0]?.gameId;
  let state = initialState;
  let prevSeq = firstSeq - 1;

  for (let i = 0; i < events.length; i++) {
    const result = step(state, events[i]!, i, firstSeq, prevSeq, gameId);
    if (!result.ok) return { states, error: result.error };
    state = result.state;
    states.push(state);
    prevSeq = events[i]!.seq;
  }

  const pending = pendingSettleError(state, prevSeq);
  if (pending) return { states, error: pending };
  return { states };
}

export function isReplayError(value: unknown): value is ReplayError {
  return (
    typeof value === "object" &&
    value !== null &&
    "seq" in value &&
    "eventType" in value &&
    "reason" in value
  );
}

export { createEmptyState };
export type EmptyState = GameState;
