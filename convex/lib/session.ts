import { GameError, fail } from "./errors";

/** UUID v4-ish session ids from crypto.randomUUID(). */
const CLIENT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Ambiguity-free room codes (matches generateRoomCode alphabet). */
const ROOM_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;

export const MAX_CLIENT_ID_LEN = 64;
export const MAX_NAME_LEN = 20;
export const CREATE_RATE_WINDOW_MS = 15_000;
/** Max new room joins per client within the window (reconnects excluded). */
export const JOIN_RATE_WINDOW_MS = 10_000;
export const MAX_JOINS_PER_WINDOW = 3;
/** Minimum gap between roll/move mutations from one seat (anti double-click flood). */
export const ACTION_MIN_INTERVAL_MS = 100;
/** Minimum gap between heartbeats from one seat. */
export const HEARTBEAT_MIN_INTERVAL_MS = 5_000;

export function assertValidClientId(clientId: string): string {
  const id = clientId.trim();
  if (!id) fail(GameError.missingSession);
  if (id.length > MAX_CLIENT_ID_LEN) fail(GameError.invalidSession);
  if (!CLIENT_ID_RE.test(id)) fail(GameError.invalidSession);
  return id;
}

export function assertValidRoomCode(code: string): string {
  const normalized = code.trim().toUpperCase();
  if (!ROOM_CODE_RE.test(normalized)) fail(GameError.invalidCode);
  return normalized;
}

/** Trim and cap length; empty input becomes a safe display fallback. */
export function sanitizePlayerName(
  name: string,
  fallback = "Player",
): string {
  const trimmed = name.trim().slice(0, MAX_NAME_LEN);
  return trimmed || fallback;
}

/**
 * Reject spammy actions. `lastActionAt` is optional on older player docs.
 * Returns the timestamp to write back after a successful action.
 */
export function assertActionInterval(
  lastActionAt: number | undefined,
  minIntervalMs: number,
  now: number = Date.now(),
): number {
  if (
    lastActionAt !== undefined &&
    now - lastActionAt < minIntervalMs
  ) {
    fail(GameError.rateLimited);
  }
  return now;
}
