import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { MAX_NAME_LEN } from "./session";

export { INITIAL_RATING } from "./rating";

/** Whitelist of profile fields any public function may return. */
export const publicProfileValidator = v.object({
  username: v.string(),
  displayName: v.string(),
  rating: v.number(),
  peakRating: v.number(),
  gamesPlayed: v.number(),
  wins: v.number(),
  ratedGames: v.number(),
  createdAt: v.number(),
});

export function toPublicProfile(p: Doc<"profiles">) {
  return {
    username: p.username,
    displayName: p.displayName,
    rating: p.rating,
    peakRating: p.peakRating,
    gamesPlayed: p.gamesPlayed,
    wins: p.wins,
    ratedGames: p.ratedGames,
    createdAt: p.createdAt,
  };
}

/** Strip control characters, collapse whitespace, cap length; null if empty. */
export function cleanDisplayName(raw: string): string | null {
  const cleaned = raw
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LEN);
  return cleaned || null;
}
