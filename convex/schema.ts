import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { ludoEventValidator } from "./lib/game/eventValidators";
import {
  metricKindValidator,
  metricOutcomeValidator,
  metricSourceValidator,
  opsSampleFields,
} from "./lib/metrics";

export { colorValidator } from "./lib/colors";
import { colorValidator } from "./lib/colors";

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
    /** 2v2: teammate who must consume the seat holder's pending roll (one move). */
    passedRollTo: v.optional(v.union(colorValidator, v.null())),
    consecutiveSixes: v.number(),
    /**
     * @deprecated Three-six rollback now uses sixStreakSnapshot.
     * Kept optional so older rooms read cleanly until rematch/reset.
     */
    lastMovedTokenIndex: v.optional(v.union(v.number(), v.null())),
    /**
     * Full board token positions captured before the first six of the
     * current consecutive-six streak. Restored (not yard-reset) on the
     * third six. Cleared when the streak ends or the turn advances.
     */
    sixStreakSnapshot: v.optional(
      v.union(
        v.null(),
        v.array(
          v.object({
            color: colorValidator,
            index: v.number(),
            steps: v.number(),
          }),
        ),
      ),
    ),
    /** Monotonic id so scheduled turn timeouts ignore stale jobs. */
    turnId: v.optional(v.number()),
    /** When the current turn began (ms). Client countdown is derived. */
    turnStartedAt: v.optional(v.number()),
    winner: v.union(colorValidator, v.null()),
    /** Finish order (winner first, then subsequent finishers / survivors). */
    rankings: v.optional(v.array(colorValidator)),
    lastEvent: v.optional(v.string()),
    /** Shared move / turn log for the current match (newest last). */
    events: v.optional(
      v.array(
        v.object({
          at: v.number(),
          text: v.string(),
        }),
      ),
    ),
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
    /** Solo vs-computer room — rejects human joins; bots are server-driven. */
    vsComputer: v.optional(v.boolean()),
    /** Absent or "1v1" = classic free-for-all; "2v2" = fixed team pairs. */
    mode: v.optional(v.union(v.literal("1v1"), v.literal("2v2"))),
    /** Set when a 2v2 match ends — clearer than inferring from seat colours. */
    winningTeam: v.optional(
      v.union(v.literal("A"), v.literal("B"), v.null()),
    ),
    /** Monotonic event log head (undefined on legacy rooms). */
    eventSeq: v.optional(v.number()),
    rulesVersion: v.optional(v.number()),
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
    /** Last gameplay/presence action — used for action rate-limiting. */
    lastActionAt: v.optional(v.number()),
    /** Last chat send — separate from gameplay rate-limiting. */
    lastChatAt: v.optional(v.number()),
    /** Last troubleshoot report — separate from gameplay rate-limiting. */
    lastTroubleAt: v.optional(v.number()),
    /** Last client metrics batch — rate-limits ops.reportClientEvents. */
    lastMetricsAt: v.optional(v.number()),
    /** Server-driven seat; never accepts client heartbeats as authority. */
    isBot: v.optional(v.boolean()),
    /** Manual team pick in 2v2 lobby (host is always Team A). */
    team: v.optional(v.union(v.literal("A"), v.literal("B"))),
    /**
     * Set when the player left a started match. The seat stays (it is part of
     * the event-sourced game state) but no longer counts as present.
     */
    leftAt: v.optional(v.number()),
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

  chatMessages: defineTable({
    roomId: v.id("rooms"),
    playerId: v.id("players"),
    /** Display name snapshot at send time. */
    name: v.string(),
    /** Seat colour snapshot at send time. */
    color: colorValidator,
    text: v.string(),
    createdAt: v.number(),
    /** Seat colours mentioned via @Name in text (optional for older rows). */
    mentionedColors: v.optional(v.array(colorValidator)),
  })
    .index("by_room", ["roomId"])
    .index("by_room_createdAt", ["roomId", "createdAt"]),

  /** Host-approved reclaim of a disconnected seat by matching name. */
  rejoinRequests: defineTable({
    roomId: v.id("rooms"),
    playerId: v.id("players"),
    requesterClientId: v.string(),
    requesterName: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("denied"),
    ),
    createdAt: v.number(),
    resolvedAt: v.optional(v.number()),
  })
    .index("by_room_status", ["roomId", "status"])
    .index("by_player", ["playerId"])
    .index("by_requester", ["requesterClientId"]),

  /**
   * Who is in voice for a room. Heartbeat via updatedAt; clients filter
   * stale rows (~20s). Signaling only — audio is peer-to-peer WebRTC.
   */
  voicePeers: defineTable({
    roomId: v.id("rooms"),
    color: colorValidator,
    updatedAt: v.number(),
  })
    .index("by_room", ["roomId"])
    .index("by_room_color", ["roomId", "color"]),

  /** WebRTC signaling (SDP offer/answer + ICE). Routed by seat color. */
  gameEvents: defineTable(ludoEventValidator).index("by_game_seq", [
    "gameId",
    "seq",
  ]),

  voiceSignals: defineTable({
    roomId: v.id("rooms"),
    fromColor: colorValidator,
    toColor: colorValidator,
    type: v.union(v.literal("offer"), v.literal("answer"), v.literal("ice")),
    payload: v.string(),
    createdAt: v.number(),
  })
    .index("by_room_to", ["roomId", "toColor"])
    .index("by_room", ["roomId"]),

  /**
   * Raw metric samples, insert-only. Successful server mutations and batched
   * client reports land here; ops.rollup folds complete minutes into
   * opsMinute and deletes the raw rows.
   */
  opsSamples: defineTable(opsSampleFields).index("by_at", ["at"]),

  /** Per-minute aggregates; `hist` counts latencies per LATENCY_BUCKETS_MS bucket. */
  opsMinute: defineTable({
    minute: v.number(),
    kind: metricKindValidator,
    outcome: metricOutcomeValidator,
    source: metricSourceValidator,
    count: v.number(),
    hist: v.array(v.number()),
  }).index("by_minute", ["minute", "kind", "outcome", "source"]),

  /** Point-in-time gauges captured by each rollup run. */
  opsGauges: defineTable({
    minute: v.number(),
    activeRooms: v.number(),
    activePlayers: v.number(),
    connectedPlayers: v.number(),
  }).index("by_minute", ["minute"]),

  /** Most recent client-reported rejections and errors (capped by the rollup). */
  opsErrors: defineTable({
    at: v.number(),
    kind: metricKindValidator,
    code: v.string(),
    message: v.string(),
  }).index("by_at", ["at"]),
});
