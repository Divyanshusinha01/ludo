import { useSyncExternalStore } from "react";
import { ConvexError } from "convex/values";
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

/**
 * Per-tab seat id. localStorage is shared by every tab on a phone/computer,
 * so a second window "joining" used to reconnect as the host. Leaving then
 * removed the only seat and the room code disappeared.
 */
const TAB_STORAGE_KEY = "ludo_tab_session";
const OWNER_STALE_MS = 20_000;
const CLIENT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidClientId(id: string): boolean {
  return id.length <= 64 && CLIENT_ID_RE.test(id);
}

let tabNonce = "";
let cachedId = "";
let heartbeatStarted = false;

function ensureTabNonce(): string {
  if (!tabNonce) tabNonce = crypto.randomUUID();
  return tabNonce;
}

function ownerKey(id: string): string {
  return `ludo_seat_owner_${id}`;
}

function readOwner(id: string): { nonce: string; at: number } | null {
  try {
    const raw = localStorage.getItem(ownerKey(id));
    if (!raw) return null;
    const sep = raw.lastIndexOf(":");
    if (sep <= 0) return null;
    const nonce = raw.slice(0, sep);
    const at = Number(raw.slice(sep + 1));
    if (!nonce || !Number.isFinite(at)) return null;
    return { nonce, at };
  } catch {
    return null;
  }
}

function writeOwner(id: string, at = Date.now()) {
  try {
    localStorage.setItem(ownerKey(id), `${ensureTabNonce()}:${at}`);
  } catch {
    /* private mode */
  }
}

/** Another open tab is already playing as this id (duplicated tab). */
function ownedByOtherLiveTab(id: string): boolean {
  const owner = readOwner(id);
  if (!owner) return false;
  if (owner.nonce === ensureTabNonce()) return false;
  if (owner.at <= 0) return false;
  return Date.now() - owner.at < OWNER_STALE_MS;
}

function readTabId(): string {
  try {
    return sessionStorage.getItem(TAB_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function persistTabId(id: string) {
  try {
    sessionStorage.setItem(TAB_STORAGE_KEY, id);
  } catch {
    /* private mode */
  }
}

function claim(id: string): boolean {
  if (ownedByOtherLiveTab(id)) return false;
  writeOwner(id);
  const owner = readOwner(id);
  return !!owner && owner.nonce === ensureTabNonce();
}

function startOwnerHeartbeat() {
  if (heartbeatStarted || typeof window === "undefined") return;
  heartbeatStarted = true;
  window.setInterval(() => {
    if (cachedId) writeOwner(cachedId);
  }, 4000);
  window.addEventListener("pagehide", () => {
    // Mark stale so a refresh of this tab can keep the seat, while a
    // duplicated tab that is still open keeps a fresh timestamp.
    if (cachedId) writeOwner(cachedId, 0);
  });
  window.addEventListener("pageshow", () => {
    if (cachedId) writeOwner(cachedId);
  });
}

export function getOrCreateClientId(): string {
  if (typeof window === "undefined") return "";
  if (cachedId) return cachedId;
  ensureTabNonce();

  const existing = readTabId();
  if (existing && isValidClientId(existing) && claim(existing)) {
    cachedId = existing;
    startOwnerHeartbeat();
    return cachedId;
  }

  const fresh = crypto.randomUUID();
  cachedId = fresh;
  persistTabId(fresh);
  writeOwner(fresh);
  startOwnerHeartbeat();
  return cachedId;
}

const sessionListeners = new Set<() => void>();
let sessionReady = false;

function ensureSessionId(): string {
  const id = getOrCreateClientId();
  if (!sessionReady && typeof window !== "undefined") {
    sessionReady = true;
    queueMicrotask(() => {
      for (const listener of sessionListeners) listener();
    });
  }
  return id;
}

export function useSessionId(): string {
  return useSyncExternalStore(
    (onStoreChange) => {
      sessionListeners.add(onStoreChange);
      if (typeof window !== "undefined") {
        ensureSessionId();
        queueMicrotask(onStoreChange);
      }
      return () => {
        sessionListeners.delete(onStoreChange);
      };
    },
    () => ensureSessionId(),
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

/** One-shot name from the home join form — not shown as a prefill. */
const PENDING_JOIN_NAME_KEY = "ludo_pending_join_name";

export function setPendingJoinName(name: string) {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(PENDING_JOIN_NAME_KEY, name.trim().slice(0, 20));
  } catch {
    /* private mode */
  }
}

function readPendingJoinName(): string {
  if (typeof window === "undefined") return "";
  try {
    return (sessionStorage.getItem(PENDING_JOIN_NAME_KEY) ?? "").trim().slice(0, 20);
  } catch {
    return "";
  }
}

/** Name from home join flow — read without clearing (e.g. 2v2 team pick on room page). */
export function peekPendingJoinName(): string {
  return readPendingJoinName();
}

/** Pending join name from home — safe with SSR (re-reads sessionStorage on the client). */
export function usePendingJoinName(): string {
  return useSyncExternalStore(
    () => () => {},
    () => peekPendingJoinName(),
    () => "",
  );
}

export function takePendingJoinName(): string {
  if (typeof window === "undefined") return "";
  try {
    const value = readPendingJoinName();
    sessionStorage.removeItem(PENDING_JOIN_NAME_KEY);
    return value;
  } catch {
    return "";
  }
}

export function normalizeCode(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 6);
}

export function formatConvexError(err: unknown, fallback: string): string {
  if (err instanceof ConvexError && typeof err.data === "string") {
    return err.data;
  }
  if (err instanceof Error) {
    const msg = err.message;
    const m = msg.match(/Uncaught Error:\s*(.+?)(?:\s+at\s|$)/);
    if (m?.[1]) return m[1].trim();
    if (msg.length < 120) return msg;
  }
  return fallback;
}

export { COLOR_START, SAFE_CELLS };
