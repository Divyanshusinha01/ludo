import { expect } from "vitest";
import { api } from "../../../convex/_generated/api";
import type { Color } from "../../../convex/lib/ludo";
import {
  advance,
  bundle,
  moveAs,
  rollAs,
  seatClient,
  storedEvents,
  turnArgs,
  type DiceQueue,
  type RoomId,
  type StartedRoom,
  type T,
} from "../setup";

export type TurnArgs = { turnId: number; expectedSeq: number };

export function rollCall(
  t: T,
  dice: DiceQueue,
  roomId: RoomId,
  client: string,
  args: TurnArgs,
  face: number,
) {
  dice.push(face);
  return t.mutation(api.game.rollDice, { roomId, clientId: client, ...args });
}

export function moveCall(
  t: T,
  roomId: RoomId,
  client: string,
  args: TurnArgs,
  tokenColor: Color,
  tokenIndex: number,
) {
  return t.mutation(api.game.moveToken, { roomId, clientId: client, tokenColor, tokenIndex, ...args });
}

/**
 * Bring the seat to move to a pending 3 with two tokens on the board, so it
 * has exactly two legal moves and either one ends the turn.
 */
export async function twoTokenChoice(
  t: T,
  dice: DiceQueue,
  room: StartedRoom,
): Promise<{ seat: Color; client: string }> {
  const seat = (await bundle(t, room.roomId)).room.currentTurn;
  const client = seatClient(room, seat);
  await rollAs(t, dice, room.roomId, client, 6);
  await moveAs(t, room.roomId, client, seat, 0);
  await rollAs(t, dice, room.roomId, client, 6);
  await moveAs(t, room.roomId, client, seat, 1);
  await rollAs(t, dice, room.roomId, client, 3);
  const b = await bundle(t, room.roomId);
  expect(b.room.diceRolled).toBe(true);
  expect(b.room.currentTurn).toBe(seat);
  return { seat, client };
}

/** Fresh args after the action-interval gap, as a client tab would hold them. */
export async function freshArgs(t: T, roomId: RoomId): Promise<TurnArgs> {
  await advance(t);
  return await turnArgs(t, roomId);
}

export async function headSeq(t: T, roomId: RoomId): Promise<number> {
  return (await storedEvents(t, roomId)).length;
}

export async function typesAfter(t: T, roomId: RoomId, seq: number): Promise<string[]> {
  return (await storedEvents(t, roomId)).filter((e) => e.seq > seq).map((e) => e.eventType);
}

/** Exactly one call succeeded; returns the rejection messages of the rest. */
export function expectOneWinner(results: PromiseSettledResult<unknown>[]): string[] {
  const won = results.filter((r) => r.status === "fulfilled");
  expect(won).toHaveLength(1);
  return results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));
}
