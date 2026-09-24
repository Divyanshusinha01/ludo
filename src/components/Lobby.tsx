"use client";

import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { COLOR_HEX, COLOR_LABEL, type Color } from "@/lib/player";
import styles from "./Lobby.module.css";

type Props = {
  roomId: Id<"rooms">;
  clientId: string;
  code: string;
};

export function Lobby({ roomId, clientId, code }: Props) {
  const data = useQuery(api.rooms.getRoom, { roomId });
  const startGame = useMutation(api.rooms.startGame);

  if (!data) {
    return <p className={styles.muted}>Loading lobby…</p>;
  }

  const { room, players } = data;
  const isHost = room.hostClientId === clientId;
  const canStart = players.length === 4 && isHost;

  return (
    <section className={styles.lobby}>
      <header className={styles.header}>
        <p className={styles.label}>Room code</p>
        <h1 className={styles.code}>{code}</h1>
        <p className={styles.hint}>Share this code with your family</p>
      </header>

      <ul className={styles.list}>
        {(["red", "green", "yellow", "blue"] as Color[]).map((color) => {
          const p = players.find((x) => x.color === color);
          return (
            <li
              key={color}
              className={styles.seat}
              style={{ ["--seat" as string]: COLOR_HEX[color] }}
            >
              <span className={styles.swatch} />
              <div>
                <strong>{COLOR_LABEL[color]}</strong>
                <p>{p ? p.name : "Waiting…"}</p>
              </div>
              <span className={styles.badge}>
                {p ? (p.connected ? "Online" : "Away") : "Empty"}
              </span>
            </li>
          );
        })}
      </ul>

      {isHost ? (
        <button
          type="button"
          className={styles.start}
          disabled={!canStart}
          onClick={() => startGame({ roomId, clientId })}
        >
          {players.length === 4 ? "Start game" : `Waiting for players (${players.length}/4)`}
        </button>
      ) : (
        <p className={styles.muted}>Waiting for host to start… ({players.length}/4)</p>
      )}
    </section>
  );
}
