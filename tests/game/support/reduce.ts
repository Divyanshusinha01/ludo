import { expect } from "vitest";
import {
  decide,
  reduce,
  reduceAll,
  type GameCommand,
  type GameState,
  type LudoEvent,
  type LudoEventDraft,
} from "../../../convex/lib/game";
import { GAME_ID, makeEvent, T0 } from "../fixtures/events";

type Body = Pick<LudoEventDraft, "eventType" | "payload" | "actor">;

/** Apply bodies one by one; throws with the reducer code on rejection. */
export function apply(state: GameState, ...bodies: Body[]): GameState {
  let current = state;
  bodies.forEach((b, i) => {
    const result = reduce(current, makeEvent(b, i + 1));
    if (!result.ok) {
      throw new Error(`${b.eventType} rejected: ${result.error.code}`);
    }
    current = result.state;
  });
  return current;
}

/** Assert the body is rejected with `code` and the input is left untouched. */
export function expectReject(state: GameState, body: Body, code: string) {
  const before = structuredClone(state);
  const first = reduce(state, makeEvent(body, 1));
  const second = reduce(state, makeEvent(body, 1));
  expect(first.ok, `${body.eventType} should be rejected`).toBe(false);
  if (first.ok || second.ok) return;
  expect(first.error.code).toBe(code);
  expect(second.error.code).toBe(first.error.code);
  expect(second.error.message).toBe(first.error.message);
  expect(state).toEqual(before);
}

/** Run a command through decide + reduceAll, returning events and the new state. */
export function run(
  state: GameState,
  command: GameCommand,
): { events: LudoEvent[]; state: GameState; types: string[] } {
  const result = decide(state, command, { gameId: GAME_ID, createdAt: T0 });
  if (!result.ok) {
    throw new Error(`decide ${command.type} failed: ${result.error.code}`);
  }
  const events = result.events.map((d, i) => makeEvent(d, i + 1));
  const reduced = reduceAll(state, events);
  if (!reduced.ok) throw new Error(`reduceAll failed: ${reduced.error.code}`);
  return {
    events,
    state: reduced.state,
    types: events.map((e) => e.eventType),
  };
}
