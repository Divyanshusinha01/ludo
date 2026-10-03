import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GameError } from "../../../convex/lib/errors";
import {
  bundle,
  expectLiveEqualsReplay,
  liveState,
  seatClient,
  setupConvex,
  startedRoom,
  teardownConvex,
  type DiceQueue,
  type T,
} from "../setup";
import {
  expectOneWinner,
  freshArgs,
  headSeq,
  moveCall,
  rollCall,
  twoTokenChoice,
  typesAfter,
} from "./helpers";

let t: T;
let dice: DiceQueue;

beforeEach(() => {
  ({ t, dice } = setupConvex());
});

afterEach(() => {
  teardownConvex(dice);
});

describe("Race 1: two rolls fired together", () => {
  it("double-click from the roller: one roll lands, the other is refused", async () => {
    const room = await startedRoom(t, { players: 2 });
    const seat = (await bundle(t, room.roomId)).room.currentTurn;
    const client = seatClient(room, seat);
    const args = await freshArgs(t, room.roomId);
    const head = await headSeq(t, room.roomId);

    const results = await Promise.allSettled([
      rollCall(t, dice, room.roomId, client, args, 6),
      rollCall(t, dice, room.roomId, client, args, 6),
    ]);
    dice.clear();

    expect(expectOneWinner(results)).toEqual([GameError.diceAlreadyRolled]);
    expect(await typesAfter(t, room.roomId, head)).toEqual(["DICE_ROLLED"]);
    await expectLiveEqualsReplay(t, room.roomId);
  });

  it("roll that ends the turn races a duplicate: the duplicate sees a new turn", async () => {
    const room = await startedRoom(t, { players: 2 });
    const seat = (await bundle(t, room.roomId)).room.currentTurn;
    const client = seatClient(room, seat);
    const args = await freshArgs(t, room.roomId);
    const head = await headSeq(t, room.roomId);

    const results = await Promise.allSettled([
      rollCall(t, dice, room.roomId, client, args, 3),
      rollCall(t, dice, room.roomId, client, args, 3),
    ]);
    dice.clear();

    expect(expectOneWinner(results)).toEqual([GameError.staleAction]);
    expect(await typesAfter(t, room.roomId, head)).toEqual(["DICE_ROLLED", "TURN_ENDED", "TURN_STARTED"]);
    await expectLiveEqualsReplay(t, room.roomId);
  });

  it("the roller and an opponent roll together: only the roller's lands", async () => {
    const room = await startedRoom(t, { players: 2 });
    const seat = (await bundle(t, room.roomId)).room.currentTurn;
    const other = Object.keys(room.clients).find((c) => c !== seat)!;
    const args = await freshArgs(t, room.roomId);
    const head = await headSeq(t, room.roomId);

    const results = await Promise.allSettled([
      rollCall(t, dice, room.roomId, seatClient(room, other as typeof seat), args, 6),
      rollCall(t, dice, room.roomId, seatClient(room, seat), args, 6),
    ]);
    dice.clear();

    expect(results[1]!.status).toBe("fulfilled");
    expect(expectOneWinner(results)).toEqual([GameError.notYourTurn]);
    expect(await typesAfter(t, room.roomId, head)).toEqual(["DICE_ROLLED"]);
    await expectLiveEqualsReplay(t, room.roomId);
  });
});

describe("Race 2: two moves fired together", () => {
  it("two different tokens: the first move ends the turn, the second is stale", async () => {
    const room = await startedRoom(t, { players: 2 });
    const { seat, client } = await twoTokenChoice(t, dice, room);
    const args = await freshArgs(t, room.roomId);
    const head = await headSeq(t, room.roomId);

    const results = await Promise.allSettled([
      moveCall(t, room.roomId, client, args, seat, 0),
      moveCall(t, room.roomId, client, args, seat, 1),
    ]);

    expect(expectOneWinner(results)).toEqual([GameError.staleAction]);
    expect(await typesAfter(t, room.roomId, head)).toEqual(["TOKEN_MOVED", "TURN_ENDED", "TURN_STARTED"]);
    const tokens = (await liveState(t, room.roomId)).tokens.filter((tok) => tok.color === seat);
    expect(tokens.map((tok) => tok.steps).sort()).toEqual([-1, -1, 0, 3]);
    await expectLiveEqualsReplay(t, room.roomId);
  });

  it("the same token twice (double-click): it moves once", async () => {
    const room = await startedRoom(t, { players: 2 });
    const { seat, client } = await twoTokenChoice(t, dice, room);
    const args = await freshArgs(t, room.roomId);
    const head = await headSeq(t, room.roomId);

    const results = await Promise.allSettled([
      moveCall(t, room.roomId, client, args, seat, 0),
      moveCall(t, room.roomId, client, args, seat, 0),
    ]);

    expect(expectOneWinner(results)).toEqual([GameError.staleAction]);
    expect(await typesAfter(t, room.roomId, head)).toEqual(["TOKEN_MOVED", "TURN_ENDED", "TURN_STARTED"]);
    const token0 = (await liveState(t, room.roomId)).tokens.find(
      (tok) => tok.color === seat && tok.index === 0,
    );
    expect(token0?.steps).toBe(3);
    await expectLiveEqualsReplay(t, room.roomId);
  });

  it("a six move granting an extra turn races a second move: still one move", async () => {
    const room = await startedRoom(t, { players: 2 });
    const seat = (await bundle(t, room.roomId)).room.currentTurn;
    const client = seatClient(room, seat);
    let args = await freshArgs(t, room.roomId);
    await rollCall(t, dice, room.roomId, client, args, 6);
    dice.clear();
    args = await freshArgs(t, room.roomId);
    const head = await headSeq(t, room.roomId);

    const results = await Promise.allSettled([
      moveCall(t, room.roomId, client, args, seat, 0),
      moveCall(t, room.roomId, client, args, seat, 1),
    ]);

    const rejected = expectOneWinner(results);
    expect(rejected).toHaveLength(1);
    expect([GameError.staleAction, GameError.rateLimited, GameError.illegalMove]).toContain(rejected[0]);
    expect(await typesAfter(t, room.roomId, head)).toEqual(["TOKEN_MOVED", "EXTRA_TURN_GRANTED"]);
    const out = (await liveState(t, room.roomId)).tokens.filter(
      (tok) => tok.color === seat && tok.steps >= 0,
    );
    expect(out).toHaveLength(1);
    await expectLiveEqualsReplay(t, room.roomId);
  });
});

describe("Race 5: both clients act across a turn change", () => {
  it("the mover ends the turn while the next seat rolls on the old view", async () => {
    const room = await startedRoom(t, { players: 2 });
    const { seat, client } = await twoTokenChoice(t, dice, room);
    const next = Object.keys(room.clients).find((c) => c !== seat) as typeof seat;
    const nextClient = seatClient(room, next);
    const oldView = await freshArgs(t, room.roomId);
    const head = await headSeq(t, room.roomId);

    const results = await Promise.allSettled([
      moveCall(t, room.roomId, client, oldView, seat, 0),
      rollCall(t, dice, room.roomId, nextClient, oldView, 6),
    ]);
    dice.clear();

    expect(results[0]!.status).toBe("fulfilled");
    expect(expectOneWinner(results)).toEqual([GameError.staleAction]);
    expect(await typesAfter(t, room.roomId, head)).toEqual(["TOKEN_MOVED", "TURN_ENDED", "TURN_STARTED"]);
    expect((await bundle(t, room.roomId)).room.currentTurn).toBe(next);

    // The next seat refreshes and rolls; the previous mover's retry is refused.
    const fresh = await freshArgs(t, room.roomId);
    const afterTurn = await headSeq(t, room.roomId);
    const second = await Promise.allSettled([
      moveCall(t, room.roomId, client, oldView, seat, 1),
      rollCall(t, dice, room.roomId, nextClient, fresh, 6),
    ]);
    dice.clear();
    expect(second[1]!.status).toBe("fulfilled");
    expect(expectOneWinner(second)).toEqual([GameError.staleAction]);
    expect(await typesAfter(t, room.roomId, afterTurn)).toEqual(["DICE_ROLLED"]);
    await expectLiveEqualsReplay(t, room.roomId);
  });

  it("in 2v2 the roller and the teammate who may pass race: one action lands", async () => {
    const room = await startedRoom(t, { players: 4, mode: "2v2" });
    const b = await bundle(t, room.roomId);
    const seat = b.room.currentTurn;
    const others = Object.keys(room.clients).filter((c) => c !== seat) as Array<typeof seat>;
    const args = await freshArgs(t, room.roomId);
    const head = await headSeq(t, room.roomId);

    const results = await Promise.allSettled([
      rollCall(t, dice, room.roomId, seatClient(room, seat), args, 6),
      ...others.map((c) => rollCall(t, dice, room.roomId, seatClient(room, c), args, 6)),
    ]);
    dice.clear();

    expect(results[0]!.status).toBe("fulfilled");
    const rejected = expectOneWinner(results);
    for (const msg of rejected) {
      expect([GameError.notYourTurn, GameError.diceAlreadyRolled]).toContain(msg);
    }
    expect(await typesAfter(t, room.roomId, head)).toEqual(["DICE_ROLLED"]);
    await expectLiveEqualsReplay(t, room.roomId);
  });
});
