import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import { GameError } from "../../convex/lib/errors";
import { MAX_TIMEOUT_LIVES, teamTeammateColor, TURN_TIMEOUT_MS } from "../../convex/lib/ludo";
import {
  advance,
  bundle,
  expectLiveEqualsReplay,
  expectRejectedUnchanged,
  moveAs,
  pendingJobs,
  rawRoom,
  rollAs,
  seatClient,
  setClock,
  setupConvex,
  startedRoom,
  storedEvents,
  teardownConvex,
  turnArgs,
  type DiceQueue,
  type RoomId,
  type T,
} from "./setup";

let t: T;
let dice: DiceQueue;

beforeEach(() => {
  ({ t, dice } = setupConvex());
});

afterEach(() => {
  teardownConvex(dice);
});

async function typesAfter(roomId: RoomId, seq: number): Promise<string[]> {
  return (await storedEvents(t, roomId)).filter((e) => e.seq > seq).map((e) => e.eventType);
}

async function head(roomId: RoomId): Promise<number> {
  return (await rawRoom(t, roomId))!.eventSeq!;
}

/**
 * Stop the clock just past the turn deadline without running the timeout job:
 * timers run to 5ms short of it, then only the wall clock steps over.
 */
async function justPastDeadline(roomId: RoomId): Promise<void> {
  const deadline = (await rawRoom(t, roomId))!.turnStartedAt! + TURN_TIMEOUT_MS;
  await advance(t, deadline - Date.now() - 5);
  setClock(deadline + 1);
}

/** The single live timeout job must be armed at the current head and deadline. */
async function expectTimeoutArmedAtHead(roomId: RoomId): Promise<void> {
  const room = (await rawRoom(t, roomId))!;
  const live = (await pendingJobs(t, roomId)).filter(
    (j) => j.name.includes("handleTurnTimeout") && j.args.expectedSeq === room.eventSeq,
  );
  expect(live).toHaveLength(1);
  expect(live[0]!.scheduledTime).toBe(room.turnStartedAt! + TURN_TIMEOUT_MS);
  expect(live[0]!.args.turnId).toBe(room.turnId);
}

describe("turn timeouts", () => {
  it("an idle turn times out through the scheduled job", async () => {
    const room = await startedRoom(t, { players: 2 });
    const seat = (await bundle(t, room.roomId)).room.currentTurn;
    const seq = await head(room.roomId);
    await expectTimeoutArmedAtHead(room.roomId);

    await advance(t, TURN_TIMEOUT_MS - 1_000);
    expect(await typesAfter(room.roomId, seq)).toEqual([]);

    await advance(t, 1_100);
    expect(await typesAfter(room.roomId, seq)).toEqual(["TURN_TIMED_OUT", "TURN_ENDED", "TURN_STARTED"]);
    const b = await bundle(t, room.roomId);
    expect(b.room.currentTurn).not.toBe(seat);
    expect(b.players.find((p) => p.color === seat)?.lives).toBe(MAX_TIMEOUT_LIVES - 1);
    await expectTimeoutArmedAtHead(room.roomId);
    await expectLiveEqualsReplay(t, room.roomId);
  });

  it("running out of lives eliminates the seat and ends a 1v1 match", async () => {
    const room = await startedRoom(t, { players: 2 });
    const first = (await bundle(t, room.roomId)).room.currentTurn;
    for (let i = 0; i < MAX_TIMEOUT_LIVES * 2 - 1; i++) {
      await advance(t, TURN_TIMEOUT_MS + 10);
    }
    const events = await storedEvents(t, room.roomId);
    expect(events.filter((e) => e.eventType === "TURN_TIMED_OUT")).toHaveLength(MAX_TIMEOUT_LIVES * 2 - 1);
    const eliminated = events.find((e) => e.eventType === "PLAYER_ELIMINATED");
    expect(eliminated?.payload).toEqual({ color: first, reason: "timeout" });
    expect(events.at(-1)?.eventType).toBe("GAME_FINISHED");

    const final = await expectLiveEqualsReplay(t, room.roomId);
    expect(final.phase).toBe("finished");
    expect(final.winner).not.toBe(first);

    // A finished match arms nothing new and later timers change nothing.
    const seq = await head(room.roomId);
    await advance(t, TURN_TIMEOUT_MS * 3);
    expect(await typesAfter(room.roomId, seq)).toEqual([]);
  });

  it("the clock restarts every turn, so a long match has no spurious timeouts", async () => {
    const room = await startedRoom(t, { players: 2 });
    const start = Date.now();
    for (let turn = 0; turn < 5; turn++) {
      await advance(t, TURN_TIMEOUT_MS - 15_000);
      const b = await bundle(t, room.roomId);
      const result = await rollAs(t, dice, room.roomId, seatClient(room, b.room.currentTurn), 3);
      expect(result.turnExpired).toBeUndefined();
      await expectTimeoutArmedAtHead(room.roomId);
    }
    expect(Date.now() - start).toBeGreaterThan(TURN_TIMEOUT_MS * 3);
    const types = (await storedEvents(t, room.roomId)).map((e) => e.eventType);
    expect(types).not.toContain("TURN_TIMED_OUT");
    await expectLiveEqualsReplay(t, room.roomId);
  });

  it("an extra turn restarts the clock and re-arms the timeout", async () => {
    const room = await startedRoom(t, { players: 2 });
    const seat = (await bundle(t, room.roomId)).room.currentTurn;
    const client = seatClient(room, seat);
    await advance(t, 20_000);
    await rollAs(t, dice, room.roomId, client, 6);
    await advance(t, 30_000);
    await moveAs(t, room.roomId, client, seat, 0);
    expect((await storedEvents(t, room.roomId)).at(-1)?.eventType).toBe("EXTRA_TURN_GRANTED");
    expect((await rawRoom(t, room.roomId))!.turnStartedAt).toBe(Date.now());
    await expectTimeoutArmedAtHead(room.roomId);

    // 90s into the turn but only 40s into the extra roll: not expired.
    await advance(t, 40_000);
    const result = await rollAs(t, dice, room.roomId, client, 3);
    expect(result.turnExpired).toBeUndefined();
    await expectLiveEqualsReplay(t, room.roomId);
  });

  it("an extra turn left idle times out through the re-armed job", async () => {
    const room = await startedRoom(t, { players: 2 });
    const seat = (await bundle(t, room.roomId)).room.currentTurn;
    const client = seatClient(room, seat);
    await rollAs(t, dice, room.roomId, client, 6);
    await moveAs(t, room.roomId, client, seat, 0);
    const seq = await head(room.roomId);
    await advance(t, TURN_TIMEOUT_MS + 10);
    expect(await typesAfter(room.roomId, seq)).toEqual(["TURN_TIMED_OUT", "TURN_ENDED", "TURN_STARTED"]);
    await expectLiveEqualsReplay(t, room.roomId);
  });

  it("a 2v2 roll pass restarts the clock for the teammate and re-arms the timeout", async () => {
    const room = await startedRoom(t, { players: 4, mode: "2v2" });
    const seat = (await bundle(t, room.roomId)).room.currentTurn;
    const mate = teamTeammateColor(seat);
    await advance(t, 20_000);
    await rollAs(t, dice, room.roomId, seatClient(room, seat), 6);
    await advance(t, 20_000);
    await t.mutation(api.game.passTurn, {
      roomId: room.roomId,
      clientId: seatClient(room, seat),
      targetColor: mate,
      ...(await turnArgs(t, room.roomId)),
    });
    expect((await storedEvents(t, room.roomId)).at(-1)?.eventType).toBe("ROLL_PASSED");
    expect((await rawRoom(t, room.roomId))!.turnStartedAt).toBe(Date.now());
    await expectTimeoutArmedAtHead(room.roomId);

    // 80s into the turn but only 40s into the pass: the teammate may still move.
    await advance(t, 40_000);
    await moveAs(t, room.roomId, seatClient(room, mate), mate, 0);
    await expectLiveEqualsReplay(t, room.roomId);
  });

  it("a passed roll left idle times out through the re-armed job", async () => {
    const room = await startedRoom(t, { players: 4, mode: "2v2" });
    const seat = (await bundle(t, room.roomId)).room.currentTurn;
    await rollAs(t, dice, room.roomId, seatClient(room, seat), 6);
    await advance(t, 30_000);
    await t.mutation(api.game.passTurn, {
      roomId: room.roomId,
      clientId: seatClient(room, seat),
      targetColor: teamTeammateColor(seat),
      ...(await turnArgs(t, room.roomId)),
    });
    const seq = await head(room.roomId);
    await advance(t, TURN_TIMEOUT_MS - 1_000);
    expect(await typesAfter(room.roomId, seq)).toEqual([]);
    await advance(t, 1_100);
    expect(await typesAfter(room.roomId, seq)).toEqual(["TURN_TIMED_OUT", "TURN_ENDED", "TURN_STARTED"]);
    await expectLiveEqualsReplay(t, room.roomId);
  });

  it("a roll that leaves a move pending keeps the turn's deadline", async () => {
    const room = await startedRoom(t, { players: 2 });
    const seat = (await bundle(t, room.roomId)).room.currentTurn;
    const startedAt = (await rawRoom(t, room.roomId))!.turnStartedAt!;
    await advance(t, 40_000);
    await rollAs(t, dice, room.roomId, seatClient(room, seat), 6);
    expect((await rawRoom(t, room.roomId))!.turnStartedAt).toBe(startedAt);
    await expectTimeoutArmedAtHead(room.roomId);

    const seq = await head(room.roomId);
    await advance(t, 25_000);
    expect(await typesAfter(room.roomId, seq)).toEqual(["TURN_TIMED_OUT", "TURN_ENDED", "TURN_STARTED"]);
    await expectLiveEqualsReplay(t, room.roomId);
  });

  it("a roll after the deadline but before the job runs commits the timeout instead", async () => {
    const room = await startedRoom(t, { players: 2 });
    const seat = (await bundle(t, room.roomId)).room.currentTurn;
    const seq = await head(room.roomId);
    await justPastDeadline(room.roomId);
    expect(await head(room.roomId)).toBe(seq);
    const args = await turnArgs(t, room.roomId);
    dice.push(6);
    const result = await t.mutation(api.game.rollDice, {
      roomId: room.roomId,
      clientId: seatClient(room, seat),
      ...args,
    });
    dice.clear();
    expect(result).toMatchObject({ skipped: true, turnExpired: true });
    expect(await typesAfter(room.roomId, seq)).toEqual(["TURN_TIMED_OUT", "TURN_ENDED", "TURN_STARTED"]);

    // The job armed at the old head fires later and does nothing.
    const afterExpiry = await head(room.roomId);
    await advance(t, 10);
    expect(await head(room.roomId)).toBe(afterExpiry);
    await expectLiveEqualsReplay(t, room.roomId);
  });

  it("a move after the deadline is refused and the job then expires the turn", async () => {
    const room = await startedRoom(t, { players: 2 });
    const seat = (await bundle(t, room.roomId)).room.currentTurn;
    const client = seatClient(room, seat);
    await rollAs(t, dice, room.roomId, client, 6);
    await justPastDeadline(room.roomId);
    const args = await turnArgs(t, room.roomId);
    await expectRejectedUnchanged(
      t,
      room.roomId,
      () =>
        t.mutation(api.game.moveToken, {
          roomId: room.roomId,
          clientId: client,
          tokenColor: seat,
          tokenIndex: 0,
          ...args,
        }),
      GameError.turnExpired,
    );
    const seq = await head(room.roomId);
    await advance(t, 10);
    expect(await typesAfter(room.roomId, seq)).toEqual(["TURN_TIMED_OUT", "TURN_ENDED", "TURN_STARTED"]);
    await expectLiveEqualsReplay(t, room.roomId);
  });

  it("a timeout job armed at an older head is a no-op", async () => {
    const room = await startedRoom(t, { players: 2 });
    const seat = (await bundle(t, room.roomId)).room.currentTurn;
    const stale = await turnArgs(t, room.roomId);
    await rollAs(t, dice, room.roomId, seatClient(room, seat), 6);
    setClock(Date.now() + TURN_TIMEOUT_MS * 2);
    const seq = await head(room.roomId);
    await t.mutation(internal.game.handleTurnTimeout, {
      roomId: room.roomId,
      turnId: stale.turnId,
      expectedSeq: stale.expectedSeq,
    });
    expect(await head(room.roomId)).toBe(seq);
    await expectLiveEqualsReplay(t, room.roomId);
  });

  it("a timeout job before the deadline is a no-op", async () => {
    const room = await startedRoom(t, { players: 2 });
    const args = await turnArgs(t, room.roomId);
    const seq = await head(room.roomId);
    await t.mutation(internal.game.handleTurnTimeout, {
      roomId: room.roomId,
      turnId: args.turnId,
      expectedSeq: args.expectedSeq,
    });
    expect(await head(room.roomId)).toBe(seq);
  });

  it("a rematch re-arms the clock for the new match", async () => {
    const room = await startedRoom(t, { players: 2 });
    for (let i = 0; i < MAX_TIMEOUT_LIVES * 2 - 1; i++) {
      await advance(t, TURN_TIMEOUT_MS + 10);
    }
    expect((await rawRoom(t, room.roomId))!.status).toBe("finished");
    await advance(t, 5_000);
    await t.mutation(api.rooms.rematch, { roomId: room.roomId, clientId: room.host });
    expect((await rawRoom(t, room.roomId))!.turnStartedAt).toBe(Date.now());
    await expectTimeoutArmedAtHead(room.roomId);

    await advance(t, 30_000);
    const b = await bundle(t, room.roomId);
    const result = await rollAs(t, dice, room.roomId, seatClient(room, b.room.currentTurn), 3);
    expect(result.turnExpired).toBeUndefined();
    await expectLiveEqualsReplay(t, room.roomId);
  });
});
