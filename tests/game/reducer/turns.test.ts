import { describe, expect, it } from "vitest";
import { MAX_TIMEOUT_LIVES } from "../../../convex/lib/ludo";
import { ev } from "../fixtures/events";
import { lobbyHistory, started4p } from "../fixtures/histories";
import { deepFreeze, playingState, replayState } from "../fixtures/states";
import { apply, expectReject } from "../support/reduce";

describe("TURN_STARTED", () => {
  it("first turn goes to the first seat and bumps turnNumber", () => {
    const events = started4p();
    const s = replayState(events);
    expect(s.currentTurn).toBe("red");
    expect(s.turnNumber).toBe(1);
  });

  it("rejects a first turn for anyone but the first seat", () => {
    const beforeTurn = deepFreeze(replayState(started4p().slice(0, -1)));
    expectReject(beforeTurn, ev.turnStarted("green"), "wrong_turn");
  });

  it("advances clockwise and resets the dice", () => {
    const s = deepFreeze(
      playingState({ colors: ["red", "green", "yellow"], diceValue: 4, consecutiveSixes: 1 }),
    );
    const next = apply(s, ev.turnEnded("timeout"), ev.turnStarted("green"));
    expect(next.currentTurn).toBe("green");
    expect(next.turnNumber).toBe(2);
    expect(next.diceValue).toBeNull();
    expect(next.diceRolled).toBe(false);
    expect(next.consecutiveSixes).toBe(0);
    expect(next.sixStreakSnapshot).toBeNull();
  });

  it("rejects skipping the next seat", () => {
    expectReject(
      deepFreeze(apply(playingState({ colors: ["red", "green", "yellow"] }), ev.turnEnded("timeout"))),
      ev.turnStarted("yellow"),
      "wrong_turn",
    );
  });

  it("rejects a turn start before the current turn ended", () => {
    expectReject(
      deepFreeze(playingState({ colors: ["red", "green", "yellow"] })),
      ev.turnStarted("green"),
      "turn_not_ended",
    );
  });

  it("skips finished and eliminated seats in 1v1 rotation", () => {
    const s = deepFreeze(
      apply(
        playingState({
          colors: ["red", "green", "yellow", "blue"],
          seats: { green: { finishRank: 1 }, yellow: { eliminated: true, finishRank: 3 } },
          rankings: ["green"],
        }),
        ev.turnEnded("timeout"),
      ),
    );
    expect(apply(s, ev.turnStarted("blue")).currentTurn).toBe("blue");
    expectReject(s, ev.turnStarted("green"), "wrong_turn");
  });

  it("is rejected in the lobby", () => {
    expectReject(deepFreeze(replayState(lobbyHistory())), ev.turnStarted("red"), "wrong_phase");
  });

  it("is rejected while a move is unresolved", () => {
    const s = apply(
      playingState({ colors: ["red", "yellow"], steps: { red: [10] } }),
      ev.diceRolled("red", 3),
      ev.tokenMoved("red", "red", 0),
    );
    expectReject(deepFreeze(s), ev.turnStarted("yellow"), "settle_pending");
  });
});

describe("TURN_ENDED", () => {
  it("closes a completed move", () => {
    const s = apply(
      playingState({ colors: ["red", "yellow"], steps: { red: [10] } }),
      ev.diceRolled("red", 3),
      ev.tokenMoved("red", "red", 0),
      ev.turnEnded("moved"),
    );
    expect(s.settle).toEqual({ kind: "turn_ended" });
    expect(s.passedRollTo).toBeNull();
    expect(apply(s, ev.turnStarted("yellow")).settle).toBeNull();
  });

  it("closes a roll with no legal moves", () => {
    const s = apply(
      playingState({ colors: ["red", "yellow"] }),
      ev.diceRolled("red", 3),
      ev.turnEnded("no_moves"),
    );
    expect(s.settle).toEqual({ kind: "turn_ended" });
    expect(apply(s, ev.turnStarted("yellow")).settle).toBeNull();
  });

  it("rejects 'moved' when no move happened", () => {
    expectReject(
      deepFreeze(playingState({ colors: ["red", "yellow"] })),
      ev.turnEnded("moved"),
      "invalid_turn_end",
    );
  });

  it("rejects 'no_moves' while a legal move exists", () => {
    const s = apply(
      playingState({ colors: ["red", "yellow"], steps: { red: [10] } }),
      ev.diceRolled("red", 3),
    );
    expectReject(deepFreeze(s), ev.turnEnded("no_moves"), "invalid_turn_end");
  });

  it("rejects a non-move reason while a move is unresolved", () => {
    const s = apply(
      playingState({ colors: ["red", "yellow"], steps: { red: [10] } }),
      ev.diceRolled("red", 3),
      ev.tokenMoved("red", "red", 0),
    );
    expectReject(deepFreeze(s), ev.turnEnded("timeout"), "invalid_turn_end");
  });

  it("rejects ending a move that earned an extra turn", () => {
    const s = apply(
      playingState({ colors: ["red", "yellow"], steps: { red: [10] } }),
      ev.diceRolled("red", 6),
      ev.tokenMoved("red", "red", 0),
    );
    expectReject(deepFreeze(s), ev.turnEnded("moved"), "invalid_turn_end");
  });

  it("is rejected in the lobby and after the match", () => {
    expectReject(deepFreeze(replayState(lobbyHistory())), ev.turnEnded("timeout"), "wrong_phase");
    expectReject(
      deepFreeze(playingState({ colors: ["red", "yellow"], phase: "finished", winner: "red", rankings: ["red", "yellow"] })),
      ev.turnEnded("timeout"),
      "game_finished",
    );
  });
});

describe("TURN_TIMED_OUT", () => {
  it("costs the turn actor a life", () => {
    const s = apply(playingState({ colors: ["red", "yellow"] }), ev.turnTimedOut("red"));
    expect(s.seats.find((x) => x.color === "red")!.lives).toBe(MAX_TIMEOUT_LIVES - 1);
  });

  it("charges the playing teammate when the seat holder already finished (2v2)", () => {
    const s = apply(
      playingState({
        colors: ["red", "green", "yellow", "blue"],
        mode: "2v2",
        seats: { red: { finishRank: 1 } },
        rankings: ["red"],
        steps: { red: [56, 56, 56, 56] },
      }),
      ev.turnTimedOut("red"),
    );
    expect(s.seats.find((x) => x.color === "yellow")!.lives).toBe(MAX_TIMEOUT_LIVES - 1);
    expect(s.seats.find((x) => x.color === "red")!.lives).toBe(MAX_TIMEOUT_LIVES);
  });

  it("rejects timing out an eliminated seat", () => {
    expectReject(
      deepFreeze(playingState({ colors: ["red", "yellow"], seats: { red: { eliminated: true, lives: 0 } } })),
      ev.turnTimedOut("red"),
      "invalid_timeout",
    );
  });
});

describe("PLAYER_ELIMINATED", () => {
  it("timeout: sends tokens home to the yard and ranks last among the playable", () => {
    const s = apply(
      playingState({ colors: ["red", "green", "yellow"], steps: { green: [5, 20] } }),
      ev.playerEliminated("green", "timeout"),
    );
    const green = s.seats.find((x) => x.color === "green")!;
    expect(green).toMatchObject({ eliminated: true, lives: 0, finishRank: 3 });
    expect(s.tokens.filter((t) => t.color === "green").every((t) => t.steps === -1)).toBe(true);
  });

  it("left: removes the seat's tokens from the board", () => {
    const s = apply(
      playingState({ colors: ["red", "green", "yellow"] }),
      ev.playerEliminated("green", "left"),
    );
    expect(s.tokens.some((t) => t.color === "green")).toBe(false);
    expect(s.seats.find((x) => x.color === "green")!.eliminated).toBe(true);
  });

  it("rejects eliminating an unknown, already eliminated or finished seat", () => {
    const s = deepFreeze(
      playingState({
        colors: ["red", "green", "yellow"],
        seats: { green: { eliminated: true, finishRank: 3 }, yellow: { finishRank: 1 } },
        rankings: ["yellow"],
      }),
    );
    expectReject(s, ev.playerEliminated("blue", "left"), "no_seat");
    expectReject(s, ev.playerEliminated("green", "left"), "invalid_elimination");
    expectReject(s, ev.playerEliminated("yellow", "left"), "invalid_elimination");
  });

  it("is rejected in the lobby and after the match", () => {
    expectReject(deepFreeze(replayState(lobbyHistory())), ev.playerEliminated("yellow", "left"), "wrong_phase");
    expectReject(
      deepFreeze(playingState({ colors: ["red", "yellow"], phase: "finished", winner: "red", rankings: ["red", "yellow"] })),
      ev.playerEliminated("yellow", "left"),
      "game_finished",
    );
  });
});
