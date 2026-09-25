import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { colorValidator } from "./schema";
import type { Color } from "./lib/ludo";
import { GameError, fail } from "./lib/errors";
import { requirePlayer } from "./lib/roomAuth";
import {
  assertActionInterval,
  assertValidClientId,
  CHAT_MIN_INTERVAL_MS,
  MAX_CHAT_MESSAGES,
  sanitizeChatText,
} from "./lib/session";
import type { Doc } from "./_generated/dataModel";

const chatMessagePublic = v.object({
  _id: v.id("chatMessages"),
  name: v.string(),
  color: colorValidator,
  text: v.string(),
  createdAt: v.number(),
  isMine: v.boolean(),
  mentionedColors: v.array(colorValidator),
  mentionsMe: v.boolean(),
  /** True when the message was sent with @tags — only sender + targets see it. */
  isPrivate: v.boolean(),
});

/** Extract seat colours for @Name mentions (longest name first). */
export function parseMentionedColors(
  text: string,
  players: Doc<"players">[],
  senderId: Doc<"players">["_id"],
): Color[] {
  const candidates = players
    .filter((p) => p._id !== senderId && !p.isBot)
    .map((p) => ({ name: p.name, color: p.color as Color }))
    .sort((a, b) => b.name.length - a.name.length);

  const found = new Set<Color>();
  const lower = text.toLowerCase();

  for (const c of candidates) {
    if (found.has(c.color)) continue;
    const needle = `@${c.name}`.toLowerCase();
    let from = 0;
    while (from <= lower.length - needle.length) {
      const idx = lower.indexOf(needle, from);
      if (idx === -1) break;
      const after = idx + needle.length;
      const next = lower[after];
      // Require end of string or a non-name char so @Al does not match @Alex.
      if (next === undefined || /[\s.,!?;:)\]}]/.test(next)) {
        found.add(c.color);
        break;
      }
      from = idx + 1;
    }
  }

  return [...found].slice(0, 4);
}

function canSeeMessage(
  m: Doc<"chatMessages">,
  me: Doc<"players">,
): boolean {
  const mentioned = m.mentionedColors ?? [];
  if (mentioned.length === 0) return true; // public room chat
  return m.playerId === me._id || mentioned.includes(me.color);
}

export const listMessages = query({
  args: {
    roomId: v.id("rooms"),
    clientId: v.string(),
  },
  returns: v.array(chatMessagePublic),
  handler: async (ctx, args) => {
    const clientId = assertValidClientId(args.clientId);
    const me = await requirePlayer(ctx, args.roomId, clientId);

    // Fetch extra so private DMs for others don't wipe the visible window.
    const newest = await ctx.db
      .query("chatMessages")
      .withIndex("by_room_createdAt", (q) => q.eq("roomId", args.roomId))
      .order("desc")
      .take(MAX_CHAT_MESSAGES * 2);

    const visible = newest
      .filter((m) => canSeeMessage(m, me))
      .slice(0, MAX_CHAT_MESSAGES)
      .reverse();

    return visible.map((m) => {
      const mentionedColors = m.mentionedColors ?? [];
      const isPrivate = mentionedColors.length > 0;
      return {
        _id: m._id,
        name: m.name,
        color: m.color,
        text: m.text,
        createdAt: m.createdAt,
        isMine: m.playerId === me._id,
        mentionedColors,
        mentionsMe: mentionedColors.includes(me.color),
        isPrivate,
      };
    });
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

    const roomPlayers = await ctx.db
      .query("players")
      .withIndex("by_room", (q) => q.eq("roomId", args.roomId))
      .collect();

    const mentionedColors = parseMentionedColors(
      text,
      roomPlayers,
      player._id,
    );

    const messageId = await ctx.db.insert("chatMessages", {
      roomId: args.roomId,
      playerId: player._id,
      name: player.name,
      color: player.color,
      text,
      createdAt: now,
      mentionedColors:
        mentionedColors.length > 0 ? mentionedColors : undefined,
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
