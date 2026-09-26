"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import {
  findCaptureTarget,
  getLegalMoves,
  tryMoveSteps,
} from "../../convex/lib/ludo";
import { useRoomPresence } from "@/hooks/useRoomPresence";
import {
  useTokenAnimation,
  type AnimToken,
} from "@/hooks/useTokenAnimation";
import { haptic } from "@/lib/haptics";
import { bindAudioUnlock, isMuted, playSound, setMuted } from "@/lib/sounds";
import { Board } from "./Board";
import { Dice } from "./Dice";
import { Button, ErrorText } from "./ui";
import {
  COLOR_HEX,
  COLOR_LABEL,
  formatConvexError,
  type Color,
} from "@/lib/player";
import {
  buildTroubleSnapshot,
  isTroubleshootCoolingDown,
  runTroubleshoot,
} from "@/lib/troubleshoot";
import type { RoomBundle } from "./Lobby";
import { RejoinRequests } from "./RejoinRequests";
import styles from "./GameScreen.module.css";

type Props = {
  data: RoomBundle;
  roomId: Id<"rooms">;
  clientId: string;
};

/** Apply mutation result locally so joiners don't wait on query sync. */
type LocalDice = {
  value: number;
  rolled: boolean;
  turnId: number;
};

const ROLL_MIN_SPIN_MS = 280;
const ROLL_REVEAL_MS = 450;
/** Brief pause after dice reveal before a server auto-move animates. */
const AUTO_MOVE_DELAY_MS = 380;

function tokenSig(tokens: AnimToken[]) {
  return tokens
    .map((t) => `${t.color}:${t.index}:${t.steps}`)
    .sort()
    .join("|");
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
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

export function GameScreen({ data, roomId, clientId }: Props) {
  const router = useRouter();
  const rollDice = useMutation(api.game.rollDice);
  const moveToken = useMutation(api.game.moveToken);
  const rematch = useMutation(api.rooms.rematch);
  const leaveRoom = useMutation(api.rooms.leaveRoom);
  const reportTrouble = useMutation(api.trouble.reportTrouble);
  const [rolling, setRolling] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [troubleBusy, setTroubleBusy] = useState(false);
  const [muted, setMutedState] = useState(() =>
    typeof window !== "undefined" ? isMuted() : false,
  );
  const [offline, setOffline] = useState(false);
  /** Instant dice UI after roll — avoids waiting for Convex subscription. */
  const [localDice, setLocalDice] = useState<LocalDice | null>(null);
  /** Instant token targets after move — animation starts without network wait. */
  const [optimisticTokens, setOptimisticTokens] = useState<AnimToken[] | null>(
    null,
  );
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
      data.tokens.map((t) => ({
        color: t.color as Color,
        index: t.index,
        steps: t.steps,
      })),
    [data.tokens],
  );

  // Drop local dice once the server subscription catches up (or turn changes).
  useEffect(() => {
    if (!localDice) return;
    if (data.room.turnId !== localDice.turnId) {
      const id = setTimeout(() => setLocalDice(null), 0);
      return () => clearTimeout(id);
    }
    if (
      data.room.diceValue === localDice.value &&
      data.room.diceRolled === localDice.rolled
    ) {
      const id = setTimeout(() => setLocalDice(null), 0);
      return () => clearTimeout(id);
    }
  }, [
    data.room.turnId,
    data.room.diceValue,
    data.room.diceRolled,
    localDice,
  ]);

  // Drop optimistic tokens once server matches (or rematch resets length).
  useEffect(() => {
    if (!optimisticTokens) return;
    if (
      serverTokens.length !== optimisticTokens.length ||
      tokenSig(serverTokens) === tokenSig(optimisticTokens)
    ) {
      const id = setTimeout(() => setOptimisticTokens(null), 0);
      return () => clearTimeout(id);
    }
  }, [serverTokens, optimisticTokens]);

  const animTokens = optimisticTokens ?? serverTokens;
  const { displayTokens, animating, fx } = useTokenAnimation(animTokens);

  const remainingMs = useTurnCountdown(
    data.room.turnStartedAt ?? null,
    data.room.turnTimeoutMs ?? 60_000,
    data.room.status === "playing",
  );

  // Turn-start beep when turnId changes
  useEffect(() => {
    if (data.room.status !== "playing") return;
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
    if (data.room.status === "finished" && data.room.winner && !winPlayed.current) {
      winPlayed.current = true;
      playSound("win");
      haptic("win");
    }
    if (data.room.status === "playing") {
      winPlayed.current = false;
    }
  }, [data.room.status, data.room.winner]);

  const selectable = useMemo(() => {
    if (!data.me) return [] as number[];
    const rolled = localDice ? localDice.rolled : data.room.diceRolled;
    const diceValue = localDice ? localDice.value : data.room.diceValue;
    if (!rolled || diceValue === null) return [] as number[];
    if (data.me.color !== data.room.currentTurn) return [];
    if (data.room.status !== "playing") return [];
    if (animating || optimisticTokens) return [];
    const mePlayer = data.players.find((p) => p.isMe);
    if (mePlayer?.finishRank != null || mePlayer?.eliminated) return [];
    const tokens = optimisticTokens ?? serverTokens;
    return getLegalMoves(tokens, data.me.color, diceValue);
  }, [data, animating, localDice, optimisticTokens, serverTokens]);

  const finishRanks = useMemo(() => {
    const ranks: Partial<Record<Color, number>> = {};
    for (const p of data.players) {
      if (p.finishRank != null) {
        ranks[p.color as Color] = p.finishRank;
      }
    }
    return ranks;
  }, [data.players]);

  const moveLogRef = useRef<HTMLUListElement>(null);
  const eventCount = data.room.events?.length ?? 0;
  useEffect(() => {
    const el = moveLogRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [eventCount]);

  const { room, players, me } = data;
  const diceValue = localDice ? localDice.value : room.diceValue;
  const diceRolled = localDice ? localDice.rolled : room.diceRolled;
  const myTurn =
    !!me &&
    me.color === room.currentTurn &&
    room.status === "playing" &&
    !players.find((p) => p.color === me.color)?.eliminated &&
    players.find((p) => p.color === me.color)?.finishRank == null;
  const canRoll =
    myTurn && !diceRolled && !rolling && !animating && !optimisticTokens;
  const turnLabel = COLOR_LABEL[room.currentTurn as Color];
  const turnPlayer = players.find((p) => p.color === room.currentTurn);
  const turnAway =
    room.status === "playing" &&
    !!turnPlayer &&
    !turnPlayer.connected &&
    !turnPlayer.isBot;
  const botThinking =
    room.status === "playing" && !!turnPlayer?.isBot && !myTurn;
  const seconds = Math.ceil(remainingMs / 1000);
  const timerUrgent = seconds <= 10;
  const threeSixesBanner = /three 6s/i.test(room.lastEvent ?? "");

  const meDisconnected =
    !!me &&
    !!players.find((p) => p.isMe && !p.connected) &&
    !offline;

  async function applyOptimisticMove(tokenIndex: number, dice: number) {
    if (!me) return;
    const base = optimisticTokens ?? serverTokens;
    const mover = base.find(
      (t) => t.color === me.color && t.index === tokenIndex,
    );
    const dest = mover ? tryMoveSteps(mover.steps, dice) : null;
    if (mover && dest !== null) {
      const captured = findCaptureTarget(base, me.color, dest);
      const next = base.map((t) => {
        if (t.color === me.color && t.index === tokenIndex) {
          return { ...t, steps: dest };
        }
        if (
          captured &&
          t.color === captured.color &&
          t.index === captured.index
        ) {
          return { ...t, steps: -1 };
        }
        return t;
      });
      setOptimisticTokens(next);
      setLocalDice({
        value: dice,
        rolled: false,
        turnId: room.turnId,
      });
    }
  }

  async function onRoll() {
    if (!canRoll || rollLock.current) return;
    rollLock.current = true;
    setError(null);
    setRolling(true);
    setReveal(false);
    haptic("roll");
    playSound("roll");
    const started = performance.now();
    try {
      const result = await rollDice({
        roomId,
        clientId,
        turnId: room.turnId,
      });
      // Keep a short spin even on fast networks; never stack extra delay
      // after a slow round-trip (joiners feel this hardest).
      const elapsed = performance.now() - started;
      if (elapsed < ROLL_MIN_SPIN_MS) {
        await sleep(ROLL_MIN_SPIN_MS - elapsed);
      }
      if (result.threeSixes) playSound("threeSixes");

      if (result.skipped) {
        setLocalDice(null);
      } else if (result.rollAgain) {
        // Show the 6 briefly, then allow another roll immediately.
        setLocalDice({
          value: result.value,
          rolled: false,
          turnId: room.turnId,
        });
      } else if (result.autoMoved && result.autoMove && me) {
        // Reveal dice, pause briefly, then animate the sole legal move.
        setLocalDice({
          value: result.value,
          rolled: true,
          turnId: room.turnId,
        });
        setReveal(true);
        setTimeout(() => setReveal(false), ROLL_REVEAL_MS);
        await sleep(AUTO_MOVE_DELAY_MS);
        await applyOptimisticMove(
          result.legalMoves[0] ?? 0,
          result.value,
        );
        if (result.autoMove.captured) haptic("capture");
        setRolling(false);
        rollLock.current = false;
        return;
      } else {
        setLocalDice({
          value: result.value,
          rolled: true,
          turnId: room.turnId,
        });
      }

      setReveal(true);
      setTimeout(() => setReveal(false), ROLL_REVEAL_MS);
    } catch (e) {
      setError(formatConvexError(e, "Could not roll"));
      setLocalDice(null);
    } finally {
      setRolling(false);
      rollLock.current = false;
    }
  }

  async function commitMove(tokenIndex: number) {
    if (
      animating ||
      moveLock.current ||
      !myTurn ||
      !diceRolled ||
      diceValue === null ||
      !me
    ) {
      return;
    }
    moveLock.current = true;
    setError(null);
    haptic("tap");

    await applyOptimisticMove(tokenIndex, diceValue);

    try {
      const result = await moveToken({
        roomId,
        clientId,
        tokenIndex,
        turnId: room.turnId,
      });
      if (result.captured) {
        haptic("capture");
      }
    } catch (e) {
      setError(formatConvexError(e, "Illegal move"));
      setOptimisticTokens(null);
      setLocalDice({
        value: diceValue,
        rolled: true,
        turnId: room.turnId,
      });
    } finally {
      moveLock.current = false;
    }
  }

  async function onSelectToken(tokenIndex: number) {
    if (
      animating ||
      moveLock.current ||
      !myTurn ||
      !diceRolled ||
      diceValue === null ||
      !me
    ) {
      return;
    }
    // Explicit token id from geometric hit-test — never infer from stack order.
    await commitMove(tokenIndex);
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

  function clearLocalTroubleState() {
    setLocalDice(null);
    setOptimisticTokens(null);
    setError(null);
    setRolling(false);
    setReveal(false);
    setBusy(false);
    rollLock.current = false;
    moveLock.current = false;
  }

  async function onTroubleshoot() {
    if (troubleBusy || isTroubleshootCoolingDown()) return;
    setTroubleBusy(true);
    const snapshot = buildTroubleSnapshot({
      clientId,
      roomId,
      code: room.code,
      screen: "game",
      lastError: error ?? undefined,
      roomStatus: room.status,
      turnId: room.turnId,
      diceRolled: room.diceRolled,
      diceValue: room.diceValue,
      offline,
    });
    await runTroubleshoot({
      report: (s) => reportTrouble(s),
      snapshot,
      clearLocal: clearLocalTroubleState,
    });
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

  const midGameFinishers = players.filter(
    (p) => p.finishRank != null && !p.eliminated && room.status === "playing",
  );

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
                onClick={() => void onTroubleshoot()}
                disabled={troubleBusy || isTroubleshootCoolingDown()}
                aria-busy={troubleBusy || undefined}
                aria-label="Troubleshoot connection"
              >
                {troubleBusy ? "Fixing…" : "Troubleshoot"}
              </button>
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
                  className={styles.iconBtn}
                  disabled={busy}
                  onClick={onLeave}
                  aria-label="Leave game"
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
              {myTurn
                ? " — you"
                : botThinking
                  ? " — computer"
                  : turnAway
                    ? " — away"
                    : ""}
            </h2>
          )}
        </div>
      </header>

      <RejoinRequests
        roomId={roomId}
        clientId={clientId}
        isHost={!!me?.isHost}
      />

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

      {(room.events?.length ?? 0) > 0 && (
        <div className={styles.moveLog} aria-label="Move history">
          <p className={styles.moveLogTitle}>Moves</p>
          <ul
            ref={moveLogRef}
            className={styles.moveLogList}
            aria-live="polite"
            aria-relevant="additions"
          >
            {room.events!.map((e, i) => (
              <li
                key={`${e.at}-${i}`}
                className={
                  i === room.events!.length - 1 ? styles.moveLogLatest : undefined
                }
              >
                {e.text}
              </li>
            ))}
          </ul>
        </div>
      )}

      {threeSixesBanner && room.status === "playing" && (
        <p className={styles.ruleBanner} role="status">
          Three 6s in a row — streak voided; board restored
        </p>
      )}

      {botThinking && (
        <p className={styles.banner} role="status" aria-live="polite">
          Computer is thinking…
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
            p.color === room.currentTurn &&
            room.status === "playing" &&
            p.finishRank == null &&
            !p.eliminated;
          const finished = p.finishRank != null && !p.eliminated;
          return (
            <li
              key={p._id}
              className={`${styles.player} ${isActive ? styles.active : ""} ${!p.connected && !p.isBot ? styles.away : ""} ${p.eliminated ? styles.eliminated : ""} ${finished ? styles.finished : ""}`}
              style={{ ["--c" as string]: COLOR_HEX[p.color as Color] }}
            >
              <span className={styles.swatch} />
              <span className={styles.playerMeta}>
                <span className={styles.playerName}>
                  {p.name}
                  {p.isMe ? " (you)" : ""}
                  {p.eliminated
                    ? " · out"
                    : finished
                      ? ` · #${p.finishRank}`
                      : p.isBot
                        ? isActive
                          ? " · turn"
                          : ""
                        : !p.connected
                          ? " · away"
                          : isActive
                            ? " · turn"
                            : ""}
                </span>
                {!finished && !p.eliminated && (
                  <span className={styles.lives} aria-label={`${p.lives} lives`}>
                    {"♥".repeat(Math.max(0, p.lives))}
                    <span className={styles.livesEmpty}>
                      {"♡".repeat(Math.max(0, 3 - p.lives))}
                    </span>
                  </span>
                )}
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
            value={diceValue}
            rolling={rolling}
            disabled={!canRoll}
            waitingLabel={waitingLabel}
            reveal={reveal}
            onRoll={onRoll}
          />
        </div>
      )}

      <div className={styles.boardSlot}>
        <Board
          tokens={displayTokens}
          selectable={
            myTurn && diceRolled && !animating && !optimisticTokens
              ? selectable
              : []
          }
          myColor={me?.color}
          activeColor={
            room.status === "playing" ? (room.currentTurn as Color) : null
          }
          finishRanks={finishRanks}
          playerCount={players.length}
          fx={fx}
          onSelectToken={onSelectToken}
        />
      </div>

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
                const place = i + 1;
                const isWinner = color === room.winner || place === 1;
                const isLoser = place === players.length;
                return (
                  <li
                    key={color}
                    style={{ ["--c" as string]: COLOR_HEX[color as Color] }}
                  >
                    <span className={styles.rankNum}>{place}</span>
                    <span className={styles.swatch} />
                    {p?.name ?? COLOR_LABEL[color as Color]}
                    {isWinner
                      ? " · winner"
                      : isLoser
                        ? " · lose"
                        : p?.eliminated
                          ? " · out"
                          : ""}
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

        {midGameFinishers.length > 0 && room.status === "playing" && (
          <p className={styles.standing} role="status">
            {midGameFinishers
              .sort((a, b) => (a.finishRank ?? 0) - (b.finishRank ?? 0))
              .map((p) => `${p.name} #${p.finishRank}`)
              .join(" · ")}
            {" — match continues"}
          </p>
        )}

        {myTurn &&
          diceRolled &&
          selectable.length > 0 &&
          !animating && (
            <p className={styles.prompt}>Tap a glowing token to move</p>
          )}
        {myTurn && !diceRolled && room.status === "playing" && !animating && (
          <p className={styles.prompt}>Your turn — roll the dice</p>
        )}
        {!myTurn && room.status === "playing" && !turnAway && (
          <p className={styles.waiting}>Waiting for {turnLabel}…</p>
        )}
        <ErrorText
          onTroubleshoot={() => void onTroubleshoot()}
          troubleBusy={troubleBusy}
          troubleDisabled={isTroubleshootCoolingDown()}
        >
          {error}
        </ErrorText>
      </div>
    </div>
  );
}
