import type { OfflineGameState } from "./types";

export const OFFLINE_GAME_STORAGE_KEY = "ludo_offline_game_v1";
export const OFFLINE_CHANGE_EVENT = "ludo-offline-change";

/** Stable snapshot for useSyncExternalStore (must not parse anew every read). */
let cachedRaw: string | null | undefined;
let cachedState: OfflineGameState | null = null;

function notifyChange() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OFFLINE_CHANGE_EVENT));
}

function invalidateOfflineCache() {
  cachedRaw = undefined;
}

function parseOfflineGame(raw: string): OfflineGameState | null {
  const parsed = JSON.parse(raw) as OfflineGameState;
  if (
    !parsed ||
    (parsed.status !== "playing" && parsed.status !== "finished")
  ) {
    return null;
  }
  if (!Array.isArray(parsed.seats) || !Array.isArray(parsed.tokens)) {
    return null;
  }
  return parsed;
}

export function loadOfflineGame(): OfflineGameState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(OFFLINE_GAME_STORAGE_KEY);
    if (cachedRaw !== undefined && raw === cachedRaw) {
      return cachedState;
    }
    cachedRaw = raw;
    if (!raw) {
      cachedState = null;
      return null;
    }
    cachedState = parseOfflineGame(raw);
    return cachedState;
  } catch {
    cachedRaw = null;
    cachedState = null;
    return null;
  }
}

export function saveOfflineGame(state: OfflineGameState): void {
  if (typeof window === "undefined") return;
  try {
    const raw = JSON.stringify(state);
    localStorage.setItem(OFFLINE_GAME_STORAGE_KEY, raw);
    cachedRaw = raw;
    cachedState = state;
    notifyChange();
  } catch {
    /* private mode / quota */
  }
}

export function clearOfflineGame(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(OFFLINE_GAME_STORAGE_KEY);
    cachedRaw = null;
    cachedState = null;
    notifyChange();
  } catch {
    /* private mode */
  }
}

export function subscribeOfflineGame(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = () => onStoreChange();
  window.addEventListener(OFFLINE_CHANGE_EVENT, handler);
  const onStorage = (e: StorageEvent) => {
    if (e.key === OFFLINE_GAME_STORAGE_KEY) {
      invalidateOfflineCache();
      handler();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(OFFLINE_CHANGE_EVENT, handler);
    window.removeEventListener("storage", onStorage);
  };
}
