import {
  Color,
  decideRollOutcome,
  findCaptureTargets,
  FINISHED_STEPS,
  gainsExtraTurn,
  getLegalMovesForActor,
  legalMovesForDelegatedRoll,
  moveControllerColor,
  nextColorAmong,
  nextTurnSeatColor,
  rollControllerColor,
  rotationColors,
  snapshotTokens,
  startsSixStreak,
  tryMoveSteps,
  turnActorColor,
  teamTeammateColor,
} from "../ludo";
import type { LudoEvent } from "./eventValidators";
import { reject, type ReduceResult } from "./errors";
import {
  applyGameFinishedReason,
  assignFinishRankInState,
  playableColors,
} from "./finish";
import {
  activeColorsForMatch,
  createEmptyState,
  lobbySeatFromSnapshot,
  patchTokenSteps,
  replaceTokens,
  seatByColor,
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
  return null;
}

function advanceTurnColor(state: GameState, fromSeat: Color): Color {
  if (state.mode === "2v2") {
    return nextTurnSeatColor(fromSeat, teamPlayers(state), state.mode);
  }
  return nextColorAmong(fromSeat, playableColors(state));
}

export function reduce(state: GameState, event: LudoEvent): ReduceResult {
  switch (event.eventType) {
    case "GAME_CREATED": {
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
      const firstTurn = colors[0] ?? "red";
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
      if (state.settle !== null) {
        return reject("settle_pending", "Turn start while move unresolved");
      }
      const seat = event.payload.seat;
      if (state.turnNumber > 0) {
        const expected = advanceTurnColor(state, state.currentTurn);
        if (seat !== expected) {
          return reject("wrong_turn", "Turn seat mismatch");
        }
      } else {
        const first = activeColorsForMatch(state)[0];
        if (first && seat !== first) {
          return reject("wrong_turn", "First turn seat mismatch");
        }
      }
      return {
        ok: true,
        state: {
          ...state,
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
      if (value < 1 || value > 6) {
        return reject("invalid_dice", "Invalid dice value");
      }
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
        },
      };
      return { ok: true, state: next };
    }
    case "TOKEN_CAPTURED": {
      if (state.settle?.kind !== "after_token_move") {
        return reject("unexpected_capture", "No move pending");
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
      let next = patchTokenSteps(
        state,
        event.payload.victimColor,
        event.payload.victimIndex,
        -1,
      );
      return { ok: true, state: next };
    }
    case "EXTRA_TURN_GRANTED": {
      if (state.settle?.kind !== "after_token_move") {
        return reject("unexpected_extra", "No move pending");
      }
      const { dice, toSteps } = state.settle;
      const didCapture = findCaptureTargets(
        state.tokens,
        state.settle.tokenColor,
        toSteps,
        state.mode,
      ).length > 0;
      const reachedHome = toSteps === FINISHED_STEPS;
      if (!gainsExtraTurn(dice, didCapture, reachedHome)) {
        return reject("no_extra", "Extra turn not granted");
      }
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
      const { color, rank } = event.payload;
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
      if (state.phase === "finished") {
        return reject("game_finished", "Already finished");
      }
      if (
        state.settle !== null &&
        event.payload.reason !== "three_sixes" &&
        event.payload.reason !== "no_moves" &&
        event.payload.reason !== "timeout"
      ) {
        // move completion ends via turn end after settle cleared in prior events
      }
      return {
        ok: true,
        state: {
          ...state,
          settle: null,
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
      const { color, reason } = event.payload;
      const seat = seatByColor(state, color);
      if (!seat) return reject("no_seat", "Unknown seat");
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
            t.color === color ? { ...t, steps: -1 } : t,
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
    case "TEAM_FINISHED": {
      return {
        ok: true,
        state: { ...state, winningTeam: event.payload.team },
      };
    }
    case "GAME_FINISHED": {
      const next = applyGameFinishedReason(state, event.payload.reason);
      return { ok: true, state: { ...next, finishedAt: next.finishedAt ?? 0 } };
    }
    default: {
      const _exhaustive: never = event;
      return reject("unknown_event", `Unknown event ${(_exhaustive as LudoEvent).eventType}`);
    }
  }
}

export function reduceAll(
  initial: GameState,
  events: LudoEvent[],
): ReduceResult {
  let current = initial;
  for (const event of events) {
    const result = reduce(current, event);
    if (!result.ok) return result;
    current = result.state;
  }
  if (current.settle !== null) {
    return reject("incomplete", "Transaction left settle pending");
  }
  return { ok: true, state: current };
}
