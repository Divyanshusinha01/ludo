import { v, type Infer } from "convex/values";
import { TEAM_COLORS, seatingColors, type Color, type GameMode, type Team } from "./ludo";
import { mutuallyAcceptable } from "./rating";

export const queueValidator = v.union(
  v.literal("duel"),
  v.literal("ffa4"),
  v.literal("team2v2"),
);

export type QueueName = Infer<typeof queueValidator>;

export const QUEUE_NAMES: QueueName[] = ["duel", "ffa4", "team2v2"];

export const QUEUES: Record<QueueName, { size: number; mode: GameMode; label: string }> = {
  duel: { size: 2, mode: "1v1", label: "1v1 Duel" },
  ffa4: { size: 4, mode: "1v1", label: "4-player free-for-all" },
  team2v2: { size: 4, mode: "2v2", label: "2v2 Teams" },
};

/** A waiting ticket with no ping for this long is treated as gone (tab closed). */
export const STALE_TICKET_MS = 20_000;
/** Clients ping while searching; pings closer than this are not written. */
export const QUEUE_PING_MIN_INTERVAL_MS = 2_000;
/** Matched tickets are re-checked this often and dropped once their room is over. */
export const MATCHED_TICKET_RECHECK_MS = 60_000;
/** Tickets read per matcher run; groups beyond this wait for the next run. */
export const MATCH_BATCH = 64;
/** Rooms created per matcher run, to keep one transaction small. */
export const MAX_GROUPS_PER_RUN = 8;
/** A seat with a heartbeat this recent belongs to a live tab and is not reclaimed. */
export const SEAT_LIVE_MS = 15_000;

export type TicketLike = {
  accountId: string;
  rating: number;
  joinedAt: number;
  lastPingAt: number;
};

/**
 * Groups of `size` distinct accounts whose ratings are all mutually inside
 * each other's acceptance window (which widens the longer a ticket waits).
 * The oldest unmatched ticket anchors each group and the next-oldest
 * compatible tickets fill it; an anchor that cannot fill a group stays
 * waiting without blocking younger tickets. Stale tickets are skipped.
 */
export function formGroups<T extends TicketLike>(
  tickets: T[],
  size: number,
  now: number,
  maxGroups: number = MAX_GROUPS_PER_RUN,
): T[][] {
  const live = tickets
    .filter((t) => now - t.lastPingAt <= STALE_TICKET_MS)
    .sort((a, b) => a.joinedAt - b.joinedAt);
  const used = new Set<T>();
  const groups: T[][] = [];
  for (const anchor of live) {
    if (groups.length >= maxGroups) break;
    if (used.has(anchor)) continue;
    const group: T[] = [anchor];
    for (const candidate of live) {
      if (group.length === size) break;
      if (used.has(candidate) || group.includes(candidate)) continue;
      if (group.some((t) => t.accountId === candidate.accountId)) continue;
      if (!group.every((t) => mutuallyAcceptable(t, candidate, now))) continue;
      group.push(candidate);
    }
    if (group.length === size) {
      for (const t of group) used.add(t);
      groups.push(group);
    }
  }
  return groups;
}

export type SeatAssignment<T> = { ticket: T; color: Color; team?: Team };

/**
 * Seat colours for a full group. Free-for-all queues use the classic seating
 * order; 2v2 snake-drafts by rating (1st+4th vs 2nd+3rd) so teams are balanced.
 */
export function assignSeats<T extends { rating: number; joinedAt: number }>(
  queue: QueueName,
  group: T[],
): SeatAssignment<T>[] {
  const { size, mode } = QUEUES[queue];
  if (group.length !== size) {
    throw new Error(`assignSeats: ${queue} needs ${size} tickets, got ${group.length}`);
  }
  if (mode !== "2v2") {
    const colors = seatingColors(size);
    return group.map((ticket, i) => ({ ticket, color: colors[i]! }));
  }
  const ranked = [...group].sort((a, b) => b.rating - a.rating || a.joinedAt - b.joinedAt);
  const teamA = [ranked[0]!, ranked[3]!];
  const teamB = [ranked[1]!, ranked[2]!];
  return [
    ...teamA.map((ticket, i) => ({ ticket, color: TEAM_COLORS.A[i]!, team: "A" as const })),
    ...teamB.map((ticket, i) => ({ ticket, color: TEAM_COLORS.B[i]!, team: "B" as const })),
  ];
}
