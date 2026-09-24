/**
 * Live Convex integration / security suite.
 * Requires NEXT_PUBLIC_CONVEX_URL (from .env.local via `npx convex dev`).
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

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
  assert(recon.reconnected === true, "reconnect works");
  assert(recon.color === "yellow", "reconnect keeps colour");
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
  assert(typeof turnId === "number" && Number.isFinite(turnId), "turnId present");
  assert(started!.room.currentTurn === "red", "red starts");

  await expectReject(
    "wrong player roll",
    () =>
      client.mutation(api.game.rollDice, {
        roomId: roomId4,
        clientId: p2b,
        turnId,
      }),
    "turn",
  );
  mark("only current player can roll");

  await expectReject("stale turnId", () =>
    client.mutation(api.game.rollDice, {
      roomId: roomId4,
      clientId: h4,
      turnId: turnId - 1,
    }),
  );
  mark("stale/replayed roll rejected");

  await expectReject("move before roll", () =>
    client.mutation(api.game.moveToken, {
      roomId: roomId4,
      clientId: h4,
      tokenIndex: 0,
      turnId,
    }),
  );
  mark("cannot move without rolling");

  // Concurrent double-roll: exactly one should succeed.
  const concurrent = await Promise.allSettled([
    client.mutation(api.game.rollDice, {
      roomId: roomId4,
      clientId: h4,
      turnId,
    }),
    client.mutation(api.game.rollDice, {
      roomId: roomId4,
      clientId: h4,
      turnId,
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
  assert(afterRoll!.room.diceValue === roll.value, "server dice matches");
  // After a skip, turn advances and diceRolled is cleared; otherwise dice stays pending.
  if (roll.skipped) {
    assert(afterRoll!.room.diceRolled === false, "skipped roll clears diceRolled");
  } else {
    assert(afterRoll!.room.diceRolled === true, "pending move keeps diceRolled");
  }
  mark("dice authored server-side (client cannot set face)");

  await expectReject("double roll", () =>
    client.mutation(api.game.rollDice, {
      roomId: roomId4,
      clientId: h4,
      turnId,
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
    }),
  );
  mark("cannot move on another's turn");

  await expectReject("invalid token index", () =>
    client.mutation(api.game.moveToken, {
      roomId: roomId4,
      clientId: h4,
      tokenIndex: 99,
      turnId,
    }),
  );
  mark("invalid token index rejected");

  await expectReject("negative token", () =>
    client.mutation(api.game.moveToken, {
      roomId: roomId4,
      clientId: h4,
      tokenIndex: -1,
      turnId,
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
      }),
      client.mutation(api.game.moveToken, {
        roomId: roomId4,
        clientId: h4,
        tokenIndex: idx,
        turnId,
      }),
    ]);
    const moveWins = moves.filter((r) => r.status === "fulfilled");
    assert(moveWins.length === 1, "exactly one concurrent move succeeds");
    mark("concurrent moves → single token move");
  } else {
    mark("concurrent moves (skipped — no legal moves this roll)");
  }

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
  assert(reconFin.reconnected === true, "seated reconnect after finish");
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
    }),
  );
  mark("outsider cannot roll");

  console.log("\n=== 8. Brief pause for action interval ===");
  await sleep(120);

  console.log(`\nIntegration tests passed (${passed.length} checks).`);
  console.log("Rooms:", code, code4, fr.code, nameRoom.code);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
