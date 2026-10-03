/**
 * Live Convex integration / security suite.
 * Requires NEXT_PUBLIC_CONVEX_URL (from .env.local via `npx convex dev`).
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import type { FunctionReturnType } from "convex/server";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import {
  createEmptyState,
  diffGameStates,
  replayWithTrace,
  type GameState,
} from "../convex/lib/game";
import type { LudoEvent } from "../convex/lib/game/eventValidators";

type RoomBundle = NonNullable<FunctionReturnType<typeof api.rooms.getRoom>>;

function loadEnvLocal() {
  try {
    const raw = readFileSync(".env.local", "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (!m) continue;
      const key = m[1]!.trim();
      const val = m[2]!.trim();
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    /* ignore */
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function sid() {
  return randomUUID();
}

async function expectReject(
  label: string,
  fn: () => Promise<unknown>,
  messageIncludes?: string,
) {
  let rejected = false;
  let msg = "";
  try {
    await fn();
  } catch (e) {
    rejected = true;
    msg = e instanceof Error ? e.message : String(e);
  }
  assert(rejected, `${label}: expected rejection`);
  if (messageIncludes) {
    assert(
      msg.toLowerCase().includes(messageIncludes.toLowerCase()),
      `${label}: expected message containing "${messageIncludes}", got "${msg}"`,
    );
  }
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function listAllEvents(
  client: ConvexHttpClient,
  roomId: Id<"rooms">,
  clientId: string,
): Promise<LudoEvent[]> {
  const events: LudoEvent[] = [];
  let afterSeq: number | undefined;
  for (;;) {
    const page = await client.query(api.gameEvents.listEvents, {
      roomId,
      clientId,
      afterSeq,
    });
    events.push(...(page.events as LudoEvent[]));
    if (page.nextAfterSeq === null) return events;
    afterSeq = page.nextAfterSeq;
  }
}

/**
 * The public bundle omits rulesVersion, sixStreakSnapshot and settle, so those
 * are taken from the replayed state; every exposed field is compared.
 */
function liveStateFromBundle(
  bundle: RoomBundle,
  hidden: Pick<GameState, "rulesVersion" | "sixStreakSnapshot" | "settle">,
): GameState {
  const { room } = bundle;
  return {
    ...hidden,
    phase: room.status,
    mode: room.mode,
    vsComputer: room.vsComputer,
    seats: bundle.players.map((p) => ({
      color: p.color,
      name: p.name,
      isBot: p.isBot,
      team: p.team ?? undefined,
      lives: p.lives,
      eliminated: p.eliminated,
      finishRank: p.finishRank,
    })),
    tokens: bundle.tokens.map((t) => ({
      color: t.color,
      index: t.index,
      steps: t.steps,
    })),
    currentTurn: room.currentTurn,
    diceValue: room.diceValue,
    diceRolled: room.diceRolled,
    consecutiveSixes: room.consecutiveSixes,
    passedRollTo: room.passedRollTo,
    turnNumber: room.turnId,
    rankings: room.rankings,
    winner: room.winner,
    winningTeam: room.winningTeam,
    finishedAt: room.finishedAt,
  };
}

/**
 * Replays the room's full event log locally and asserts it reproduces the
 * state served by getRoom. Retries when a scheduled job (bot, timeout) commits
 * between the reads.
 */
async function assertLiveMatchesReplay(
  client: ConvexHttpClient,
  roomId: Id<"rooms">,
  clientId: string,
  label: string,
): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const before = await client.query(api.rooms.getRoom, { roomId, clientId });
    assert(before, `${label}: room exists`);
    const events = await listAllEvents(client, roomId, clientId);
    const after = await client.query(api.rooms.getRoom, { roomId, clientId });
    if (after?.room.eventSeq !== before.room.eventSeq) {
      await sleep(200);
      continue;
    }

    const tailSeq = events.at(-1)?.seq ?? 0;
    assert(
      tailSeq === before.room.eventSeq,
      `${label}: log ends at seq ${tailSeq} but room head is ${before.room.eventSeq}`,
    );
    const trace = replayWithTrace(createEmptyState(), events);
    if (trace.error) {
      const { seq, eventType, reason } = trace.error;
      throw new Error(`${label}: replay failed at seq ${seq} (${eventType}): ${reason}`);
    }
    const replayed = trace.states[trace.states.length - 1]!;
    const live = liveStateFromBundle(before, replayed);
    const diffs = diffGameStates(live, replayed);
    assert(
      diffs.length === 0,
      `${label}: live state differs from replay:\n  ${diffs.join("\n  ")}`,
    );
    return events.length;
  }
  throw new Error(`${label}: event head kept moving; could not take a stable snapshot`);
}

async function main() {
  loadEnvLocal();
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL missing");

  const client = new ConvexHttpClient(url);
  const passed: string[] = [];
  const mark = (name: string) => {
    passed.push(name);
    console.log(`  ✓ ${name}`);
  };

  console.log("\n=== 1. Basic room flow ===");
  const host1 = sid();
  const p2 = sid();

  const create = await client.mutation(api.rooms.createRoom, {
    clientId: host1,
    name: "Host",
  });
  assert(create.code.length === 6, "room code is 6 chars");
  assert(/^[A-HJ-NP-Z2-9]{6}$/.test(create.code), "room code alphabet");
  assert(create.color === "red", "host is red");
  const { code, roomId } = create;
  mark("create room + valid code");

  assert(
    (
      await client.mutation(api.rooms.joinRoom, {
        code,
        clientId: p2,
        name: "Yellow",
      })
    ).color === "yellow",
    "p2 opposite house (yellow)",
  );
  mark("join with room code (2 players)");

  await expectReject("invalid session", () =>
    client.mutation(api.rooms.createRoom, {
      clientId: "not-a-uuid",
      name: "X",
    }),
  );
  mark("reject invalid session id");

  await client.mutation(api.rooms.startGame, {
    roomId,
    clientId: host1,
  });

  let state = await client.query(api.rooms.getRoomByCode, {
    code,
    clientId: host1,
  });
  assert(state, "room exists");
  assert(state!.room.status === "playing", "2p game started");
  assert(state!.tokens.length === 8, "8 tokens for 2 players");
  assert(state!.me?.isHost === true, "host flagged");
  assert(
    state!.players.every((p) => !("clientId" in p)),
    "session ids not leaked",
  );
  mark("start 2p + session ids not in public players");

  await assertLiveMatchesReplay(client, roomId, host1, "2p start");
  mark("2p event log replays to live state");

  console.log("\n=== 2. Room capacity / join security ===");
  const h4 = sid();
  const p2b = sid();
  const p3 = sid();
  const p4 = sid();
  const p5 = sid();

  const create4 = await client.mutation(api.rooms.createRoom, {
    clientId: h4,
    name: "Host4",
  });
  const code4 = create4.code;
  const roomId4 = create4.roomId;
  for (const [id, name] of [
    [p2b, "Yellow"],
    [p3, "Green"],
    [p4, "Blue"],
  ] as const) {
    await client.mutation(api.rooms.joinRoom, {
      code: code4,
      clientId: id,
      name,
    });
  }
  mark("join 3rd and 4th players");

  await expectReject(
    "5th player",
    () =>
      client.mutation(api.rooms.joinRoom, {
        code: code4,
        clientId: p5,
        name: "Extra",
      }),
    "full",
  );
  mark("reject 5th player");

  const recon = await client.mutation(api.rooms.joinRoom, {
    code: code4,
    clientId: p2b,
    name: "Yellow2",
  });
  assert(!("pending" in recon) && recon.reconnected === true, "reconnect works");
  assert(!("pending" in recon) && recon.color === "yellow", "reconnect keeps colour");
  mark("reconnect keeps seat");

  await expectReject(
    "non-host start",
    () =>
      client.mutation(api.rooms.startGame, {
        roomId: roomId4,
        clientId: p2b,
      }),
    "host",
  );
  mark("non-host cannot start");

  await client.mutation(api.rooms.startGame, {
    roomId: roomId4,
    clientId: h4,
  });
  mark("host starts 4p game");

  await expectReject(
    "join after start",
    () =>
      client.mutation(api.rooms.joinRoom, {
        code: code4,
        clientId: sid(),
        name: "Late",
      }),
    "started",
  );
  mark("reject join after game started");

  console.log("\n=== 3. Turn / dice / move security ===");
  const started = await client.query(api.rooms.getRoom, {
    roomId: roomId4,
    clientId: h4,
  });
  assert(started, "4p room");
  const turnId = started!.room.turnId;
  let eventSeq = started!.room.eventSeq;
  assert(typeof turnId === "number" && Number.isFinite(turnId), "turnId present");
  assert(started!.room.currentTurn === "red", "red starts");

  await expectReject(
    "wrong player roll",
    () =>
      client.mutation(api.game.rollDice, {
        roomId: roomId4,
        clientId: p2b,
        turnId,
        expectedSeq: eventSeq,
      }),
    "turn",
  );
  mark("only current player can roll");

  await expectReject("stale turnId", () =>
    client.mutation(api.game.rollDice, {
      roomId: roomId4,
      clientId: h4,
      turnId: turnId - 1,
      expectedSeq: eventSeq,
    }),
  );
  mark("stale/replayed roll rejected");

  await expectReject("move before roll", () =>
    client.mutation(api.game.moveToken, {
      roomId: roomId4,
      clientId: h4,
      tokenIndex: 0,
      turnId,
      expectedSeq: eventSeq,
    }),
  );
  mark("cannot move without rolling");

  // Concurrent double-roll: exactly one should succeed.
  const concurrent = await Promise.allSettled([
    client.mutation(api.game.rollDice, {
      roomId: roomId4,
      clientId: h4,
      turnId,
      expectedSeq: eventSeq,
    }),
    client.mutation(api.game.rollDice, {
      roomId: roomId4,
      clientId: h4,
      turnId,
      expectedSeq: eventSeq,
    }),
  ]);
  const rollWins = concurrent.filter((r) => r.status === "fulfilled");
  const rollFails = concurrent.filter((r) => r.status === "rejected");
  assert(rollWins.length === 1, "exactly one concurrent roll succeeds");
  assert(rollFails.length === 1, "exactly one concurrent roll rejected");
  const roll = (rollWins[0] as PromiseFulfilledResult<{
    value: number;
    legalMoves: number[];
    skipped: boolean;
  }>).value;
  assert(roll.value >= 1 && roll.value <= 6, "dice 1-6");
  mark("concurrent rolls → single dice result");

  const afterRoll = await client.query(api.rooms.getRoom, {
    roomId: roomId4,
    clientId: h4,
  });
  // A skipped roll ends the turn and TURN_STARTED clears the die, so the face
  // survives only in the event log.
  if (roll.skipped) {
    assert(afterRoll!.room.diceRolled === false, "skipped roll clears diceRolled");
    assert(afterRoll!.room.diceValue === null, "skipped roll clears diceValue");
    assert(afterRoll!.room.turnId > turnId, "skipped roll advances the turn");
    const rolled = (await listAllEvents(client, roomId4, h4)).filter(
      (e): e is Extract<LudoEvent, { eventType: "DICE_ROLLED" }> =>
        e.eventType === "DICE_ROLLED",
    );
    assert(
      rolled.length === 1 &&
        rolled[0]!.payload.color === "red" &&
        rolled[0]!.payload.value === roll.value,
      "skipped roll recorded once in event log with server dice",
    );
  } else {
    assert(afterRoll!.room.diceValue === roll.value, "server dice matches");
    assert(afterRoll!.room.diceRolled === true, "pending move keeps diceRolled");
  }
  mark("dice authored server-side (client cannot set face)");
  eventSeq = afterRoll!.room.eventSeq;

  await expectReject("double roll", () =>
    client.mutation(api.game.rollDice, {
      roomId: roomId4,
      clientId: h4,
      turnId,
      expectedSeq: eventSeq,
    }),
  );
  mark("cannot roll twice");

  // Stranger / wrong seat cannot move
  await expectReject("other player move", () =>
    client.mutation(api.game.moveToken, {
      roomId: roomId4,
      clientId: p2b,
      tokenIndex: 0,
      turnId,
      expectedSeq: eventSeq,
    }),
  );
  mark("cannot move on another's turn");

  await expectReject("invalid token index", () =>
    client.mutation(api.game.moveToken, {
      roomId: roomId4,
      clientId: h4,
      tokenIndex: 99,
      turnId,
      expectedSeq: eventSeq,
    }),
  );
  mark("invalid token index rejected");

  await expectReject("negative token", () =>
    client.mutation(api.game.moveToken, {
      roomId: roomId4,
      clientId: h4,
      tokenIndex: -1,
      turnId,
      expectedSeq: eventSeq,
    }),
  );
  mark("negative token index rejected");

  if (roll.legalMoves?.length && !roll.skipped) {
    const idx = roll.legalMoves[0]!;
    // Concurrent double-move
    const moves = await Promise.allSettled([
      client.mutation(api.game.moveToken, {
        roomId: roomId4,
        clientId: h4,
        tokenIndex: idx,
        turnId,
        expectedSeq: eventSeq,
      }),
      client.mutation(api.game.moveToken, {
        roomId: roomId4,
        clientId: h4,
        tokenIndex: idx,
        turnId,
        expectedSeq: eventSeq,
      }),
    ]);
    const moveWins = moves.filter((r) => r.status === "fulfilled");
    assert(moveWins.length === 1, "exactly one concurrent move succeeds");
    mark("concurrent moves → single token move");
  } else {
    mark("concurrent moves (skipped — no legal moves this roll)");
  }

  const raceEvents = await assertLiveMatchesReplay(
    client,
    roomId4,
    h4,
    "4p after races",
  );
  mark(`4p event log (${raceEvents} events) replays to live state after races`);

  console.log("\n=== 4. Input validation ===");
  await expectReject("empty room code", () =>
    client.mutation(api.rooms.joinRoom, {
      code: "",
      clientId: sid(),
      name: "X",
    }),
  );
  await expectReject("oversized room code", () =>
    client.mutation(api.rooms.joinRoom, {
      code: "ABCDEFGH",
      clientId: sid(),
      name: "X",
    }),
  );
  await expectReject("invalid alphabet code", () =>
    client.mutation(api.rooms.joinRoom, {
      code: "OOOOOO",
      clientId: sid(),
      name: "X",
    }),
  );
  await expectReject("nonexistent room", () =>
    client.mutation(api.rooms.joinRoom, {
      code: "ABC234",
      clientId: sid(),
      name: "X",
    }),
  );
  mark("reject empty/oversized/invalid/missing room codes");

  const longName = "A".repeat(200);
  const nameClient = sid();
  const nameRoom = await client.mutation(api.rooms.createRoom, {
    clientId: nameClient,
    name: longName,
  });
  const namedByCode = await client.query(api.rooms.getRoomByCode, {
    code: nameRoom.code,
    clientId: nameClient,
  });
  assert(namedByCode, "named room");
  assert(
    namedByCode!.players[0]!.name.length <= 20,
    "long name truncated server-side",
  );
  mark("oversized player name sanitized");

  await expectReject("bogus room id roll", async () => {
    // Convex Id validation or roomNotFound — either is a safe rejection.
    await client.mutation(api.game.rollDice, {
      roomId: "k57xxxxxxxxxxxxxxxxxxxxxxxxxxxxx" as Id<"rooms">,
      clientId: h4,
      turnId: 1,
      expectedSeq: 0,
    });
  });
  mark("invalid room id rejected safely");

  console.log("\n=== 5. Rate limits ===");
  const spamHost = sid();
  await client.mutation(api.rooms.createRoom, {
    clientId: spamHost,
    name: "Spam",
  });
  await expectReject(
    "create rate limit",
    () =>
      client.mutation(api.rooms.createRoom, {
        clientId: spamHost,
        name: "Spam2",
      }),
    "slow",
  );
  mark("room create rate-limited");

  console.log("\n=== 6. Impersonation / finished-room join ===");
  // Random UUID cannot act as host
  await expectReject("impersonate host start", () =>
    client.mutation(api.rooms.startGame, {
      roomId: roomId4,
      clientId: sid(),
    }),
  );
  mark("random UUID cannot impersonate host");

  // Leave until finished, then try new join
  const finishHost = sid();
  const finishP2 = sid();
  const fr = await client.mutation(api.rooms.createRoom, {
    clientId: finishHost,
    name: "F1",
  });
  await client.mutation(api.rooms.joinRoom, {
    code: fr.code,
    clientId: finishP2,
    name: "F2",
  });
  await client.mutation(api.rooms.startGame, {
    roomId: fr.roomId,
    clientId: finishHost,
  });
  await client.mutation(api.rooms.leaveRoom, {
    roomId: fr.roomId,
    clientId: finishP2,
  });
  const finished = await client.query(api.rooms.getRoomByCode, {
    code: fr.code,
    clientId: finishHost,
  });
  assert(finished?.room.status === "finished", "forfeit finishes game");
  await assertLiveMatchesReplay(client, fr.roomId, finishHost, "forfeit");
  mark("forfeited game replays to live state");
  await expectReject(
    "join finished",
    () =>
      client.mutation(api.rooms.joinRoom, {
        code: fr.code,
        clientId: sid(),
        name: "Late",
      }),
    "finished",
  );
  mark("reject join of finished room");

  // Reconnect after finish still works for seated player
  const reconFin = await client.mutation(api.rooms.joinRoom, {
    code: fr.code,
    clientId: finishHost,
    name: "F1",
  });
  assert(
    !("pending" in reconFin) && reconFin.reconnected === true,
    "seated reconnect after finish",
  );
  mark("seated player can reconnect after finish");

  console.log("\n=== 7. Post-action / state integrity ===");
  state = await client.query(api.rooms.getRoomByCode, {
    code: code4,
    clientId: h4,
  });
  assert(state, "room exists");
  assert(
    state!.room.status === "playing" || state!.room.status === "finished",
    "game active or finished",
  );
  assert(state!.players.length === 4, "4 players");
  assert(state!.tokens.length === 16, "16 tokens");
  // All clients see same dice/turn if still playing
  const views = await Promise.all(
    [h4, p2b, p3, p4].map((id) =>
      client.query(api.rooms.getRoom, { roomId: roomId4, clientId: id }),
    ),
  );
  const turns = new Set(views.map((v) => v?.room.currentTurn));
  const dice = new Set(views.map((v) => v?.room.diceValue));
  const tids = new Set(views.map((v) => v?.room.turnId));
  assert(turns.size === 1, "all seats agree on currentTurn");
  assert(dice.size === 1, "all seats agree on diceValue");
  assert(tids.size === 1, "all seats agree on turnId");
  mark("multi-client state synchronized");

  // Act after leaving / not in room
  await expectReject("outsider roll", () =>
    client.mutation(api.game.rollDice, {
      roomId: roomId4,
      clientId: sid(),
      turnId: state!.room.turnId,
      expectedSeq: state!.room.eventSeq,
    }),
  );
  mark("outsider cannot roll");

  console.log("\n=== 8. Lobby bots (mixed human + computer) ===");
  const botHost = sid();
  const botGuest = sid();
  const botRoom = await client.mutation(api.rooms.createRoom, {
    clientId: botHost,
    name: "BotHost",
  });
  await client.mutation(api.rooms.addBot, {
    roomId: botRoom.roomId,
    clientId: botHost,
  });
  let botState = await client.query(api.rooms.getRoom, {
    roomId: botRoom.roomId,
    clientId: botHost,
  });
  assert(botState, "bot lobby exists");
  assert(botState!.players.length === 2, "host + 1 bot");
  assert(
    botState!.players.some((p) => p.isBot && p.name === "Computer"),
    "bot seat named Computer",
  );
  mark("host can add computer in lobby");

  await client.mutation(api.rooms.joinRoom, {
    code: botRoom.code,
    clientId: botGuest,
    name: "Guest",
  });
  botState = await client.query(api.rooms.getRoom, {
    roomId: botRoom.roomId,
    clientId: botHost,
  });
  assert(botState!.players.length === 3, "host + bot + guest");
  await expectReject("non-host add bot", () =>
    client.mutation(api.rooms.addBot, {
      roomId: botRoom.roomId,
      clientId: botGuest,
    }),
    "host",
  );
  mark("only host can add computer");

  const botColor = botState!.players.find((p) => p.isBot)!.color;
  await client.mutation(api.rooms.kickPlayer, {
    roomId: botRoom.roomId,
    clientId: botHost,
    targetColor: botColor,
  });
  botState = await client.query(api.rooms.getRoom, {
    roomId: botRoom.roomId,
    clientId: botHost,
  });
  assert(!botState!.players.some((p) => p.isBot), "bot removed");
  mark("host can remove computer");

  await client.mutation(api.rooms.addBot, {
    roomId: botRoom.roomId,
    clientId: botHost,
  });
  await client.mutation(api.rooms.startGame, {
    roomId: botRoom.roomId,
    clientId: botHost,
  });
  botState = await client.query(api.rooms.getRoom, {
    roomId: botRoom.roomId,
    clientId: botHost,
  });
  assert(botState!.room.status === "playing", "mixed game started");
  assert(botState!.players.filter((p) => p.isBot).length === 1, "1 bot in play");
  assert(botState!.players.filter((p) => !p.isBot).length === 2, "2 humans");
  assert(botState!.tokens.length === 12, "3 seats × 4 tokens");
  mark("start with humans + bot");

  // Wait for possible bot turn scheduling (BOT_THINK_MS = 700)
  await sleep(900);
  botState = await client.query(api.rooms.getRoom, {
    roomId: botRoom.roomId,
    clientId: botHost,
  });
  assert(
    botState!.room.status === "playing" || botState!.room.status === "finished",
    "game still valid after bot think window",
  );
  mark("bot turn scheduler does not break room");

  await assertLiveMatchesReplay(client, botRoom.roomId, botHost, "bot game");
  mark("bot game event log replays to live state");

  console.log("\n=== 9. Brief pause for action interval ===");
  await sleep(120);

  console.log(`\nIntegration tests passed (${passed.length} checks).`);
  console.log("Rooms:", code, code4, fr.code, nameRoom.code, botRoom.code);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
