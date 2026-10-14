import {
  Color,
  COLORS,
  decideRollOutcome,
  findCaptureTargets,
  FINISHED_STEPS,
  gainsExtraTurn,
  getLegalMovesForActor,
  hasWon,
  legalMovesForDelegatedRoll,
  MAX_TIMEOUT_LIVES,
  moveControllerColor,
  nextColorAmong,
  nextTurnSeatColor,
  rollControllerColor,
  snapshotTokens,
  startsSixStreak,
  teamAllTokensHome,
  teamOfColor,
  tryMoveSteps,
  turnActorColor,
  teamTeammateColor,
} from "../ludo";
import type { EventActor, LudoEvent } from "./eventValidators";
import { reject, type ReduceResult } from "./errors";
import {
  applyGameFinishedReason,
  assignFinishRankInState,
  playableColors,
} from "./finish";
import { malformedEventReason } from "./shape";
import {
  createEmptyState,
  lobbySeatFromSnapshot,
  patchTokenSteps,
  replaceTokens,
  seatByColor,
  seatedColors,
  teamPlayers,
  tokensForColors,
  updateSeat,
  type GameState,
} from "./state";

export { createEmptyState };

function assertPlaying(state: GameState): ReduceResult | null {
  if (state.phase === "finished") {
    return reject("game_finished", "Match already finished");
  }
  if (state.phase !== "playing") {
    return reject("wrong_phase", "Match has not started");
  }
  return null;
}

/** A seat actor must be the colour the event acts for; system actors may act for anyone. */
function assertActor(actor: EventActor, color: Color): ReduceResult | null {
  if (actor.kind === "seat" && actor.color !== color) {
    return reject("wrong_actor", "Actor does not control this action");
  }
  return null;
}

/** Legal moves for the die currently on the table. */
function legalMovesForPendingRoll(state: GameState) {
  const dice = state.diceValue;
  if (dice === null) return [];
  if (state.passedRollTo !== null) {
    return legalMovesForDelegatedRoll(state.tokens, state.passedRollTo, dice);
  }
  const mover = moveControllerColor(state.currentTurn, teamPlayers(state), state.mode, null);
  return getLegalMovesForActor(state.tokens, mover, teamPlayers(state), state.mode, dice);
}

function extraTurnReason(
  settle: Extract<GameState["settle"], { kind: "after_token_move" }>,
): "six" | "capture" | "home" | null {
  const didCapture = settle.captures > 0;
  const reachedHome = settle.toSteps === FINISHED_STEPS;
  if (!gainsExtraTurn(settle.dice, didCapture, reachedHome)) return null;
  return reachedHome ? "home" : didCapture ? "capture" : "six";
}

function validateTurnEnd(
  state: GameState,
  reason: Extract<LudoEvent, { eventType: "TURN_ENDED" }>["payload"]["reason"],
): ReduceResult | null {
  if (reason === "moved") {
    if (state.settle?.kind !== "after_token_move") {
      return reject("invalid_turn_end", "No move to end the turn on");
    }
    const unresolved = assertCapturesResolved(state);
    if (unresolved) return unresolved;
    if (extraTurnReason(state.settle) !== null) {
      return reject("invalid_turn_end", "Move earned an extra turn");
    }
    return null;
  }
  if (state.settle !== null) {
    return reject("invalid_turn_end", "Move still unresolved");
  }
  if (reason === "no_moves") {
    if (!state.diceRolled || state.diceValue === null) {
      return reject("invalid_turn_end", "No roll to end the turn on");
    }
    if (legalMovesForPendingRoll(state).length > 0) {
      return reject("invalid_turn_end", "A legal move is available");
    }
  }
  if (reason === "three_sixes" && (state.diceRolled || state.diceValue !== 6)) {
    return reject("invalid_turn_end", "No third six to end the turn on");
  }
  return null;
}

/** A move may not be settled while an opponent still sits on its landing cell. */
function assertCapturesResolved(state: GameState): ReduceResult | null {
  if (state.settle?.kind !== "after_token_move") return null;
  const pending = findCaptureTargets(
    state.tokens,
    state.settle.tokenColor,
    state.settle.toSteps,
    state.mode,
  );
  if (pending.length > 0) {
    return reject("capture_missing", "Move left a capturable token on its cell");
  }
  return null;
}

function advanceTurnColor(state: GameState, fromSeat: Color): Color {
  if (state.mode === "2v2") {
    return nextTurnSeatColor(fromSeat, teamPlayers(state), state.mode);
  }
  return nextColorAmong(fromSeat, playableColors(state));
}

export function reduce(state: GameState, event: LudoEvent): ReduceResult {
  const malformed = malformedEventReason(event);
  if (malformed) return reject("malformed_event", malformed);
  switch (event.eventType) {
    case "GAME_CREATED": {
      if (state.phase !== "lobby" || state.seats.length > 0) {
        return reject("wrong_phase", "Game already created");
      }
      const p = event.payload;
      return {
        ok: true,
        state: {
          ...createEmptyState(),
          phase: "lobby",
          mode: p.mode === "2v2" ? "2v2" : "1v1",
          vsComputer: p.vsComputer,
          rulesVersion: p.rulesVersion,
          seats: [],
        },
      };
    }
    case "PLAYER_JOINED": {
      if (state.phase !== "lobby") {
        return reject("wrong_phase", "Cannot join after match start");
      }
      const seat = lobbySeatFromSnapshot(event.payload.seat);
      if (state.seats.some((s) => s.color === seat.color)) {
        return reject("seat_taken", "Seat already taken");
      }
      return { ok: true, state: { ...state, seats: [...state.seats, seat] } };
    }
    case "PLAYER_LEFT": {
      if (state.phase !== "lobby") {
        return reject("wrong_phase", "In-game leave uses elimination");
      }
      return {
        ok: true,
        state: {
          ...state,
          seats: state.seats.filter((s) => s.color !== event.payload.color),
        },
      };
    }
    case "GAME_STARTED": {
      if (state.phase === "playing") {
        return reject("wrong_phase", "Match already in play");
      }
      const p = event.payload;
      const seats = p.seats.map((s) => ({
        color: s.color,
        name: s.name,
        isBot: s.isBot,
        team: s.team,
        lives: s.lives,
        eliminated: s.eliminated,
        finishRank: s.finishRank ?? null,
      }));
      const colors = seats.map((s) => s.color);
      const firstTurn = COLORS.find((c) => colors.includes(c)) ?? "red";
      return {
        ok: true,
        state: {
          ...state,
          phase: "playing",
          mode: p.mode,
          rulesVersion: p.rulesVersion,
          seats,
          tokens: tokensForColors(colors),
          currentTurn: firstTurn,
          diceValue: null,
          diceRolled: false,
          consecutiveSixes: 0,
          sixStreakSnapshot: null,
          passedRollTo: null,
          turnNumber: 0,
          rankings: [],
          winner: null,
          winningTeam: null,
          settle: null,
          finishedAt: null,
        },
      };
    }
    case "TURN_STARTED": {
      const playingCheck = assertPlaying(state);
      if (playingCheck && !playingCheck.ok) return playingCheck;
      if (state.settle?.kind === "after_token_move") {
        return reject("settle_pending", "Turn start while move unresolved");
      }
      const seat = event.payload.seat;
      if (state.turnNumber > 0) {
        if (state.settle?.kind !== "turn_ended") {
          return reject("turn_not_ended", "Previous turn has not ended");
        }
        const expected = advanceTurnColor(state, state.currentTurn);
        if (seat !== expected) {
          return reject("wrong_turn", "Turn seat mismatch");
        }
      } else {
        const first = seatedColors(state)[0];
        if (first && seat !== first) {
          return reject("wrong_turn", "First turn seat mismatch");
        }
      }
      return {
        ok: true,
        state: {
          ...state,
          settle: null,
          currentTurn: seat,
          turnNumber: state.turnNumber + 1,
          diceValue: null,
          diceRolled: false,
          passedRollTo: null,
          consecutiveSixes: 0,
          sixStreakSnapshot: null,
        },
      };
    }
    case "DICE_ROLLED": {
      const playingCheck = assertPlaying(state);
      if (playingCheck && !playingCheck.ok) return playingCheck;
      if (state.diceRolled) {
        return reject("dice_rolled", "Dice already rolled");
      }
      if (state.settle !== null) {
        return reject("settle_pending", "Cannot roll during settle");
      }
      const { color, value } = event.payload;
      if (!Number.isInteger(value) || value < 1 || value > 6) {
        return reject("invalid_dice", "Invalid dice value");
      }
      const actorCheck = assertActor(event.actor, color);
      if (actorCheck) return actorCheck;
      const rollColor = rollControllerColor(
        state.currentTurn,
        teamPlayers(state),
        state.mode,
        state.passedRollTo,
      );
      if (color !== rollColor) {
        return reject("wrong_actor", "Not roll controller");
      }
      const legal = getLegalMovesForActor(
        state.tokens,
        color,
        teamPlayers(state),
        state.mode,
        value,
      );
      const decision = decideRollOutcome(
        value,
        state.consecutiveSixes,
        legal.length,
      );
      let next: GameState = { ...state, diceValue: value };
      if (decision.kind === "no_moves_six") {
        next = {
          ...next,
          diceRolled: false,
          consecutiveSixes: decision.consecutiveSixes,
          sixStreakSnapshot: startsSixStreak(value, state.consecutiveSixes)
            ? snapshotTokens(state.tokens)
            : state.sixStreakSnapshot,
        };
      } else if (decision.kind === "three_sixes") {
        next = {
          ...next,
          diceRolled: false,
          consecutiveSixes: 0,
          sixStreakSnapshot: null,
        };
        if (state.sixStreakSnapshot?.length) {
          next = replaceTokens(next, state.sixStreakSnapshot);
          next = { ...next, diceValue: value };
        }
      } else if (decision.kind === "no_moves") {
        next = { ...next, diceRolled: true, consecutiveSixes: 0 };
      } else {
        next = {
          ...next,
          diceRolled: true,
          consecutiveSixes: decision.consecutiveSixes,
          sixStreakSnapshot: startsSixStreak(value, state.consecutiveSixes)
            ? snapshotTokens(state.tokens)
            : state.sixStreakSnapshot,
        };
      }
      return { ok: true, state: next };
    }
    case "ROLL_PASSED": {
      const playingCheck = assertPlaying(state);
      if (playingCheck && !playingCheck.ok) return playingCheck;
      if (state.mode !== "2v2") {
        return reject("wrong_mode", "Rolls can only be passed in 2v2");
      }
      if (!state.diceRolled || state.diceValue === null) {
        return reject("no_roll", "No roll to pass");
      }
      const { from, to } = event.payload;
      if (from !== state.currentTurn) {
        return reject("wrong_seat", "Pass must be from seat holder");
      }
      if (to !== teamTeammateColor(from)) {
        return reject("wrong_teammate", "Invalid pass target");
      }
      return {
        ok: true,
        state: { ...state, passedRollTo: to },
      };
    }
    case "TOKEN_MOVED": {
      const playingCheck = assertPlaying(state);
      if (playingCheck && !playingCheck.ok) return playingCheck;
      if (!state.diceRolled || state.diceValue === null) {
        return reject("roll_first", "Roll first");
      }
      const dice = state.diceValue;
      const seat = state.currentTurn;
      const passed = state.passedRollTo;
      const wasDelegated = passed !== null;
      const moveColor = moveControllerColor(
        seat,
        teamPlayers(state),
        state.mode,
        passed,
      );
      const actorCheck = assertActor(event.actor, moveColor);
      if (actorCheck) return actorCheck;
      const { tokenColor, tokenIndex } = event.payload;
      const legal = wasDelegated
        ? legalMovesForDelegatedRoll(state.tokens, passed, dice)
        : getLegalMovesForActor(
            state.tokens,
            moveColor,
            teamPlayers(state),
            state.mode,
            dice,
          );
      if (
        !legal.some((m) => m.color === tokenColor && m.index === tokenIndex)
      ) {
        return reject("illegal_move", "Illegal move");
      }
      const token = state.tokens.find(
        (t) => t.color === tokenColor && t.index === tokenIndex,
      );
      if (!token) return reject("no_token", "Token missing");
      const dest = tryMoveSteps(token.steps, dice);
      if (dest === null) return reject("illegal_move", "Cannot move");
      let next = patchTokenSteps(state, tokenColor, tokenIndex, dest);
      next = {
        ...next,
        diceRolled: false,
        settle: {
          kind: "after_token_move",
          seat,
          actorColor: moveColor,
          tokenColor,
          tokenIndex,
          dice,
          fromSteps: token.steps,
          toSteps: dest,
          wasDelegated,
          captures: 0,
        },
      };
      return { ok: true, state: next };
    }
    case "TOKEN_CAPTURED": {
      if (state.settle?.kind !== "after_token_move") {
        return reject("unexpected_capture", "No move pending");
      }
      if (event.payload.byColor !== state.settle.tokenColor) {
        return reject("invalid_capture", "Capturer is not the moved token");
      }
      const captures = findCaptureTargets(
        state.tokens,
        state.settle.tokenColor,
        state.settle.toSteps,
        state.mode,
      );
      const match = captures.find(
        (c) =>
          c.color === event.payload.victimColor &&
          c.index === event.payload.victimIndex,
      );
      if (!match) return reject("invalid_capture", "Capture not on landing");
      const next = patchTokenSteps(
        state,
        event.payload.victimColor,
        event.payload.victimIndex,
        -1,
      );
      return {
        ok: true,
        state: {
          ...next,
          settle: { ...state.settle, captures: state.settle.captures + 1 },
        },
      };
    }
    case "EXTRA_TURN_GRANTED": {
      if (state.settle?.kind !== "after_token_move") {
        return reject("unexpected_extra", "No move pending");
      }
      const unresolved = assertCapturesResolved(state);
      if (unresolved) return unresolved;
      if (event.payload.color !== state.settle.seat) {
        return reject("wrong_seat", "Extra turn must go to the seat holder");
      }
      const reason = extraTurnReason(state.settle);
      if (reason === null) {
        return reject("no_extra", "Extra turn not granted");
      }
      if (event.payload.reason !== reason) {
        return reject("extra_reason", `Extra turn was earned by ${reason}`);
      }
      const dice = state.settle.dice;
      const keepSix = dice === 6;
      return {
        ok: true,
        state: {
          ...state,
          settle: null,
          passedRollTo: null,
          consecutiveSixes: keepSix ? state.consecutiveSixes : 0,
          sixStreakSnapshot: keepSix ? state.sixStreakSnapshot : null,
          diceValue: dice,
          diceRolled: false,
        },
      };
    }
    case "PLAYER_FINISHED": {
      const playingCheck = assertPlaying(state);
      if (playingCheck) return playingCheck;
      const { color, rank } = event.payload;
      if (!seatByColor(state, color)) return reject("no_seat", "Unknown seat");
      if (!hasWon(state.tokens, color)) {
        return reject("not_home", "Player still has tokens out");
      }
      const assigned = assignFinishRankInState(state, color);
      if (assigned.rank !== rank) {
        return reject("rank_mismatch", "Finish rank mismatch");
      }
      let next = assigned.state;
      if (state.settle?.kind === "after_token_move") {
        next = { ...next, settle: null, consecutiveSixes: 0, sixStreakSnapshot: null };
      }
      return { ok: true, state: next };
    }
    case "TURN_ENDED": {
      const playingCheck = assertPlaying(state);
      if (playingCheck) return playingCheck;
      const invalid = validateTurnEnd(state, event.payload.reason);
      if (invalid) return invalid;
      return {
        ok: true,
        state: {
          ...state,
          settle: { kind: "turn_ended" },
          passedRollTo: null,
          consecutiveSixes: 0,
          sixStreakSnapshot: null,
        },
      };
    }
    case "TURN_TIMED_OUT": {
      const playingCheck = assertPlaying(state);
      if (playingCheck && !playingCheck.ok) return playingCheck;
      const actor = turnActorColor(
        event.payload.color,
        teamPlayers(state),
        state.mode,
      );
      const seat = seatByColor(state, actor);
      if (!seat || seat.eliminated || seat.finishRank != null) {
        return reject("invalid_timeout", "Cannot timeout seat");
      }
      const lives = seat.lives - 1;
      return {
        ok: true,
        state: updateSeat(state, actor, { lives: Math.max(0, lives) }),
      };
    }
    case "PLAYER_ELIMINATED": {
      const playingCheck = assertPlaying(state);
      if (playingCheck) return playingCheck;
      const { color, reason } = event.payload;
      const seat = seatByColor(state, color);
      if (!seat) return reject("no_seat", "Unknown seat");
      if (seat.eliminated || seat.finishRank != null) {
        return reject("invalid_elimination", "Seat is no longer playing");
      }
      const place =
        reason === "left"
          ? state.rankings.length + playableColors(state).length
          : playableColors(state).length;
      let next = updateSeat(state, color, {
        eliminated: true,
        lives: 0,
        finishRank: seat.finishRank ?? place,
      });
      if (reason === "timeout") {
        next = replaceTokens(
          next,
          next.tokens.map((t) =>
            t.color === color && t.steps !== FINISHED_STEPS
              ? { ...t, steps: -1 }
              : t,
          ),
        );
      } else if (reason === "left") {
        next = {
          ...next,
          tokens: next.tokens.filter((t) => t.color !== color),
        };
      }
      return { ok: true, state: next };
    }
    case "PLAYER_REINSTATED": {
      const playingCheck = assertPlaying(state);
      if (playingCheck) return playingCheck;
      const { color } = event.payload;
      const seat = seatByColor(state, color);
      if (!seat) return reject("no_seat", "Unknown seat");
      if (!seat.eliminated) {
        return reject("invalid_reinstate", "Seat is still playing");
      }
      const next = updateSeat(state, color, {
        eliminated: false,
        lives: MAX_TIMEOUT_LIVES,
        finishRank: null,
      });
      return {
        ok: true,
        state: {
          ...next,
          rankings: next.rankings.filter((c) => c !== color),
          tokens: [
            ...next.tokens.filter((t) => t.color !== color),
            ...tokensForColors([color]),
          ],
        },
      };
    }
    case "TEAM_FINISHED": {
      const playingCheck = assertPlaying(state);
      if (playingCheck) return playingCheck;
      if (state.mode !== "2v2") {
        return reject("wrong_mode", "Teams only finish in 2v2");
      }
      const team = event.payload.team;
      if (!teamAllTokensHome(state.tokens, team)) {
        return reject("not_home", "Team still has tokens out");
      }
      const winner =
        state.winner && teamOfColor(state.winner) === team
          ? state.winner
          : (state.rankings.find((c) => teamOfColor(c) === team) ?? state.winner);
      return {
        ok: true,
        state: { ...state, winningTeam: team, winner },
      };
    }
    case "GAME_FINISHED": {
      const playingCheck = assertPlaying(state);
      if (playingCheck) return playingCheck;
      const next = applyGameFinishedReason(state, event.payload.reason);
      return { ok: true, state: { ...next, finishedAt: next.finishedAt ?? 0 } };
    }
    default: {
      const _exhaustive: never = event;
      return reject("unknown_event", `Unknown event ${(_exhaustive as LudoEvent).eventType}`);
    }
  }
}

/** Apply events in order; a pending move (settle) at the end is allowed. */
export function reducePartial(
  initial: GameState,
  events: LudoEvent[],
): ReduceResult {
  let current = initial;
  for (const event of events) {
    const result = reduce(current, event);
    if (!result.ok) return result;
    current = result.state;
  }
  return { ok: true, state: current };
}

/** Apply a complete transaction; it must not leave a move unresolved. */
export function reduceAll(
  initial: GameState,
  events: LudoEvent[],
): ReduceResult {
  const result = reducePartial(initial, events);
  if (!result.ok) return result;
  const current = result.state;
  if (current.settle !== null) {
    return reject("incomplete", "Transaction left settle pending");
  }
  return { ok: true, state: current };
}
