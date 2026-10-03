import { describe, expect, it } from "vitest";
import {
  createEmptyState,
  isReplayError,
  replayGame,
  replayWithTrace,
  type LudoEvent,
  type ReplayError,
} from "../../../convex/lib/game";
import { ev, makeEvent, seqify } from "../fixtures/events";
import { finishedGame, started1v1 } from "../fixtures/histories";

const sim = finishedGame(9);
const history = () => sim.events.map((e) => structuredClone(e));

function renumber(events: LudoEvent[]): LudoEvent[] {
  return events.map((e, i) => makeEvent(e, i + 1, { createdAt: e.createdAt }));
}

/** Index of the first DICE_ROLLED that is immediately followed by its TOKEN_MOVED. */
function rollBeforeMove(events: LudoEvent[]): number {
  const i = events.findIndex(
    (e, j) => e.eventType === "DICE_ROLLED" && events[j + 1]?.eventType === "TOKEN_MOVED",
  );
  if (i < 0) throw new Error("fixture has no roll followed by a move");
  return i;
}

function replayFailure(events: LudoEvent[], firstSeq?: number): ReplayError {
  let thrown: unknown;
  try {
    replayGame(createEmptyState(), events, firstSeq ? { firstSeq } : undefined);
  } catch (e) {
    thrown = e;
  }
  expect(thrown, "replay should have failed").toBeDefined();
  expect(thrown).not.toBeInstanceOf(Error);
  expect(isReplayError(thrown), `not a ReplayError: ${String(thrown)}`).toBe(true);
  return thrown as ReplayError;
}

/** replayGame and replayWithTrace must agree on where and why a history is corrupt. */
function expectCorrupt(
  events: LudoEvent[],
  expected: { seq: number; eventType?: string; reason: string | RegExp },
) {
  const err = replayFailure(events);
  expect(err.seq).toBe(expected.seq);
  if (expected.eventType) expect(err.eventType).toBe(expected.eventType);
  if (typeof expected.reason === "string") expect(err.reason).toBe(expected.reason);
  else expect(err.reason).toMatch(expected.reason);

  const trace = replayWithTrace(createEmptyState(), events);
  expect(trace.error, "replayWithTrace must report the corruption").toBeDefined();
  expect(trace.error).toMatchObject({ seq: err.seq, eventType: err.eventType, reason: err.reason });
  return { err, trace };
}

describe("corrupted history", () => {
  it("the uncorrupted fixture replays cleanly", () => {
    expect(replayGame(createEmptyState(), history()).state).toEqual(sim.final);
    expect(replayWithTrace(createEmptyState(), history()).error).toBeUndefined();
  });

  describe("missing events", () => {
    it("a dropped event leaves a seq gap", () => {
      const events = history();
      const i = rollBeforeMove(events);
      events.splice(i, 1);
      expectCorrupt(events, { seq: i + 2, reason: "Seq not contiguous" });
    });

    it("a dropped roll that is renumbered over is caught by the reducer", () => {
      const events = history();
      const i = rollBeforeMove(events);
      events.splice(i, 1);
      const { err } = expectCorrupt(renumber(events), {
        seq: i + 1,
        eventType: "TOKEN_MOVED",
        reason: "Roll first",
      });
      expect(err.stateBefore).toEqual(sim.states[i]);
    });

    it("a dropped first event is a first-seq mismatch", () => {
      expectCorrupt(history().slice(1), { seq: 2, reason: "First seq mismatch" });
    });
  });

  describe("duplicate events", () => {
    it("an event repeated with the same seq", () => {
      const events = history();
      const i = rollBeforeMove(events);
      events.splice(i + 1, 0, structuredClone(events[i]!));
      expectCorrupt(events, { seq: i + 1, reason: "Seq not contiguous" });
    });

    it("a repeated roll renumbered into sequence is rejected as a second roll", () => {
      const events = history();
      const i = rollBeforeMove(events);
      events.splice(i + 1, 0, structuredClone(events[i]!));
      const { err, trace } = expectCorrupt(renumber(events), {
        seq: i + 2,
        eventType: "DICE_ROLLED",
        reason: "Dice already rolled",
      });
      expect(err.stateBefore).toEqual(sim.states[i + 1]);
      expect(trace.states).toEqual(sim.states.slice(0, i + 2));
    });
  });

  describe("renumbered events", () => {
    it("a history shifted to start at 11 is rejected by default", () => {
      const shifted = history().map((e) => makeEvent(e, e.seq + 10, { createdAt: e.createdAt }));
      expectCorrupt(shifted, { seq: 11, reason: "First seq mismatch" });
    });

    it("the same shifted history replays when firstSeq says so", () => {
      const shifted = history().map((e) => makeEvent(e, e.seq + 10, { createdAt: e.createdAt }));
      expect(replayGame(createEmptyState(), shifted, { firstSeq: 11 }).state).toEqual(sim.final);
    });

    it("two events swapped in seq order", () => {
      const events = history();
      const i = rollBeforeMove(events);
      [events[i], events[i + 1]] = [events[i + 1]!, events[i]!];
      expectCorrupt(events, { seq: i + 2, reason: "Seq not contiguous" });
    });

    it("a seq whose eventId was not updated", () => {
      const events = history();
      events[7] = { ...events[7]!, eventId: `${events[7]!.gameId}:99` };
      expectCorrupt(events, { seq: 8, reason: "eventId mismatch" });
    });
  });

  describe("bad payloads", () => {
    const cases: Array<[string, (e: LudoEvent) => unknown]> = [
      ["null payload", () => null],
      ["empty payload", () => ({})],
      ["dice value as a string", (e) => ({ ...e.payload, value: "6" })],
      ["dice value out of range", (e) => ({ ...e.payload, value: 7 })],
      ["fractional dice value", (e) => ({ ...e.payload, value: 2.5 })],
      ["unknown colour", (e) => ({ ...e.payload, color: "purple" })],
    ];

    it.each(cases)("DICE_ROLLED with %s fails as a ReplayError", (_label, corrupt) => {
      const events = history();
      const i = rollBeforeMove(events);
      events[i] = { ...events[i]!, payload: corrupt(events[i]!) } as unknown as LudoEvent;
      const { err } = expectCorrupt(events, { seq: i + 1, eventType: "DICE_ROLLED", reason: /.+/ });
      expect(err.stateBefore).toEqual(sim.states[i]);
    });

    it.each([
      ["null payload", null],
      ["missing token index", { tokenColor: "red" }],
      ["negative token index", { tokenColor: "red", tokenIndex: -1 }],
      ["token index as a string", { tokenColor: "red", tokenIndex: "0" }],
    ] as const)("TOKEN_MOVED with %s fails as a ReplayError", (_label, payload) => {
      const events = history();
      const i = rollBeforeMove(events) + 1;
      events[i] = { ...events[i]!, payload } as unknown as LudoEvent;
      expectCorrupt(events, { seq: i + 1, eventType: "TOKEN_MOVED", reason: /.+/ });
    });

    it("GAME_STARTED without seats fails as a ReplayError", () => {
      const events = history();
      const i = events.findIndex((e) => e.eventType === "GAME_STARTED");
      events[i] = {
        ...events[i]!,
        payload: { ...events[i]!.payload, seats: undefined },
      } as unknown as LudoEvent;
      expectCorrupt(events, { seq: i + 1, eventType: "GAME_STARTED", reason: /.+/ });
    });

    it("an event with no actor fails as a ReplayError", () => {
      const events = history();
      const i = rollBeforeMove(events);
      const { actor: _actor, ...rest } = events[i]!;
      events[i] = rest as unknown as LudoEvent;
      expectCorrupt(events, { seq: i + 1, eventType: "DICE_ROLLED", reason: /.+/ });
    });
  });

  it("an unknown event type", () => {
    const events = history();
    events[6] = { ...events[6]!, eventType: "TOKEN_TELEPORTED" } as unknown as LudoEvent;
    expectCorrupt(events, { seq: 7, eventType: "TOKEN_TELEPORTED", reason: /Unknown event/ });
  });

  describe("illegal transitions", () => {
    it("a turn handed to the wrong seat", () => {
      const events = history();
      const i = events.findIndex((e, j) => j > 5 && e.eventType === "TURN_STARTED");
      const started = events[i]! as Extract<LudoEvent, { eventType: "TURN_STARTED" }>;
      const other = started.payload.seat === "red" ? "yellow" : "red";
      events[i] = makeEvent(ev.turnStarted(other), i + 1, { createdAt: events[i]!.createdAt });
      expectCorrupt(events, { seq: i + 1, eventType: "TURN_STARTED", reason: "Turn seat mismatch" });
    });

    it("a move of a token that is not legal for the roll", () => {
      const events = history();
      const i = rollBeforeMove(events) + 1;
      const moved = events[i]! as Extract<LudoEvent, { eventType: "TOKEN_MOVED" }>;
      const rival = moved.payload.tokenColor === "red" ? "yellow" : "red";
      events[i] = makeEvent(
        ev.tokenMoved(moved.payload.tokenColor, rival, 0),
        i + 1,
        { createdAt: moved.createdAt },
      );
      expectCorrupt(events, { seq: i + 1, eventType: "TOKEN_MOVED", reason: "Illegal move" });
    });

    it("events appended after GAME_FINISHED", () => {
      const events = history();
      const tail = seqify([ev.turnStarted("red")], events.length);
      expectCorrupt([...events, ...tail], {
        seq: events.length + 1,
        eventType: "TURN_STARTED",
        reason: /finished/i,
      });
    });
  });

  describe("mixed gameId", () => {
    it("an event from another game spliced in with a consistent eventId", () => {
      const events = history();
      const other = "other_game" as LudoEvent["gameId"];
      events[9] = makeEvent(events[9]!, 10, { gameId: other, createdAt: events[9]!.createdAt });
      expectCorrupt(events, { seq: 10, reason: /gameId/ });
    });

    it("an entire log from another game is fine on its own", () => {
      const other = "other_game" as LudoEvent["gameId"];
      const events = history().map((e) => makeEvent(e, e.seq, { gameId: other, createdAt: e.createdAt }));
      expect(replayGame(createEmptyState(), events).state).toEqual(sim.final);
    });
  });

  describe("replayWithTrace never reports partial success", () => {
    it("a history that stops mid-move is an error, not a shorter success", () => {
      const events = started1v1();
      const tail = seqify([ev.diceRolled("red", 6), ev.tokenMoved("red", "red", 0)], events.length);
      const all = [...events, ...tail];
      const err = replayFailure(all);
      expect(err.reason).toBe("Replay ended with pending settle");
      const trace = replayWithTrace(createEmptyState(), all);
      expect(trace.error).toMatchObject({ reason: "Replay ended with pending settle" });
    });

    it("states stop at the last good event", () => {
      const events = history();
      const i = rollBeforeMove(events);
      events.splice(i, 1);
      const trace = replayWithTrace(createEmptyState(), events);
      expect(trace.error).toBeDefined();
      expect(trace.states).toEqual(sim.states.slice(0, i + 1));
    });

    it("the error carries the state from just before the failing event", () => {
      const events = history();
      const i = rollBeforeMove(events);
      events.splice(i, 1);
      const trace = replayWithTrace(createEmptyState(), renumber(events));
      expect(trace.error?.stateBefore).toEqual(trace.states.at(-1));
    });
  });
});
