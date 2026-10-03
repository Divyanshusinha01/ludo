import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import {
  createEmptyState,
  replayGame,
  type LudoEvent,
} from "../../convex/lib/game";
import { finishedGame, scriptedOpening1v1 } from "../game/fixtures/histories";
import { GAME_ID } from "../game/fixtures/events";

type PageArgs = { afterSeq: number; limit: number };
type Request = { query: unknown; args: PageArgs };

const server = vi.hoisted(() => ({
  events: [] as LudoEvent[],
  eventSeq: 0,
  requests: [] as PageArgs[],
  pageCache: new Map<string, unknown>(),
}));

vi.mock("@/lib/player", () => ({ useSessionId: () => "client-1" }));

vi.mock("convex/react", () => ({
  useQuery: (query: unknown) => {
    if (getFunctionName(query as never) !== "rooms:getRoomByCode") {
      throw new Error(`unexpected useQuery ${getFunctionName(query as never)}`);
    }
    return { room: { _id: GAME_ID, eventSeq: server.eventSeq } };
  },
  useQueries: (requests: Record<string, Request>) => {
    const out: Record<string, unknown> = {};
    for (const [key, req] of Object.entries(requests)) {
      expect(getFunctionName(req.query as never)).toBe("gameEvents:listEvents");
      const cacheKey = `${req.args.afterSeq}:${req.args.limit}`;
      if (!server.pageCache.has(cacheKey)) {
        server.requests.push(req.args);
        server.pageCache.set(cacheKey, listEventsPage(req.args));
      }
      out[key] = server.pageCache.get(cacheKey);
    }
    return out;
  },
}));

/** Mirrors `gameEvents.listEvents`: pages capped at 200, cursor via nextAfterSeq. */
function listEventsPage({ afterSeq, limit }: PageArgs) {
  const capped = Math.min(limit, 200);
  const rows = server.events.filter((e) => e.seq > afterSeq).slice(0, capped + 1);
  const page = rows.slice(0, capped);
  const hasMore = rows.length > capped;
  return { events: page, nextAfterSeq: hasMore ? (page.at(-1)?.seq ?? null) : null };
}

function setLog(events: LudoEvent[]) {
  server.events = events;
  server.eventSeq = events.at(-1)?.seq ?? 0;
  server.requests = [];
  server.pageCache.clear();
}

const { ReplayClient } = await import("@/app/debug/replay/[code]/ReplayClient");

function inspector() {
  return JSON.parse(screen.getByTestId("replay-inspector").textContent ?? "null") as {
    selectedEvent: LudoEvent | null;
    state: unknown;
  };
}

function rows() {
  return within(screen.getByRole("list")).getAllByRole("button");
}

const plain = (v: unknown) => JSON.parse(JSON.stringify(v)) as unknown;

describe("ReplayClient", () => {
  beforeEach(() => setLog(scriptedOpening1v1()));

  it("lists every event with its seq and type", () => {
    render(<ReplayClient code="ABCD" />);
    const events = server.events;
    expect(rows()).toHaveLength(events.length);
    events.forEach((e, i) => {
      expect(rows()[i]).toHaveTextContent(`${e.seq} · ${e.eventType}`);
    });
    expect(screen.getByText(new RegExp(`${events.length} events loaded`))).toBeInTheDocument();
  });

  it("starts at the empty state with no event selected or highlighted", () => {
    render(<ReplayClient code="ABCD" />);
    expect(inspector()).toEqual({ selectedEvent: null, state: plain(createEmptyState()) });
    expect(screen.queryByRole("button", { current: "step" })).toBeNull();
  });

  it("clicking an event shows its payload and the state after it, and highlights that row", () => {
    render(<ReplayClient code="ABCD" />);
    const events = server.events;
    const i = events.findIndex((e) => e.eventType === "DICE_ROLLED");
    fireEvent.click(rows()[i]!);

    const shown = inspector();
    expect(shown.selectedEvent).toEqual(plain(events[i]));
    expect(shown.selectedEvent?.payload).toEqual(plain(events[i]!.payload));
    expect(shown.state).toEqual(plain(replayGame(createEmptyState(), events.slice(0, i + 1)).state));

    expect(rows()[i]).toHaveAttribute("aria-current", "step");
    expect(screen.getAllByRole("button", { current: "step" })).toHaveLength(1);
  });

  it("Prev and Next step through events and stay in bounds", () => {
    render(<ReplayClient code="ABCD" />);
    const events = server.events;
    const prev = screen.getByRole("button", { name: "Prev" });
    const next = screen.getByRole("button", { name: "Next" });

    fireEvent.click(prev);
    expect(inspector().selectedEvent).toBeNull();

    for (let i = 0; i < events.length; i++) {
      fireEvent.click(next);
      expect(inspector().selectedEvent?.seq).toBe(events[i]!.seq);
      expect(rows()[i]).toHaveAttribute("aria-current", "step");
    }
    fireEvent.click(next);
    expect(inspector().selectedEvent?.seq).toBe(events.at(-1)!.seq);

    fireEvent.click(prev);
    expect(inspector().selectedEvent?.seq).toBe(events.at(-2)!.seq);
    expect(rows()[events.length - 2]).toHaveAttribute("aria-current", "step");

    for (let i = 0; i < events.length + 3; i++) fireEvent.click(prev);
    expect(inspector().selectedEvent).toBeNull();
    expect(inspector().state).toEqual(plain(createEmptyState()));
  });

  it("fetches a log longer than 200 events across pages and the last step equals replayGame", () => {
    const sim = finishedGame(7);
    expect(sim.events.length).toBeGreaterThan(400);
    setLog(sim.events);

    render(<ReplayClient code="ABCD" />);
    expect(rows()).toHaveLength(sim.events.length);
    expect(server.requests.length).toBe(Math.ceil(sim.events.length / 200));
    expect(server.requests.every((r) => r.limit <= 200)).toBe(true);
    expect(server.requests.map((r) => r.afterSeq)).toEqual(
      server.requests.map((_, i) => i * 200),
    );
    expect(screen.queryByText(/loading more/)).toBeNull();

    fireEvent.click(rows().at(-1)!);
    const final = replayGame(createEmptyState(), sim.events).state;
    expect(inspector().state).toEqual(plain(final));
    expect(inspector().state).toEqual(plain(sim.final));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a replay error banner for a corrupted log", () => {
    const events = scriptedOpening1v1();
    const gap = events.filter((e) => e.seq !== 6);
    setLog(gap);

    render(<ReplayClient code="ABCD" />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Replay error at seq 7: Seq not contiguous",
    );

    fireEvent.click(rows().at(-1)!);
    expect(inspector().state).toEqual(
      plain(replayGame(createEmptyState(), events.slice(0, 5)).state),
    );
  });
});
