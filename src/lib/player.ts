export type Color = "red" | "green" | "yellow" | "blue";

export const COLOR_HEX: Record<Color, string> = {
  red: "#e53935",
  green: "#43a047",
  yellow: "#f9a825",
  blue: "#1e88e5",
};

export const COLOR_LABEL: Record<Color, string> = {
  red: "Red",
  green: "Green",
  yellow: "Yellow",
  blue: "Blue",
};

const STORAGE_KEY = "ludo_client_id";

export function getOrCreateClientId(): string {
  if (typeof window === "undefined") return "";
  let id = localStorage.getItem(STORAGE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(STORAGE_KEY, id);
  }
  return id;
}

export function getStoredName(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("ludo_player_name") ?? "";
}

export function storeName(name: string) {
  if (typeof window === "undefined") return;
  localStorage.setItem("ludo_player_name", name);
}
