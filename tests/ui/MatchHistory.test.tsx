import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { getFunctionName } from "convex/server";

type Entry = {
  matchId: string;
  queue: "duel" | "ffa4" | "team2v2";
  rated: boolean;
  kind: "ranked" | "private" | "computer";
  finishedAt: number;
  color: "red";
  placement: number;
  won: boolean;
  ratingBefore: number;
  ratingAfter: number;
  delta: number;
};

let paginated: { results: Entry[]; status: string; loadMore: ReturnType<typeof vi.fn> };
let queryResults: Record<string, unknown>;

vi.mock("convex/react", () => ({
  usePaginatedQuery: (ref: unknown) => {
    expect(getFunctionName(ref as never)).toBe("history:listMine");
    return paginated;
  },
  useQuery: (ref: unknown) => queryResults[getFunctionName(ref as never)],
}));

const { MatchHistory } = await import("@/components/MatchHistory");
const { Leaderboard } = await import("@/components/Leaderboard");
const { RatingResultBanner } = await import("@/components/RatingResultBanner");

function entry(over: Partial<Entry>): Entry {
  return {
    matchId: "m1",
    queue: "duel",
    rated: true,
    kind: "ranked",
    finishedAt: Date.UTC(2026, 9, 1, 12),
    color: "red",
    placement: 1,
    won: true,
    ratingBefore: 1200,
    ratingAfter: 1220,
    delta: 20,
    ...over,
  };
}

beforeEach(() => {
  paginated = { results: [], status: "Exhausted", loadMore: vi.fn() };
  queryResults = {};
});

describe("MatchHistory", () => {
  it("shows a loading state for the first page", () => {
    paginated.status = "LoadingFirstPage";
    render(<MatchHistory />);
    expect(screen.getByText("Loading match history…")).toBeInTheDocument();
  });

  it("shows an empty state", () => {
    render(<MatchHistory />);
    expect(screen.getByText(/No games yet/)).toBeInTheDocument();
  });

  it("labels private and vs-computer games with their result and no rating", () => {
    paginated.results = [
      entry({ matchId: "m2", kind: "computer", rated: false, won: true, placement: 1, delta: 0 }),
      entry({ matchId: "m1", kind: "private", queue: "ffa4", rated: false, won: false, placement: 2, delta: 0 }),
    ];
    render(<MatchHistory />);
    const rows = within(screen.getByRole("list")).getAllByRole("listitem");

    expect(rows[0]).toHaveTextContent("vs Computer");
    expect(rows[0]).toHaveTextContent("Won");
    expect(rows[0]).toHaveTextContent("Unrated");
    expect(within(rows[0]!).queryByLabelText("Rating change")).toBeNull();

    expect(rows[1]).toHaveTextContent("Private room");
    expect(rows[1]).toHaveTextContent("2nd");
    expect(within(rows[1]!).queryByLabelText("Rating change")).toBeNull();
  });

  it("lists games with outcome, rating change and new rating", () => {
    paginated.results = [
      entry({ matchId: "m3", queue: "ffa4", won: false, placement: 3, ratingBefore: 1220, ratingAfter: 1213, delta: -7 }),
      entry({ matchId: "m2", queue: "team2v2", won: true, placement: 1 }),
      entry({ matchId: "m1", rated: false, won: false, placement: 2, ratingAfter: 1200, delta: 0 }),
    ];
    render(<MatchHistory />);
    const rows = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(rows).toHaveLength(3);

    expect(rows[0]).toHaveTextContent("4-player free-for-all");
    expect(rows[0]).toHaveTextContent("3rd");
    expect(within(rows[0]!).getByLabelText("Rating change")).toHaveTextContent("-7");
    expect(rows[0]).toHaveTextContent("1213");

    expect(rows[1]).toHaveTextContent("2v2 Teams");
    expect(rows[1]).toHaveTextContent("Team won");
    expect(within(rows[1]!).getByLabelText("Rating change")).toHaveTextContent("+20");

    expect(rows[2]).toHaveTextContent("Unrated");
    expect(within(rows[2]!).getByLabelText("Rating change")).toHaveTextContent("±0");
  });

  it("loads more pages on demand", () => {
    paginated.results = [entry({})];
    paginated.status = "CanLoadMore";
    render(<MatchHistory />);
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(paginated.loadMore).toHaveBeenCalledWith(10);
  });

  it("hides the load more button once exhausted", () => {
    paginated.results = [entry({})];
    render(<MatchHistory />);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });
});

describe("Leaderboard", () => {
  it("ranks players and highlights the viewer", () => {
    queryResults["history:leaderboard"] = [
      { rank: 1, username: "alice", displayName: "Alice", rating: 1240, ratedGames: 3, wins: 3 },
      { rank: 2, username: "bob", displayName: "Bob", rating: 1180, ratedGames: 2, wins: 0 },
    ];
    render(<Leaderboard highlight="bob" />);
    const rows = screen.getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("1. Alice");
    expect(rows[0]).toHaveTextContent("1240");
    expect(rows[1]).toHaveAttribute("aria-current", "true");
    expect(rows[0]).not.toHaveAttribute("aria-current");
  });

  it("shows an empty state", () => {
    queryResults["history:leaderboard"] = [];
    render(<Leaderboard />);
    expect(screen.getByText("No rated games played yet.")).toBeInTheDocument();
  });
});

describe("RatingResultBanner", () => {
  const roomId = "room_1" as never;
  const result = (rated: boolean) => ({
    matchId: "m1",
    queue: "duel",
    mode: "1v1",
    rated,
    kind: "ranked",
    endReason: rated ? "sole_survivor" : "abandoned",
    startedAt: 1,
    finishedAt: 2,
    participants: [
      { username: "a", displayName: "A", color: "red", placement: 1, won: true, ratingBefore: 1200, ratingAfter: 1220, delta: 20 },
      { username: "b", displayName: "B", color: "yellow", placement: 2, won: false, ratingBefore: 1200, ratingAfter: 1180, delta: -20 },
    ],
  });

  it("shows the viewer's own rating change", () => {
    queryResults["history:getRoomResult"] = result(true);
    render(<RatingResultBanner roomId={roomId} myColor="yellow" />);
    expect(screen.getByRole("status")).toHaveTextContent("-20 rating");
    expect(screen.getByRole("status")).toHaveTextContent("1200 → 1180");
  });

  it("waits for settlement", () => {
    queryResults["history:getRoomResult"] = null;
    render(<RatingResultBanner roomId={roomId} myColor="red" />);
    expect(screen.getByRole("status")).toHaveTextContent("Updating ratings…");
  });

  it("says when the game was unrated", () => {
    queryResults["history:getRoomResult"] = result(false);
    render(<RatingResultBanner roomId={roomId} myColor="red" />);
    expect(screen.getByRole("status")).toHaveTextContent(/Unrated/);
  });

  it("renders nothing for a viewer without a seat", () => {
    queryResults["history:getRoomResult"] = result(true);
    const { container } = render(<RatingResultBanner roomId={roomId} myColor={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
