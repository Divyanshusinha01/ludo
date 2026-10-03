import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Color } from "../../convex/lib/ludo";
import {
  bundle,
  expectLiveEqualsReplay,
  rawRoom,
  seatClient,
  setClock,
  setupConvex,
  startedRoom,
  storedEvents,
  teardownConvex,
  type DiceQueue,
  type StartedRoom,
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

/** Everyone but `keeper` goes silent for `awayMs`; then the cleanup cron runs. */
async function onlyKeeperStays(room: StartedRoom, keeper: Color, awayMs: number): Promise<void> {
  setClock(Date.now() + awayMs);
  await t.mutation(api.rooms.heartbeat, { roomId: room.roomId, clientId: seatClient(room, keeper) });
  await t.mutation(internal.cleanup.tick, {});
}

describe("underpopulated auto-win in cleanup", () => {
  it("1v1: the silent seat forfeits as abandoned and the connected seat wins", async () => {
    const room = await startedRoom(t, { players: 2 });
    const seat = (await bundle(t, room.roomId)).room.currentTurn;
    const keeper = (Object.keys(room.clients) as Color[]).find((c) => c !== seat)!;
    const seq = (await rawRoom(t, room.roomId))!.eventSeq!;

    await onlyKeeperStays(room, keeper, 100_000);

    const added = (await storedEvents(t, room.roomId)).filter((e) => e.seq > seq);
    expect(added[0]).toMatchObject({
      eventType: "PLAYER_ELIMINATED",
      payload: { color: seat, reason: "abandoned" },
    });
    expect(added.at(-1)?.eventType).toBe("GAME_FINISHED");
    const final = await expectLiveEqualsReplay(t, room.roomId);
    expect(final.phase).toBe("finished");
    expect(final.winner).toBe(keeper);
  });

  it("3 players: every silent seat forfeits through the log", async () => {
    const room = await startedRoom(t, { players: 3 });
    const keeper = (Object.keys(room.clients) as Color[])[0]!;

    await onlyKeeperStays(room, keeper, 100_000);

    const eliminated = (await storedEvents(t, room.roomId)).filter((e) => e.eventType === "PLAYER_ELIMINATED");
    expect(eliminated.map((e) => e.payload)).toEqual(
      expect.arrayContaining(
        (Object.keys(room.clients) as Color[])
          .filter((c) => c !== keeper)
          .map((color) => ({ color, reason: "abandoned" })),
      ),
    );
    expect(eliminated).toHaveLength(2);
    const final = await expectLiveEqualsReplay(t, room.roomId);
    expect(final.phase).toBe("finished");
    expect(final.winner).toBe(keeper);
  });

  it("within the grace period nothing is committed", async () => {
    const room = await startedRoom(t, { players: 2 });
    const keeper = (Object.keys(room.clients) as Color[])[0]!;
    const seq = (await rawRoom(t, room.roomId))!.eventSeq!;

    await onlyKeeperStays(room, keeper, 60_000);

    expect((await rawRoom(t, room.roomId))!.eventSeq).toBe(seq);
    const b = await bundle(t, room.roomId);
    expect(b.room.status).toBe("playing");
    await expectLiveEqualsReplay(t, room.roomId);
  });
});
