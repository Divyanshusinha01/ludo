import type { OfflineGameState } from "./types";

export const OFFLINE_GAME_STORAGE_KEY = "ludo_offline_game_v1";
export const OFFLINE_CHANGE_EVENT = "ludo-offline-change";

function notifyChange() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OFFLINE_CHANGE_EVENT));
}

export function loadOfflineGame(): OfflineGameState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(OFFLINE_GAME_STORAGE_KEY);
    if (!raw) return null;
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
  } catch {
    return null;
  }
}

export function saveOfflineGame(state: OfflineGameState): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(OFFLINE_GAME_STORAGE_KEY, JSON.stringify(state));
    notifyChange();
  } catch {
    /* private mode / quota */
  }
}

export function clearOfflineGame(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(OFFLINE_GAME_STORAGE_KEY);
    notifyChange();
  } catch {
    /* private mode */
  }
}

export function subscribeOfflineGame(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = () => onStoreChange();
  window.addEventListener(OFFLINE_CHANGE_EVENT, handler);
  window.addEventListener("storage", (e) => {
    if (e.key === OFFLINE_GAME_STORAGE_KEY) handler();
  });
  return () => {
    window.removeEventListener(OFFLINE_CHANGE_EVENT, handler);
  };
}
