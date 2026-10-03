"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "../../convex/_generated/api";
import { QUEUES } from "../../convex/lib/matchmaking";
import { COLOR_HEX, normalizeCode } from "@/lib/player";
import { Button, StatusText } from "./ui";
import listStyles from "./MatchHistory.module.css";
import styles from "./HomeScreen.module.css";

/** Ranked games anyone can watch, plus "watch by code" for private rooms. */
export function LiveGames({ limit = 10 }: { limit?: number }) {
  const router = useRouter();
  const games = useQuery(api.spectate.listLive, { limit });
  const [code, setCode] = useState("");

  function onWatch(e: FormEvent) {
    e.preventDefault();
    const normalized = normalizeCode(code);
    if (normalized.length !== 6) return;
    router.push(`/spectate/${normalized}`);
  }

  return (
    <section className={listStyles.section} aria-labelledby="live-games-title">
      <h2 id="live-games-title" className={listStyles.heading}>Watch live</h2>
      {games === undefined ? (
        <StatusText>Loading live games…</StatusText>
      ) : games.length === 0 ? (
        <p className={listStyles.empty}>No ranked games in progress right now.</p>
      ) : (
        <ul className={listStyles.list}>
          {games.map((g) => (
            <li key={g.code} className={listStyles.row}>
              <div className={listStyles.main}>
                <span className={listStyles.queue}>
                  {g.players.map((p, i) => (
                    <span key={p.color}>
                      {i > 0 ? (g.mode === "2v2" ? " · " : " vs ") : ""}
                      <span aria-hidden style={{ color: COLOR_HEX[p.color] }}>●</span> {p.name}
                      {p.rating !== null ? ` (${p.rating})` : ""}
                    </span>
                  ))}
                </span>
                <span className={listStyles.meta}>
                  {g.queue ? QUEUES[g.queue].label : g.mode} · {g.spectators} watching
                </span>
              </div>
              <span />
              <Link href={`/spectate/${g.code}`} aria-label={`Watch game ${g.code}`}>
                Watch
              </Link>
            </li>
          ))}
        </ul>
      )}
      <form className={styles.actions} onSubmit={onWatch}>
        <label className={styles.field}>
          Watch by room code
          <input
            value={code}
            onChange={(e) => setCode(normalizeCode(e.target.value))}
            autoCapitalize="characters"
            placeholder="6-character code"
            maxLength={6}
            autoComplete="off"
          />
        </label>
        <Button type="submit" variant="secondary" disabled={normalizeCode(code).length !== 6}>
          Watch game
        </Button>
      </form>
    </section>
  );
}
