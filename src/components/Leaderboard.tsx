"use client";

import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { StatusText } from "./ui";
import styles from "./MatchHistory.module.css";

export function Leaderboard({ limit = 20, highlight }: { limit?: number; highlight?: string }) {
  const entries = useQuery(api.history.leaderboard, { limit });

  if (entries === undefined) return <StatusText>Loading leaderboard…</StatusText>;

  return (
    <section className={styles.section} aria-labelledby="leaderboard-title">
      <h2 id="leaderboard-title" className={styles.heading}>Leaderboard</h2>
      {entries.length === 0 ? (
        <p className={styles.empty}>No rated games played yet.</p>
      ) : (
        <ol className={styles.list}>
          {entries.map((e) => (
            <li
              key={e.username}
              className={styles.row}
              aria-current={e.username === highlight ? "true" : undefined}
            >
              <div className={styles.main}>
                <span className={styles.queue}>
                  <span className={styles.rank}>{e.rank}.</span> {e.displayName}
                </span>
                <span className={styles.meta}>@{e.username}</span>
              </div>
              <span className={styles.meta}>
                {e.wins}W / {e.ratedGames}
              </span>
              <span className={styles.rating}>{e.rating}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
