import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { colorValidator } from "./schema";
import { GameError, fail } from "./lib/errors";
import { requirePlayer } from "./lib/roomAuth";
import {
  assertActionInterval,
  assertValidClientId,
  CHAT_MIN_INTERVAL_MS,
  MAX_CHAT_MESSAGES,
  sanitizeChatText,
} from "./lib/session";

const chatMessagePublic = v.object({
  _id: v.id("chatMessages"),
  name: v.string(),
  color: colorValidator,
  text: v.string(),
  createdAt: v.number(),
  isMine: v.boolean(),
});

export const listMessages = query({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
  },
  returns: v.array(chatMessagePublic),
  handler: async (ctx, args) => {
    const clientId = assertValidClientId(args.clientId);
    const me = await requirePlayer(ctx, args.roomId, clientId);

    const newest = await ctx.db
      .query("chatMessages")
      .withIndex("by_room_createdAt", (q) => q.eq("roomId", args.roomId))
      .order("desc")
      .take(MAX_CHAT_MESSAGES);

    return newest.reverse().map((m) => ({
      _id: m._id,
      name: m.name,
      color: m.color,
      text: m.text,
      createdAt: m.createdAt,
      isMine: m.playerId === me._id,
    }));
  },
});

export const sendMessage = mutation({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
    text: v.string(),
  },
  returns: v.id("chatMessages"),
  handler: async (ctx, args) => {
    const clientId = assertValidClientId(args.clientId);
    const player = await requirePlayer(ctx, args.roomId, clientId);
    if (player.isBot) fail(GameError.notInRoom);

    const text = sanitizeChatText(args.text);

    const now = assertActionInterval(
      player.lastChatAt,
      CHAT_MIN_INTERVAL_MS,
    );

    const room = await ctx.db.get(args.roomId);
    if (!room) fail(GameError.roomNotFound);

    const messageId = await ctx.db.insert("chatMessages", {
      roomId: args.roomId,
      playerId: player._id,
      name: player.name,
      color: player.color,
      text,
      createdAt: now,
    });

    await ctx.db.patch(player._id, { lastChatAt: now });

    const all = await ctx.db
      .query("chatMessages")
      .withIndex("by_room", (q) => q.eq("roomId", args.roomId))
      .collect();
    if (all.length > MAX_CHAT_MESSAGES) {
      all.sort((a, b) => a.createdAt - b.createdAt);
      const excess = all.length - MAX_CHAT_MESSAGES;
      for (let i = 0; i < excess; i++) {
        await ctx.db.delete(all[i]!._id);
      }
    }

    return messageId;
  },
});
