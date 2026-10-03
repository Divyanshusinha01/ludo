"use client";

import { usePaginatedQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import { QUEUES } from "../../convex/lib/matchmaking";
import { ListSkeleton } from "./ListSkeleton";
import { fadeInClass } from "./Skeleton";
import { Button, StatusText } from "./ui";
import styles from "./MatchHistory.module.css";

const PAGE_SIZE = 10;

export function formatDelta(delta: number): string {
  return delta > 0 ? `+${delta}` : `${delta}`;
}

function ordinal(n: number): string {
  const suffix = n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th";
  return `${n}${suffix}`;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

type HistoryEntry = FunctionReturnType<typeof api.history.listMine>["page"][number];

function gameLabel(entry: HistoryEntry): string {
  if (entry.kind === "computer") return "vs Computer";
  if (entry.kind === "private") return entry.queue === "team2v2" ? "Private room · 2v2" : "Private room";
  return QUEUES[entry.queue].label;
}

export function MatchHistorySkeleton() {
  return <ListSkeleton title="Match history" label="Loading match history…" />;
}

export function MatchHistory() {
  const { results, status, loadMore } = usePaginatedQuery(
    api.history.listMine,
    {},
    { initialNumItems: PAGE_SIZE },
  );

  if (status === "LoadingFirstPage") return <MatchHistorySkeleton />;

  return (
    <section className={`${styles.section} ${fadeInClass}`} aria-labelledby="history-title">
      <h2 id="history-title" className={styles.heading}>Match history</h2>
      {results.length === 0 ? (
        <p className={styles.empty}>No games yet — play a match from the home screen.</p>
      ) : (
        <ol className={styles.list}>
          {results.map((entry) => {
            const ranked = entry.kind === "ranked";
            const outcome = ranked && !entry.rated
              ? "Unrated"
              : entry.queue === "team2v2"
                ? entry.won ? "Team won" : "Team lost"
                : entry.won ? "Won" : ordinal(entry.placement);
            const deltaClass = entry.delta > 0 ? styles.up : entry.delta < 0 ? styles.down : styles.even;
            return (
              <li key={entry.matchId} className={styles.row}>
                <div className={styles.main}>
                  <span className={styles.queue}>{gameLabel(entry)}</span>
                  <span className={styles.meta}>
                    <time dateTime={new Date(entry.finishedAt).toISOString()}>
                      {dateFormat.format(entry.finishedAt)}
                    </time>
                  </span>
                </div>
                <span className={styles.outcome}>{outcome}</span>
                {ranked ? (
                  <span className={styles.rating}>
                    <span className={deltaClass} aria-label="Rating change">
                      {entry.rated ? formatDelta(entry.delta) : "±0"}
                    </span>
                    <span className={styles.meta}>{entry.ratingAfter}</span>
                  </span>
                ) : (
                  <span className={styles.rating}>
                    <span className={styles.meta}>Unrated</span>
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {status === "CanLoadMore" && (
        <Button type="button" variant="secondary" onClick={() => loadMore(PAGE_SIZE)}>
          Load more
        </Button>
      )}
      {status === "LoadingMore" && <StatusText>Loading…</StatusText>}
    </section>
  );
}
