import type { Id } from "../../convex/_generated/dataModel";

export type TroubleScreen = "home" | "lobby" | "game" | "join";

export type TroubleSnapshot = {
  clientId: string;
  roomId?: Id<"rooms">;
  code?: string;
  screen: TroubleScreen;
  lastError?: string;
  roomStatus?: string;
  turnId?: number;
  diceRolled?: boolean;
  diceValue?: number | null;
  offline?: boolean;
  userAgent?: string;
};

const COOLDOWN_KEY = "ludo_trouble_at";
export const TROUBLESHOOT_COOLDOWN_MS = 20_000;

export function isTroubleshootCoolingDown(now = Date.now()): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = sessionStorage.getItem(COOLDOWN_KEY);
    if (!raw) return false;
    const at = Number(raw);
    if (!Number.isFinite(at)) return false;
    return now - at < TROUBLESHOOT_COOLDOWN_MS;
  } catch {
    return false;
  }
}

function markTroubleshootCooldown(now = Date.now()): void {
  try {
    sessionStorage.setItem(COOLDOWN_KEY, String(now));
  } catch {
    /* private mode */
  }
}

export function buildTroubleSnapshot(
  partial: Omit<TroubleSnapshot, "userAgent"> & { userAgent?: string },
): TroubleSnapshot {
  const offline =
    partial.offline ??
    (typeof navigator !== "undefined" ? !navigator.onLine : undefined);
  return {
    ...partial,
    offline,
    lastError: partial.lastError?.trim().slice(0, 200) || undefined,
    code: partial.code?.trim().toUpperCase().slice(0, 6) || undefined,
    userAgent:
      partial.userAgent?.slice(0, 120) ??
      (typeof navigator !== "undefined"
        ? navigator.userAgent.slice(0, 120)
        : undefined),
  };
}

/**
 * Fix-first: attempt to log, always clear local state, then soft-reload.
 * Logging failures must not block recovery.
 */
export async function runTroubleshoot(opts: {
  report: (snapshot: TroubleSnapshot) => Promise<unknown>;
  snapshot: TroubleSnapshot;
  clearLocal: () => void;
}): Promise<void> {
  markTroubleshootCooldown();
  const offline =
    opts.snapshot.offline === true ||
    (typeof navigator !== "undefined" && !navigator.onLine);

  if (!offline) {
    try {
      await opts.report(opts.snapshot);
    } catch {
      /* fix-first */
    }
  }

  opts.clearLocal();

  if (typeof window !== "undefined") {
    window.location.reload();
  }
}
