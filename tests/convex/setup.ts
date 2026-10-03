/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, vi, type MockInstance } from "vitest";
import schema from "../../convex/schema";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  canonicalGameState,
  createEmptyState,
  replayGame,
  type GameState,
  type LudoEvent,
} from "../../convex/lib/game";
import { loadGameState } from "../../convex/lib/gameStore";
import {
  moveControllerColor,
  rollControllerColor,
  type Color,
  type GameMode,
  type TeamPlayerLike,
} from "../../convex/lib/ludo";
import { mulberry32, randomForFace } from "../game/fixtures/dice";

export const modules = import.meta.glob("../../convex/**/!(*.*.*)*.*s");

/** Captured before vi.useFakeTimers so tests can still yield to the real event loop. */
const realSetTimeout = globalThis.setTimeout;

export const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
/** Gap between actions: clears the 100ms per-seat action interval. */
export const STEP_MS = 150;

function makeConvex() {
  return convexTest(schema, modules);
}

export type T = ReturnType<typeof makeConvex>;
export type RoomId = Id<"rooms">;

/** Deterministic UUIDv4-shaped session id (passes assertValidClientId). */
export function clientId(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/**
 * Scripted dice: faces queued here are served to `rollFairDice` through
 * Math.random; every other Math.random call (bot rolls included) falls through
 * to the fallback, which is the real Math.random unless `seedFallback` is used.
 */
export class DiceQueue {
  private queue: number[] = [];
  private spy: MockInstance<() => number>;
  private fallback: () => number;

  constructor() {
    this.fallback = Math.random.bind(Math);
    this.spy = vi.spyOn(Math, "random").mockImplementation(() => {
      const face = this.queue.shift();
      return face === undefined ? this.fallback() : randomForFace(face);
    });
  }

  /** Make unscripted Math.random calls (bot dice) reproducible. */
  seedFallback(seed: number): void {
    this.fallback = mulberry32(seed);
  }

  push(...faces: number[]): void {
    this.queue.push(...faces);
  }

  clear(): void {
    this.queue = [];
  }

  get pending(): number {
    return this.queue.length;
  }

  restore(): void {
    this.spy.mockRestore();
  }
}

export function setupConvex(): { t: T; dice: DiceQueue } {
  vi.useFakeTimers({ now: T0 });
  const t = makeConvex();
  return { t, dice: new DiceQueue() };
}

export function teardownConvex(dice: DiceQueue | undefined): void {
  dice?.restore();
  vi.useRealTimers();
}

/**
 * Long matches resolve entirely through microtasks; without a macrotask turn
 * the vitest worker cannot answer its own RPC and reports a timeout.
 */
async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => realSetTimeout(resolve, 0));
}

/** Move the clock forward and let any scheduled job that came due finish. */
export async function advance(t: T, ms: number = STEP_MS): Promise<void> {
  await yieldToEventLoop();
  vi.advanceTimersByTime(ms);
  await t.finishInProgressScheduledFunctions();
}

/** Jump the wall clock without firing any timer (scheduled jobs stay pending). */
export function setClock(ms: number): void {
  vi.setSystemTime(ms);
}

export type ScheduledJob = {
  name: string;
  scheduledTime: number;
  args: Record<string, unknown>;
};

/** Jobs still waiting to run, read from the scheduler's system table. */
export async function pendingJobs(t: T, roomId: RoomId): Promise<ScheduledJob[]> {
  const rows = await t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect());
  return rows
    .filter((r) => r.state.kind === "pending")
    .map((r) => ({
      name: r.name,
      scheduledTime: r.scheduledTime,
      args: (r.args[0] ?? {}) as Record<string, unknown>,
    }))
    .filter((j) => j.args.roomId === roomId);
}

/** Room doc + event log, for asserting that a rejected call changed nothing. */
export async function snapshot(t: T, roomId: RoomId) {
  const events = await storedEvents(t, roomId);
  const room = await rawRoom(t, roomId);
  const tokens = await t.run(async (ctx) =>
    (
      await ctx.db
        .query("tokens")
        .withIndex("by_room", (q) => q.eq("roomId", roomId))
        .collect()
    ).map((tok) => ({ color: tok.color, index: tok.index, steps: tok.steps })),
  );
  return { events, room, tokens };
}

/** Run `call`, expect it to reject with `message`, and expect no state change. */
export async function expectRejectedUnchanged(
  t: T,
  roomId: RoomId,
  call: () => Promise<unknown>,
  message: string | RegExp,
): Promise<void> {
  const before = await snapshot(t, roomId);
  await expect(call()).rejects.toThrow(message);
  expect(await snapshot(t, roomId)).toEqual(before);
}

/** Run every scheduled job (bots, timeouts) until the queue is empty. */
export async function drainScheduled(t: T, maxIterations = 500): Promise<void> {
  await t.finishAllScheduledFunctions(() => vi.runAllTimers(), maxIterations);
}

export async function bundle(t: T, roomId: RoomId, client?: string) {
  const b = await t.query(api.rooms.getRoom, { roomId, clientId: client });
  if (!b) throw new Error("room missing");
  return b;
}

export async function rawRoom(t: T, roomId: RoomId) {
  return await t.run(async (ctx) => await ctx.db.get(roomId));
}

export type Seats = Partial<Record<Color, string>>;

export type StartedRoom = {
  roomId: RoomId;
  code: string;
  host: string;
  /** Session id for every human seat, by colour. */
  clients: Seats;
};

/** Create a lobby, fill it with humans, and start the match. */
export async function startedRoom(
  t: T,
  opts: {
    players: number;
    mode?: GameMode;
    start?: boolean;
    /** Offset for session ids, so several rooms in one test get distinct players. */
    clientBase?: number;
  },
): Promise<StartedRoom> {
  const mode = opts.mode ?? "1v1";
  const base = opts.clientBase ?? 0;
  const host = clientId(base + 1);
  const created = await t.mutation(api.rooms.createRoom, {
    clientId: host,
    name: "P1",
    mode,
  });
  if (!("roomId" in created)) throw new Error("create returned pending");
  const clients: Seats = { [created.color]: host };
  const teams: Array<"A" | "B"> = ["B", "B", "A"];
  for (let i = 2; i <= opts.players; i++) {
    const id = clientId(base + i);
    const joined = await t.mutation(api.rooms.joinRoom, {
      code: created.code,
      clientId: id,
      name: `P${i}`,
      ...(mode === "2v2" ? { team: teams[i - 2] } : {}),
    });
    if (!("roomId" in joined)) throw new Error("join returned pending");
    clients[joined.color as Color] = id;
  }
  if (opts.start !== false) {
    await t.mutation(api.rooms.startGame, { roomId: created.roomId, clientId: host });
  }
  return { roomId: created.roomId, code: created.code, host, clients };
}

export function seatClient(room: StartedRoom, color: Color): string {
  const id = room.clients[color];
  if (!id) throw new Error(`no human client for ${color}`);
  return id;
}

/** Client args a tab would send right now: its view of turnId + eventSeq. */
export async function turnArgs(t: T, roomId: RoomId) {
  const { room } = await bundle(t, roomId);
  return { turnId: room.turnId, expectedSeq: room.eventSeq };
}

export async function rollAs(
  t: T,
  dice: DiceQueue,
  roomId: RoomId,
  client: string,
  face: number,
) {
  await advance(t);
  const args = await turnArgs(t, roomId);
  dice.clear();
  dice.push(face);
  try {
    return await t.mutation(api.game.rollDice, { roomId, clientId: client, ...args });
  } finally {
    dice.clear();
  }
}

export async function moveAs(
  t: T,
  roomId: RoomId,
  client: string,
  tokenColor: Color,
  tokenIndex: number,
) {
  await advance(t);
  const args = await turnArgs(t, roomId);
  return await t.mutation(api.game.moveToken, {
    roomId,
    clientId: client,
    tokenColor,
    tokenIndex,
    ...args,
  });
}

/** Stored events in seq order, read straight from the table. */
export async function storedEvents(t: T, roomId: RoomId): Promise<LudoEvent[]> {
  const rows = await t.run(async (ctx) =>
    await ctx.db
      .query("gameEvents")
      .withIndex("by_game_seq", (q) => q.eq("gameId", roomId))
      .collect(),
  );
  return rows.map(({ _id: _i, _creationTime: _c, ...e }) => e as LudoEvent);
}

/** Every event through the public paged API (follows nextAfterSeq). */
export async function listAllEvents(
  t: T,
  roomId: RoomId,
  client: string,
): Promise<{ events: LudoEvent[]; pages: number }> {
  const events: LudoEvent[] = [];
  let afterSeq: number | undefined;
  let pages = 0;
  for (;;) {
    const page = await t.query(api.gameEvents.listEvents, {
      roomId,
      clientId: client,
      ...(afterSeq !== undefined ? { afterSeq } : {}),
    });
    pages++;
    events.push(...(page.events as LudoEvent[]));
    if (page.nextAfterSeq === null) break;
    afterSeq = page.nextAfterSeq;
  }
  return { events, pages };
}

export async function liveState(t: T, roomId: RoomId): Promise<GameState> {
  return await t.run(async (ctx) => {
    const room = await ctx.db.get(roomId);
    if (!room) throw new Error("room missing");
    return await loadGameState(ctx, room);
  });
}

/** The materialized projection must equal a from-scratch replay of the log. */
export async function expectLiveEqualsReplay(t: T, roomId: RoomId): Promise<GameState> {
  const events = await storedEvents(t, roomId);
  const room = await rawRoom(t, roomId);
  expect(room?.eventSeq).toBe(events.length);
  events.forEach((e, i) => expect(e.seq).toBe(i + 1));
  const replayed = replayGame(createEmptyState(), events).state;
  const live = await liveState(t, roomId);
  expect(canonicalGameState(live)).toEqual(canonicalGameState(replayed));
  const verdict = await t.query(internal.gameEvents.verifyReplay, { roomId });
  expect(verdict).toEqual({ ok: true, headSeq: events.length, diffs: [] });
  return replayed;
}

function teamPlayers(
  players: Array<{ color: Color; team: "A" | "B" | null; eliminated: boolean; finishRank: number | null }>,
): TeamPlayerLike[] {
  return players.map((p) => ({
    color: p.color,
    team: p.team ?? undefined,
    eliminated: p.eliminated,
    finishRank: p.finishRank,
  }));
}

export type PlayOptions = {
  seed: number;
  maxActions?: number;
  /** Called after every successful human action. */
  afterAction?: () => Promise<void>;
};

/**
 * Drive a human-only match through the public mutations with seeded dice and
 * random legal choices until it finishes. Returns the number of actions.
 */
export async function playToEnd(
  t: T,
  dice: DiceQueue,
  room: StartedRoom,
  opts: PlayOptions,
): Promise<number> {
  const rng = mulberry32(opts.seed);
  const max = opts.maxActions ?? 4000;
  for (let actions = 0; actions < max; actions++) {
    const b = await bundle(t, room.roomId);
    if (b.room.status !== "playing") return actions;
    const players = teamPlayers(b.players);
    const seat = b.room.currentTurn;
    if (!b.room.diceRolled) {
      const roller = rollControllerColor(seat, players, b.room.mode, b.room.passedRollTo);
      const face = 1 + Math.floor(rng() * 6);
      await rollAs(t, dice, room.roomId, seatClient(room, roller), face);
    } else {
      const mover = moveControllerColor(seat, players, b.room.mode, b.room.passedRollTo);
      const client = seatClient(room, mover);
      const legal = await t.query(api.game.getLegalTokenIndexes, {
        roomId: room.roomId,
        clientId: client,
      });
      if (legal.length === 0) {
        throw new Error(`dice on the table but ${mover} has no legal move`);
      }
      const pick = legal[Math.floor(rng() * legal.length)]!;
      await moveAs(t, room.roomId, client, pick.color, pick.index);
    }
    await opts.afterAction?.();
  }
  throw new Error(`match did not finish within ${max} actions`);
}

/** The next action a client would send in a playing room: who sends it and with what. */
export type NextAction =
  | { kind: "roll"; client: string; face: number }
  | { kind: "move"; client: string; tokenColor: Color; tokenIndex: number };

/** Pick the next legal action with `rng`, or null once the room is not playing. */
export async function nextAction(
  t: T,
  room: StartedRoom,
  rng: () => number,
): Promise<NextAction | null> {
  const b = await bundle(t, room.roomId);
  if (b.room.status !== "playing") return null;
  const players = teamPlayers(b.players);
  const seat = b.room.currentTurn;
  if (!b.room.diceRolled) {
    const roller = rollControllerColor(seat, players, b.room.mode, b.room.passedRollTo);
    return { kind: "roll", client: seatClient(room, roller), face: 1 + Math.floor(rng() * 6) };
  }
  const mover = moveControllerColor(seat, players, b.room.mode, b.room.passedRollTo);
  const client = seatClient(room, mover);
  const legal = await t.query(api.game.getLegalTokenIndexes, { roomId: room.roomId, clientId: client });
  if (legal.length === 0) throw new Error(`dice on the table but ${mover} has no legal move`);
  const pick = legal[Math.floor(rng() * legal.length)]!;
  return { kind: "move", client, tokenColor: pick.color, tokenIndex: pick.index };
}

/** Play up to `count` legal actions; stops early if the match ends. Returns actions played. */
export async function playActions(
  t: T,
  dice: DiceQueue,
  room: StartedRoom,
  rng: () => number,
  count: number,
): Promise<number> {
  for (let i = 0; i < count; i++) {
    const action = await nextAction(t, room, rng);
    if (!action) return i;
    if (action.kind === "roll") await rollAs(t, dice, room.roomId, action.client, action.face);
    else await moveAs(t, room.roomId, action.client, action.tokenColor, action.tokenIndex);
  }
  return count;
}

function sortedTokens(tokens: Array<{ color: Color; index: number; steps: number }>) {
  return tokens
    .map((tok) => ({ color: tok.color, index: tok.index, steps: tok.steps }))
    .sort((a, b) => a.color.localeCompare(b.color) || a.index - b.index);
}

/** The game-relevant part of a getRoom bundle, as a client renders it. */
export function bundleView(b: Awaited<ReturnType<typeof bundle>>) {
  return {
    phase: b.room.status,
    currentTurn: b.room.currentTurn,
    diceValue: b.room.diceValue,
    diceRolled: b.room.diceRolled,
    turnId: b.room.turnId,
    passedRollTo: b.room.passedRollTo,
    winner: b.room.winner,
    rankings: b.room.rankings,
    seats: b.players
      .map((p) => ({ color: p.color, lives: p.lives, eliminated: p.eliminated, finishRank: p.finishRank }))
      .sort((a, b) => a.color.localeCompare(b.color)),
    tokens: sortedTokens(b.tokens),
  };
}

/** The same view derived from a GameState (live projection or a client replay). */
export function stateView(s: GameState) {
  return {
    phase: s.phase,
    currentTurn: s.currentTurn,
    diceValue: s.diceValue,
    diceRolled: s.diceRolled,
    turnId: s.turnNumber,
    passedRollTo: s.passedRollTo,
    winner: s.winner,
    rankings: s.rankings,
    seats: s.seats
      .map((p) => ({ color: p.color, lives: p.lives, eliminated: p.eliminated, finishRank: p.finishRank }))
      .sort((a, b) => a.color.localeCompare(b.color)),
    tokens: sortedTokens(s.tokens),
  };
}

/**
 * Incremental resync: page through listEvents after `seenSeq` and replay the
 * missed events onto the client's last known state.
 */
export async function catchUp(
  t: T,
  roomId: RoomId,
  client: string,
  from: { state: GameState; seenSeq: number },
  pageSize = 200,
): Promise<{ state: GameState; seenSeq: number; fetched: number; pages: number }> {
  const missed: LudoEvent[] = [];
  let afterSeq = from.seenSeq;
  let pages = 0;
  for (;;) {
    const page = await t.query(api.gameEvents.listEvents, { roomId, clientId: client, afterSeq, limit: pageSize });
    pages++;
    missed.push(...(page.events as LudoEvent[]));
    if (page.nextAfterSeq === null) break;
    afterSeq = page.nextAfterSeq;
  }
  if (missed.length === 0) return { ...from, fetched: 0, pages };
  const { state } = replayGame(from.state, missed, { firstSeq: from.seenSeq + 1 });
  return { state, seenSeq: missed.at(-1)!.seq, fetched: missed.length, pages };
}

export async function eventTypes(t: T, roomId: RoomId, afterSeq = 0): Promise<string[]> {
  return (await storedEvents(t, roomId))
    .filter((e) => e.seq > afterSeq)
    .map((e) => e.eventType);
}
