import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../../convex/_generated/api";
import { GameError } from "../../convex/lib/errors";
import { TURN_TIMEOUT_MS, type Color } from "../../convex/lib/ludo";
import {
  advance,
  bundle,
  expectLiveEqualsReplay,
  expectRejectedUnchanged,
  moveAs,
  rawRoom,
  rollAs,
  seatClient,
  setupConvex,
  startedRoom,
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
  teardownConvex(dice);
});

function rollCall(roomId: RoomId, client: string, face = 6) {
  return async () => {
    const args = await turnArgs(t, roomId);
    dice.clear();
    dice.push(face);
    return await t.mutation(api.game.rollDice, { roomId, clientId: client, ...args });
  };
}

function moveCall(roomId: RoomId, client: string, tokenIndex: number, tokenColor?: Color) {
  return async () => {
    const args = await turnArgs(t, roomId);
    return await t.mutation(api.game.moveToken, {
      roomId,
      clientId: client,
      tokenIndex,
      ...(tokenColor ? { tokenColor } : {}),
      ...args,
    });
  };
}

async function seats(room: StartedRoom) {
  const current = (await bundle(t, room.roomId)).room.currentTurn as Color;
  const other = (Object.keys(room.clients) as Color[]).find((c) => c !== current)!;
  return { current, other, client: seatClient(room, current), otherClient: seatClient(room, other) };
}

describe("server-side move validation through the public mutations", () => {
  it("rolling or moving outside a live match is rejected", async () => {
    const lobby = await startedRoom(t, { players: 2, start: false });
    await expectRejectedUnchanged(t, lobby.roomId, rollCall(lobby.roomId, lobby.host), GameError.gameNotPlaying);
    await expectRejectedUnchanged(t, lobby.roomId, moveCall(lobby.roomId, lobby.host, 0), GameError.gameNotPlaying);

    const room = await startedRoom(t, { players: 3, clientBase: 10 });
    await t.mutation(api.rooms.leaveRoom, { roomId: room.roomId, clientId: room.clients.yellow! });
    await t.mutation(api.rooms.leaveRoom, { roomId: room.roomId, clientId: room.clients.green! });
    expect((await rawRoom(t, room.roomId))?.status).toBe("finished");
    await advance(t);
    await expectRejectedUnchanged(t, room.roomId, rollCall(room.roomId, room.host), GameError.gameNotPlaying);
    await expectRejectedUnchanged(t, room.roomId, moveCall(room.roomId, room.host, 0), GameError.gameNotPlaying);
  });

  it("moving before rolling is rejected", async () => {
    const room = await startedRoom(t, { players: 2 });
    const { client } = await seats(room);
    await advance(t);
    await expectRejectedUnchanged(t, room.roomId, moveCall(room.roomId, client, 0), GameError.illegalMove);
  });

  it("rolling twice in one turn is rejected", async () => {
    const room = await startedRoom(t, { players: 2 });
    const { client } = await seats(room);
    await rollAs(t, dice, room.roomId, client, 6);
    expect((await bundle(t, room.roomId)).room.diceRolled).toBe(true);
    await advance(t);
    await expectRejectedUnchanged(t, room.roomId, rollCall(room.roomId, client), GameError.diceAlreadyRolled);
  });

  it("only the seat whose turn it is may move after the roll", async () => {
    const room = await startedRoom(t, { players: 2 });
    const { client, otherClient, other } = await seats(room);
    await rollAs(t, dice, room.roomId, client, 6);
    await advance(t);
    await expectRejectedUnchanged(t, room.roomId, moveCall(room.roomId, otherClient, 0), GameError.notYourTurn);
    await expectRejectedUnchanged(t, room.roomId, moveCall(room.roomId, otherClient, 0, other), GameError.notYourTurn);
  });

  it("an opponent's token, or a token that does not exist, cannot be moved", async () => {
    const room = await startedRoom(t, { players: 2 });
    const { client, other } = await seats(room);
    await rollAs(t, dice, room.roomId, client, 6);
    await advance(t);
    for (const call of [
      moveCall(room.roomId, client, 0, other),
      moveCall(room.roomId, client, 4),
      moveCall(room.roomId, client, -1),
      moveCall(room.roomId, client, 1.5),
    ]) {
      await expectRejectedUnchanged(t, room.roomId, call, GameError.illegalMove);
    }
  });

  it("a yard token cannot leave without a six", async () => {
    const room = await startedRoom(t, { players: 2 });
    const { current, client } = await seats(room);
    await rollAs(t, dice, room.roomId, client, 6);
    await moveAs(t, room.roomId, client, current, 0);
    await rollAs(t, dice, room.roomId, client, 6);
    await moveAs(t, room.roomId, client, current, 1);
    await rollAs(t, dice, room.roomId, client, 3);

    const b = await bundle(t, room.roomId);
    expect(b.room.currentTurn).toBe(current);
    expect(b.room.diceRolled).toBe(true);
    await advance(t);
    await expectRejectedUnchanged(t, room.roomId, moveCall(room.roomId, client, 2), GameError.illegalMove);

    await moveAs(t, room.roomId, client, current, 0);
    await expectLiveEqualsReplay(t, room.roomId);
  });

  it("an eliminated seat can no longer roll or move", async () => {
    const room = await startedRoom(t, { players: 3 });
    const first = (await bundle(t, room.roomId)).room.currentTurn as Color;
    for (let i = 0; i < 20; i++) {
      const b = await bundle(t, room.roomId);
      if (b.players.find((p) => p.color === first)?.eliminated) break;
      await advance(t, TURN_TIMEOUT_MS + 10);
    }
    const b = await bundle(t, room.roomId);
    expect(b.room.status).toBe("playing");
    expect(b.players.find((p) => p.color === first)?.eliminated).toBe(true);

    const client = seatClient(room, first);
    await advance(t);
    await expectRejectedUnchanged(t, room.roomId, rollCall(room.roomId, client), GameError.eliminated);
    await expectRejectedUnchanged(t, room.roomId, moveCall(room.roomId, client, 0), GameError.eliminated);
  });
});
