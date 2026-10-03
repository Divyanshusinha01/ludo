"use client";

import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { Color } from "@/lib/player";
import { formatDelta } from "./MatchHistory";
import styles from "./GameScreen.module.css";

/** Post-game rating change for a finished ranked room. */
export function RatingResultBanner({ roomId, myColor }: { roomId: Id<"rooms">; myColor: Color | null }) {
  const result = useQuery(api.history.getRoomResult, { roomId });

  if (result === undefined) return null;
  if (result === null) {
    return <p className={styles.waiting} role="status">Updating ratings…</p>;
  }
  if (!result.rated) {
    return <p className={styles.waiting} role="status">Unrated — no rating change this game.</p>;
  }
  const mine = myColor ? result.participants.find((p) => p.color === myColor) : undefined;
  if (!mine) return null;

  const tone = mine.delta > 0 ? styles.ratingUp : mine.delta < 0 ? styles.ratingDown : "";
  return (
    <p className={`${styles.ratingBanner} ${tone}`} role="status">
      <strong>{formatDelta(mine.delta)} rating</strong>
      <span>
        {mine.ratingBefore} → {mine.ratingAfter}
      </span>
    </p>
  );
}
