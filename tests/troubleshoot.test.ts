import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  buildTroubleSnapshot,
  isTroubleshootCoolingDown,
  runTroubleshoot,
  TROUBLESHOOT_COOLDOWN_MS,
} from "../src/lib/troubleshoot";

describe("troubleshoot helpers", () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    });
    vi.stubGlobal("navigator", { onLine: true, userAgent: "vitest-ua" });
    vi.stubGlobal("window", {
      location: { reload: vi.fn() },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds a light snapshot", () => {
    const snap = buildTroubleSnapshot({
      clientId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      screen: "home",
      lastError: "x".repeat(300),
    });
    expect(snap.lastError?.length).toBe(200);
    expect(snap.userAgent).toBe("vitest-ua");
    expect(snap.offline).toBe(false);
  });

  it("clears local and reloads even if report fails", async () => {
    const clearLocal = vi.fn();
    const report = vi.fn().mockRejectedValue(new Error("boom"));
    await runTroubleshoot({
      report,
      snapshot: buildTroubleSnapshot({
        clientId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        screen: "game",
      }),
      clearLocal,
    });
    expect(report).toHaveBeenCalled();
    expect(clearLocal).toHaveBeenCalled();
    expect(window.location.reload).toHaveBeenCalled();
    expect(isTroubleshootCoolingDown()).toBe(true);
  });

  it("skips report when offline", async () => {
    const report = vi.fn();
    const clearLocal = vi.fn();
    await runTroubleshoot({
      report,
      snapshot: buildTroubleSnapshot({
        clientId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        screen: "home",
        offline: true,
      }),
      clearLocal,
    });
    expect(report).not.toHaveBeenCalled();
    expect(clearLocal).toHaveBeenCalled();
    expect(TROUBLESHOOT_COOLDOWN_MS).toBeGreaterThan(0);
  });
});
