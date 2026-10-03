import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { GameError } from "../../convex/lib/errors";

const h = vi.hoisted(() => ({
  calls: [] as Array<{ fn: string; args: unknown }>,
  queryResults: {} as Record<string, unknown>,
  mutationErrors: {} as Record<string, Error>,
  push: (() => {}) as (href: string) => void,
  boardProps: null as null | { selectableTokens: unknown[]; myColor?: string },
  diceProps: null as null | { disabled: boolean },
}));

vi.mock("convex/react", () => ({
  useQuery: (ref: unknown, args: unknown) =>
    args === "skip" ? undefined : h.queryResults[getFunctionName(ref as never)],
  useMutation: (ref: unknown) => {
    const fn = getFunctionName(ref as never);
    return (args: unknown) => {
      h.calls.push({ fn, args });
      const err = h.mutationErrors[fn];
      return err ? Promise.reject(err) : Promise.resolve(null);
    };
  },
  useConvex: () => ({
    connectionState: () => ({ isWebSocketConnected: true }),
    subscribeToConnectionState: () => () => {},
  }),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: (href: string) => h.push(href) }) }));
vi.mock("next/dynamic", () => ({
  default: () =>
    function GameScreenStub(props: { spectate?: { count: number }; clientId: string }) {
      return <div data-testid="game-screen" data-count={props.spectate?.count} data-client={props.clientId} />;
    },
}));
vi.mock("@/lib/sounds", () => ({
  bindAudioUnlock: () => {},
  isMuted: () => true,
  playSound: () => {},
  setMuted: () => {},
}));
vi.mock("@/lib/haptics", () => ({ haptic: () => {} }));
vi.mock("@/components/Board", () => ({
  Board: (props: { selectableTokens: unknown[]; myColor?: string }) => {
    h.boardProps = props;
    return <div data-testid="board" />;
  },
}));
vi.mock("@/components/Dice", () => ({
  Dice: (props: { disabled: boolean }) => {
    h.diceProps = props;
    return <button type="button" disabled={props.disabled}>Roll</button>;
  },
}));

const { GameScreen } = await import("@/components/GameScreen");
const { LiveGames } = await import("@/components/LiveGames");
const { SpectateClient } = await import("@/app/spectate/[code]/SpectateClient");

const ROOM_ID = "room_1_abcdefghijklmnop" as never;
const SPECTATOR = "00000000-0000-4000-8000-000000000900";

function roomBundle(over: { status?: "lobby" | "playing" | "finished"; me?: boolean; ranked?: boolean } = {}) {
  const status = over.status ?? "playing";
  return {
    room: {
      _id: ROOM_ID,
      code: "ABCDEF",
      status,
      currentTurn: "red" as const,
      diceValue: null,
      diceRolled: false,
      consecutiveSixes: 0,
      turnId: 3,
      turnStartedAt: Date.now(),
      turnTimeoutMs: 60_000,
      winner: status === "finished" ? ("red" as const) : null,
      rankings: status === "finished" ? (["red", "yellow"] as const).slice() : [],
      lastEvent: undefined,
      events: [],
      eventSeq: 9,
      createdAt: 1,
      finishedAt: status === "finished" ? 2 : null,
      vsComputer: false,
      ranked: over.ranked ?? true,
      mode: "1v1" as const,
      winningTeam: null,
      passedRollTo: null,
    },
    players: [
      { _id: "p1", name: "Alice", color: "red" as const, connected: true, lives: 3, eliminated: false, finishRank: status === "finished" ? 1 : null, isMe: !!over.me, isHost: true, isBot: false, team: null },
      { _id: "p2", name: "Bob", color: "yellow" as const, connected: true, lives: 3, eliminated: false, finishRank: status === "finished" ? 2 : null, isMe: false, isHost: false, isBot: false, team: null },
    ],
    tokens: [0, 1, 2, 3].flatMap((index) => [
      { _id: `r${index}`, color: "red" as const, index, steps: -1 },
      { _id: `y${index}`, color: "yellow" as const, index, steps: -1 },
    ]),
    me: over.me ? { color: "red" as const, name: "Alice", isHost: true } : null,
  } as never;
}

function fnsCalled() {
  return h.calls.map((c) => c.fn);
}

beforeEach(() => {
  h.calls = [];
  h.queryResults = {};
  h.mutationErrors = {};
  h.push = vi.fn();
  h.boardProps = null;
  h.diceProps = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GameScreen in spectate mode", () => {
  it("control: a seated player gets turn controls and heartbeats", () => {
    render(<GameScreen data={roomBundle({ me: true })} roomId={ROOM_ID} clientId={SPECTATOR} />);
    expect(screen.getByText("YOUR TURN")).toBeInTheDocument();
    expect(h.diceProps?.disabled).toBe(false);
    expect(fnsCalled()).toContain("rooms:heartbeat");
  });

  it("is read-only: badge, no turn controls, no seat heartbeats or metrics", async () => {
    vi.useFakeTimers();
    // Even a bundle that claims a seat must not unlock controls in spectate mode.
    render(
      <GameScreen data={roomBundle({ me: true })} roomId={ROOM_ID} clientId={SPECTATOR} spectate={{ count: 3 }} />,
    );
    expect(screen.getByText("Spectating · 3 watching")).toBeInTheDocument();
    expect(screen.queryByText("YOUR TURN")).toBeNull();
    expect(screen.queryByRole("button", { name: "Troubleshoot connection" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Leave game" })).toBeNull();
    expect(h.diceProps?.disabled).toBe(true);
    expect(h.boardProps?.selectableTokens).toEqual([]);
    expect(h.boardProps?.myColor).toBeUndefined();

    await act(async () => {
      vi.advanceTimersByTime(60_000);
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(fnsCalled()).toEqual([]);
  });

  it("stop watching goes home without leaving any seat", () => {
    render(<GameScreen data={roomBundle()} roomId={ROOM_ID} clientId={SPECTATOR} spectate={{ count: 1 }} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop watching" }));
    expect(h.push).toHaveBeenCalledWith("/");
    expect(fnsCalled()).not.toContain("rooms:leaveRoom");
  });

  it("a finished game shows results with no rematch control", () => {
    h.queryResults["history:getRoomResult"] = null;
    render(
      <GameScreen data={roomBundle({ status: "finished", ranked: false })} roomId={ROOM_ID} clientId={SPECTATOR} spectate={{ count: 1 }} />,
    );
    expect(screen.getByText("Match over.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Play again" })).toBeNull();
    expect(screen.queryByText(/Waiting for host/)).toBeNull();
  });
});

describe("LiveGames", () => {
  it("lists live ranked games with ratings, watcher counts and watch links", () => {
    h.queryResults["spectate:listLive"] = [
      {
        code: "ABCDEF",
        queue: "duel",
        mode: "1v1",
        startedAt: 1,
        spectators: 4,
        players: [
          { name: "Alice", color: "red", team: null, rating: 1240, connected: true },
          { name: "Bob", color: "yellow", team: null, rating: 1180, connected: true },
        ],
      },
    ];
    render(<LiveGames />);
    const row = screen.getAllByRole("listitem")[0]!;
    expect(row).toHaveTextContent("Alice (1240)");
    expect(row).toHaveTextContent("vs");
    expect(row).toHaveTextContent("Bob (1180)");
    expect(row).toHaveTextContent("4 watching");
    expect(within(row).getByRole("link", { name: "Watch game ABCDEF" })).toHaveAttribute("href", "/spectate/ABCDEF");
  });

  it("shows an empty state and watches a private room by code", () => {
    h.queryResults["spectate:listLive"] = [];
    render(<LiveGames />);
    expect(screen.getByText("No ranked games in progress right now.")).toBeInTheDocument();
    const submit = screen.getByRole("button", { name: "Watch game" });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Watch by room code"), { target: { value: "xy-z234" } });
    fireEvent.click(submit);
    expect(h.push).toHaveBeenCalledWith("/spectate/XYZ234");
  });
});

describe("SpectateClient", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("joins as a watcher, renders the read-only screen, and leaves on unmount", async () => {
    h.queryResults["spectate:getSpectatorRoom"] = { view: roomBundle(), spectators: 2 };
    const { unmount } = render(<SpectateClient code="abcdef" />);
    const screenEl = await screen.findByTestId("game-screen");
    expect(screenEl).toHaveAttribute("data-count", "2");
    const join = h.calls.find((c) => c.fn === "spectate:joinSpectate");
    expect(join?.args).toMatchObject({ roomId: ROOM_ID });
    unmount();
    expect(fnsCalled()).toContain("spectate:leaveSpectate");
  });

  it("does not join a lobby and says the game hasn't started", async () => {
    h.queryResults["spectate:getSpectatorRoom"] = { view: roomBundle({ status: "lobby" }), spectators: 0 };
    render(<SpectateClient code="ABCDEF" />);
    expect(await screen.findByText(/hasn't started yet/)).toBeInTheDocument();
    expect(fnsCalled()).not.toContain("spectate:joinSpectate");
  });

  it("shows not found for unknown codes", () => {
    h.queryResults["spectate:getSpectatorRoom"] = null;
    render(<SpectateClient code="ABCDEF" />);
    expect(screen.getByText("Game not found")).toBeInTheDocument();
  });

  it("sends a seated player back to their seat", async () => {
    h.queryResults["spectate:getSpectatorRoom"] = { view: roomBundle(), spectators: 0 };
    h.mutationErrors["spectate:joinSpectate"] = new Error(GameError.spectatorIsPlayer);
    render(<SpectateClient code="ABCDEF" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(GameError.spectatorIsPlayer);
    expect(screen.getByRole("link", { name: "Go to your seat" })).toHaveAttribute("href", "/room/ABCDEF");
  });
});
