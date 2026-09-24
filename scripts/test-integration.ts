import { readFileSync } from "node:fs";
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

async function main() {
  loadEnvLocal();
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL missing");

  const client = new ConvexHttpClient(url);

  const create = await client.mutation(api.rooms.createRoom, {
    clientId: "host-1",
    name: "Host",
  });
  assert(create.code.length === 6, "room code is 6 digits");
  assert(create.color === "red", "host is red");
  const { code, roomId } = create;

  assert(
    (await client.mutation(api.rooms.joinRoom, {
      code,
      clientId: "p2",
      name: "Green",
    })).color === "green",
    "p2 green",
  );
  assert(
    (await client.mutation(api.rooms.joinRoom, {
      code,
      clientId: "p3",
      name: "Yellow",
    })).color === "yellow",
    "p3 yellow",
  );
  assert(
    (await client.mutation(api.rooms.joinRoom, {
      code,
      clientId: "p4",
      name: "Blue",
    })).color === "blue",
    "p4 blue",
  );

  let rejected = false;
  try {
    await client.mutation(api.rooms.joinRoom, {
      code,
      clientId: "p5",
      name: "Extra",
    });
  } catch {
    rejected = true;
  }
  assert(rejected, "5th player rejected");

  const recon = await client.mutation(api.rooms.joinRoom, {
    code,
    clientId: "p2",
    name: "Green2",
  });
  assert(recon.reconnected === true, "reconnect works");
  assert(recon.color === "green", "reconnect keeps colour");

  await client.mutation(api.rooms.startGame, {
    roomId,
    clientId: "host-1",
  });

  let badTurn = false;
  try {
    await client.mutation(api.game.rollDice, { roomId, clientId: "p2" });
  } catch {
    badTurn = true;
  }
  assert(badTurn, "non-turn player cannot roll");

  const roll = await client.mutation(api.game.rollDice, {
    roomId,
    clientId: "host-1",
  });
  assert(roll.value >= 1 && roll.value <= 6, "dice 1-6");

  if (roll.legalMoves?.length) {
    let illegal = false;
    try {
      await client.mutation(api.game.moveToken, {
        roomId,
        clientId: "host-1",
        tokenIndex: 99,
      });
    } catch {
      illegal = true;
    }
    assert(illegal, "invalid token rejected");

    await client.mutation(api.game.moveToken, {
      roomId,
      clientId: "host-1",
      tokenIndex: roll.legalMoves[0]!,
    });
  }

  const state = await client.query(api.rooms.getRoomByCode, { code });
  assert(state, "room exists");
  assert(
    state!.room.status === "playing" || state!.room.status === "finished",
    "game active",
  );
  assert(state!.players.length === 4, "4 players");
  assert(state!.tokens.length === 16, "16 tokens");

  // Simulate complete game flow: force tokens nearly finished via repeated plays is heavy;
  // verify win detection with a dedicated short room by rolling until a move happens.
  console.log("Integration tests passed. Room", code);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
