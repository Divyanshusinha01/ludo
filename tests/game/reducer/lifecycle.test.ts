import { describe, expect, it } from "vitest";
import { createEmptyState } from "../../../convex/lib/game";
import { MAX_TIMEOUT_LIVES } from "../../../convex/lib/ludo";
import { ev, seatSnapshot, startedSeat } from "../fixtures/events";
import { finishedGame, lobbyHistory, started1v1 } from "../fixtures/histories";
import { deepFreeze, playingState, replayState } from "../fixtures/states";
import { apply, expectReject } from "../support/reduce";

const lobby = () => deepFreeze(replayState(lobbyHistory()));

describe("GAME_CREATED", () => {
  it("opens an empty lobby with the requested mode", () => {
    const s = apply(createEmptyState(), ev.gameCreated({ mode: "2v2", vsComputer: false }));
    expect(s.phase).toBe("lobby");
    expect(s.mode).toBe("2v2");
    expect(s.vsComputer).toBe(false);
    expect(s.seats).toEqual([]);
    expect(s.tokens).toEqual([]);
  });

  it("records vs-computer rooms", () => {
    const s = apply(createEmptyState(), ev.gameCreated({ vsComputer: true }));
    expect(s.vsComputer).toBe(true);
    expect(s.mode).toBe("1v1");
  });
});

describe("PLAYER_JOINED / PLAYER_LEFT (lobby)", () => {
  it("seats a joining player with full lives", () => {
    const s = apply(lobby(), ev.playerJoined(seatSnapshot("green", "1v1", { isBot: true })));
    expect(s.seats.map((x) => x.color)).toEqual(["red", "yellow", "green"]);
    const green = s.seats.find((x) => x.color === "green")!;
    expect(green).toMatchObject({ isBot: true, lives: MAX_TIMEOUT_LIVES, eliminated: false, finishRank: null });
  });

  it("rejects a second player on a taken colour", () => {
    expectReject(lobby(), ev.playerJoined(seatSnapshot("yellow")), "seat_taken");
  });

  it("removes a leaving or kicked player", () => {
    expect(apply(lobby(), ev.playerLeft("yellow")).seats.map((x) => x.color)).toEqual(["red"]);
    expect(apply(lobby(), ev.playerLeft("yellow", "kicked")).seats.map((x) => x.color)).toEqual(["red"]);
  });

  it("rejects joins and lobby-leaves once the match is playing", () => {
    const playing = deepFreeze(replayState(started1v1()));
    expectReject(playing, ev.playerJoined(seatSnapshot("green")), "wrong_phase");
    expectReject(playing, ev.playerLeft("yellow"), "wrong_phase");
  });
});

describe("GAME_STARTED", () => {
  it("snapshots seats, deals yard tokens and waits for the first TURN_STARTED", () => {
    const s = apply(lobby(), ev.gameStarted([startedSeat("red"), startedSeat("yellow")]));
    expect(s.phase).toBe("playing");
    expect(s.turnNumber).toBe(0);
    expect(s.currentTurn).toBe("red");
    expect(s.tokens).toHaveLength(8);
    expect(s.tokens.every((t) => t.steps === -1)).toBe(true);
    expect(s.rankings).toEqual([]);
    expect(s.winner).toBeNull();
  });

  it("uses board colour order for the first turn regardless of seat snapshot order", () => {
    const s = apply(
      lobby(),
      ev.gameStarted([startedSeat("yellow"), startedSeat("green")]),
    );
    expect(s.currentTurn).toBe("green");
    expect(apply(s, ev.turnStarted("green")).turnNumber).toBe(1);
  });

  it("is rejected while a match is already in play", () => {
    const playing = deepFreeze(replayState(started1v1()));
    expectReject(
      playing,
      ev.gameStarted([startedSeat("red"), startedSeat("yellow")]),
      "wrong_phase",
    );
  });

  it("is the only way out of a finished match (rematch resets everything)", () => {
    const finished = deepFreeze(finishedGame(11).final);
    expect(finished.phase).toBe("finished");
    const s = apply(finished, ev.gameStarted([startedSeat("red"), startedSeat("yellow")]));
    expect(s.phase).toBe("playing");
    expect(s.rankings).toEqual([]);
    expect(s.winner).toBeNull();
    expect(s.turnNumber).toBe(0);
    expect(s.seats.every((x) => x.finishRank === null && !x.eliminated)).toBe(true);
    expect(s.tokens.every((t) => t.steps === -1)).toBe(true);
  });

  it("does not let an in-play state start from a hand-built lobby-less state", () => {
    expectReject(
      deepFreeze(playingState({ colors: ["red", "yellow"] })),
      ev.gameStarted([startedSeat("red"), startedSeat("yellow")]),
      "wrong_phase",
    );
  });
});
