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
    winner: v.union(colorValidator, v.null()),
    lastEvent: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_code", ["code"]),

  players: defineTable({
    roomId: v.id("rooms"),
    clientId: v.string(),
    name: v.string(),
    color: colorValidator,
    connected: v.boolean(),
    lastSeenAt: v.number(),
  })
    .index("by_room", ["roomId"])
    .index("by_room_client", ["roomId", "clientId"])
    .index("by_room_color", ["roomId", "color"]),

  tokens: defineTable({
    roomId: v.id("rooms"),
    color: colorValidator,
    index: v.number(),
    steps: v.number(),
  })
    .index("by_room", ["roomId"])
    .index("by_room_color", ["roomId", "color"]),
});
