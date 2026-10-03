import { describe, expect, it } from "vitest";
import { ev } from "../fixtures/events";
import { lobbyHistory } from "../fixtures/histories";
import { deepFreeze, playingState, replayState } from "../fixtures/states";
import { apply, expectReject, run } from "../support/reduce";

const lobby = () => deepFreeze(replayState(lobbyHistory()));
const finished = () =>
  deepFreeze(
    playingState({
      colors: ["red", "yellow"],
      phase: "finished",
      winner: "red",
      rankings: ["red", "yellow"],
      steps: { red: [56, 56, 56, 56] },
      seats: { red: { finishRank: 1 } },
    }),
  );

describe("PLAYER_FINISHED", () => {
  it("1v1: last token home ranks the mover first and ends the match", () => {
    const rolled = apply(
      playingState({ colors: ["red", "yellow"], steps: { red: [56, 56, 56, 52], yellow: [10] } }),
      ev.diceRolled("red", 4),
    );
    const { types, state } = run(rolled, {
      type: "MoveToken",
      actorColor: "red",
      tokenColor: "red",
      tokenIndex: 3,
    });
    expect(types).toEqual(["TOKEN_MOVED", "PLAYER_FINISHED", "GAME_FINISHED"]);
    expect(state.phase).toBe("finished");
    expect(state.winner).toBe("red");
    expect(state.rankings).toEqual(["red", "yellow"]);
    expect(state.seats.find((s) => s.color === "red")!.finishRank).toBe(1);
    expect(state.settle).toBeNull();
    expect(state.diceRolled).toBe(false);
  });

  it("3 players: a finisher is ranked and the match continues without them", () => {
    const rolled = apply(
      playingState({
        colors: ["red", "green", "yellow"],
        steps: { red: [56, 56, 56, 52], green: [10], yellow: [10] },
      }),
      ev.diceRolled("red", 4),
    );
    const { types, state } = run(rolled, {
      type: "MoveToken",
      actorColor: "red",
      tokenColor: "red",
      tokenIndex: 3,
    });
    expect(types).toEqual([
      "TOKEN_MOVED",
      "PLAYER_FINISHED",
      "TURN_ENDED",
      "TURN_STARTED",
    ]);
    expect(state.phase).toBe("playing");
    expect(state.rankings).toEqual(["red"]);
    expect(state.winner).toBe("red");
    expect(state.currentTurn).toBe("green");
  });

  it("second finisher takes rank 2", () => {
    const s = apply(
      playingState({
        colors: ["red", "green", "yellow"],
        steps: { red: [56, 56, 56, 56], green: [56, 56, 56, 56] },
        seats: { red: { finishRank: 1 } },
        rankings: ["red"],
        winner: "red",
      }),
      ev.playerFinished("green", 2),
    );
    expect(s.rankings).toEqual(["red", "green"]);
    expect(s.winner).toBe("red");
  });

  it("rejects a rank that does not match the finishing order", () => {
    expectReject(
      deepFreeze(playingState({ colors: ["red", "yellow"], steps: { red: [56, 56, 56, 56] } })),
      ev.playerFinished("red", 2),
      "rank_mismatch",
    );
  });

  it("rejects a finish while the player still has tokens out", () => {
    expectReject(
      deepFreeze(playingState({ colors: ["red", "yellow"], steps: { red: [56, 56, 56, 40] } })),
      ev.playerFinished("red", 1),
      "not_home",
    );
  });

  it("rejects an unknown seat", () => {
    expectReject(
      deepFreeze(playingState({ colors: ["red", "yellow"] })),
      ev.playerFinished("green", 1),
      "no_seat",
    );
  });

  it("is rejected in the lobby and after the match", () => {
    expectReject(lobby(), ev.playerFinished("red", 1), "wrong_phase");
    expectReject(finished(), ev.playerFinished("yellow", 2), "game_finished");
  });
});

describe("GAME_FINISHED", () => {
  it("sole survivor wins when everyone else is eliminated", () => {
    const s = apply(
      playingState({
        colors: ["red", "green", "yellow"],
        seats: {
          red: { eliminated: true, lives: 0, finishRank: 3 },
          yellow: { eliminated: true, lives: 0, finishRank: 2 },
        },
      }),
      ev.gameFinished("sole_survivor"),
    );
    expect(s.phase).toBe("finished");
    expect(s.winner).toBe("green");
    expect(s.rankings[0]).toBe("green");
    expect([...s.rankings].sort()).toEqual(["green", "red", "yellow"]);
  });

  it("forfeit down to one player finishes the match via decide", () => {
    const { types, state } = run(playingState({ colors: ["red", "yellow"] }), {
      type: "ForfeitSeat",
      color: "yellow",
      reason: "left",
    });
    expect(types).toEqual(["PLAYER_ELIMINATED", "GAME_FINISHED"]);
    expect(state.phase).toBe("finished");
    expect(state.winner).toBe("red");
    expect(state.rankings).toEqual(["red", "yellow"]);
  });

  it("abandoned ends a running match", () => {
    const s = apply(playingState({ colors: ["red", "yellow"] }), ev.gameFinished("abandoned"));
    expect(s.phase).toBe("finished");
    expect([...s.rankings].sort()).toEqual(["red", "yellow"]);
  });

  it("is rejected in the lobby and after the match", () => {
    expectReject(lobby(), ev.gameFinished("abandoned"), "wrong_phase");
    expectReject(finished(), ev.gameFinished("abandoned"), "game_finished");
  });
});

describe("TEAM_FINISHED", () => {
  it("is rejected in the lobby and after the match", () => {
    expectReject(lobby(), ev.teamFinished("A"), "wrong_phase");
    expectReject(finished(), ev.teamFinished("A"), "game_finished");
  });

  it("is rejected outside 2v2 and before the team is home", () => {
    expectReject(
      deepFreeze(playingState({ colors: ["red", "yellow"], steps: { red: [56, 56, 56, 56], yellow: [56, 56, 56, 56] } })),
      ev.teamFinished("A"),
      "wrong_mode",
    );
    expectReject(
      deepFreeze(
        playingState({
          colors: ["red", "green", "yellow", "blue"],
          mode: "2v2",
          steps: { red: [56, 56, 56, 56], yellow: [56, 56, 56, 10] },
        }),
      ),
      ev.teamFinished("A"),
      "not_home",
    );
  });
});
