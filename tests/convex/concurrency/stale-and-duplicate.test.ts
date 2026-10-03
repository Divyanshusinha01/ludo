import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GameError } from "../../../convex/lib/errors";
import {
  advance,
  bundle,
  expectLiveEqualsReplay,
  expectRejectedUnchanged,
  seatClient,
  setupConvex,
  startedRoom,
  teardownConvex,
  type DiceQueue,
  type T,
} from "../setup";
import { freshArgs, headSeq, moveCall, rollCall, twoTokenChoice, typesAfter } from "./helpers";

let t: T;
let dice: DiceQueue;

beforeEach(() => {
  ({ t, dice } = setupConvex());
});

afterEach(() => {
  dice.clear();
  teardownConvex(dice);
});

describe("Race 3: stale view after another action", () => {
  it("stale expectedSeq within the same turn is refused; a fresh view succeeds", async () => {
    const room = await startedRoom(t, { players: 2 });
    const seat = (await bundle(t, room.roomId)).room.currentTurn;
    const client = seatClient(room, seat);
    const beforeRoll = await freshArgs(t, room.roomId);
    await rollCall(t, dice, room.roomId, client, beforeRoll, 6);
    dice.clear();
    await advance(t);

    // Same turnId, but the log moved on by the roll.
    await expectRejectedUnchanged(
      t,
      room.roomId,
      () => moveCall(t, room.roomId, client, beforeRoll, seat, 0),
      GameError.staleAction,
    );

    const fresh = await freshArgs(t, room.roomId);
    expect(fresh.turnId).toBe(beforeRoll.turnId);
    await moveCall(t, room.roomId, client, fresh, seat, 0);
    await expectLiveEqualsReplay(t, room.roomId);
  });

  it("stale turnId from a tab that missed the turn change is refused", async () => {
    const room = await startedRoom(t, { players: 2 });
    const { seat, client } = await twoTokenChoice(t, dice, room);
    const next = Object.keys(room.clients).find((c) => c !== seat) as typeof seat;
    const nextClient = seatClient(room, next);
    const nextTabView = await freshArgs(t, room.roomId);
    await moveCall(t, room.roomId, client, nextTabView, seat, 0);
    await advance(t);

    await expectRejectedUnchanged(
      t,
      room.roomId,
      () => rollCall(t, dice, room.roomId, nextClient, nextTabView, 6),
      GameError.staleAction,
    );
    dice.clear();

    const fresh = await freshArgs(t, room.roomId);
    await expectRejectedUnchanged(
      t,
      room.roomId,
      () => rollCall(t, dice, room.roomId, nextClient, { ...fresh, expectedSeq: nextTabView.expectedSeq }, 6),
      GameError.staleAction,
    );
    dice.clear();
    await rollCall(t, dice, room.roomId, nextClient, fresh, 6);
    await expectLiveEqualsReplay(t, room.roomId);
  });
});

describe("Race 4: the same request delivered twice", () => {
  it("a duplicated roll with a pending move lands once", async () => {
    const room = await startedRoom(t, { players: 2 });
    const client = seatClient(room, (await bundle(t, room.roomId)).room.currentTurn);
    const args = await freshArgs(t, room.roomId);
    const head = await headSeq(t, room.roomId);
    await rollCall(t, dice, room.roomId, client, args, 6);
    dice.clear();
    await advance(t);
    await expectRejectedUnchanged(
      t,
      room.roomId,
      () => rollCall(t, dice, room.roomId, client, args, 6),
      GameError.diceAlreadyRolled,
    );
    expect(await typesAfter(t, room.roomId, head)).toEqual(["DICE_ROLLED"]);
    await expectLiveEqualsReplay(t, room.roomId);
  });

  it("a duplicated roll that ended the turn lands once", async () => {
    const room = await startedRoom(t, { players: 2 });
    const client = seatClient(room, (await bundle(t, room.roomId)).room.currentTurn);
    const args = await freshArgs(t, room.roomId);
    const head = await headSeq(t, room.roomId);
    await rollCall(t, dice, room.roomId, client, args, 2);
    dice.clear();
    await advance(t);
    await expectRejectedUnchanged(
      t,
      room.roomId,
      () => rollCall(t, dice, room.roomId, client, args, 2),
      GameError.staleAction,
    );
    expect(await typesAfter(t, room.roomId, head)).toEqual(["DICE_ROLLED", "TURN_ENDED", "TURN_STARTED"]);
    await expectLiveEqualsReplay(t, room.roomId);
  });

  it("a duplicated move lands once", async () => {
    const room = await startedRoom(t, { players: 2 });
    const { seat, client } = await twoTokenChoice(t, dice, room);
    const args = await freshArgs(t, room.roomId);
    const head = await headSeq(t, room.roomId);
    await moveCall(t, room.roomId, client, args, seat, 1);
    await advance(t);
    await expectRejectedUnchanged(
      t,
      room.roomId,
      () => moveCall(t, room.roomId, client, args, seat, 1),
      GameError.staleAction,
    );
    expect(await typesAfter(t, room.roomId, head)).toEqual(["TOKEN_MOVED", "TURN_ENDED", "TURN_STARTED"]);
    await expectLiveEqualsReplay(t, room.roomId);
  });

  it("a duplicated six move (extra turn, same turnId) lands once", async () => {
    const room = await startedRoom(t, { players: 2 });
    const seat = (await bundle(t, room.roomId)).room.currentTurn;
    const client = seatClient(room, seat);
    await rollCall(t, dice, room.roomId, client, await freshArgs(t, room.roomId), 6);
    dice.clear();
    const args = await freshArgs(t, room.roomId);
    const head = await headSeq(t, room.roomId);
    await moveCall(t, room.roomId, client, args, seat, 0);
    await advance(t);
    // The dice are cleared, so the rules refuse it before the seq check does.
    await expectRejectedUnchanged(
      t,
      room.roomId,
      () => moveCall(t, room.roomId, client, args, seat, 0),
      eitherMessage(GameError.illegalMove, GameError.staleAction),
    );
    expect(await typesAfter(t, room.roomId, head)).toEqual(["TOKEN_MOVED", "EXTRA_TURN_GRANTED"]);
    await expectLiveEqualsReplay(t, room.roomId);
  });

  it("a duplicated six move delivered after the extra roll does not move again", async () => {
    const room = await startedRoom(t, { players: 2 });
    const seat = (await bundle(t, room.roomId)).room.currentTurn;
    const client = seatClient(room, seat);
    await rollCall(t, dice, room.roomId, client, await freshArgs(t, room.roomId), 6);
    dice.clear();
    const moveArgs = await freshArgs(t, room.roomId);
    await moveCall(t, room.roomId, client, moveArgs, seat, 0);
    await rollCall(t, dice, room.roomId, client, await freshArgs(t, room.roomId), 6);
    dice.clear();
    const head = await headSeq(t, room.roomId);
    await advance(t);

    // Token 0 could legally move 6 again, so only the seq check stops the replay.
    await expectRejectedUnchanged(
      t,
      room.roomId,
      () => moveCall(t, room.roomId, client, moveArgs, seat, 0),
      GameError.staleAction,
    );
    expect(await headSeq(t, room.roomId)).toBe(head);
    await expectLiveEqualsReplay(t, room.roomId);
  });
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function eitherMessage(...messages: string[]): RegExp {
  return new RegExp(messages.map(escape).join("|"));
}
