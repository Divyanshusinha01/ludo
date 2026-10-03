import {
  Color,
  decideRollOutcome,
  findCaptureTargets,
  FINISHED_STEPS,
  gainsExtraTurn,
  getLegalMovesForActor,
  hasWon,
  nextColorAmong,
  nextTurnSeatColor,
  shouldKeepRollForTeammatePass,
  shouldTransferRollToTeammate,
  teamTeammateColor,
  tryMoveSteps,
  turnActorColor,
  turnSeatAfterDelegatedMove,
  type TokenState,
} from "../ludo";
import type {
  EventActor,
  LudoEvent,
  LudoEventDraft,
} from "./eventValidators";
import { ReduceError } from "./errors";
import {
  draftAllRankedFinish,
  draftAutomaticLoserFinish,
  draftSoleSurvivorWin,
  draftTeamEliminationWin,
  draftTeamHomeWin,
  playableColors,
} from "./finish";
import { reduce, reduceAll } from "./reducer";
import type { GameState } from "./state";

/** Opaque room id (Convex Id<"rooms"> at runtime). */
export type GameId = string;

export type GameCommand =
  | { type: "RollDice"; color: Color; value: number }
  | {
      type: "MoveToken";
      actorColor: Color;
      tokenColor: Color;
      tokenIndex: number;
    }
  | { type: "PassRoll"; from: Color; to: Color }
  | { type: "ExpireTurn" }
  | { type: "ForfeitSeat"; color: Color; reason: "left" | "abandoned" }
  | { type: "FinishAbandoned" };

export type DecideResult =
  | { ok: true; events: LudoEventDraft[] }
  | { ok: false; error: ReduceError | { code: string; message: string } };

function systemActor(): EventActor {
  return { kind: "system" };
}

function seatActor(color: Color): EventActor {
  return { kind: "seat", color };
}

function draft(
  gameId: GameId,
  createdAt: number,
  actor: EventActor,
  event: Omit<LudoEventDraft, "gameId" | "createdAt" | "actor">,
): LudoEventDraft {
  return {
    gameId,
    createdAt,
    actor,
    ...event,
  } as LudoEventDraft;
}

function materializeDrafts(
  gameId: GameId,
  startSeq: number,
  drafts: LudoEventDraft[],
): LudoEvent[] {
  return drafts.map((d, i) => {
    const seq = startSeq + i + 1;
    return {
      ...d,
      seq,
      eventId: `${gameId}:${seq}`,
    } as LudoEvent;
  });
}

function simulate(
  state: GameState,
  gameId: GameId,
  drafts: LudoEventDraft[],
): DecideResult {
  const events = materializeDrafts(gameId, 0, drafts);
  const result = reduceAll(state, events);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, events: drafts };
}

type TurnEndReason =
  | "moved"
  | "no_moves"
  | "three_sixes"
  | "timeout"
  | "finished"
  | "eliminated";

function appendTurnAdvance(
  state: GameState,
  gameId: GameId,
  createdAt: number,
  reason: TurnEndReason,
  fromSeat: Color,
  drafts: LudoEventDraft[],
): LudoEventDraft[] {
  drafts.push(
    draft(gameId, createdAt, systemActor(), {
      eventType: "TURN_ENDED",
      payload: { reason },
    }),
  );
  const sim = reduceAll(
    state,
    materializeDrafts(gameId, 0, drafts),
  );
  if (!sim.ok) return drafts;
  const nextSeat =
    state.mode === "2v2"
      ? nextTurnSeatColor(fromSeat, sim.state.seats, state.mode)
      : nextColorAmong(fromSeat, playableColors(sim.state));
  drafts.push(
    draft(gameId, createdAt, systemActor(), {
      eventType: "TURN_STARTED",
      payload: { seat: nextSeat },
    }),
  );
  return drafts;
}

function appendPostMoveFinishes(
  state: GameState,
  gameId: GameId,
  createdAt: number,
  drafts: LudoEventDraft[],
  tokens: TokenState[],
): LudoEventDraft[] {
  let sim = reduceAll(state, materializeDrafts(gameId, 0, drafts));
  if (!sim.ok) return drafts;
  let simState = sim.state;
  const checks = [
    () => draftTeamHomeWin(simState, tokens),
    () => draftTeamEliminationWin(simState),
    () => draftAutomaticLoserFinish(simState),
    () => draftSoleSurvivorWin(simState),
    () => draftAllRankedFinish(simState),
  ];
  for (const check of checks) {
    const extra = check();
    if (extra) {
      for (const e of extra) {
        drafts.push({
          ...e,
          gameId: gameId as LudoEventDraft["gameId"],
          createdAt,
        });
      }
      sim = reduceAll(state, materializeDrafts(gameId, 0, drafts));
      if (!sim.ok) break;
      simState = sim.state;
      if (simState.phase === "finished") break;
    }
  }
  return drafts;
}

export function decide(
  state: GameState,
  command: GameCommand,
  ctx: { gameId: GameId; createdAt: number },
): DecideResult {
  const { gameId, createdAt } = ctx;

  if (command.type === "RollDice") {
    const drafts: LudoEventDraft[] = [
      draft(gameId, createdAt, seatActor(command.color), {
        eventType: "DICE_ROLLED",
        payload: { color: command.color, value: command.value },
      }),
    ];
    const afterRoll = reduceAll(
      state,
      materializeDrafts(gameId, 0, drafts),
    );
    if (!afterRoll.ok) return { ok: false, error: afterRoll.error };
    const rolled = afterRoll.state;
    const decision = decideRollOutcome(
      command.value,
      state.consecutiveSixes,
      getLegalMovesForActor(
        state.tokens,
        command.color,
        state.seats,
        state.mode,
        command.value,
      ).length,
    );

    if (decision.kind === "three_sixes") {
      appendTurnAdvance(
        state,
        gameId,
        createdAt,
        "three_sixes",
        state.currentTurn,
        drafts,
      );
      return simulate(state, gameId, drafts);
    }

    if (decision.kind === "no_moves_six") {
      return simulate(state, gameId, drafts);
    }

    if (decision.kind === "no_moves") {
      const seat = state.currentTurn;
      if (
        command.color === seat &&
        shouldKeepRollForTeammatePass(
          state.mode,
          seat,
          command.value,
          rolled.tokens,
          rolled.seats,
        )
      ) {
        const teammate = teamTeammateColor(seat);
        if (
          shouldTransferRollToTeammate(
            { diceRolled: true, diceValue: command.value },
            seat,
            teammate,
            rolled.tokens,
            rolled.seats,
            state.mode,
          )
        ) {
          drafts.push(
            draft(gameId, createdAt, seatActor(seat), {
              eventType: "ROLL_PASSED",
              payload: { from: seat, to: teammate },
            }),
          );
          return simulate(state, gameId, drafts);
        }
      }
      appendTurnAdvance(
        state,
        gameId,
        createdAt,
        "no_moves",
        seat,
        drafts,
      );
      return simulate(state, gameId, drafts);
    }

    const legal = getLegalMovesForActor(
      rolled.tokens,
      command.color,
      rolled.seats,
      state.mode,
      command.value,
    );
    if (legal.length === 1) {
      const only = legal[0]!;
      const moveResult = decide(
        rolled,
        {
          type: "MoveToken",
          actorColor: command.color,
          tokenColor: only.color,
          tokenIndex: only.index,
        },
        ctx,
      );
      if (!moveResult.ok) return moveResult;
      return {
        ok: true,
        events: [...drafts, ...moveResult.events],
      };
    }

    return simulate(state, gameId, drafts);
  }

  if (command.type === "MoveToken") {
    const drafts: LudoEventDraft[] = [
      draft(gameId, createdAt, seatActor(command.actorColor), {
        eventType: "TOKEN_MOVED",
        payload: {
          tokenColor: command.tokenColor,
          tokenIndex: command.tokenIndex,
        },
      }),
    ];
    let sim = reduceAll(state, materializeDrafts(gameId, 0, drafts));
    if (!sim.ok) return { ok: false, error: sim.error };
    const dice = state.diceValue ?? 0;
    const token = state.tokens.find(
      (t) =>
        t.color === command.tokenColor && t.index === command.tokenIndex,
    );
    const dest =
      token && state.diceValue !== null
        ? tryMoveSteps(token.steps, state.diceValue)
        : null;
    if (dest === null) {
      return { ok: false, error: new ReduceError("illegal_move", "Bad move") };
    }
    const captures = findCaptureTargets(
      state.tokens,
      command.tokenColor,
      dest,
      state.mode,
    );
    for (const c of captures) {
      drafts.push(
        draft(gameId, createdAt, seatActor(command.actorColor), {
          eventType: "TOKEN_CAPTURED",
          payload: {
            byColor: command.tokenColor,
            victimColor: c.color,
            victimIndex: c.index,
          },
        }),
      );
    }
    sim = reduceAll(state, materializeDrafts(gameId, 0, drafts));
    if (!sim.ok) return { ok: false, error: sim.error };

    const updatedTokens = sim.state.tokens;
    const didCapture = captures.length > 0;
    const reachedHome = dest === FINISHED_STEPS;
    const seat = state.currentTurn;
    const wasDelegated = state.passedRollTo !== null;

    if (hasWon(updatedTokens, command.tokenColor)) {
      const rank =
        [...sim.state.rankings, command.tokenColor].length;
      drafts.push(
        draft(gameId, createdAt, systemActor(), {
          eventType: "PLAYER_FINISHED",
          payload: { color: command.tokenColor, rank },
        }),
      );
      appendPostMoveFinishes(state, gameId, createdAt, drafts, updatedTokens);
      sim = reduceAll(state, materializeDrafts(gameId, 0, drafts));
      if (sim.ok && sim.state.phase !== "finished") {
        appendTurnAdvance(state, gameId, createdAt, "finished", seat, drafts);
      }
      return simulate(state, gameId, drafts);
    }

    const extra = gainsExtraTurn(dice, didCapture, reachedHome);
    if (extra) {
      const reason = reachedHome ? "home" : didCapture ? "capture" : "six";
      drafts.push(
        draft(gameId, createdAt, systemActor(), {
          eventType: "EXTRA_TURN_GRANTED",
          payload: { color: seat, reason },
        }),
      );
      return simulate(state, gameId, drafts);
    }

    if (wasDelegated) {
      const { nextSeat } = turnSeatAfterDelegatedMove(
        seat,
        dice,
        didCapture,
        reachedHome,
        sim.state.seats,
        state.mode,
      );
      drafts.push(
        draft(gameId, createdAt, systemActor(), {
          eventType: "TURN_ENDED",
          payload: { reason: "moved" },
        }),
      );
      drafts.push(
        draft(gameId, createdAt, systemActor(), {
          eventType: "TURN_STARTED",
          payload: { seat: nextSeat },
        }),
      );
    } else {
      appendTurnAdvance(state, gameId, createdAt, "moved", seat, drafts);
    }
    appendPostMoveFinishes(state, gameId, createdAt, drafts, updatedTokens);
    return simulate(state, gameId, drafts);
  }

  if (command.type === "PassRoll") {
    const drafts: LudoEventDraft[] = [
      draft(gameId, createdAt, seatActor(command.from), {
        eventType: "ROLL_PASSED",
        payload: { from: command.from, to: command.to },
      }),
    ];
    return simulate(state, gameId, drafts);
  }

  if (command.type === "ExpireTurn") {
    const seat = state.currentTurn;
    const actor = turnActorColor(seat, state.seats, state.mode);
    const drafts: LudoEventDraft[] = [
      draft(gameId, createdAt, systemActor(), {
        eventType: "TURN_TIMED_OUT",
        payload: { color: seat },
      }),
    ];
    let sim = reduceAll(state, materializeDrafts(gameId, 0, drafts));
    if (!sim.ok) return { ok: false, error: sim.error };
    const livesSeat = sim.state.seats.find((s) => s.color === actor);
    if (livesSeat && livesSeat.lives <= 0) {
      drafts.push(
        draft(gameId, createdAt, systemActor(), {
          eventType: "PLAYER_ELIMINATED",
          payload: { color: actor, reason: "timeout" },
        }),
      );
      appendPostMoveFinishes(state, gameId, createdAt, drafts, sim.state.tokens);
      sim = reduceAll(state, materializeDrafts(gameId, 0, drafts));
      if (sim.ok && sim.state.phase !== "finished") {
        appendTurnAdvance(
          state,
          gameId,
          createdAt,
          "eliminated",
          seat,
          drafts,
        );
      }
    } else {
      appendTurnAdvance(state, gameId, createdAt, "timeout", seat, drafts);
    }
    return simulate(state, gameId, drafts);
  }

  if (command.type === "ForfeitSeat") {
    const drafts: LudoEventDraft[] = [
      draft(gameId, createdAt, systemActor(), {
        eventType: "PLAYER_ELIMINATED",
        payload: { color: command.color, reason: command.reason },
      }),
    ];
    appendPostMoveFinishes(state, gameId, createdAt, drafts, state.tokens);
    return simulate(state, gameId, drafts);
  }

  if (command.type === "FinishAbandoned") {
    const drafts: LudoEventDraft[] = [
      draft(gameId, createdAt, systemActor(), {
        eventType: "GAME_FINISHED",
        payload: { reason: "abandoned" },
      }),
    ];
    return simulate(state, gameId, drafts);
  }

  return { ok: false, error: { code: "unknown", message: "Unknown command" } };
}
