import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../../../convex/_generated/api";
import type { Color } from "../../../convex/lib/ludo";
import { HEARTBEAT_MIN_INTERVAL_MS } from "../../../convex/lib/session";
import { mulberry32 } from "../../game/fixtures/dice";
import {
  advance,
  expectLiveEqualsReplay,
  nextAction,
  rawRoom,
  seatClient,
  setClock,
  setupConvex,
  snapshot,
  startedRoom,
  storedEvents,
  teardownConvex,
  turnArgs,
  type DiceQueue,
  type RoomId,
  type StartedRoom,
  type T,
} from "../setup";
import { moveCall, rollCall } from "./helpers";

let t: T;
let dice: DiceQueue;

beforeEach(() => {
  ({ t, dice } = setupConvex());
});

afterEach(() => {
  dice.clear();
  teardownConvex(dice);
});

const GAMEPLAY_EVENTS = new Set([
  "DICE_ROLLED",
  "TOKEN_MOVED",
  "TOKEN_CAPTURED",
  "EXTRA_TURN_GRANTED",
  "TURN_ENDED",
  "TURN_STARTED",
  "PLAYER_FINISHED",
  "GAME_FINISHED",
]);

async function presence(roomId: RoomId) {
  const rows = await t.run(async (ctx) =>
    await ctx.db
      .query("players")
      .withIndex("by_room", (q) => q.eq("roomId", roomId))
      .collect(),
  );
  return Object.fromEntries(rows.map((p) => [p.color, { connected: p.connected, lastSeenAt: p.lastSeenAt }])) as Record<
    Color,
    { connected: boolean; lastSeenAt: number }
  >;
}

function heartbeat(room: StartedRoom, seat: Color) {
  return t.mutation(api.rooms.heartbeat, { roomId: room.roomId, clientId: seatClient(room, seat) });
}

function disconnect(room: StartedRoom, seat: Color) {
  return t.mutation(api.rooms.markDisconnected, { roomId: room.roomId, clientId: seatClient(room, seat) });
}

function seats(room: StartedRoom): Color[] {
  return Object.keys(room.clients) as Color[];
}

describe("reconnect storm: presence calls interleaved with gameplay", () => {
  it("a pure presence storm writes no game events and leaves the room untouched", async () => {
    const room = await startedRoom(t, { players: 4 });
    const before = await snapshot(t, room.roomId);

    const calls = seats(room).flatMap((seat) => [
      disconnect(room, seat),
      heartbeat(room, seat),
      disconnect(room, seat),
      heartbeat(room, seat),
    ]);
    const results = await Promise.allSettled(calls);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    expect(await snapshot(t, room.roomId)).toEqual(before);
  });

  it.each([1, 2, 3])("seed %i: gameplay lands every round and only gameplay events are logged", async (seed) => {
    const rng = mulberry32(seed);
    dice.seedFallback(seed);
    const room = await startedRoom(t, { players: 3 });
    const startSeq = (await rawRoom(t, room.roomId))!.eventSeq!;

    for (let round = 0; round < 30; round++) {
      await advance(t);
      const action = await nextAction(t, room, rng);
      if (!action) break;
      const args = await turnArgs(t, room.roomId);
      const play = () =>
        action.kind === "roll"
          ? rollCall(t, dice, room.roomId, action.client, args, action.face)
          : moveCall(t, room.roomId, action.client, args, action.tokenColor, action.tokenIndex);

      const storm: Array<() => Promise<unknown>> = [];
      for (const seat of seats(room)) {
        const n = 1 + Math.floor(rng() * 4);
        for (let i = 0; i < n; i++) storm.push(() => (rng() < 0.5 ? disconnect(room, seat) : heartbeat(room, seat)));
      }
      const at = Math.floor(rng() * (storm.length + 1));
      storm.splice(at, 0, play);

      const results = await Promise.allSettled(storm.map((call) => call()));
      dice.clear();
      expect(results.filter((r) => r.status === "rejected")).toEqual([]);
      expect((await rawRoom(t, room.roomId))!.eventSeq).toBeGreaterThan(args.expectedSeq);
    }

    const added = (await storedEvents(t, room.roomId)).filter((e) => e.seq > startSeq);
    expect(added.length).toBeGreaterThan(0);
    for (const e of added) expect(GAMEPLAY_EVENTS).toContain(e.eventType);
    await expectLiveEqualsReplay(t, room.roomId);
  });

  it("a disconnected seat can still act, and its actions do not change presence", async () => {
    const room = await startedRoom(t, { players: 2 });
    const roller = (await t.query(api.rooms.getRoom, { roomId: room.roomId }))!.room.currentTurn;
    await disconnect(room, roller);
    await advance(t);
    const args = await turnArgs(t, room.roomId);
    await rollCall(t, dice, room.roomId, seatClient(room, roller), args, 6);
    dice.clear();
    expect((await presence(room.roomId))[roller].connected).toBe(false);
    await expectLiveEqualsReplay(t, room.roomId);
  });
});

describe("presence ends up correct after the storm", () => {
  it("disconnect plus heartbeats inside the soft window: the seat stays away, in any order", async () => {
    const room = await startedRoom(t, { players: 2 });
    const [a, b] = seats(room) as [Color, Color];
    await Promise.allSettled([heartbeat(room, a), disconnect(room, a), heartbeat(room, a)]);
    await Promise.allSettled([disconnect(room, b), heartbeat(room, b), heartbeat(room, b)]);
    const p = await presence(room.roomId);
    expect(p[a].connected).toBe(false);
    expect(p[b].connected).toBe(false);
  });

  it("a heartbeat flood after the soft window reconnects the seat with a single lastSeenAt", async () => {
    const room = await startedRoom(t, { players: 3 });
    const all = seats(room);
    await Promise.all(all.map((seat) => disconnect(room, seat)));
    const disconnectedAt = Date.now();

    setClock(disconnectedAt + HEARTBEAT_MIN_INTERVAL_MS);
    const reconnectedAt = Date.now();
    const [back, ...away] = all as [Color, ...Color[]];
    await Promise.all(Array.from({ length: 10 }, () => heartbeat(room, back)));

    const p = await presence(room.roomId);
    expect(p[back]).toEqual({ connected: true, lastSeenAt: reconnectedAt });
    for (const seat of away) expect(p[seat].connected).toBe(false);
  });

  it("the heartbeat soft rate limit holds: floods inside the window do not move lastSeenAt", async () => {
    const room = await startedRoom(t, { players: 2 });
    const seat = seats(room)[0]!;
    const before = (await presence(room.roomId))[seat].lastSeenAt;

    setClock(before + HEARTBEAT_MIN_INTERVAL_MS - 1);
    await Promise.all(Array.from({ length: 20 }, () => heartbeat(room, seat)));
    expect((await presence(room.roomId))[seat].lastSeenAt).toBe(before);

    setClock(before + HEARTBEAT_MIN_INTERVAL_MS);
    await Promise.all(Array.from({ length: 20 }, () => heartbeat(room, seat)));
    expect((await presence(room.roomId))[seat].lastSeenAt).toBe(before + HEARTBEAT_MIN_INTERVAL_MS);
  });

  it("joinRoom reconnects during a storm without adding events", async () => {
    const room = await startedRoom(t, { players: 2 });
    const seat = seats(room).find((c) => seatClient(room, c) !== room.host)!;
    const client = seatClient(room, seat);
    const seqBefore = (await rawRoom(t, room.roomId))!.eventSeq;
    const eventsBefore = await storedEvents(t, room.roomId);

    const [, , joined] = await Promise.all([
      disconnect(room, seat),
      heartbeat(room, seat),
      t.mutation(api.rooms.joinRoom, { code: room.code, clientId: client, name: "P2" }),
    ]);

    expect(joined).toMatchObject({ roomId: room.roomId, color: seat, reconnected: true });
    expect((await rawRoom(t, room.roomId))!.eventSeq).toBe(seqBefore);
    expect(await storedEvents(t, room.roomId)).toEqual(eventsBefore);
  });
});
