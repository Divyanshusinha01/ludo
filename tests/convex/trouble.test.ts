import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../convex/_generated/api";
import { GameError } from "../../convex/lib/errors";
import { TROUBLE_MIN_INTERVAL_MS } from "../../convex/lib/session";
import {
  advance,
  clientId,
  setupConvex,
  startedRoom,
  teardownConvex,
  type DiceQueue,
  type T,
} from "./setup";

let t: T;
let dice: DiceQueue;

beforeEach(() => {
  ({ t, dice } = setupConvex());
});

afterEach(() => {
  teardownConvex(dice);
  vi.restoreAllMocks();
});

function troubleLogs(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return spy.mock.calls
    .map((call: unknown[]) => JSON.parse(String(call[0])) as Record<string, unknown>)
    .filter((entry: Record<string, unknown>) => entry.event === "trouble_report");
}

describe("reportTrouble", () => {
  it("caps every free-text field before it reaches the logs", async () => {
    const log = vi.spyOn(console, "log");
    const long = "x".repeat(10_000);
    await t.mutation(api.trouble.reportTrouble, {
      clientId: clientId(1),
      screen: "home",
      code: long,
      lastError: long,
      roomStatus: long,
      userAgent: long,
    });

    const [entry] = troubleLogs(log);
    expect(entry).toMatchObject({ clientId: clientId(1).slice(0, 8), screen: "home" });
    expect(String(entry!.code)).toHaveLength(6);
    expect(String(entry!.lastError)).toHaveLength(200);
    expect(String(entry!.roomStatus)).toHaveLength(20);
    expect(String(entry!.userAgent)).toHaveLength(120);
  });

  it("rejects a malformed session id", async () => {
    await expect(
      t.mutation(api.trouble.reportTrouble, { clientId: "not-a-uuid", screen: "home" }),
    ).rejects.toThrow(GameError.invalidSession);
  });

  it("requires a seat when a room is named", async () => {
    const room = await startedRoom(t, { players: 2 });
    await expect(
      t.mutation(api.trouble.reportTrouble, {
        clientId: clientId(99),
        roomId: room.roomId,
        screen: "game",
      }),
    ).rejects.toThrow(GameError.notInRoom);
  });

  it("rate-limits a seated player", async () => {
    const room = await startedRoom(t, { players: 2 });
    const report = () =>
      t.mutation(api.trouble.reportTrouble, {
        clientId: room.host,
        roomId: room.roomId,
        screen: "game",
      });

    await expect(report()).resolves.toEqual({ ok: true });
    await expect(report()).rejects.toThrow(GameError.rateLimited);
    await advance(t, TROUBLE_MIN_INTERVAL_MS);
    await expect(report()).resolves.toEqual({ ok: true });
  });
});
