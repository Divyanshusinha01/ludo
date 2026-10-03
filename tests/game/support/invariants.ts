import type { GameState, LudoEvent } from "../../../convex/lib/game";
import {
  COLORS,
  FINISHED_STEPS,
  teamOfColor,
  teamTeammateColor,
  turnActorColor,
} from "../../../convex/lib/ludo";

export class InvariantError extends Error {}

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new InvariantError(msg);
}

export type InvariantContext = {
  /** State before `event` was applied. */
  prev?: GameState;
  event?: LudoEvent;
  /** True when `state` is the end of a committed transaction. */
  boundary?: boolean;
};

/**
 * Structural rules every reachable state must satisfy. Turn-ownership rules
 * only hold at transaction boundaries (mid-transaction the seat holder may
 * have just been eliminated, before TURN_STARTED moves the turn on).
 */
export function assertInvariants(state: GameState, ctx: InvariantContext = {}) {
  const { prev, event } = ctx;
  const where = event ? ` (after ${event.eventType}@${event.seq})` : "";
  const seatColors = state.seats.map((s) => s.color);

  check(new Set(seatColors).size === seatColors.length, `duplicate seat${where}`);

  if (state.phase !== "lobby") {
    const keys = new Set<string>();
    for (const t of state.tokens) {
      check(
        Number.isInteger(t.steps) && t.steps >= -1 && t.steps <= FINISHED_STEPS,
        `token ${t.color}:${t.index} steps ${t.steps} out of range${where}`,
      );
      check(t.index >= 0 && t.index <= 3, `token index ${t.index}${where}`);
      check(seatColors.includes(t.color), `token for unseated ${t.color}${where}`);
      const key = `${t.color}:${t.index}`;
      check(!keys.has(key), `duplicate token ${key}${where}`);
      keys.add(key);
    }
  }

  check(
    state.diceValue === null ||
      (Number.isInteger(state.diceValue) &&
        state.diceValue >= 1 &&
        state.diceValue <= 6),
    `dice ${state.diceValue}${where}`,
  );
  check(
    state.consecutiveSixes >= 0 && state.consecutiveSixes <= 2,
    `consecutiveSixes ${state.consecutiveSixes}${where}`,
  );

  check(
    new Set(state.rankings).size === state.rankings.length,
    `duplicate ranking${where}`,
  );
  for (const c of state.rankings) {
    check(seatColors.includes(c), `ranking for unseated ${c}${where}`);
  }
  const ranks = state.seats
    .filter((s) => !s.eliminated && s.finishRank != null)
    .map((s) => s.finishRank);
  check(new Set(ranks).size === ranks.length, `duplicate finishRank${where}`);

  if (state.mode === "2v2") {
    for (const s of state.seats) {
      check(
        s.team === undefined || s.team === teamOfColor(s.color),
        `seat ${s.color} on wrong team ${s.team}${where}`,
      );
    }
    if (state.winningTeam && state.winner) {
      check(
        teamOfColor(state.winner) === state.winningTeam,
        `winner ${state.winner} not on ${state.winningTeam}${where}`,
      );
    }
  }

  if (state.phase === "finished") {
    check(state.settle === null, `settle pending after finish${where}`);
    check(!state.diceRolled, `dice pending after finish${where}`);
    check(
      [...state.rankings].sort().join() === [...seatColors].sort().join(),
      `final rankings ${state.rankings} do not cover seats ${seatColors}${where}`,
    );
    check(state.winner === state.rankings[0], `winner is not rank #1${where}`);
  }

  if (state.passedRollTo !== null) {
    check(state.mode === "2v2", `roll passed outside 2v2${where}`);
    check(
      state.passedRollTo === teamTeammateColor(state.currentTurn),
      `roll passed to non-teammate${where}`,
    );
  }

  if (prev && event) {
    const restarted = event.eventType === "GAME_STARTED";
    if (prev.phase === "finished") {
      check(
        state.phase === "finished" || restarted,
        `left finished via ${event.eventType}`,
      );
    }
    if (!restarted && prev.phase !== "lobby") {
      check(
        state.turnNumber >= prev.turnNumber,
        `turnNumber went backwards${where}`,
      );
    }

    const rollback =
      event.eventType === "DICE_ROLLED" &&
      prev.consecutiveSixes === 2 &&
      event.payload.value === 6;
    if (!restarted && !rollback) {
      for (const t of prev.tokens) {
        if (t.steps !== FINISHED_STEPS) continue;
        const now = state.tokens.find(
          (x) => x.color === t.color && x.index === t.index,
        );
        check(
          !now || now.steps === FINISHED_STEPS,
          `finished token ${t.color}:${t.index} moved${where}`,
        );
      }
    }

    const actor = event.actor;
    if (actor.kind === "seat" && event.eventType !== "PLAYER_JOINED") {
      const seat = prev.seats.find((s) => s.color === actor.color);
      check(seat, `actor ${actor.color} not seated${where}`);
      check(!seat.eliminated, `eliminated ${seat.color} acted${where}`);
      if (prev.phase === "playing") {
        check(seat.finishRank == null, `finished ${seat.color} acted${where}`);
      }
    }
  }

  if (ctx.boundary && state.phase === "playing") {
    check(state.settle === null, `settle pending at boundary${where}`);
    const seat = state.seats.find((s) => s.color === state.currentTurn);
    check(seat, `turn held by unseated ${state.currentTurn}${where}`);
    check(!seat.eliminated, `turn held by eliminated ${seat.color}${where}`);
    const actor = turnActorColor(state.currentTurn, state.seats, state.mode);
    const actorSeat = state.seats.find((s) => s.color === actor);
    check(
      actorSeat && !actorSeat.eliminated && actorSeat.finishRank == null,
      `turn actor ${actor} cannot play${where}`,
    );
    check(COLORS.includes(state.currentTurn), `bad currentTurn${where}`);
  }
}

/** Run invariants over every state produced by a simulated/replayed history. */
export function assertHistoryInvariants(
  events: LudoEvent[],
  states: GameState[],
  boundaries?: Set<number>,
) {
  for (let i = 1; i < states.length; i++) {
    assertInvariants(states[i]!, {
      prev: states[i - 1],
      event: events[i - 1],
      boundary: boundaries?.has(i) ?? false,
    });
  }
}
