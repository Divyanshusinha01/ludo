import { readFileSync } from "node:fs";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import { FINISHED_STEPS } from "../convex/lib/ludo";

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

/**
 * Play until a winner by repeatedly rolling and moving.
 * Caps iterations so CI does not hang forever.
 */
async function playToCompletion(client: ConvexHttpClient) {
  const create = await client.mutation(api.rooms.createRoom, {
    clientId: "c0",
    name: "P0",
  });
  const { code, roomId } = create;
  for (let i = 1; i < 4; i++) {
    await client.mutation(api.rooms.joinRoom, {
      code,
      clientId: `c${i}`,
      name: `P${i}`,
    });
  }
  await client.mutation(api.rooms.startGame, {
    roomId,
    clientId: "c0",
  });

  const colorToClient: Record<string, string> = {
    red: "c0",
    green: "c1",
    yellow: "c2",
    blue: "c3",
  };

  for (let i = 0; i < 2500; i++) {
    const state = await client.query(api.rooms.getRoom, {
      roomId,
      clientId: "c0",
    });
    assert(state, "state");
    if (state!.room.status === "finished") {
      assert(state!.room.winner, "has winner");
      const finished = state!.tokens.filter(
        (t) => t.color === state!.room.winner && t.steps === FINISHED_STEPS,
      );
      assert(finished.length === 4, "winner finished all tokens");
      console.log("Full game completed. Winner:", state!.room.winner, "turns~", i);
      return;
    }

    const turn = state!.room.currentTurn;
    const clientId = colorToClient[turn]!;
    if (!state!.room.diceRolled) {
      const roll = await client.mutation(api.game.rollDice, {
        roomId,
        clientId,
      });
      if (roll.skipped || !roll.legalMoves?.length) continue;
    }

    const legal = await client.query(api.game.getLegalTokenIndexes, {
      roomId,
      clientId,
    });
    if (!legal.length) continue;
    await client.mutation(api.game.moveToken, {
      roomId,
      clientId,
      tokenIndex: legal[0]!,
    });
  }

  throw new Error("Game did not finish within turn budget");
}

async function main() {
  loadEnvLocal();
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL missing");
  const client = new ConvexHttpClient(url);
  await playToCompletion(client);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
