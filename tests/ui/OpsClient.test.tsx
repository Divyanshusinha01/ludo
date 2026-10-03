import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { getFunctionName } from "convex/server";

type DashboardArgs = { token: string; nowMinute: number };

const server = vi.hoisted(() => ({
  result: undefined as unknown,
  error: null as Error | null,
  calls: [] as unknown[],
}));

vi.mock("convex/react", () => ({
  useQuery: (query: unknown, args: unknown) => {
    expect(getFunctionName(query as never)).toBe("ops:dashboard");
    server.calls.push(args);
    if (args === "skip") return undefined;
    if (server.error) throw server.error;
    return server.result;
  },
}));

const { OpsClient, OPS_TOKEN_KEY } = await import("@/app/ops/OpsClient");

const MINUTE = 60_000;
const windowEnd = 1_700_000_040_000 - (1_700_000_040_000 % MINUTE);

function emptyDashboard() {
  return {
    windowStart: windowEnd - 59 * MINUTE,
    windowEnd,
    hasData: false,
    gauges: null,
    perMinute: [],
    latency: [],
    totals: {
      mutations: 0,
      clientCalls: 0,
      stale: 0,
      rateLimited: 0,
      rejected: 0,
      errors: 0,
      resyncs: 0,
      serverReconnects: 0,
    },
    errorRate: null,
    reconnectSuccessRate: null,
    recentErrors: [],
  };
}

function populatedDashboard() {
  return {
    ...emptyDashboard(),
    hasData: true,
    gauges: { minute: windowEnd, activeRooms: 3, activePlayers: 11, connectedPlayers: 9 },
    perMinute: [
      { minute: windowEnd - MINUTE, mutations: 40, clientCalls: 30, failures: 1, stale: 2 },
      { minute: windowEnd, mutations: 25, clientCalls: 20, failures: 0, stale: 1 },
    ],
    latency: [
      { kind: "move", count: 20, p50: 42.4, p95: 180.6, p99: 390 },
      { kind: "roll", count: 30, p50: 31, p95: 96.2, p99: 140 },
    ],
    totals: {
      mutations: 65,
      clientCalls: 50,
      stale: 3,
      rateLimited: 0,
      rejected: 1,
      errors: 0,
      resyncs: 2,
      serverReconnects: 4,
    },
    errorRate: 1 / 50,
    reconnectSuccessRate: 0.75,
    recentErrors: [
      { at: windowEnd - 30_000, kind: "move", code: "illegal_move", message: "Illegal move" },
    ],
  };
}

function card(label: string) {
  const summary = screen.getByRole("region", { name: "Summary" });
  return within(summary).getByText(label).parentElement!;
}

function signIn(token = "secret") {
  fireEvent.change(screen.getByLabelText("Dashboard token"), { target: { value: token } });
  fireEvent.click(screen.getByRole("button", { name: "Open dashboard" }));
}

describe("OpsClient", () => {
  beforeEach(() => {
    sessionStorage.clear();
    server.result = undefined;
    server.error = null;
    server.calls = [];
  });

  it("shows the token gate and makes no query until a token is entered", () => {
    render(<OpsClient />);
    expect(screen.getByLabelText("Dashboard token")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open dashboard" })).toBeDisabled();
    expect(server.calls).toHaveLength(0);
  });

  it("stores the token in sessionStorage and queries with it and the current minute", () => {
    server.result = emptyDashboard();
    render(<OpsClient />);
    signIn(" secret ");

    expect(sessionStorage.getItem(OPS_TOKEN_KEY)).toBe("secret");
    const args = server.calls.at(-1) as DashboardArgs;
    expect(args.token).toBe("secret");
    expect(args.nowMinute % MINUTE).toBe(0);
    expect(Math.abs(args.nowMinute - Date.now())).toBeLessThan(2 * MINUTE);
  });

  it("reuses a token already in sessionStorage", () => {
    sessionStorage.setItem(OPS_TOKEN_KEY, "kept");
    server.result = emptyDashboard();
    render(<OpsClient />);
    expect(screen.queryByLabelText("Dashboard token")).toBeNull();
    expect((server.calls.at(-1) as DashboardArgs).token).toBe("kept");
  });

  it("shows a loading state while the query is pending", () => {
    sessionStorage.setItem(OPS_TOKEN_KEY, "kept");
    render(<OpsClient />);
    expect(screen.getByText("Loading metrics…")).toBeInTheDocument();
  });

  it("shows an explicit empty state with no data and no metric values", () => {
    sessionStorage.setItem(OPS_TOKEN_KEY, "kept");
    server.result = emptyDashboard();
    render(<OpsClient />);
    expect(screen.getByTestId("ops-empty")).toHaveTextContent(/No data/);
    expect(screen.queryByRole("region", { name: "Summary" })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("renders gauges, rates, latency percentiles, per-minute rows and recent errors", () => {
    sessionStorage.setItem(OPS_TOKEN_KEY, "kept");
    server.result = populatedDashboard();
    render(<OpsClient />);

    expect(card("Active rooms")).toHaveTextContent("3");
    expect(card("Active players")).toHaveTextContent("11");
    expect(card("Connected players")).toHaveTextContent("9");
    expect(card("Error rate")).toHaveTextContent("2.0%");
    expect(card("Reconnect success")).toHaveTextContent("75.0%");
    expect(card("Stale mutations")).toHaveTextContent("3");
    expect(card("Resyncs")).toHaveTextContent("2");
    expect(card("Server mutations")).toHaveTextContent("65");

    const latency = within(screen.getByRole("region", { name: "Latency" }));
    const moveRow = latency.getByText("move").closest("tr")!;
    expect(within(moveRow).getAllByRole("cell").map((c) => c.textContent)).toEqual([
      "move",
      "20",
      "42 ms",
      "181 ms",
      "390 ms",
    ]);

    const perMinute = within(screen.getByRole("region", { name: "Per minute" }));
    const minuteRows = perMinute.getAllByRole("row").slice(1);
    expect(minuteRows).toHaveLength(2);
    expect(within(minuteRows[0]!).getAllByRole("cell")[1]).toHaveTextContent("25");

    const errors = within(screen.getByRole("region", { name: "Recent errors" }));
    expect(errors.getByText("illegal_move")).toBeInTheDocument();
    expect(errors.getByText("Illegal move")).toBeInTheDocument();
  });

  it("shows 'no data' for null rates and missing gauges instead of zeros", () => {
    sessionStorage.setItem(OPS_TOKEN_KEY, "kept");
    server.result = {
      ...emptyDashboard(),
      hasData: true,
      recentErrors: [{ at: windowEnd, kind: "roll", code: "internal", message: "boom" }],
    };
    render(<OpsClient />);
    expect(card("Active rooms")).toHaveTextContent("no data");
    expect(card("Error rate")).toHaveTextContent("no data");
    expect(card("Reconnect success")).toHaveTextContent("no data");
    expect(screen.getByText("No latency samples.")).toBeInTheDocument();
  });

  it("returns to the token gate with an alert when the query rejects the token", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    sessionStorage.setItem(OPS_TOKEN_KEY, "wrong");
    server.error = new Error("Not authorized");
    render(<OpsClient />);

    expect(screen.getByRole("alert")).toHaveTextContent("Token rejected");
    expect(screen.getByLabelText("Dashboard token")).toBeInTheDocument();
    expect(sessionStorage.getItem(OPS_TOKEN_KEY)).toBeNull();

    server.error = null;
    server.result = emptyDashboard();
    signIn("right");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("ops-empty")).toBeInTheDocument();
    consoleError.mockRestore();
  });

  it("sign out clears the token", () => {
    sessionStorage.setItem(OPS_TOKEN_KEY, "kept");
    server.result = emptyDashboard();
    render(<OpsClient />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(sessionStorage.getItem(OPS_TOKEN_KEY)).toBeNull();
    expect(screen.getByLabelText("Dashboard token")).toBeInTheDocument();
  });
});
