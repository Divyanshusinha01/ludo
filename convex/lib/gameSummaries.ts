import { Color, getLegalMovesForActor } from "./ludo";
import type { LudoEvent } from "./game/eventValidators";
import type { GameState } from "./game/state";

export type MoveSummary = {
  won: boolean;
  matchOver?: boolean;
  rank?: number;
  captured: boolean;
  reachedHome: boolean;
  leftYard: boolean;
  fromSteps: number;
  toSteps: number;
  extraTurn?: boolean;
  captures: Array<{ color: string; index: number }>;
};

export type RollSummary = {
  value: number;
  skipped: boolean;
  legalMoves: number[];
  legalTokenMoves?: Array<{ color: Color; index: number }>;
  threeSixes?: boolean;
  rollAgain?: boolean;
  autoMoved?: boolean;
  autoMove?: MoveSummary;
  turnExpired?: true;
};

export function summarizeRoll(
  before: GameState,
  events: LudoEvent[],
  after: GameState,
): RollSummary {
  const diceEvent = events.find((e) => e.eventType === "DICE_ROLLED");
  const value =
    diceEvent?.eventType === "DICE_ROLLED" ? diceEvent.payload.value : 0;
  const actor =
    diceEvent?.eventType === "DICE_ROLLED" ? diceEvent.payload.color : before.currentTurn;
  const legalTokenMoves = getLegalMovesForActor(
    before.tokens,
    actor,
    before.seats,
    before.mode,
    value,
  );
  const legalMoves = legalTokenMoves.map((m) => m.index);
  const threeSixes = events.some(
    (e) =>
      e.eventType === "TURN_ENDED" && e.payload.reason === "three_sixes",
  );
  const skipped = events.some(
    (e) =>
      e.eventType === "TURN_ENDED" &&
      (e.payload.reason === "no_moves" || e.payload.reason === "three_sixes"),
  );
  const rollAgain =
    events.length === 1 &&
    diceEvent?.eventType === "DICE_ROLLED" &&
    !after.diceRolled &&
    value === 6;
  const moveEvents = events.filter((e) => e.eventType === "TOKEN_MOVED");
  const autoMoved = moveEvents.length > 0;
  let autoMove: MoveSummary | undefined;
  if (autoMoved) {
    autoMove = summarizeMove(before, events, after);
  }
  return {
    value,
    skipped,
    legalMoves,
    legalTokenMoves,
    threeSixes: threeSixes || undefined,
    rollAgain: rollAgain || undefined,
    autoMoved: autoMoved || undefined,
    autoMove,
  };
}

export function summarizeMove(
  before: GameState,
  events: LudoEvent[],
  after: GameState,
): MoveSummary {
  const moved = events.find((e) => e.eventType === "TOKEN_MOVED");
  const captures = events
    .filter((e) => e.eventType === "TOKEN_CAPTURED")
    .map((e) =>
      e.eventType === "TOKEN_CAPTURED"
        ? { color: e.payload.victimColor, index: e.payload.victimIndex }
        : { color: "red", index: 0 },
    );
  const tokenColor =
    moved?.eventType === "TOKEN_MOVED" ? moved.payload.tokenColor : before.currentTurn;
  const tokenIndex =
    moved?.eventType === "TOKEN_MOVED" ? moved.payload.tokenIndex : 0;
  const beforeTok = before.tokens.find(
    (t) => t.color === tokenColor && t.index === tokenIndex,
  );
  const afterTok = after.tokens.find(
    (t) => t.color === tokenColor && t.index === tokenIndex,
  );
  const finished = events.find((e) => e.eventType === "PLAYER_FINISHED");
  const rank =
    finished?.eventType === "PLAYER_FINISHED"
      ? finished.payload.rank
      : undefined;
  const matchOver = after.phase === "finished";
  const extraTurn = events.some((e) => e.eventType === "EXTRA_TURN_GRANTED");
  return {
    won: rank != null,
    matchOver: matchOver || undefined,
    rank,
    captured: captures.length > 0,
    reachedHome: afterTok?.steps === 56,
    leftYard: beforeTok?.steps === -1,
    fromSteps: beforeTok?.steps ?? -1,
    toSteps: afterTok?.steps ?? -1,
    extraTurn: extraTurn || undefined,
    captures,
  };
}
