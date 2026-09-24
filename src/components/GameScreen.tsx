"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { getLegalMoves } from "../../convex/lib/ludo";
import { useRoomPresence } from "@/hooks/useRoomPresence";
import { haptic } from "@/lib/haptics";
import { Board } from "./Board";
import { Dice } from "./Dice";
import { Button, ErrorText, StatusText } from "./ui";
import {
  COLOR_HEX,
  COLOR_LABEL,
  formatConvexError,
  type Color,
} from "@/lib/player";
import styles from "./GameScreen.module.css";

type Props = {
  roomId: Id<"rooms">;
  clientId: string;
};

function isNotableEvent(event: string | undefined): boolean {
  if (!event) return false;
  return /no moves|three 6s|turn skipped|wins|captured|roll again|left|away/i.test(
    event,
  );
}

export function GameScreen({ roomId, clientId }: Props) {
  const router = useRouter();
  const data = useQuery(api.rooms.getRoom, { roomId, clientId });
  const rollDice = useMutation(api.game.rollDice);
  const moveToken = useMutation(api.game.moveToken);
  const rematch = useMutation(api.rooms.rematch);
  const leaveRoom = useMutation(api.rooms.leaveRoom);
  const [rolling, setRolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useRoomPresence(roomId, clientId);

  const selectable = useMemo(() => {
    if (!data?.me || !data.room.diceRolled || data.room.diceValue === null) {
      return [] as number[];
    }
    if (data.me.color !== data.room.currentTurn) return [];
    if (data.room.status !== "playing") return [];
    return getLegalMoves(
      data.tokens.map((t) => ({
        color: t.color as Color,
        index: t.index,
        steps: t.steps,
      })),
      data.me.color,
      data.room.diceValue,
    );
  }, [data]);

  if (!data) return <StatusText>Loading game…</StatusText>;

  const { room, players, tokens, me } = data;
  const myTurn = me?.color === room.currentTurn && room.status === "playing";
  const canRoll = myTurn && !room.diceRolled;
  const turnLabel = COLOR_LABEL[room.currentTurn as Color];
  const notable = isNotableEvent(room.lastEvent);
  const turnPlayer = players.find((p) => p.color === room.currentTurn);
  const turnAway =
    room.status === "playing" && !!turnPlayer && !turnPlayer.connected;

  async function onRoll() {
    setError(null);
    setRolling(true);
    haptic("roll");
    try {
      await rollDice({ roomId, clientId });
    } catch (e) {
      setError(formatConvexError(e, "Could not roll"));
    } finally {
      setTimeout(() => setRolling(false), 400);
    }
  }

  async function onSelectToken(tokenIndex: number) {
    setError(null);
    haptic("tap");
    try {
      const result = await moveToken({ roomId, clientId, tokenIndex });
      if (result.won) haptic("win");
      else if (result.captured) haptic("capture");
    } catch (e) {
      setError(formatConvexError(e, "Illegal move"));
    }
  }

  async function onRematch() {
    setError(null);
    setBusy(true);
    try {
      await rematch({ roomId, clientId });
    } catch (e) {
      setError(formatConvexError(e, "Could not start rematch"));
    } finally {
      setBusy(false);
    }
  }

  async function onLeave() {
    setBusy(true);
    try {
      await leaveRoom({ roomId, clientId });
      router.push("/");
    } catch (e) {
      setError(formatConvexError(e, "Could not leave"));
      setBusy(false);
    }
  }

  const waitingLabel = canRoll
    ? undefined
    : myTurn
      ? "Choose a token"
      : turnAway
        ? `${turnLabel} is away`
        : `Waiting for ${turnLabel}`;

  return (
    <div className={styles.game}>
      <header className={styles.top}>
        <div className={styles.topText}>
          <div className={styles.topRow}>
            <p className={styles.label}>Room {room.code}</p>
            {room.status === "playing" && (
              <button
                type="button"
                className={styles.leaveLink}
                disabled={busy}
                onClick={onLeave}
              >
                Leave
              </button>
            )}
          </div>
          {room.status === "finished" ? (
            <h2 className={styles.title}>
              {COLOR_LABEL[room.winner as Color]} wins!
            </h2>
          ) : (
            <h2 className={styles.title}>
              <span
                className={styles.dot}
                style={{ background: COLOR_HEX[room.currentTurn as Color] }}
              />
              {turnLabel}&apos;s turn
              {myTurn ? " — you" : turnAway ? " — away" : ""}
            </h2>
          )}
          <p className={styles.event} aria-live="polite">
            {room.lastEvent}
          </p>
        </div>
        {room.status === "playing" && (
          <Dice
            value={room.diceValue}
            rolling={rolling}
            disabled={!canRoll}
            waitingLabel={waitingLabel}
            onRoll={onRoll}
          />
        )}
      </header>

      {notable && room.status === "playing" && (
        <p className={styles.banner} role="status" aria-live="polite">
          {room.lastEvent}
        </p>
      )}

      {turnAway && !myTurn && room.status === "playing" && (
        <p className={styles.afk} role="status">
          {turnLabel} is away — their turn skips in about a minute if they
          don&apos;t return.
        </p>
      )}

      <ul className={styles.players}>
        {players.map((p) => (
          <li
            key={p._id}
            className={`${styles.player} ${p.color === room.currentTurn ? styles.active : ""} ${!p.connected ? styles.away : ""}`}
            style={{ ["--c" as string]: COLOR_HEX[p.color as Color] }}
          >
            <span className={styles.swatch} />
            <span>
              {p.name}
              {p.isMe ? " (you)" : ""}
              {!p.connected ? " (away)" : ""}
              {p.color === room.currentTurn && room.status === "playing"
                ? " · turn"
                : ""}
            </span>
          </li>
        ))}
      </ul>

      <Board
        tokens={tokens.map((t) => ({
          color: t.color as Color,
          index: t.index,
          steps: t.steps,
        }))}
        selectable={myTurn && room.diceRolled ? selectable : []}
        myColor={me?.color}
        onSelectToken={onSelectToken}
      />

      <div className={styles.controls}>
        {room.status === "finished" && (
          <div className={styles.endActions}>
            {me?.isHost ? (
              <Button variant="ink" disabled={busy} onClick={onRematch}>
                Play again
              </Button>
            ) : (
              <p className={styles.waiting}>Waiting for host to rematch…</p>
            )}
            <Button variant="secondary" disabled={busy} onClick={onLeave}>
              Back home
            </Button>
          </div>
        )}

        {myTurn && room.diceRolled && selectable.length > 0 && (
          <p className={styles.prompt}>Tap a glowing token to move</p>
        )}
        {myTurn && !room.diceRolled && room.status === "playing" && (
          <p className={styles.prompt}>Your turn — roll the dice</p>
        )}
        {!myTurn && room.status === "playing" && !turnAway && (
          <p className={styles.waiting}>Waiting for {turnLabel}…</p>
        )}
        <ErrorText>{error}</ErrorText>
      </div>
    </div>
  );
}
