import { describe, expect, it } from "vitest";
import {
  createEmptyState,
  reduceAll,
  reducePartial,
  replayGame,
  replayWithTrace,
  type LudoEvent,
} from "../../../convex/lib/game";
import { ev, makeEvent, seqify } from "../fixtures/events";
import { scriptedOpening1v1, started1v1 } from "../fixtures/histories";
import { playingState } from "../fixtures/states";

const replay = (events: LudoEvent[], firstSeq?: number) =>
  replayGame(createEmptyState(), events, firstSeq ? { firstSeq } : undefined);

function renumber(events: LudoEvent[], seqs: number[]): LudoEvent[] {
  return events.map((e, i) => makeEvent(e, seqs[i]!, { createdAt: e.createdAt }));
}

describe("replayGame sequence numbers", () => {
  it("accepts a contiguous history starting at 1", () => {
    const events = scriptedOpening1v1();
    expect(replay(events).applied).toBe(events.length);
  });

  it("accepts an empty history", () => {
    expect(replay([]).state).toEqual(createEmptyState());
  });

  it("rejects a first event that is not seq 1", () => {
    const events = renumber(started1v1(), [2, 3, 4, 5, 6]);
    expect(() => replay(events)).toThrow(expect.objectContaining({ seq: 2, reason: "First seq mismatch" }));
  });

  it("honours a custom firstSeq", () => {
    const events = started1v1();
    expect(() => replay(events, 1)).not.toThrow();
    expect(() => replay(events, 2)).toThrow(expect.objectContaining({ seq: 1 }));
  });

  it("rejects a duplicate seq", () => {
    const events = renumber(started1v1(), [1, 2, 2, 3, 4]);
    expect(() => replay(events)).toThrow(expect.objectContaining({ seq: 2, reason: "Seq not contiguous" }));
  });

  it("rejects a gap", () => {
    const events = renumber(started1v1(), [1, 2, 3, 5, 6]);
    expect(() => replay(events)).toThrow(expect.objectContaining({ seq: 5, reason: "Seq not contiguous" }));
  });

  it("rejects seq going backwards", () => {
    const events = renumber(started1v1(), [1, 2, 4, 3, 5]);
    expect(() => replay(events)).toThrow(expect.objectContaining({ seq: 4, reason: "Seq not contiguous" }));
  });

  it("rejects an eventId that does not match gameId:seq", () => {
    const events = started1v1();
    events[2] = { ...events[2]!, eventId: "other:3" };
    expect(() => replay(events)).toThrow(expect.objectContaining({ seq: 3, reason: "eventId mismatch" }));
  });

  it("rejects a history that does not start with GAME_CREATED", () => {
    const events = seqify([ev.playerJoined({ color: "red", name: "RED", isBot: false })]);
    expect(() => replay(events)).toThrow(expect.objectContaining({ seq: 1, eventType: "PLAYER_JOINED" }));
  });

  it("replayWithTrace reports the same sequence errors without throwing", () => {
    const events = renumber(started1v1(), [1, 2, 3, 5, 6]);
    const trace = replayWithTrace(createEmptyState(), events);
    expect(trace.error).toMatchObject({ seq: 5, reason: "Seq not contiguous" });
    expect(trace.states).toHaveLength(4);
  });
});

describe("transaction boundaries", () => {
  const moving = () => {
    const s = playingState({ colors: ["red", "yellow"], steps: { red: [10] } });
    return { s, events: seqify([ev.diceRolled("red", 3), ev.tokenMoved("red", "red", 0)]) };
  };

  it("reduceAll rejects a transaction that leaves a move unresolved", () => {
    const { s, events } = moving();
    const result = reduceAll(s, events);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("incomplete");
  });

  it("reducePartial allows a pending move mid-transaction", () => {
    const { s, events } = moving();
    const result = reducePartial(s, events);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.state.settle).not.toBeNull();
  });

  it("replay rejects a history that ends mid-move", () => {
    const events = [...started1v1()];
    const tail = seqify(
      [ev.diceRolled("red", 6), ev.tokenMoved("red", "red", 0)],
      events.length,
    );
    expect(() => replay([...events, ...tail])).toThrow(
      expect.objectContaining({ reason: "Replay ended with pending settle" }),
    );
  });

  it("the first failing event stops the transaction and nothing after it applies", () => {
    const s = playingState({ colors: ["red", "yellow"], steps: { red: [10] } });
    const events = seqify([ev.diceRolled("red", 3), ev.diceRolled("red", 3), ev.tokenMoved("red", "red", 0)]);
    const result = reducePartial(s, events);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("dice_rolled");
  });
});
