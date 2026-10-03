import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalGameState,
  createEmptyState,
  replayGame,
  replayWithTrace,
  type LudoEvent,
} from "../../../convex/lib/game";
import { makeEvent } from "../fixtures/events";
import { finishedGame } from "../fixtures/histories";

const replay = (events: LudoEvent[]) => replayGame(createEmptyState(), events).state;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("replay determinism", () => {
  const { events } = finishedGame(21, ["red", "green", "yellow", "blue"]);

  it("replaying the same events many times yields deep-equal states", () => {
    const first = replay(events);
    for (let i = 0; i < 25; i++) {
      expect(replay(events)).toEqual(first);
    }
  });

  it("does not mutate the input events", () => {
    const copy = structuredClone(events);
    replay(events);
    expect(events).toEqual(copy);
  });

  it("ignores createdAt and actorClientId", () => {
    const retimed = events.map((e, i) => ({
      ...e,
      createdAt: 42 + i * 1000,
      actorClientId: `client-${i % 3}`,
    }));
    expect(canonicalGameState(replay(retimed))).toEqual(canonicalGameState(replay(events)));
  });

  it("never reads Math.random or Date.now", () => {
    const random = vi.spyOn(Math, "random");
    const now = vi.spyOn(Date, "now");
    replay(events);
    replayWithTrace(createEmptyState(), events);
    expect(random).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
  });

  it("replayWithTrace ends in the same state as replayGame, one state per event", () => {
    const trace = replayWithTrace(createEmptyState(), events);
    expect(trace.error).toBeUndefined();
    expect(trace.states).toHaveLength(events.length + 1);
    expect(trace.states.at(-1)).toEqual(replay(events));
  });

  it("swapping two adjacent events changes the outcome or is rejected", () => {
    const baseline = canonicalGameState(replay(events));
    let checked = 0;
    for (let i = 5; i < events.length - 1; i += 7) {
      const a = events[i]!;
      const b = events[i + 1]!;
      if (a.eventType === b.eventType && JSON.stringify(a.payload) === JSON.stringify(b.payload)) {
        continue;
      }
      const swapped = [...events];
      swapped[i] = makeEvent(b, a.seq, { createdAt: b.createdAt });
      swapped[i + 1] = makeEvent(a, b.seq, { createdAt: a.createdAt });
      let outcome: unknown;
      try {
        outcome = canonicalGameState(replay(swapped));
      } catch {
        outcome = "rejected";
      }
      expect(outcome).not.toEqual(baseline);
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
  });
});

describe("incremental build-up equals full replay", () => {
  it.each([
    ["1v1", 3, ["red", "yellow"], "1v1"],
    ["4p", 4, ["red", "green", "yellow", "blue"], "1v1"],
    ["2v2", 5, ["red", "green", "yellow", "blue"], "2v2"],
  ] as const)("%s: replaying every committed prefix matches the simulated state", (_l, seed, colors, mode) => {
    const sim = finishedGame(seed, [...colors], mode);
    for (const b of sim.boundaries) {
      expect(replay(sim.events.slice(0, b))).toEqual(sim.states[b]);
    }
  });
});
