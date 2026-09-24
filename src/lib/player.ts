import { useSyncExternalStore } from "react";
import type { Color } from "../../convex/lib/ludo";
import { COLOR_START, SAFE_CELLS } from "../../convex/lib/ludo";

export type { Color };

export const COLOR_HEX: Record<Color, string> = {
  red: "#e53935",
  green: "#43a047",
  yellow: "#e6a100",
  blue: "#1e88e5",
};

export const COLOR_LABEL: Record<Color, string> = {
  red: "Red",
  green: "Green",
  yellow: "Yellow",
  blue: "Blue",
};

/** Session secret — never sent to other clients by the server. */
const STORAGE_KEY = "ludo_session_id";
const CLIENT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidClientId(id: string): boolean {
  return id.length <= 64 && CLIENT_ID_RE.test(id);
}

export function getOrCreateClientId(): string {
  if (typeof window === "undefined") return "";
  let id = localStorage.getItem(STORAGE_KEY);
  // Migrate from older key if present.
  if (!id) {
    id = localStorage.getItem("ludo_client_id");
    if (id) {
      localStorage.setItem(STORAGE_KEY, id);
      localStorage.removeItem("ludo_client_id");
    }
  }
  if (!id || !isValidClientId(id)) {
    id = crypto.randomUUID();
    localStorage.setItem(STORAGE_KEY, id);
  }
  return id;
}

export function useSessionId(): string {
  return useSyncExternalStore(
    () => () => {},
    () => getOrCreateClientId(),
    () => "",
  );
}

export function getStoredName(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("ludo_player_name") ?? "";
}

export function useStoredName(): string {
  return useSyncExternalStore(
    () => () => {},
    () => getStoredName(),
    () => "",
  );
}

export function storeName(name: string) {
  if (typeof window === "undefined") return;
  localStorage.setItem("ludo_player_name", name);
}

export function normalizeCode(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 6);
}

export function formatConvexError(err: unknown, fallback: string): string {
  if (err instanceof Error) {
    const msg = err.message;
    const m = msg.match(/Uncaught Error:\s*(.+?)(?:\s+at\s|$)/);
    if (m?.[1]) return m[1].trim();
    if (msg.length < 120) return msg;
  }
  return fallback;
}

export { COLOR_START, SAFE_CELLS };
