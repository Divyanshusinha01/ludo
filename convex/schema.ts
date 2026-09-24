import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const colorValidator = v.union(
  v.literal("red"),
  v.literal("green"),
  v.literal("yellow"),
  v.literal("blue"),
);

export const tokenValidator = v.object({
  index: v.number(),
  /** -1 = yard, 0-50 = track steps from start, 51-55 = home stretch, 56 = finished */
  steps: v.number(),
});

export default defineSchema({
  rooms: defineTable({
    code: v.string(),
    status: v.union(
      v.literal("lobby"),
      v.literal("playing"),
      v.literal("finished"),
    ),
    hostClientId: v.string(),
    currentTurn: colorValidator,
    diceValue: v.union(v.number(), v.null()),
    diceRolled: v.boolean(),
    consecutiveSixes: v.number(),
    /**
     * Token index moved during the current consecutive-six streak
     * (used for three-sixes yard return). Cleared when streak ends.
     */
    lastMovedTokenIndex: v.optional(v.union(v.number(), v.null())),
    /** Monotonic id so scheduled turn timeouts ignore stale jobs. */
    turnId: v.optional(v.number()),
    /** When the current turn began (ms). Client countdown is derived. */
    turnStartedAt: v.optional(v.number()),
    winner: v.union(colorValidator, v.null()),
    /** Finish order (winner first, then subsequent finishers / survivors). */
    rankings: v.optional(v.array(colorValidator)),
    lastEvent: v.optional(v.string()),
    createdAt: v.number(),
    /** Set when status becomes finished — used for finished TTL. */
    finishedAt: v.optional(v.number()),
    /** Updated on gameplay mutations — used to expire idle playing rooms. */
    lastActivityAt: v.optional(v.number()),
    /**
     * Authoritative seated colours for OCC-safe join.
     * Concurrent joins patch this field; losers retry.
     */
    seatedColors: v.optional(v.array(colorValidator)),
  })
    .index("by_code", ["code"])
    .index("by_host", ["hostClientId"])
    .index("by_status", ["status"])
    .index("by_status_createdAt", ["status", "createdAt"])
    .index("by_status_finishedAt", ["status", "finishedAt"])
    .index("by_status_lastActivityAt", ["status", "lastActivityAt"]),

  players: defineTable({
    roomId: v.id("rooms"),
    clientId: v.string(),
    name: v.string(),
    color: colorValidator,
    connected: v.boolean(),
    lastSeenAt: v.number(),
    /** Timeout lives remaining (default 3). */
    lives: v.optional(v.number()),
    /** Eliminated after losing all lives (or forfeit). */
    eliminated: v.optional(v.boolean()),
    /** 1 = winner, higher = later finish / elimination order. */
    finishRank: v.optional(v.number()),
    /** Set on first seat insert — used for join rate-limiting. */
    joinedAt: v.optional(v.number()),
  })
    .index("by_room", ["roomId"])
    .index("by_room_client", ["roomId", "clientId"])
    .index("by_room_color", ["roomId", "color"])
    .index("by_client", ["clientId"]),

  tokens: defineTable({
    roomId: v.id("rooms"),
    color: colorValidator,
    index: v.number(),
    steps: v.number(),
  })
    .index("by_room", ["roomId"])
    .index("by_room_color", ["roomId", "color"]),
});
