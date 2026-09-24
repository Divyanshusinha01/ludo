"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { Board } from "./Board";
import { Dice } from "./Dice";
import { COLOR_HEX, COLOR_LABEL, type Color } from "@/lib/player";
import styles from "./GameScreen.module.css";

type Props = {
  roomId: Id<"rooms">;
  clientId: string;
};

export function GameScreen({ roomId, clientId }: Props) {
  const data = useQuery(api.rooms.getRoom, { roomId });
  const legal = useQuery(api.game.getLegalTokenIndexes, { roomId, clientId });
  const rollDice = useMutation(api.game.rollDice);
  const moveToken = useMutation(api.game.moveToken);
  const heartbeat = useMutation(api.rooms.heartbeat);
  const markDisconnected = useMutation(api.rooms.markDisconnected);
  const [rolling, setRolling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const tick = () => {
      void heartbeat({ roomId, clientId });
    };
    tick();
    const id = setInterval(tick, 8000);
    const onUnload = () => {
      void markDisconnected({ roomId, clientId });
    };
    window.addEventListener("pagehide", onUnload);
    return () => {
      clearInterval(id);
      window.removeEventListener("pagehide", onUnload);
    };
  }, [roomId, clientId, heartbeat, markDisconnected]);

  if (!data) return <p className={styles.muted}>Loading game…</p>;

  const { room, players, tokens } = data;
  const me = players.find((p) => p.clientId === clientId);
  const myTurn = me?.color === room.currentTurn && room.status === "playing";
  const canRoll = myTurn && !room.diceRolled;
  const selectable = legal ?? [];

  async function onRoll() {
    setError(null);
    setRolling(true);
    try {
      await rollDice({ roomId, clientId });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not roll");
    } finally {
      setTimeout(() => setRolling(false), 400);
    }
  }

  async function onSelectToken(tokenIndex: number) {
    setError(null);
    try {
      await moveToken({ roomId, clientId, tokenIndex });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Illegal move");
    }
  }

  return (
    <div className={styles.game}>
      <header className={styles.top}>
        <div>
          <p className={styles.label}>Room {room.code}</p>
          {room.status === "finished" ? (
            <h2 className={styles.title}>
              {COLOR_LABEL[room.winner as Color]} wins!
            </h2>
          ) : (
            <h2 className={styles.title}>
              <span
                className={styles.dot}
                style={{ background: COLOR_HEX[room.currentTurn] }}
              />
              {COLOR_LABEL[room.currentTurn]}&apos;s turn
              {myTurn ? " — you" : ""}
            </h2>
          )}
          <p className={styles.event}>{room.lastEvent}</p>
        </div>
        <Dice
          value={room.diceValue}
          rolling={rolling}
          disabled={!canRoll || room.status !== "playing"}
          onRoll={onRoll}
        />
      </header>

      <ul className={styles.players}>
        {players.map((p) => (
          <li
            key={p._id}
            className={`${styles.player} ${p.color === room.currentTurn ? styles.active : ""}`}
            style={{ ["--c" as string]: COLOR_HEX[p.color] }}
          >
            <span className={styles.swatch} />
            <span>
              {p.name}
              {!p.connected ? " (away)" : ""}
            </span>
          </li>
        ))}
      </ul>

      <Board
        tokens={tokens.map((t) => ({
          color: t.color,
          index: t.index,
          steps: t.steps,
        }))}
        selectable={myTurn && room.diceRolled ? selectable : []}
        myColor={me?.color}
        onSelectToken={onSelectToken}
      />

      {myTurn && room.diceRolled && selectable.length > 0 && (
        <p className={styles.prompt}>Tap a glowing token to move</p>
      )}
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
