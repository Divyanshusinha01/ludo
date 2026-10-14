import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import { BOT_THINK_MS, botClientId } from "../../convex/lib/bot";
import {
  moveControllerColor,
  rollControllerColor,
  type Color,
} from "../../convex/lib/ludo";
import { mulberry32 } from "../game/fixtures/dice";
import {
  advance,
  bundle,
  clientId,
  expectLiveEqualsReplay,
  moveAs,
  rawRoom,
  rollAs,
  seatClient,
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

async function head(roomId: RoomId): Promise<number> {
  return (await rawRoom(t, roomId))!.eventSeq!;
}

async function typesAfter(roomId: RoomId, seq: number): Promise<string[]> {
  return (await storedEvents(t, roomId)).filter((e) => e.seq > seq).map((e) => e.eventType);
}

type VsComputer = { roomId: RoomId; human: string; humanColor: Color };

async function vsComputer(botCount: number): Promise<VsComputer> {
  const human = clientId(1);
  const created = await t.mutation(api.rooms.createVsComputer, { clientId: human, name: "Human", botCount });
  if (!("roomId" in created)) throw new Error("create returned pending");
  return { roomId: created.roomId, human, humanColor: created.color };
}

/** The seat that must act next (roller, or mover once the dice are down). */
async function actingColor(roomId: RoomId): Promise<Color> {
  const b = await bundle(t, roomId);
  const players = b.players.map((p) => ({
    color: p.color,
    team: p.team ?? undefined,
    eliminated: p.eliminated,
    finishRank: p.finishRank,
  }));
  return b.room.diceRolled
    ? moveControllerColor(b.room.currentTurn, players, b.room.mode, b.room.passedRollTo)
    : rollControllerColor(b.room.currentTurn, players, b.room.mode, b.room.passedRollTo);
}

/**
 * Play a vs-computer match: the human acts through the public mutations with
 * seeded choices, bots act only through their scheduled jobs.
 */
async function playVsComputer(
  game: VsComputer,
  seed: number,
  opts: { maxSteps?: number; afterStep?: () => Promise<void> } = {},
): Promise<void> {
  const rng = mulberry32(seed);
  dice.seedFallback(seed + 1);
  for (let step = 0; step < (opts.maxSteps ?? 6000); step++) {
    const b = await bundle(t, game.roomId);
    if (b.room.status !== "playing") return;
    const actor = await actingColor(game.roomId);
    if (actor !== game.humanColor) {
      await advance(t, BOT_THINK_MS);
    } else if (!b.room.diceRolled) {
      await rollAs(t, dice, game.roomId, game.human, 1 + Math.floor(rng() * 6));
    } else {
      const legal = await t.query(api.game.getLegalTokenIndexes, {
        roomId: game.roomId,
        clientId: game.human,
      });
      const pick = legal[Math.floor(rng() * legal.length)]!;
      await moveAs(t, game.roomId, game.human, pick.color, pick.index);
    }
    await opts.afterStep?.();
  }
  if (opts.maxSteps === undefined) throw new Error("vs-computer match did not finish");
}

describe("bots act only through events", () => {
  it("vs one bot: the full match is in the log and replays to the live state", async () => {
    const game = await vsComputer(1);
    expect((await storedEvents(t, game.roomId)).map((e) => e.eventType)).toEqual([
      "GAME_CREATED",
      "PLAYER_JOINED",
      "PLAYER_JOINED",
      "GAME_STARTED",
      "TURN_STARTED",
    ]);
    let checks = 0;
    await playVsComputer(game, 21, {
      afterStep: async () => {
        if (++checks % 10 === 0) await expectLiveEqualsReplay(t, game.roomId);
      },
    });

    const final = await expectLiveEqualsReplay(t, game.roomId);
    expect(final.phase).toBe("finished");
    const events = await storedEvents(t, game.roomId);
    const botColor = final.seats.find((s) => s.isBot)!.color;
    const botRolls = events.filter((e) => e.eventType === "DICE_ROLLED" && e.actor.kind === "seat" && e.actor.color === botColor);
    expect(botRolls.length).toBeGreaterThan(5);
    // Lobby events are caused by the host's createVsComputer call, bot seats included.
    const startSeq = events.find((e) => e.eventType === "GAME_STARTED")!.seq;
    const wrongSession = events.filter((e) => {
      if (e.seq <= startSeq || e.actor.kind !== "seat") return false;
      const expected = e.actor.color === botColor ? botClientId(game.roomId, botColor) : game.human;
      return e.actorClientId !== expected;
    });
    expect(wrongSession.map((e) => ({ seq: e.seq, type: e.eventType, actor: e.actor, by: e.actorClientId }))).toEqual([]);
  });

  it("vs three bots: every step stays replayable", async () => {
    const game = await vsComputer(3);
    let checks = 0;
    await playVsComputer(game, 33, {
      maxSteps: 400,
      afterStep: async () => {
        if (++checks % 20 === 0) await expectLiveEqualsReplay(t, game.roomId);
      },
    });
    const events = await storedEvents(t, game.roomId);
    const botSeats = new Set(
      events.flatMap((e) => (e.actor.kind === "seat" && e.actor.color !== game.humanColor ? [e.actor.color] : [])),
    );
    expect(botSeats.size).toBe(3);
    await expectLiveEqualsReplay(t, game.roomId);
  });

  it("a bot waits BOT_THINK_MS, then plays one action per job", async () => {
    const game = await vsComputer(1);
    dice.seedFallback(5);
    // Hand the turn to the bot: a 3 with every token in the yard has no move.
    await rollAs(t, dice, game.roomId, game.human, 3);
    expect(await actingColor(game.roomId)).not.toBe(game.humanColor);
    const seq = await head(game.roomId);

    await advance(t, BOT_THINK_MS - 50);
    expect(await typesAfter(game.roomId, seq)).toEqual([]);
    await advance(t, 100);
    const added = await typesAfter(game.roomId, seq);
    expect(added[0]).toBe("DICE_ROLLED");
    await expectLiveEqualsReplay(t, game.roomId);
  });

  it("a bot job armed at an older head is a no-op", async () => {
    const game = await vsComputer(1);
    await rollAs(t, dice, game.roomId, game.human, 3);
    const stale = await turnArgs(t, game.roomId);
    await advance(t, BOT_THINK_MS + 50);
    const seq = await head(game.roomId);
    expect(seq).toBeGreaterThan(stale.expectedSeq);
    await t.mutation(internal.game.playBotTurn, {
      roomId: game.roomId,
      turnId: stale.turnId,
      expectedSeq: stale.expectedSeq,
    });
    expect(await head(game.roomId)).toBe(seq);
  });

  it("a bot job on a human's turn is a no-op", async () => {
    const game = await vsComputer(1);
    const args = await turnArgs(t, game.roomId);
    expect(await actingColor(game.roomId)).toBe(game.humanColor);
    await t.mutation(internal.game.playBotTurn, { roomId: game.roomId, ...args });
    expect(await head(game.roomId)).toBe(args.expectedSeq);
  });

  it("clients cannot act for a bot seat", async () => {
    const game = await vsComputer(1);
    await rollAs(t, dice, game.roomId, game.human, 3);
    const botColor = await actingColor(game.roomId);
    const args = await turnArgs(t, game.roomId);
    await expect(
      t.mutation(api.game.rollDice, {
        roomId: game.roomId,
        clientId: botClientId(game.roomId, botColor),
        ...args,
      }),
    ).rejects.toThrow();
    await expect(
      t.mutation(api.game.rollDice, { roomId: game.roomId, clientId: game.human, ...args }),
    ).rejects.toThrow();
    expect(await head(game.roomId)).toBe(args.expectedSeq);
  });
});

describe("forfeit through leaveRoom", () => {
  it("a seat that is not on turn leaves: eliminated, turn untouched, then skipped", async () => {
    const room = await startedRoom(t, { players: 3 });
    const b = await bundle(t, room.roomId);
    const seat = b.room.currentTurn;
    const leaver = (Object.keys(room.clients) as Color[]).find((c) => c !== seat)!;
    const seq = await head(room.roomId);

    await t.mutation(api.rooms.leaveRoom, { roomId: room.roomId, clientId: seatClient(room, leaver) });
    const added = (await storedEvents(t, room.roomId)).filter((e) => e.seq > seq);
    expect(added.map((e) => e.eventType)).toEqual(["PLAYER_ELIMINATED"]);
    expect(added[0]!.payload).toEqual({ color: leaver, reason: "left" });
    const after = await bundle(t, room.roomId);
    expect(after.room.currentTurn).toBe(seat);
    expect(after.room.status).toBe("playing");
    await expectLiveEqualsReplay(t, room.roomId);

    // Several turns later the leaver has never been handed the turn.
    for (let i = 0; i < 6; i++) {
      const cur = (await bundle(t, room.roomId)).room.currentTurn;
      expect(cur).not.toBe(leaver);
      await rollAs(t, dice, room.roomId, seatClient(room, cur), 2);
    }
    await expectLiveEqualsReplay(t, room.roomId);
  });

  it("the seat on turn leaves with the dice down: the turn passes on", async () => {
    const room = await startedRoom(t, { players: 3 });
    const seat = (await bundle(t, room.roomId)).room.currentTurn;
    await rollAs(t, dice, room.roomId, seatClient(room, seat), 6);
    const seq = await head(room.roomId);

    await t.mutation(api.rooms.leaveRoom, { roomId: room.roomId, clientId: seatClient(room, seat) });
    expect(await typesAfter(room.roomId, seq)).toEqual(["PLAYER_ELIMINATED", "TURN_ENDED", "TURN_STARTED"]);
    const after = await bundle(t, room.roomId);
    expect(after.room.currentTurn).not.toBe(seat);
    expect(after.room.diceRolled).toBe(false);
    await expectLiveEqualsReplay(t, room.roomId);
  });

  it("1v1: the leaver forfeits and the other seat wins", async () => {
    const room = await startedRoom(t, { players: 2 });
    const seat = (await bundle(t, room.roomId)).room.currentTurn;
    const other = (Object.keys(room.clients) as Color[]).find((c) => c !== seat)!;
    await t.mutation(api.rooms.leaveRoom, { roomId: room.roomId, clientId: seatClient(room, seat) });

    const final = await expectLiveEqualsReplay(t, room.roomId);
    expect(final.phase).toBe("finished");
    expect(final.winner).toBe(other);
    const events = await storedEvents(t, room.roomId);
    expect(events.at(-1)?.eventType).toBe("GAME_FINISHED");
    expect(events.find((e) => e.eventType === "PLAYER_ELIMINATED")?.payload).toEqual({
      color: seat,
      reason: "left",
    });
  });

  it("2v2: one teammate leaving keeps the match going", async () => {
    const room = await startedRoom(t, { players: 4, mode: "2v2" });
    const seat = (await bundle(t, room.roomId)).room.currentTurn;
    const leaver = (Object.keys(room.clients) as Color[]).find((c) => c !== seat)!;
    await t.mutation(api.rooms.leaveRoom, { roomId: room.roomId, clientId: seatClient(room, leaver) });
    const state = await expectLiveEqualsReplay(t, room.roomId);
    expect(state.phase).toBe("playing");
    expect(state.seats.find((s) => s.color === leaver)?.eliminated).toBe(true);
  });

  it("a leaver on a new device asks to rejoin; host approval reinstates the seat", async () => {
    const room = await startedRoom(t, { players: 3 });
    const seat = (await bundle(t, room.roomId)).room.currentTurn;
    const leaver = (Object.keys(room.clients) as Color[]).find(
      (c) => c !== seat && room.clients[c] !== room.host,
    )!;
    const leaverName = (await bundle(t, room.roomId)).players.find((p) => p.color === leaver)!.name;
    await t.mutation(api.rooms.leaveRoom, { roomId: room.roomId, clientId: seatClient(room, leaver) });

    const device = clientId(99);
    const { requestId } = await t.mutation(api.rooms.joinRoom, { code: room.code, clientId: device, name: leaverName });
    if (!requestId) throw new Error("expected a pending rejoin request");
    const requests = await t.query(api.rooms.listPendingRejoinRequests, { roomId: room.roomId, clientId: room.host });
    expect(requests.map((r) => r.playerColor)).toEqual([leaver]);

    const seq = await head(room.roomId);
    await t.mutation(api.rooms.respondRejoinRequest, { requestId, clientId: room.host, approve: true });
    expect(await typesAfter(room.roomId, seq)).toEqual(["PLAYER_REINSTATED"]);

    const after = await bundle(t, room.roomId, device);
    expect(after.me?.color).toBe(leaver);
    expect(after.players.find((p) => p.color === leaver)?.eliminated).toBe(false);
    expect(after.tokens.filter((tok) => tok.color === leaver).map((tok) => tok.steps)).toEqual([-1, -1, -1, -1]);
    await expectLiveEqualsReplay(t, room.roomId);

    let reached = false;
    for (let i = 0; i < 6 && !reached; i++) {
      const cur = (await bundle(t, room.roomId)).room.currentTurn;
      if (cur === leaver) reached = true;
      else await rollAs(t, dice, room.roomId, seatClient(room, cur), 2);
    }
    expect(reached).toBe(true);
    await expectLiveEqualsReplay(t, room.roomId);
  });

  it("a leaver on the same device must ask again; a denial keeps the seat forfeited", async () => {
    const room = await startedRoom(t, { players: 3 });
    const seat = (await bundle(t, room.roomId)).room.currentTurn;
    const leaver = (Object.keys(room.clients) as Color[]).find(
      (c) => c !== seat && room.clients[c] !== room.host,
    )!;
    const leaverClient = seatClient(room, leaver);
    await t.mutation(api.rooms.leaveRoom, { roomId: room.roomId, clientId: leaverClient });
    expect((await bundle(t, room.roomId, leaverClient)).me).toBeNull();

    const { requestId } = await t.mutation(api.rooms.joinRoom, { code: room.code, clientId: leaverClient, name: "anything" });
    if (!requestId) throw new Error("expected a pending rejoin request");
    await t.mutation(api.rooms.respondRejoinRequest, { requestId, clientId: room.host, approve: false });

    expect(await t.query(api.rooms.getRejoinRequestStatus, { requestId })).toEqual({ status: "denied" });
    const after = await bundle(t, room.roomId, leaverClient);
    expect(after.me).toBeNull();
    expect(after.players.find((p) => p.color === leaver)?.eliminated).toBe(true);
  });

  it("leaving after being eliminated adds no events", async () => {
    const room = await startedRoom(t, { players: 3 });
    const seat = (await bundle(t, room.roomId)).room.currentTurn;
    const leaver = (Object.keys(room.clients) as Color[]).find((c) => c !== seat)!;
    await t.mutation(api.rooms.leaveRoom, { roomId: room.roomId, clientId: seatClient(room, leaver) });
    const seq = await head(room.roomId);
    await t.mutation(api.rooms.leaveRoom, { roomId: room.roomId, clientId: seatClient(room, leaver) });
    expect(await head(room.roomId)).toBe(seq);
    await expectLiveEqualsReplay(t, room.roomId);
  });
});
