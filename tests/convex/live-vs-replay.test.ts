import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../../convex/_generated/api";
import {
  bundle,
  expectLiveEqualsReplay,
  listAllEvents,
  playToEnd,
  rawRoom,
  rollAs,
  setupConvex,
  startedRoom,
  storedEvents,
  teardownConvex,
  type DiceQueue,
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

describe("live projection equals event replay", () => {
  it("lobby: create + joins + start", async () => {
    const room = await startedRoom(t, { players: 3 });
    const types = (await storedEvents(t, room.roomId)).map((e) => e.eventType);
    expect(types).toEqual([
      "GAME_CREATED",
      "PLAYER_JOINED",
      "PLAYER_JOINED",
      "PLAYER_JOINED",
      "GAME_STARTED",
      "TURN_STARTED",
    ]);
    await expectLiveEqualsReplay(t, room.roomId);
  });

  it("1v1: after every action and at the end of a full match", async () => {
    const room = await startedRoom(t, { players: 2 });
    const actions = await playToEnd(t, dice, room, {
      seed: 11,
      afterAction: async () => {
        await expectLiveEqualsReplay(t, room.roomId);
      },
    });
    expect(actions).toBeGreaterThan(20);
    const final = await expectLiveEqualsReplay(t, room.roomId);
    expect(final.phase).toBe("finished");
    expect(final.winner).not.toBeNull();
  });

  it.each([
    ["3 players", 3, "1v1", 7],
    ["4 players", 4, "1v1", 8],
    ["2v2", 4, "2v2", 9],
  ] as const)("%s: full match", async (_label, players, mode, seed) => {
    const room = await startedRoom(t, { players, mode });
    await playToEnd(t, dice, room, { seed });
    const final = await expectLiveEqualsReplay(t, room.roomId);
    expect(final.phase).toBe("finished");
    if (mode === "2v2") expect(final.winningTeam).not.toBeNull();
  });

  it("rematch starts a fresh match on the same log", async () => {
    const room = await startedRoom(t, { players: 2 });
    await playToEnd(t, dice, room, { seed: 3 });
    const before = (await storedEvents(t, room.roomId)).length;
    await t.mutation(api.rooms.rematch, { roomId: room.roomId, clientId: room.host });
    const events = await storedEvents(t, room.roomId);
    expect(events.slice(before).map((e) => e.eventType)).toEqual(["GAME_STARTED", "TURN_STARTED"]);
    const state = await expectLiveEqualsReplay(t, room.roomId);
    expect(state.phase).toBe("playing");
    expect(state.tokens.every((tok) => tok.steps === -1)).toBe(true);
    const b = await bundle(t, room.roomId);
    await rollAs(t, dice, room.roomId, room.clients[b.room.currentTurn]!, 6);
    await expectLiveEqualsReplay(t, room.roomId);
  });

  it("listEvents pages past 200 events and returns the whole log in order", async () => {
    const room = await startedRoom(t, { players: 4 });
    await playToEnd(t, dice, room, { seed: 8 });
    const stored = await storedEvents(t, room.roomId);
    expect(stored.length).toBeGreaterThan(200);
    const { events, pages } = await listAllEvents(t, room.roomId, room.host);
    expect(pages).toBeGreaterThan(1);
    expect(events.map((e) => e.seq)).toEqual(stored.map((e) => e.seq));
    expect(events.every((e) => !("actorClientId" in e))).toBe(true);
    expect((await rawRoom(t, room.roomId))?.eventSeq).toBe(events.length);
  });
});
