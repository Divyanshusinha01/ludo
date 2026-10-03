import {
  createEmptyState,
  decide,
  reduce,
  type GameCommand,
  type GameState,
  type LudoEvent,
} from "../../../convex/lib/game";
import { playableColors } from "../../../convex/lib/game/finish";
import {
  getLegalMovesForActor,
  legalMovesForDelegatedRoll,
  moveControllerColor,
  rollControllerColor,
  type Color,
  type GameMode,
} from "../../../convex/lib/ludo";
import { mulberry32, type DiceSource } from "../fixtures/dice";
import { GAME_ID, makeEvent, seqify, startBodies, T0 } from "../fixtures/events";

export type SimOptions = {
  colors: Color[];
  mode?: GameMode;
  dice: DiceSource;
  /** Seed for move choice / timeout / forfeit decisions. */
  choiceSeed?: number;
  maxEvents?: number;
  /** Probability per decision of letting the turn clock expire instead. */
  timeoutRate?: number;
  /** Probability per decision of a random playable seat forfeiting. */
  forfeitRate?: number;
};

export type SimResult = {
  events: LudoEvent[];
  /** states[i] = state after events[i - 1]; states[0] = empty state. */
  states: GameState[];
  /** Indexes into `states` where a committed transaction ended. */
  boundaries: Set<number>;
  final: GameState;
};

export class SimulationError extends Error {}

export function legalChoices(state: GameState) {
  const dice = state.diceValue;
  if (!state.diceRolled || dice === null) return [];
  if (state.passedRollTo !== null) {
    return legalMovesForDelegatedRoll(state.tokens, state.passedRollTo, dice);
  }
  const mover = moveControllerColor(
    state.currentTurn,
    state.seats,
    state.mode,
    null,
  );
  return getLegalMovesForActor(state.tokens, mover, state.seats, state.mode, dice);
}

export function nextCommand(
  state: GameState,
  dice: DiceSource,
  rng: () => number,
  opts: Pick<SimOptions, "timeoutRate" | "forfeitRate"> = {},
): GameCommand {
  if (opts.timeoutRate && rng() < opts.timeoutRate) {
    return { type: "ExpireTurn" };
  }
  if (opts.forfeitRate && rng() < opts.forfeitRate) {
    const playable = playableColors(state);
    if (playable.length >= 2) {
      const color = playable[Math.floor(rng() * playable.length)]!;
      return { type: "ForfeitSeat", color, reason: "left" };
    }
  }
  if (state.diceRolled) {
    const legal = legalChoices(state);
    const pick = legal[Math.floor(rng() * legal.length)];
    if (!pick) throw new SimulationError("dice rolled but no legal move");
    return {
      type: "MoveToken",
      actorColor: moveControllerColor(
        state.currentTurn,
        state.seats,
        state.mode,
        state.passedRollTo,
      ),
      tokenColor: pick.color,
      tokenIndex: pick.index,
    };
  }
  return {
    type: "RollDice",
    color: rollControllerColor(
      state.currentTurn,
      state.seats,
      state.mode,
      state.passedRollTo,
    ),
    value: dice(),
  };
}

/** Commit one command's drafts onto an event list (pure, like commitEvents). */
export function applyCommand(
  state: GameState,
  events: LudoEvent[],
  command: GameCommand,
): { state: GameState; added: LudoEvent[]; states: GameState[] } {
  const createdAt = T0 + events.length + 1;
  const decision = decide(state, command, { gameId: GAME_ID, createdAt });
  if (!decision.ok) {
    throw new SimulationError(
      `decide ${command.type} failed: ${decision.error.code} ${decision.error.message}`,
    );
  }
  const added: LudoEvent[] = [];
  const states: GameState[] = [];
  let current = state;
  for (const draft of decision.events) {
    const event = makeEvent(draft, events.length + added.length + 1, {
      createdAt,
    });
    const result = reduce(current, event);
    if (!result.ok) {
      throw new SimulationError(
        `reduce ${event.eventType}@${event.seq} failed: ${result.error.code}`,
      );
    }
    current = result.state;
    added.push(event);
    states.push(current);
  }
  return { state: current, added, states };
}

export function simulateGame(opts: SimOptions): SimResult {
  const mode = opts.mode ?? "1v1";
  const rng = mulberry32(opts.choiceSeed ?? 1);
  const maxEvents = opts.maxEvents ?? 20_000;
  const events = seqify(startBodies(opts.colors, mode));
  const states: GameState[] = [createEmptyState()];
  const boundaries = new Set<number>([0]);
  for (const e of events) {
    const r = reduce(states[states.length - 1]!, e);
    if (!r.ok) throw new SimulationError(`start failed: ${r.error.code}`);
    states.push(r.state);
  }
  boundaries.add(states.length - 1);

  let state = states[states.length - 1]!;
  while (state.phase === "playing" && events.length < maxEvents) {
    const command = nextCommand(state, opts.dice, rng, opts);
    const step = applyCommand(state, events, command);
    events.push(...step.added);
    states.push(...step.states);
    boundaries.add(states.length - 1);
    state = step.state;
  }
  return { events, states, boundaries, final: state };
}
