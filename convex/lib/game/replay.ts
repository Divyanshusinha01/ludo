import type { LudoEvent } from "./eventValidators";
import { ReduceError } from "./errors";
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

export function replayGame(
  initialState: GameState,
  events: LudoEvent[],
  opts?: ReplayOptions,
): { state: GameState; applied: number } {
  const firstSeq = opts?.firstSeq ?? 1;
  let state = initialState;
  let prevSeq = firstSeq - 1;

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (i === 0 && event.seq !== firstSeq) {
      throw replayErr(event.seq, event.eventType, "First seq mismatch", state);
    }
    if (event.seq !== prevSeq + 1) {
      throw replayErr(event.seq, event.eventType, "Seq not contiguous", state);
    }
    if (event.eventId !== `${event.gameId}:${event.seq}`) {
      throw replayErr(event.seq, event.eventType, "eventId mismatch", state);
    }
    const result = reduce(state, event);
    if (!result.ok) {
      throw replayErr(event.seq, event.eventType, result.error.message, state);
    }
    state = result.state;
    prevSeq = event.seq;
  }

  if (state.settle !== null) {
    throw replayErr(
      prevSeq,
      "settle",
      "Replay ended with pending settle",
      state,
    );
  }

  return { state, applied: events.length };
}

function replayErr(
  seq: number,
  eventType: string,
  reason: string,
  stateBefore: GameState,
): ReplayError {
  return { seq, eventType, reason, stateBefore };
}

export function replayWithTrace(
  initialState: GameState,
  events: LudoEvent[],
  opts?: ReplayOptions,
): { states: GameState[]; error?: ReplayError } {
  const states: GameState[] = [initialState];
  const firstSeq = opts?.firstSeq ?? 1;
  let state = initialState;
  let prevSeq = firstSeq - 1;

  for (const event of events) {
    if (states.length === 1 && event.seq !== firstSeq) {
      return {
        states,
        error: replayErr(event.seq, event.eventType, "First seq mismatch", state),
      };
    }
    if (event.seq !== prevSeq + 1) {
      return {
        states,
        error: replayErr(event.seq, event.eventType, "Seq not contiguous", state),
      };
    }
    if (event.eventId !== `${event.gameId}:${event.seq}`) {
      return {
        states,
        error: replayErr(event.seq, event.eventType, "eventId mismatch", state),
      };
    }
    const result = reduce(state, event);
    if (!result.ok) {
      return {
        states,
        error: replayErr(event.seq, event.eventType, result.error.message, state),
      };
    }
    state = result.state;
    states.push(state);
    prevSeq = event.seq;
  }

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
