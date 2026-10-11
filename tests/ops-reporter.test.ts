import { describe, expect, it, vi } from "vitest";
import { GameError } from "../convex/lib/errors";
import { MAX_LATENCY_MS } from "../convex/lib/metrics";
import {
  classifyError,
  convexErrorMessage,
  isRateLimitedError,
  isStaleError,
  OPS_BATCH_MAX,
  OPS_QUEUE_MAX,
  OpsReporter,
  type OpsEvent,
} from "../src/lib/opsReporter";

function convexError(message: string): Error {
  return new Error(
    `[CONVEX M(game:rollDice)] [Request ID: abc] Server Error\nUncaught Error: ${message}\n    at handler (../convex/game.ts:10:3)`,
  );
}

describe("error classification", () => {
  it("unwraps Convex's server error wrapper", () => {
    expect(convexErrorMessage(convexError(GameError.notYourTurn))).toBe(GameError.notYourTurn);
    expect(convexErrorMessage(new Error("plain"))).toBe("plain");
    expect(convexErrorMessage("nope")).toBe("");
  });

  it("maps stale, rate-limited, rejected and unknown errors to fixed outcomes", () => {
    expect(classifyError(convexError(GameError.staleAction))).toMatchObject({ outcome: "stale", code: "stale" });
    expect(classifyError(convexError(GameError.rateLimited))).toMatchObject({
      outcome: "rate_limited",
      code: "rate_limited",
    });
    expect(classifyError(convexError(GameError.illegalMove))).toMatchObject({
      outcome: "rejected",
      code: "illegal_move",
    });
    expect(classifyError(new Error("socket closed"))).toMatchObject({ outcome: "error", code: "internal" });
  });

  it("detects stale rejections only", () => {
    expect(isStaleError(convexError(GameError.staleAction))).toBe(true);
    expect(isStaleError(convexError(GameError.turnExpired))).toBe(false);
  });

  it("detects rate-limited rejections only", () => {
    expect(isRateLimitedError(convexError(GameError.rateLimited))).toBe(true);
    expect(isRateLimitedError(convexError(GameError.staleAction))).toBe(false);
  });
});

describe("OpsReporter", () => {
  const ok = (kind: OpsEvent["kind"] = "roll"): OpsEvent => ({ kind, outcome: "ok", latencyMs: 12 });

  it("does not send when empty", async () => {
    const send = vi.fn(async () => ({ accepted: 0 }));
    await new OpsReporter(send).flush();
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps events until a transport is attached", async () => {
    const r = new OpsReporter();
    r.record(ok());
    await r.flush();
    expect(r.pending).toBe(1);
    const send = vi.fn(async (events: OpsEvent[]) => ({ accepted: events.length }));
    r.setSend(send);
    await r.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(r.pending).toBe(0);
  });

  it("clamps latency and sends at most one server batch per flush", async () => {
    const send = vi.fn(async (events: OpsEvent[]) => ({ accepted: events.length }));
    const r = new OpsReporter(send);
    r.record({ kind: "move", outcome: "ok", latencyMs: 10 * MAX_LATENCY_MS });
    r.record({ kind: "move", outcome: "ok", latencyMs: -5 });
    for (let i = 0; i < OPS_BATCH_MAX; i++) r.record(ok());
    await r.flush();
    const first = send.mock.calls[0]![0];
    expect(first).toHaveLength(OPS_BATCH_MAX);
    expect(first[0]!.latencyMs).toBe(MAX_LATENCY_MS);
    expect(first[1]!.latencyMs).toBe(0);
    expect(r.pending).toBe(2);
  });

  it("requeues a rate-limited or failed batch in order", async () => {
    let mode: "limited" | "fail" | "ok" = "limited";
    const send = vi.fn(async (events: OpsEvent[]) => {
      if (mode === "fail") throw new Error("offline");
      return { accepted: mode === "ok" ? events.length : 0 };
    });
    const r = new OpsReporter(send);
    r.record(ok("roll"));
    await r.flush();
    r.record(ok("move"));
    mode = "fail";
    await r.flush();
    expect(r.pending).toBe(2);
    mode = "ok";
    await r.flush();
    expect(send.mock.calls.at(-1)![0].map((e) => e.kind)).toEqual(["roll", "move"]);
    expect(r.pending).toBe(0);
  });

  it("serializes flushes", async () => {
    let release: () => void = () => {};
    const send = vi.fn(
      (events: OpsEvent[]) =>
        new Promise<{ accepted: number }>((resolve) => {
          release = () => resolve({ accepted: events.length });
        }),
    );
    const r = new OpsReporter(send);
    r.record(ok());
    const first = r.flush();
    r.record(ok());
    await r.flush();
    expect(send).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(r.pending).toBe(1);
  });

  it("caps the queue by dropping the oldest events", () => {
    const r = new OpsReporter(async () => ({ accepted: 0 }));
    for (let i = 0; i < OPS_QUEUE_MAX + 10; i++) r.record(ok());
    expect(r.pending).toBe(OPS_QUEUE_MAX);
  });
});
