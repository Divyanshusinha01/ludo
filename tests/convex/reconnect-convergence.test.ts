import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import { GameError } from "../../convex/lib/errors";
import { canonicalGameState, createEmptyState, replayWithTrace, type GameState } from "../../convex/lib/game";
import type { Color } from "../../convex/lib/ludo";
import { mulberry32 } from "../game/fixtures/dice";
import { moveCall, rollCall, type TurnArgs } from "./concurrency/helpers";
import {
  advance,
  bundle,
  bundleView,
  catchUp,
  expectLiveEqualsReplay,
  expectRejectedUnchanged,
  liveState,
  nextAction,
  playActions,
  playToEnd,
  rawRoom,
  rollAs,
  seatClient,
  setupConvex,
  startedRoom,
  stateView,
  storedEvents,
  teardownConvex,
  turnArgs,
  type DiceQueue,
  type RoomId,
  type StartedRoom,
  type T,
} from "./setup";

let t: T;
let dice: DiceQueue;

beforeEach(() => {
  ({ t, dice } = setupConvex());
});

afterEach(() => {
  dice.clear();
  teardownConvex(dice);
});

async function head(roomId: RoomId): Promise<number> {
  return (await rawRoom(t, roomId))!.eventSeq!;
}

/** Keep playing until the seat to act still has to roll, so a stale roll reaches the seq check. */
async function playUntilRollPending(room: StartedRoom, rng: () => number): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const b = await bundle(t, room.roomId);
    if (!b.room.diceRolled) return;
    await playActions(t, dice, room, rng, 1);
  }
  throw new Error("dice never cleared");
}

function rollerClient(room: StartedRoom, b: Awaited<ReturnType<typeof bundle>>): string {
  return seatClient(room, b.room.currentTurn);
}

describe("a tab that missed events", () => {
  it("is refused on its stale view, then converges through a full getRoom resync", async () => {
    const room = await startedRoom(t, { players: 3 });
    const rng = mulberry32(21);
    dice.seedFallback(21);
    const tabSeat = (Object.keys(room.clients) as Color[])[2]!;
    const tabClient = seatClient(room, tabSeat);

    const staleView = await bundle(t, room.roomId, tabClient);
    const staleArgs: TurnArgs = { turnId: staleView.room.turnId, expectedSeq: staleView.room.eventSeq };

    expect(await playActions(t, dice, room, rng, 12)).toBe(12);
    await playUntilRollPending(room, rng);
    expect(await head(room.roomId)).toBeGreaterThan(staleArgs.expectedSeq);

    await advance(t);
    const now = await bundle(t, room.roomId);
    await expectRejectedUnchanged(
      t,
      room.roomId,
      () => rollCall(t, dice, room.roomId, rollerClient(room, now), staleArgs, 6),
      GameError.staleAction,
    );
    dice.clear();

    const resynced = await bundle(t, room.roomId, tabClient);
    expect(resynced.room.eventSeq).toBe(await head(room.roomId));
    expect(bundleView(resynced)).toEqual(stateView(await liveState(t, room.roomId)));
    expect(bundleView(resynced)).not.toEqual(bundleView(staleView));

    await rollCall(t, dice, room.roomId, rollerClient(room, resynced), await turnArgs(t, room.roomId), 6);
    dice.clear();
    await expectLiveEqualsReplay(t, room.roomId);
  });

  it("converges by replaying listEvents(afterSeq) onto its old state, across pages", async () => {
    const room = await startedRoom(t, { players: 2 });
    const rng = mulberry32(5);
    dice.seedFallback(5);
    await playActions(t, dice, room, rng, 6);
    const client = room.host;
    const old = { state: await liveState(t, room.roomId), seenSeq: await head(room.roomId) };

    await playActions(t, dice, room, rng, 30);
    const result = await catchUp(t, room.roomId, client, old, 7);

    const live = await liveState(t, room.roomId);
    expect(result.seenSeq).toBe(await head(room.roomId));
    expect(result.pages).toBeGreaterThan(1);
    expect(canonicalGameState(result.state)).toEqual(canonicalGameState(live));
    expect(stateView(result.state)).toEqual(bundleView(await bundle(t, room.roomId, client)));
    expect(await t.query(internal.gameEvents.verifyReplay, { roomId: room.roomId })).toMatchObject({ ok: true });
  });

  it("converges incrementally across the end of a match and a rematch", async () => {
    const room = await startedRoom(t, { players: 2 });
    dice.seedFallback(9);
    await playActions(t, dice, room, mulberry32(9), 10);
    const old = { state: await liveState(t, room.roomId), seenSeq: await head(room.roomId) };

    await playToEnd(t, dice, room, { seed: 9 });
    await t.mutation(api.rooms.rematch, { roomId: room.roomId, clientId: room.host });
    const seat = (await bundle(t, room.roomId)).room.currentTurn;
    await rollAs(t, dice, room.roomId, seatClient(room, seat), 4);

    const result = await catchUp(t, room.roomId, room.host, old);
    expect(canonicalGameState(result.state)).toEqual(canonicalGameState(await liveState(t, room.roomId)));
    await expectLiveEqualsReplay(t, room.roomId);
  });

  it("converges from every point it could have dropped off", async () => {
    const room = await startedRoom(t, { players: 2 });
    await playToEnd(t, dice, room, { seed: 17 });
    const events = await storedEvents(t, room.roomId);
    const trace = replayWithTrace(createEmptyState(), events);
    expect(trace.error).toBeUndefined();
    const live = canonicalGameState(await liveState(t, room.roomId));

    const stride = Math.max(1, Math.floor(events.length / 12));
    const dropPoints = [...Array.from({ length: 13 }, (_, i) => Math.min(i * stride, events.length)), events.length - 1];
    for (const seen of new Set(dropPoints)) {
      const result = await catchUp(t, room.roomId, room.host, { state: trace.states[seen]!, seenSeq: seen });
      expect(result.fetched).toBe(events.length - seen);
      expect(canonicalGameState(result.state)).toEqual(live);
    }
  });
});

const ALLOWED_REJECTIONS = new Set<string>([
  GameError.staleAction,
  GameError.diceAlreadyRolled,
  GameError.notYourTurn,
  GameError.illegalMove,
  GameError.rollFirst,
  GameError.rateLimited,
]);

type Tab = { seat: Color; client: string; args: TurnArgs; state: GameState; seenSeq: number };
type Call = { tab: string; expectedSeq: number; run: () => Promise<unknown> };

function shuffle<X>(items: X[], rng: () => number): X[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

async function resyncTab(tab: Tab, roomId: RoomId, full: boolean): Promise<void> {
  if (full) {
    const b = await bundle(t, roomId, tab.client);
    tab.args = { turnId: b.room.turnId, expectedSeq: b.room.eventSeq };
    tab.state = await liveState(t, roomId);
    tab.seenSeq = b.room.eventSeq;
    expect(bundleView(b)).toEqual(stateView(tab.state));
  } else {
    const caught = await catchUp(t, roomId, tab.client, tab);
    tab.state = caught.state;
    tab.seenSeq = caught.seenSeq;
    tab.args = { turnId: caught.state.turnNumber, expectedSeq: caught.seenSeq };
  }
  expect(tab.args).toEqual(await turnArgs(t, roomId));
  expect(canonicalGameState(tab.state)).toEqual(canonicalGameState(await liveState(t, roomId)));
}

describe("random interleavings of stale, duplicate and fresh calls from several tabs", () => {
  it.each([1, 2, 3, 4, 5])("seed %i: one call lands per round and every tab converges", async (seed) => {
    const rng = mulberry32(seed);
    dice.seedFallback(seed);
    const room = await startedRoom(t, { players: 3 });
    const start = await liveState(t, room.roomId);
    const startArgs = await turnArgs(t, room.roomId);
    const tabs: Tab[] = (Object.keys(room.clients) as Color[]).flatMap((seat) =>
      [0, 1].map(() => ({
        seat,
        client: seatClient(room, seat),
        args: { ...startArgs },
        state: start,
        seenSeq: startArgs.expectedSeq,
      })),
    );

    for (let round = 0; round < 40; round++) {
      await advance(t);
      const action = await nextAction(t, room, rng);
      if (!action) break;
      const headBefore = await head(room.roomId);
      const fresh = await turnArgs(t, room.roomId);

      const freshRun = () =>
        action.kind === "roll"
          ? rollCall(t, dice, room.roomId, action.client, fresh, action.face)
          : moveCall(t, room.roomId, action.client, fresh, action.tokenColor, action.tokenIndex);
      const calls: Call[] = [{ tab: "fresh", expectedSeq: fresh.expectedSeq, run: freshRun }];
      if (rng() < 0.4) calls.push({ tab: "duplicate", expectedSeq: fresh.expectedSeq, run: freshRun });
      const staleCount = Math.floor(rng() * 3);
      for (let i = 0; i < staleCount; i++) {
        const tab = tabs[Math.floor(rng() * tabs.length)]!;
        const args = { ...tab.args };
        const run =
          rng() < 0.5
            ? () => rollCall(t, dice, room.roomId, tab.client, args, 1 + Math.floor(rng() * 6))
            : () => moveCall(t, room.roomId, tab.client, args, tab.seat, Math.floor(rng() * 4));
        calls.push({ tab: tab.client, expectedSeq: args.expectedSeq, run });
      }

      const ordered = shuffle(calls, rng);
      const results = await Promise.allSettled(ordered.map((c) => c.run()));
      dice.clear();

      const landed = ordered.filter((_, i) => results[i]!.status === "fulfilled");
      expect(landed).toHaveLength(1);
      expect(landed[0]!.expectedSeq).toBe(headBefore);
      for (const r of results) {
        if (r.status === "rejected") {
          expect(ALLOWED_REJECTIONS).toContain((r.reason as Error).message);
        }
      }
      expect(await head(room.roomId)).toBeGreaterThan(headBefore);
      await expectLiveEqualsReplay(t, room.roomId);

      for (const tab of tabs) {
        if (rng() < 0.4) await resyncTab(tab, room.roomId, rng() < 0.5);
      }
    }

    for (const tab of tabs) await resyncTab(tab, room.roomId, false);
    await expectLiveEqualsReplay(t, room.roomId);
  });
});
