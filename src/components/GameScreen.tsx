"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { getLegalMoves } from "../../convex/lib/ludo";
import { useRoomPresence } from "@/hooks/useRoomPresence";
import { useTokenAnimation } from "@/hooks/useTokenAnimation";
import { haptic } from "@/lib/haptics";
import { bindAudioUnlock, isMuted, playSound, setMuted } from "@/lib/sounds";
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
  return /no moves|three 6s|turn skipped|wins|captured|roll again|left|away|timed out|eliminated|reached home/i.test(
    event,
  );
}

function useTurnCountdown(
  turnStartedAt: number | null,
  timeoutMs: number,
  playing: boolean,
) {
  // Display-only clock; server enforces expiry via turnStartedAt.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!playing || !turnStartedAt) return;
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, [turnStartedAt, timeoutMs, playing]);

  if (!playing || !turnStartedAt) return timeoutMs;
  return Math.max(0, turnStartedAt + timeoutMs - now);
}

export function GameScreen({ roomId, clientId }: Props) {
  const router = useRouter();
  const data = useQuery(api.rooms.getRoom, { roomId, clientId });
  const rollDice = useMutation(api.game.rollDice);
  const moveToken = useMutation(api.game.moveToken);
  const rematch = useMutation(api.rooms.rematch);
  const leaveRoom = useMutation(api.rooms.leaveRoom);
  const [rolling, setRolling] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [muted, setMutedState] = useState(() =>
    typeof window !== "undefined" ? isMuted() : false,
  );
  const [offline, setOffline] = useState(false);
  const lastTurnId = useRef<number | null>(null);
  const winPlayed = useRef(false);
  const rollLock = useRef(false);
  const moveLock = useRef(false);

  useRoomPresence(roomId, clientId);

  useEffect(() => {
    bindAudioUnlock();
  }, []);

  useEffect(() => {
    const sync = () => setOffline(!navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  const serverTokens = useMemo(
    () =>
      (data?.tokens ?? []).map((t) => ({
        color: t.color as Color,
        index: t.index,
        steps: t.steps,
      })),
    [data?.tokens],
  );

  const { displayTokens, animating, fx } = useTokenAnimation(serverTokens);

  const remainingMs = useTurnCountdown(
    data?.room.turnStartedAt ?? null,
    data?.room.turnTimeoutMs ?? 60_000,
    data?.room.status === "playing",
  );

  // Turn-start beep when turnId changes
  useEffect(() => {
    if (!data || data.room.status !== "playing") return;
    const tid = data.room.turnId;
    if (lastTurnId.current === null) {
      lastTurnId.current = tid;
      return;
    }
    if (lastTurnId.current !== tid) {
      lastTurnId.current = tid;
      playSound("turn");
      if (data.me?.color === data.room.currentTurn) {
        haptic("tap");
      }
    }
  }, [data]);

  // Win sound (once)
  useEffect(() => {
    if (data?.room.status === "finished" && data.room.winner && !winPlayed.current) {
      winPlayed.current = true;
      playSound("win");
      haptic("win");
    }
    if (data?.room.status === "playing") {
      winPlayed.current = false;
    }
  }, [data?.room.status, data?.room.winner]);

  const selectable = useMemo(() => {
    if (!data?.me || !data.room.diceRolled || data.room.diceValue === null) {
      return [] as number[];
    }
    if (data.me.color !== data.room.currentTurn) return [];
    if (data.room.status !== "playing") return [];
    if (animating) return [];
    return getLegalMoves(
      data.tokens.map((t) => ({
        color: t.color as Color,
        index: t.index,
        steps: t.steps,
      })),
      data.me.color,
      data.room.diceValue,
    );
  }, [data, animating]);

  if (!data) return <StatusText>Loading game…</StatusText>;

  const { room, players, me } = data;
  const myTurn =
    !!me &&
    me.color === room.currentTurn &&
    room.status === "playing" &&
    !players.find((p) => p.color === me.color)?.eliminated;
  const canRoll = myTurn && !room.diceRolled && !rolling && !animating;
  const turnLabel = COLOR_LABEL[room.currentTurn as Color];
  const notable = isNotableEvent(room.lastEvent);
  const turnPlayer = players.find((p) => p.color === room.currentTurn);
  const turnAway =
    room.status === "playing" && !!turnPlayer && !turnPlayer.connected;
  const seconds = Math.ceil(remainingMs / 1000);
  const timerUrgent = seconds <= 10;
  const threeSixesBanner = /three 6s/i.test(room.lastEvent ?? "");

  const meDisconnected =
    !!me &&
    !!players.find((p) => p.isMe && !p.connected) &&
    !offline;

  async function onRoll() {
    if (!canRoll || rollLock.current) return;
    rollLock.current = true;
    setError(null);
    setRolling(true);
    setReveal(false);
    haptic("roll");
    playSound("roll");
    try {
      const result = await rollDice({
        roomId,
        clientId,
        turnId: room.turnId,
      });
      if (result.threeSixes) playSound("threeSixes");
      setReveal(true);
      setTimeout(() => setReveal(false), 700);
    } catch (e) {
      setError(formatConvexError(e, "Could not roll"));
    } finally {
      setTimeout(() => {
        setRolling(false);
        rollLock.current = false;
      }, 450);
    }
  }

  async function onSelectToken(tokenIndex: number) {
    if (animating || moveLock.current || !myTurn || !room.diceRolled) return;
    moveLock.current = true;
    setError(null);
    haptic("tap");
    try {
      const result = await moveToken({
        roomId,
        clientId,
        tokenIndex,
        turnId: room.turnId,
      });
      if (result.won) {
        /* win sound via effect */
      } else if (result.captured) {
        haptic("capture");
      }
    } catch (e) {
      setError(formatConvexError(e, "Illegal move"));
    } finally {
      moveLock.current = false;
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

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    setMutedState(next);
    if (!next) playSound("unmute");
  }

  const waitingLabel = canRoll
    ? undefined
    : myTurn
      ? animating
        ? "Moving…"
        : "Choose a token"
      : turnAway
        ? `${turnLabel} is away`
        : `Waiting for ${turnLabel}`;

  const rankedPlayers = [...players].sort((a, b) => {
    const ra = a.finishRank ?? (a.eliminated ? 99 : 50);
    const rb = b.finishRank ?? (b.eliminated ? 99 : 50);
    if (room.status === "finished" && room.rankings.length > 0) {
      const ia = room.rankings.indexOf(a.color);
      const ib = room.rankings.indexOf(b.color);
      if (ia >= 0 || ib >= 0) {
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      }
    }
    return ra - rb;
  });

  return (
    <div className={styles.game}>
      {(offline || meDisconnected) && (
        <div className={styles.reconnect} role="status">
          Reconnecting… Your seat is saved.
        </div>
      )}

      <header className={styles.top}>
        <div className={styles.topText}>
          <div className={styles.topRow}>
            <p className={styles.label}>Room {room.code}</p>
            <div className={styles.topActions}>
              <button
                type="button"
                className={styles.iconBtn}
                onClick={toggleMute}
                aria-label={muted ? "Unmute sounds" : "Mute sounds"}
              >
                {muted ? "Sound off" : "Sound on"}
              </button>
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
      </header>

      {myTurn && room.status === "playing" && (
        <div className={styles.yourTurn} role="status">
          YOUR TURN
        </div>
      )}

      {room.status === "playing" && (
        <div
          className={`${styles.timer} ${timerUrgent ? styles.timerUrgent : ""}`}
          role="timer"
          aria-live="polite"
          aria-label={`${seconds} seconds remaining`}
        >
          <div className={styles.timerBarTrack}>
            <div
              className={styles.timerBar}
              style={{
                width: `${Math.max(0, (remainingMs / (room.turnTimeoutMs || 60_000)) * 100)}%`,
              }}
            />
          </div>
          <span className={styles.timerLabel}>{seconds}s</span>
        </div>
      )}

      {threeSixesBanner && room.status === "playing" && (
        <p className={styles.ruleBanner} role="status">
          Three 6s in a row — turn voided
          {/token returned/i.test(room.lastEvent ?? "")
            ? "; token sent back to yard"
            : ""}
        </p>
      )}

      {notable && room.status === "playing" && !threeSixesBanner && (
        <p className={styles.banner} role="status" aria-live="polite">
          {room.lastEvent}
        </p>
      )}

      {turnAway && !myTurn && room.status === "playing" && (
        <p className={styles.afk} role="status">
          {turnLabel} is away — reconnect window is open; the turn timer still
          runs.
        </p>
      )}

      <ul className={styles.players}>
        {players.map((p) => {
          const isActive =
            p.color === room.currentTurn && room.status === "playing";
          return (
            <li
              key={p._id}
              className={`${styles.player} ${isActive ? styles.active : ""} ${!p.connected ? styles.away : ""} ${p.eliminated ? styles.eliminated : ""}`}
              style={{ ["--c" as string]: COLOR_HEX[p.color as Color] }}
            >
              <span className={styles.swatch} />
              <span className={styles.playerMeta}>
                <span className={styles.playerName}>
                  {p.name}
                  {p.isMe ? " (you)" : ""}
                  {p.eliminated
                    ? " · out"
                    : !p.connected
                      ? " · away"
                      : isActive
                        ? " · turn"
                        : ""}
                </span>
                <span className={styles.lives} aria-label={`${p.lives} lives`}>
                  {"♥".repeat(Math.max(0, p.lives))}
                  <span className={styles.livesEmpty}>
                    {"♡".repeat(Math.max(0, 3 - p.lives))}
                  </span>
                </span>
              </span>
            </li>
          );
        })}
      </ul>

      {room.status === "playing" && (
        <div
          className={styles.diceRow}
          style={{ ["--c" as string]: COLOR_HEX[room.currentTurn as Color] }}
        >
          <span className={styles.diceOwner}>
            <span className={styles.swatch} />
            {myTurn ? "Your dice" : `${turnLabel}'s dice`}
          </span>
          <Dice
            value={room.diceValue}
            rolling={rolling}
            disabled={!canRoll}
            waitingLabel={waitingLabel}
            reveal={reveal}
            onRoll={onRoll}
          />
        </div>
      )}

      <Board
        tokens={displayTokens}
        selectable={myTurn && room.diceRolled && !animating ? selectable : []}
        myColor={me?.color}
        activeColor={
          room.status === "playing" ? (room.currentTurn as Color) : null
        }
        fx={fx}
        onSelectToken={onSelectToken}
      />

      <div className={styles.controls}>
        {room.status === "finished" && (
          <div className={styles.results}>
            <h3 className={styles.resultsTitle}>Final rankings</h3>
            <ol className={styles.rankList}>
              {(room.rankings.length > 0
                ? room.rankings
                : rankedPlayers.map((p) => p.color)
              ).map((color, i) => {
                const p = players.find((x) => x.color === color);
                const isWinner = color === room.winner;
                return (
                  <li
                    key={color}
                    style={{ ["--c" as string]: COLOR_HEX[color as Color] }}
                  >
                    <span className={styles.rankNum}>{i + 1}</span>
                    <span className={styles.swatch} />
                    {p?.name ?? COLOR_LABEL[color as Color]}
                    {isWinner ? " · winner" : p?.eliminated ? " · out" : ""}
                  </li>
                );
              })}
            </ol>
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
          </div>
        )}

        {myTurn && room.diceRolled && selectable.length > 0 && !animating && (
          <p className={styles.prompt}>Tap a glowing token to move</p>
        )}
        {myTurn && !room.diceRolled && room.status === "playing" && !animating && (
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
