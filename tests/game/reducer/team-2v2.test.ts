import { describe, expect, it } from "vitest";
import { absoluteTrackPosition, type Color } from "../../../convex/lib/ludo";
import { ev } from "../fixtures/events";
import { started2v2 } from "../fixtures/histories";
import { deepFreeze, playingState, replayState, type PlayingStateOpts } from "../fixtures/states";
import { apply, expectReject, run } from "../support/reduce";

const ALL: Color[] = ["red", "green", "yellow", "blue"];
const team = (opts: Omit<PlayingStateOpts, "colors" | "mode"> = {}) =>
  playingState({ colors: ALL, mode: "2v2", ...opts });

const finishedRed = {
  steps: { red: [56, 56, 56, 56] },
  seats: { red: { finishRank: 1 } },
  rankings: ["red"] as Color[],
  winner: "red" as Color,
};

describe("2v2 seating and rotation", () => {
  it("starts with fixed teams: red+yellow vs green+blue", () => {
    const s = replayState(started2v2());
    expect(s.mode).toBe("2v2");
    expect(Object.fromEntries(s.seats.map((x) => [x.color, x.team]))).toEqual({
      red: "A",
      green: "B",
      yellow: "A",
      blue: "B",
    });
    expect(s.currentTurn).toBe("red");
  });

  it("rotates red -> green -> yellow -> blue -> red, alternating teams", () => {
    let s = team();
    const order: Color[] = [];
    for (const next of ["green", "yellow", "blue", "red"] as Color[]) {
      s = apply(s, ev.turnEnded("timeout"), ev.turnStarted(next));
      order.push(s.currentTurn);
    }
    expect(order).toEqual(["green", "yellow", "blue", "red"]);
  });

  it("keeps a finished seat in the rotation (their teammate plays it)", () => {
    const s = deepFreeze(team({ ...finishedRed, currentTurn: "blue" }));
    expect(apply(s, ev.turnEnded("timeout"), ev.turnStarted("red")).currentTurn).toBe("red");
  });
});

describe("2v2 delegated roll (ROLL_PASSED)", () => {
  const blocked = () => team({ steps: { yellow: [10] } });

  it("seat holder with no move hands the die to a teammate who can use it", () => {
    const { types, state } = run(blocked(), { type: "RollDice", color: "red", value: 3 });
    expect(types).toEqual(["DICE_ROLLED", "ROLL_PASSED"]);
    expect(state.passedRollTo).toBe("yellow");
    expect(state.currentTurn).toBe("red");
    expect(state.diceRolled).toBe(true);
  });

  it("the delegate moves their own token, then rotation continues from the seat", () => {
    const passed = run(blocked(), { type: "RollDice", color: "red", value: 3 }).state;
    const { types, state } = run(passed, {
      type: "MoveToken",
      actorColor: "yellow",
      tokenColor: "yellow",
      tokenIndex: 0,
    });
    expect(types).toEqual(["TOKEN_MOVED", "TURN_ENDED", "TURN_STARTED"]);
    expect(state.tokens.find((t) => t.color === "yellow" && t.index === 0)!.steps).toBe(13);
    expect(state.currentTurn).toBe("green");
    expect(state.passedRollTo).toBeNull();
  });

  it("the delegate may not move the seat holder's tokens; the seat holder may not move", () => {
    const passed = deepFreeze(
      apply(team({ steps: { red: [20], yellow: [10] } }), ev.diceRolled("red", 3), ev.rollPassed("red", "yellow")),
    );
    expectReject(passed, ev.tokenMoved("yellow", "red", 0), "illegal_move");
    expectReject(passed, ev.tokenMoved("red", "yellow", 0), "wrong_actor");
  });

  it("no pass when the teammate cannot use the die either", () => {
    const { types, state } = run(team(), { type: "RollDice", color: "red", value: 3 });
    expect(types).toEqual(["DICE_ROLLED", "TURN_ENDED", "TURN_STARTED"]);
    expect(state.currentTurn).toBe("green");
  });

  it("rejects passing to a non-teammate, from a non-holder, or with no roll", () => {
    const rolled = deepFreeze(apply(blocked(), ev.diceRolled("red", 3)));
    expectReject(rolled, ev.rollPassed("red", "green"), "wrong_teammate");
    expectReject(rolled, ev.rollPassed("yellow", "red"), "wrong_seat");
    expectReject(deepFreeze(blocked()), ev.rollPassed("red", "yellow"), "no_roll");
  });

  it("rejects passing a roll outside 2v2", () => {
    const s = deepFreeze(
      apply(playingState({ colors: ["red", "yellow"], steps: { yellow: [10] } }), ev.diceRolled("red", 3)),
    );
    expectReject(s, ev.rollPassed("red", "yellow"), "wrong_mode");
  });
});

describe("2v2 finished teammate", () => {
  it("the teammate rolls and moves on the finished seat's turn", () => {
    const s = deepFreeze(team({ ...finishedRed, steps: { ...finishedRed.steps, yellow: [10] } }));
    expectReject(s, ev.diceRolled("red", 3), "wrong_actor");
    const rolled = apply(s, ev.diceRolled("yellow", 3));
    const moved = apply(rolled, ev.tokenMoved("yellow", "yellow", 0), ev.turnEnded("moved"));
    expect(moved.tokens.find((t) => t.color === "yellow" && t.index === 0)!.steps).toBe(13);
  });

  it("timeouts on the finished seat's turn cost the teammate a life", () => {
    const s = apply(team(finishedRed), ev.turnTimedOut("red"));
    expect(s.seats.find((x) => x.color === "yellow")!.lives).toBeLessThan(
      s.seats.find((x) => x.color === "red")!.lives,
    );
  });
});

describe("2v2 captures", () => {
  it("captures an opponent's token", () => {
    const redAbs = absoluteTrackPosition("red", 5)!;
    const greenSteps = (redAbs - 13 + 52) % 52;
    const rolled = apply(team({ steps: { red: [2, 20], green: [greenSteps] } }), ev.diceRolled("red", 3));
    const { types, state } = run(rolled, {
      type: "MoveToken",
      actorColor: "red",
      tokenColor: "red",
      tokenIndex: 0,
    });
    expect(types).toEqual(["TOKEN_MOVED", "TOKEN_CAPTURED", "EXTRA_TURN_GRANTED"]);
    expect(state.tokens.find((t) => t.color === "green" && t.index === 0)!.steps).toBe(-1);
  });
});

describe("2v2 team finish", () => {
  it("both teammates home: TEAM_FINISHED then GAME_FINISHED(team_home)", () => {
    const rolled = apply(
      team({
        ...finishedRed,
        steps: { ...finishedRed.steps, yellow: [56, 56, 56, 52], green: [10] },
      }),
      ev.diceRolled("yellow", 4),
    );
    const { types, state } = run(rolled, {
      type: "MoveToken",
      actorColor: "yellow",
      tokenColor: "yellow",
      tokenIndex: 3,
    });
    expect(types).toEqual([
      "TOKEN_MOVED",
      "PLAYER_FINISHED",
      "TEAM_FINISHED",
      "GAME_FINISHED",
    ]);
    expect(state.phase).toBe("finished");
    expect(state.winningTeam).toBe("A");
    expect(state.winner).toBe("red");
    expect(state.rankings).toEqual(["red", "yellow", "green", "blue"]);
  });

  it("other team spent by elimination: the surviving team wins", () => {
    const s = team({ seats: { green: { eliminated: true, lives: 0, finishRank: 4 } } });
    const { types, state } = run(s, { type: "ForfeitSeat", color: "blue", reason: "left" });
    expect(types).toEqual(["PLAYER_ELIMINATED", "GAME_FINISHED"]);
    expect(state.phase).toBe("finished");
    expect(state.winningTeam).toBe("A");
    expect(state.rankings.slice(0, 2).sort()).toEqual(["red", "yellow"]);
    expect(state.rankings.slice(2).sort()).toEqual(["blue", "green"]);
  });
});
