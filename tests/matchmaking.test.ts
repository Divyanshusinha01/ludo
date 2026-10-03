import { describe, expect, it } from "vitest";
import {
  assignSeats,
  formGroups,
  QUEUES,
  STALE_TICKET_MS,
  type TicketLike,
} from "../convex/lib/matchmaking";

const NOW = 1_000_000;

function ticket(accountId: string, joinedAt: number, extra: Partial<TicketLike> = {}): TicketLike {
  return { accountId, rating: 1200, joinedAt, lastPingAt: NOW, ...extra };
}

describe("formGroups", () => {
  it("groups oldest tickets first and leaves the remainder waiting", () => {
    const tickets = [ticket("c", 3), ticket("a", 1), ticket("e", 5), ticket("b", 2), ticket("d", 4)];
    const groups = formGroups(tickets, 2, NOW);
    expect(groups.map((g) => g.map((t) => t.accountId))).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("never puts one account twice in a group", () => {
    const groups = formGroups([ticket("a", 1), ticket("a", 2), ticket("b", 3)], 2, NOW);
    expect(groups.map((g) => g.map((t) => t.accountId))).toEqual([["a", "b"]]);
  });

  it("skips stale tickets", () => {
    const stale = ticket("old", 0, { lastPingAt: NOW - STALE_TICKET_MS - 1 });
    const groups = formGroups([stale, ticket("a", 1), ticket("b", 2)], 2, NOW);
    expect(groups.flat().map((t) => t.accountId)).toEqual(["a", "b"]);
  });

  it("returns nothing when no group can be filled", () => {
    expect(formGroups([ticket("a", 1), ticket("b", 2), ticket("c", 3)], 4, NOW)).toEqual([]);
  });

  it("caps the number of groups per run", () => {
    const many = Array.from({ length: 20 }, (_, i) => ticket(`u${i}`, i));
    expect(formGroups(many, 2, NOW, 3)).toHaveLength(3);
  });
});

describe("formGroups rating window", () => {
  const ids = (groups: TicketLike[][]) => groups.map((g) => g.map((t) => t.accountId));
  /** Joined `i` ms after the others, all within the last second: every window is still ±100. */
  const fresh = (accountId: string, i: number, rating = 1200) =>
    ticket(accountId, NOW - 1_000 + i, { rating });

  it("keeps far-apart fresh tickets apart", () => {
    const groups = formGroups(
      [ticket("a", NOW, { rating: 1200 }), ticket("b", NOW, { rating: 1450 })],
      2,
      NOW,
    );
    expect(groups).toEqual([]);
  });

  it("matches them once both windows have widened enough", () => {
    const later = NOW + 30_000;
    const pair = [
      ticket("a", NOW, { rating: 1200, lastPingAt: later }),
      ticket("b", NOW, { rating: 1450, lastPingAt: later }),
    ];
    expect(formGroups(pair, 2, NOW + 20_000)).toEqual([]);
    expect(ids(formGroups(pair, 2, later))).toEqual([["a", "b"]]);
  });

  it("a long wait on one side is not enough: windows must be mutual", () => {
    const old = ticket("old", NOW - 120_000, { rating: 1200 });
    const fresh = ticket("fresh", NOW, { rating: 1400 });
    expect(formGroups([old, fresh], 2, NOW)).toEqual([]);
  });

  it("the oldest ticket anchors and takes its closest-in-time compatible partner", () => {
    const groups = formGroups(
      [fresh("anchor", 1, 1200), fresh("far", 2, 1600), fresh("near", 3, 1260), fresh("far2", 4, 1650)],
      2,
      NOW,
    );
    expect(ids(groups)).toEqual([
      ["anchor", "near"],
      ["far", "far2"],
    ]);
  });

  it("an anchor with no partner does not block younger tickets", () => {
    const groups = formGroups(
      [fresh("lonely", 1, 2000), fresh("b", 2), fresh("c", 3)],
      2,
      NOW,
    );
    expect(ids(groups)).toEqual([["b", "c"]]);
  });

  it("every member of a 4-player group is inside every other's window", () => {
    // 1200..1290 fits; 1340 is within 100 of 1290 but not of 1200.
    const groups = formGroups(
      [fresh("a", 1, 1200), fresh("b", 2, 1290), fresh("x", 3, 1340), fresh("c", 4, 1250), fresh("d", 5, 1230)],
      4,
      NOW,
    );
    expect(ids(groups)).toEqual([["a", "b", "c", "d"]]);
  });
});

describe("assignSeats", () => {
  it("duel uses opposite houses", () => {
    const seats = assignSeats("duel", [ticket("a", 1), ticket("b", 2)]);
    expect(seats.map((s) => [s.ticket.accountId, s.color])).toEqual([
      ["a", "red"],
      ["b", "yellow"],
    ]);
  });

  it("ffa4 fills every colour once with no teams", () => {
    const seats = assignSeats("ffa4", ["a", "b", "c", "d"].map((id, i) => ticket(id, i)));
    expect(new Set(seats.map((s) => s.color)).size).toBe(4);
    expect(seats.every((s) => s.team === undefined)).toBe(true);
  });

  it("2v2 snake-drafts by rating so team averages are close", () => {
    const group = [
      ticket("r1500", 1, { rating: 1500 }),
      ticket("r1000", 2, { rating: 1000 }),
      ticket("r1400", 3, { rating: 1400 }),
      ticket("r1100", 4, { rating: 1100 }),
    ];
    const seats = assignSeats("team2v2", group);
    const team = (t: "A" | "B") => seats.filter((s) => s.team === t).map((s) => s.ticket.accountId).sort();
    expect(team("A")).toEqual(["r1000", "r1500"]);
    expect(team("B")).toEqual(["r1100", "r1400"]);
    for (const s of seats) {
      expect(s.team === "A" ? ["red", "yellow"] : ["green", "blue"]).toContain(s.color);
    }
  });

  it("rejects a group of the wrong size", () => {
    expect(() => assignSeats("ffa4", [ticket("a", 1)])).toThrow();
  });

  it("queue sizes and modes", () => {
    expect(QUEUES.duel).toMatchObject({ size: 2, mode: "1v1" });
    expect(QUEUES.ffa4).toMatchObject({ size: 4, mode: "1v1" });
    expect(QUEUES.team2v2).toMatchObject({ size: 4, mode: "2v2" });
  });
});
