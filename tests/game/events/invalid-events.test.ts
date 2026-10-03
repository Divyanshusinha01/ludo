import { describe, expect, it } from "vitest";
import {
  createEmptyState,
  reduce,
  replayGame,
  type GameState,
  type LudoEvent,
  type LudoEventDraft,
} from "../../../convex/lib/game";
import { ev, makeEvent, seatSnapshot, startedSeat } from "../fixtures/events";
import { finishedGame, lobbyHistory, scriptedOpening1v1 } from "../fixtures/histories";
import { deepFreeze, playingState, replayState } from "../fixtures/states";
import { apply, expectReject } from "../support/reduce";

type Body = Pick<LudoEventDraft, "eventType" | "payload" | "actor">;

const fresh = () => deepFreeze(playingState({ colors: ["red", "yellow"], steps: { red: [10, 20], yellow: [10] } }));
const rolled = (value = 3) => deepFreeze(apply(fresh(), ev.diceRolled("red", value)));
const lobby = () => deepFreeze(replayState(lobbyHistory()));
const over = () => deepFreeze(finishedGame(5).final);

const cases: Array<[string, () => GameState, Body, string]> = [
  ["roll out of turn", fresh, ev.diceRolled("yellow", 3), "wrong_actor"],
  ["roll impersonating the seat holder", fresh, { ...ev.diceRolled("red", 3), actor: { kind: "seat", color: "yellow" } }, "wrong_actor"],
  ["roll twice", () => rolled(), ev.diceRolled("red", 3), "dice_rolled"],
  ["roll a 0", fresh, ev.diceRolled("red", 0), "invalid_dice"],
  ["roll a 7", fresh, ev.diceRolled("red", 7), "invalid_dice"],
  ["roll a fraction", fresh, ev.diceRolled("red", 2.5), "invalid_dice"],
  ["move before rolling", fresh, ev.tokenMoved("red", "red", 0), "roll_first"],
  ["move an opponent token", () => rolled(), ev.tokenMoved("red", "yellow", 0), "illegal_move"],
  ["move a token that does not exist", () => rolled(), ev.tokenMoved("red", "red", 7), "illegal_move"],
  ["move a yard token without a six", () => rolled(), ev.tokenMoved("red", "red", 2), "illegal_move"],
  ["move for another seat", () => rolled(), ev.tokenMoved("yellow", "red", 0), "wrong_actor"],
  ["capture with no move pending", fresh, ev.tokenCaptured("red", "red", "yellow", 0), "unexpected_capture"],
  ["extra turn with no move pending", fresh, ev.extraTurn("red", "six"), "unexpected_extra"],
  ["end a turn as 'moved' without moving", fresh, ev.turnEnded("moved"), "invalid_turn_end"],
  ["start the wrong next turn", () => deepFreeze(apply(fresh(), ev.turnEnded("timeout"))), ev.turnStarted("red"), "wrong_turn"],
  ["start a turn before the current one ended", fresh, ev.turnStarted("yellow"), "turn_not_ended"],
  ["end a turn twice", () => deepFreeze(apply(fresh(), ev.turnEnded("timeout"))), ev.turnEnded("timeout"), "invalid_turn_end"],
  ["roll between turns", () => deepFreeze(apply(fresh(), ev.turnEnded("timeout"))), ev.diceRolled("red", 3), "settle_pending"],
  ["pass a roll in 1v1", () => rolled(), ev.rollPassed("red", "yellow"), "wrong_mode"],
  ["finish with tokens out", fresh, ev.playerFinished("red", 1), "not_home"],
  ["eliminate an unseated colour", fresh, ev.playerEliminated("green", "left"), "no_seat"],
  ["start a match already in play", fresh, ev.gameStarted([startedSeat("red"), startedSeat("yellow")]), "wrong_phase"],
  ["join after the start", fresh, ev.playerJoined(seatSnapshot("green")), "wrong_phase"],
  ["join on a taken colour", lobby, ev.playerJoined(seatSnapshot("red")), "seat_taken"],
  ["roll in the lobby", lobby, ev.diceRolled("red", 3), "wrong_phase"],
  ["time out in the lobby", lobby, ev.turnTimedOut("red"), "wrong_phase"],
  ["finish a player in the lobby", lobby, ev.playerFinished("red", 1), "wrong_phase"],
  ["finish the game in the lobby", lobby, ev.gameFinished("abandoned"), "wrong_phase"],
  ["roll after the match", over, ev.diceRolled("red", 3), "game_finished"],
  ["move after the match", over, ev.tokenMoved("red", "red", 0), "game_finished"],
  ["start a turn after the match", over, ev.turnStarted("red"), "game_finished"],
  ["end a turn after the match", over, ev.turnEnded("timeout"), "game_finished"],
  ["time out after the match", over, ev.turnTimedOut("red"), "game_finished"],
  ["eliminate after the match", over, ev.playerEliminated("red", "left"), "game_finished"],
  ["finish a player after the match", over, ev.playerFinished("red", 1), "game_finished"],
  ["finish the match twice", over, ev.gameFinished("all_ranked"), "game_finished"],
];

describe("invalid events are rejected without mutating state", () => {
  it.each(cases)("%s", (_label, state, body, code) => {
    expectReject(state(), body, code);
  });

  it("an unknown event type is rejected", () => {
    const bogus = { ...makeEvent(ev.turnStarted("red"), 1), eventType: "TELEPORT" } as unknown as LudoEvent;
    const s = fresh();
    const result = reduce(s, bogus);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unknown_event");
  });

  it("GAME_CREATED cannot reset an existing lobby, match or finished game", () => {
    expectReject(lobby(), ev.gameCreated(), "wrong_phase");
    expectReject(fresh(), ev.gameCreated(), "wrong_phase");
    expectReject(over(), ev.gameCreated(), "wrong_phase");
  });
});

describe("an invalid event appended to a valid history fails replay at its seq", () => {
  it.each([
    ["roll out of turn", ev.diceRolled("yellow", 3)],
    ["move before rolling", ev.tokenMoved("red", "red", 0)],
    ["second game start", ev.gameStarted([startedSeat("red"), startedSeat("yellow")])],
  ] as const)("%s", (_label, body) => {
    const history = scriptedOpening1v1();
    const bad = makeEvent(body, history.length + 1);
    expect(() => replayGame(createEmptyState(), [...history, bad])).toThrow(
      expect.objectContaining({ seq: bad.seq, eventType: bad.eventType }),
    );
  });
});
