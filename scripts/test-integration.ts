import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";

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

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

function sid() {
  return randomUUID();
}

async function main() {
  loadEnvLocal();
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL missing");

  const client = new ConvexHttpClient(url);
  const host1 = sid();
  const p2 = sid();

  const create = await client.mutation(api.rooms.createRoom, {
    clientId: host1,
    name: "Host",
  });
  assert(create.code.length === 6, "room code is 6 chars");
  assert(create.color === "red", "host is red");
  const { code, roomId } = create;

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

  // Reject bad session ids
  let badSession = false;
  try {
    await client.mutation(api.rooms.createRoom, {
      clientId: "not-a-uuid",
      name: "X",
    });
  } catch {
    badSession = true;
  }
  assert(badSession, "invalid session rejected");

  // 2-player start should work
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

  // Fresh 4-player room for remaining checks
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
  // Join order with opposite seating: yellow, then green, then blue
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

  let rejected = false;
  try {
    await client.mutation(api.rooms.joinRoom, {
      code: code4,
      clientId: p5,
      name: "Extra",
    });
  } catch {
    rejected = true;
  }
  assert(rejected, "5th player rejected");

  const recon = await client.mutation(api.rooms.joinRoom, {
    code: code4,
    clientId: p2b,
    name: "Yellow2",
  });
  assert(recon.reconnected === true, "reconnect works");
  assert(recon.color === "yellow", "reconnect keeps colour");

  await client.mutation(api.rooms.startGame, {
    roomId: roomId4,
    clientId: h4,
  });

  const started = await client.query(api.rooms.getRoom, {
    roomId: roomId4,
    clientId: h4,
  });
  assert(started, "4p room");
  const turnId = started!.room.turnId;

  let badTurn = false;
  try {
    await client.mutation(api.game.rollDice, {
      roomId: roomId4,
      clientId: p2b,
      turnId,
    });
  } catch {
    badTurn = true;
  }
  assert(badTurn, "non-turn player cannot roll");

  let stale = false;
  try {
    await client.mutation(api.game.rollDice, {
      roomId: roomId4,
      clientId: h4,
      turnId: turnId - 1,
    });
  } catch {
    stale = true;
  }
  assert(stale, "stale turnId rejected");

  const roll = await client.mutation(api.game.rollDice, {
    roomId: roomId4,
    clientId: h4,
    turnId,
  });
  assert(roll.value >= 1 && roll.value <= 6, "dice 1-6");

  let doubleRoll = false;
  try {
    await client.mutation(api.game.rollDice, {
      roomId: roomId4,
      clientId: h4,
      turnId,
    });
  } catch {
    doubleRoll = true;
  }
  assert(doubleRoll, "double roll rejected");

  if (roll.legalMoves?.length) {
    let illegal = false;
    try {
      await client.mutation(api.game.moveToken, {
        roomId: roomId4,
        clientId: h4,
        tokenIndex: 99,
        turnId,
      });
    } catch {
      illegal = true;
    }
    assert(illegal, "invalid token rejected");

    await client.mutation(api.game.moveToken, {
      roomId: roomId4,
      clientId: h4,
      tokenIndex: roll.legalMoves[0]!,
      turnId,
    });
  }

  state = await client.query(api.rooms.getRoomByCode, {
    code: code4,
    clientId: h4,
  });
  assert(state, "room exists");
  assert(
    state!.room.status === "playing" || state!.room.status === "finished",
    "game active",
  );
  assert(state!.players.length === 4, "4 players");
  assert(state!.tokens.length === 16, "16 tokens");

  console.log("Integration tests passed. Rooms", code, code4);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
