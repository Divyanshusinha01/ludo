import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { GameError, fail } from "./lib/errors";
import { logEvent } from "./lib/log";
import { requirePlayer } from "./lib/roomAuth";
import {
  assertActionInterval,
  assertValidClientId,
  TROUBLE_MIN_INTERVAL_MS,
} from "./lib/session";

const screenValidator = v.union(
  v.literal("home"),
  v.literal("lobby"),
  v.literal("game"),
  v.literal("join"),
);

export const reportTrouble = mutation({
  args: {
    clientId: v.string(),
    roomId: v.optional(v.id("rooms")),
    code: v.optional(v.string()),
    screen: screenValidator,
    lastError: v.optional(v.string()),
    roomStatus: v.optional(v.string()),
    turnId: v.optional(v.number()),
    diceRolled: v.optional(v.boolean()),
    diceValue: v.optional(v.union(v.number(), v.null())),
    offline: v.optional(v.boolean()),
    userAgent: v.optional(v.string()),
  },
  returns: v.object({ ok: v.literal(true) }),
  handler: async (ctx, args) => {
    const clientId = assertValidClientId(args.clientId);
    const lastError = args.lastError?.trim().slice(0, 200) || undefined;
    const userAgent = args.userAgent?.trim().slice(0, 120) || undefined;
    const code = args.code?.trim().toUpperCase().slice(0, 6) || undefined;

    if (args.roomId) {
      const player = await requirePlayer(ctx, args.roomId, clientId);
      if (player.isBot) fail(GameError.notInRoom);

      const now = assertActionInterval(
        player.lastTroubleAt,
        TROUBLE_MIN_INTERVAL_MS,
      );
      await ctx.db.patch(player._id, { lastTroubleAt: now });
    }

    logEvent("trouble_report", {
      clientId,
      screen: args.screen,
      roomId: args.roomId ? String(args.roomId) : null,
      code: code ?? null,
      lastError: lastError ?? null,
      roomStatus: args.roomStatus ?? null,
      turnId: args.turnId ?? null,
      diceRolled: args.diceRolled ?? null,
      diceValue: args.diceValue ?? null,
      offline: args.offline ?? null,
      userAgent: userAgent ?? null,
    });

    return { ok: true as const };
  },
});
