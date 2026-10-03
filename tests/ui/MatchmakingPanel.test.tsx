import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { getFunctionName } from "convex/server";

type Status =
  | { status: "idle" }
  | { status: "waiting"; queue: "duel" | "ffa4" | "team2v2"; joinedAt: number }
  | { status: "matched"; queue: "duel"; roomId: string; code: string; color: "red" }
  | { status: "inGame"; roomId: string; code: string }
  | null
  | undefined;

let queueStatus: Status;
let authStatus: "loading" | "signedIn" | "signedOut";
const push = vi.fn();
const mutations = {
  "matchmaking:joinQueue": vi.fn(),
  "matchmaking:leaveQueue": vi.fn(),
  "matchmaking:queuePing": vi.fn(),
};

vi.mock("convex/react", () => ({
  useQuery: (_ref: unknown, args: unknown) => (args === "skip" ? undefined : queueStatus),
  useMutation: (ref: Parameters<typeof getFunctionName>[0]) =>
    mutations[getFunctionName(ref) as keyof typeof mutations],
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: authStatus === "signedIn" }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));
vi.mock("@/lib/auth", () => ({
  useAuthState: () => ({ status: authStatus, profile: null, lastUsername: "" }),
}));

const { MatchmakingPanel } = await import("@/components/MatchmakingPanel");

const ROOM = { roomId: "room_id_0123456789abcdef", code: "ABC123" };

beforeEach(() => {
  queueStatus = { status: "idle" };
  authStatus = "signedIn";
  push.mockReset();
  for (const fn of Object.values(mutations)) fn.mockReset().mockResolvedValue({ status: "idle" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("MatchmakingPanel", () => {
  it("asks anonymous visitors to sign in", () => {
    authStatus = "signedOut";
    render(<MatchmakingPanel />);
    expect(screen.getByText(/Sign in on the home screen/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Find match" })).toBeNull();
  });

  it("joins the chosen queue", async () => {
    mutations["matchmaking:joinQueue"].mockResolvedValue({ status: "waiting", queue: "ffa4", joinedAt: 1 });
    render(<MatchmakingPanel />);
    fireEvent.click(screen.getByRole("radio", { name: "4-player free-for-all" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Find match" }));
    });
    expect(mutations["matchmaking:joinQueue"]).toHaveBeenCalledWith({
      clientId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      queue: "ffa4",
    });
  });

  it("shows elapsed time while waiting, pings, and cancels", async () => {
    vi.useFakeTimers({ now: 100_000 });
    queueStatus = { status: "waiting", queue: "team2v2", joinedAt: 100_000 };
    render(<MatchmakingPanel />);
    expect(screen.getByRole("status")).toHaveTextContent("Searching for 2v2 Teams…");
    act(() => {
      vi.advanceTimersByTime(65_000);
    });
    expect(screen.getByLabelText("Time searching")).toHaveTextContent("1:05");
    expect(mutations["matchmaking:queuePing"].mock.calls.length).toBeGreaterThanOrEqual(12);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel search" }));
    });
    expect(mutations["matchmaking:leaveQueue"]).toHaveBeenCalledWith({});
  });

  it("navigates to the room when a search started here is matched", async () => {
    mutations["matchmaking:joinQueue"].mockResolvedValue({ status: "waiting", queue: "duel", joinedAt: 1 });
    const view = render(<MatchmakingPanel />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Find match" }));
    });
    queueStatus = { status: "matched", queue: "duel", color: "red", ...ROOM };
    view.rerender(<MatchmakingPanel />);
    expect(push).toHaveBeenCalledWith(`/room/ABC123?rid=${ROOM.roomId}`);
  });

  it("offers a rejoin button instead of jumping when a match already exists", () => {
    queueStatus = { status: "inGame", ...ROOM };
    render(<MatchmakingPanel />);
    expect(push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Rejoin game" }));
    expect(push).toHaveBeenCalledWith(`/room/ABC123?rid=${ROOM.roomId}`);
  });

  it("goes straight to the game when joining finds one already running", async () => {
    mutations["matchmaking:joinQueue"].mockResolvedValue({ status: "inGame", ...ROOM });
    render(<MatchmakingPanel />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Find match" }));
    });
    expect(push).toHaveBeenCalledWith(`/room/ABC123?rid=${ROOM.roomId}`);
  });

  it("leaving the page cancels a search started here", async () => {
    mutations["matchmaking:joinQueue"].mockResolvedValue({ status: "waiting", queue: "duel", joinedAt: 1 });
    const view = render(<MatchmakingPanel />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Find match" }));
    });
    queueStatus = { status: "waiting", queue: "duel", joinedAt: 1 };
    view.rerender(<MatchmakingPanel />);
    view.unmount();
    expect(mutations["matchmaking:leaveQueue"]).toHaveBeenCalledTimes(1);
  });
});
