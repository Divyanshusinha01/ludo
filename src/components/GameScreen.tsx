"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import {
  findCaptureTargets,
  getLegalMovesForActor,
  legalMovesForDelegatedRoll,
  moveControllerColor,
  rollControllerColor,
  shouldKeepRollForTeammatePass,
  teamTeammateColor,
  tryMoveSteps,
  turnActorColor,
  type TeamPlayerLike,
  type TokenMoveChoice,
} from "../../convex/lib/ludo";
import { useRoomPresence } from "@/hooks/useRoomPresence";
import { useConnectionResync } from "@/hooks/useConnectionResync";
import { useOpsReporter } from "@/hooks/useOpsReporter";
import { useOpponentDiceRoll } from "@/hooks/useOpponentDiceRoll";
import { classifyError, isRateLimitedError, isStaleError } from "@/lib/opsReporter";
import { ACTION_MIN_INTERVAL_MS } from "../../convex/lib/session";
import type { MetricKind } from "../../convex/lib/metrics";
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
import { PlayerProfileCard } from "./PlayerProfileCard";
import { RatingResultBanner } from "./RatingResultBanner";
import { RejoinRequests } from "./RejoinRequests";
import styles from "./GameScreen.module.css";

type Props = {
  data: RoomBundle;
  roomId: Id<"rooms">;
  clientId: string;
  /** Read-only watcher view: no seat, no controls, no seat heartbeats or metrics. */
  spectate?: { count: number };
};

/** Apply mutation result locally so joiners don't wait on query sync. */
type LocalDice = {
  value: number;
  rolled: boolean;
  turnId: number;
};

const ROLL_MIN_SPIN_MS = 220;
const ROLL_REVEAL_MS = 320;
/** Brief pause after dice reveal before a server auto-move animates. */
const AUTO_MOVE_DELAY_MS = 260;
const NOTICE_MS = 2_500;

function tokenSig(tokens: AnimToken[]) {
  return tokens
    .map((t) => `${t.color}:${t.index}:${t.steps}`)
    .sort()
    .join("|");
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** A tap right after the previous action can land inside the server's per-seat gap; retry once past it. */
async function retryIfRateLimited<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    if (!isRateLimitedError(e)) throw e;
    await sleep(ACTION_MIN_INTERVAL_MS + 50);
    return await call();
  }
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

export function GameScreen({ data, roomId, clientId, spectate }: Props) {
  const readOnly = !!spectate;
  const router = useRouter();
  const rollDice = useMutation(api.game.rollDice);
  const moveToken = useMutation(api.game.moveToken);
  const passTurn = useMutation(api.game.passTurn);
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
  /** Room head the optimistic tokens were predicted from. */
  const optimisticSeq = useRef<number | null>(null);
  const lastTurnId = useRef<number | null>(null);
  const winPlayed = useRef(false);
  const [winBurstKey, setWinBurstKey] = useState(0);
  const rollLock = useRef(false);
  const moveLock = useRef(false);
  const [profilePlayerId, setProfilePlayerId] = useState<Id<"players"> | null>(
    null,
  );
  const closeProfile = useCallback(() => setProfilePlayerId(null), []);

  useRoomPresence(roomId, clientId, !readOnly);
  const reporter = useOpsReporter(roomId, clientId, !readOnly);
  const { connected } = useConnectionResync({
    roomId,
    clientId,
    eventSeq: data.room.eventSeq,
    reporter,
    seated: !readOnly,
  });
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(id);
  }, [notice]);

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
  // A newer head also drops them: one subscription update can carry our move
  // and the next player's, so the predicted board is never seen on its own.
  useEffect(() => {
    if (!optimisticTokens) return;
    if (
      serverTokens.length !== optimisticTokens.length ||
      tokenSig(serverTokens) === tokenSig(optimisticTokens) ||
      data.room.eventSeq !== optimisticSeq.current
    ) {
      const id = setTimeout(() => setOptimisticTokens(null), 0);
      return () => clearTimeout(id);
    }
  }, [serverTokens, optimisticTokens, data.room.eventSeq]);

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

  // Win sound + confetti (once)
  useEffect(() => {
    if (data.room.status === "finished" && data.room.winner && !winPlayed.current) {
      winPlayed.current = true;
      playSound("win");
      haptic("win");
      setWinBurstKey((k) => k + 1);
    }
    if (data.room.status === "playing") {
      winPlayed.current = false;
    }
  }, [data.room.status, data.room.winner]);

  const selectableTokens = useMemo((): TokenMoveChoice[] => {
    if (!data.me) return [];
    const rolled = localDice ? localDice.rolled : data.room.diceRolled;
    const diceValue = localDice ? localDice.value : data.room.diceValue;
    if (!rolled || diceValue === null) return [];
    if (data.room.status !== "playing") return [];
    if (animating || optimisticTokens) return [];
    const mePlayer = data.players.find((p) => p.isMe);
    if (mePlayer?.finishRank != null || mePlayer?.eliminated) return [];
    const mode = data.room.mode === "2v2" ? "2v2" : "1v1";
    const turnSeat = data.room.currentTurn as Color;
    const roster = data.players as TeamPlayerLike[];
    const passedRollTo = data.room.passedRollTo ?? null;
    const moveColor = moveControllerColor(turnSeat, roster, mode, passedRollTo);
    if (mePlayer?.color !== moveColor) return [];
    const tokens = optimisticTokens ?? serverTokens;
    if (passedRollTo != null) {
      return legalMovesForDelegatedRoll(tokens, passedRollTo, diceValue);
    }
    return getLegalMovesForActor(tokens, moveColor, roster, mode, diceValue);
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

  const { room, players } = data;
  const me = readOnly ? null : data.me;
  const isTeamMode = room.mode === "2v2";
  const teamLabel = (team: "A" | "B" | null | undefined) =>
    team === "A" || team === "B" ? `Team ${team}` : null;
  const diceValue = localDice ? localDice.value : room.diceValue;
  const diceRolled = localDice ? localDice.rolled : room.diceRolled;
  const turnSeat = room.currentTurn as Color;
  const roster = players as TeamPlayerLike[];
  const gameMode = isTeamMode ? "2v2" : "1v1";
  const passedRollTo = room.passedRollTo ?? null;
  const turnActor = turnActorColor(turnSeat, roster, gameMode);
  const rollController = rollControllerColor(turnSeat, roster, gameMode, null);
  const moveController = moveControllerColor(
    turnSeat,
    roster,
    gameMode,
    passedRollTo,
  );
  const turnActorPlayer = players.find((p) => p.color === turnActor);
  const turnSeatPlayer = players.find((p) => p.color === turnSeat);
  const proxyTurn =
    isTeamMode &&
    room.status === "playing" &&
    turnSeat !== turnActor &&
    !!turnSeatPlayer?.finishRank &&
    passedRollTo == null;
  const meActive =
    !!me &&
    room.status === "playing" &&
    !players.find((p) => p.color === me.color)?.eliminated &&
    players.find((p) => p.color === me.color)?.finishRank == null;
  const iRoll =
    meActive && me.color === rollController && passedRollTo == null;
  const iMove = meActive && me.color === moveController && diceRolled;
  const myTurn = iRoll || iMove;
  const canRoll =
    connected &&
    iRoll &&
    !diceRolled &&
    !rolling &&
    !animating &&
    !optimisticTokens;

  const teammateColor =
    isTeamMode && me ? teamTeammateColor(me.color as Color) : null;
  const teammatePlayer =
    teammateColor != null
      ? players.find((p) => p.color === teammateColor)
      : undefined;
  const canPass =
    connected &&
    isTeamMode &&
    meActive &&
    me?.color === turnSeat &&
    diceRolled &&
    passedRollTo == null &&
    !proxyTurn &&
    room.status === "playing" &&
    !animating &&
    !optimisticTokens &&
    !rolling;
  const passTargetColor = useMemo((): Color | null => {
    if (
      !canPass ||
      !teammatePlayer ||
      teammatePlayer.eliminated ||
      teammatePlayer.finishRank != null ||
      !teammateColor ||
      diceValue === null
    ) {
      return null;
    }
    const tokens = optimisticTokens ?? serverTokens;
    return shouldKeepRollForTeammatePass(
      "2v2",
      turnSeat,
      diceValue,
      tokens,
      roster,
    )
      ? teammateColor
      : null;
  }, [
    canPass,
    teammatePlayer,
    teammateColor,
    diceValue,
    optimisticTokens,
    serverTokens,
    turnSeat,
    roster,
  ]);

  const { hideOpponentFace } = useOpponentDiceRoll({
    playing: room.status === "playing",
    myTurn,
    rolling,
    turnId: room.turnId,
    diceRolled: room.diceRolled,
    diceValue: room.diceValue,
    rollLock,
    minSpinMs: ROLL_MIN_SPIN_MS,
    revealMs: ROLL_REVEAL_MS,
    setRolling,
    setReveal,
  });

  const diceDisplayValue = hideOpponentFace ? null : diceValue;

  const turnLabel = COLOR_LABEL[turnSeat];
  const turnPlayer = turnActorPlayer;
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

  function reportOk(kind: MetricKind, started: number) {
    reporter.record({ kind, outcome: "ok", latencyMs: performance.now() - started });
  }

  function reportFailure(kind: MetricKind, started: number, err: unknown) {
    const { outcome, code, message } = classifyError(err);
    reporter.record({
      kind,
      outcome,
      latencyMs: performance.now() - started,
      code,
      message,
    });
  }

  /**
   * A stale rejection means the subscription already holds a newer head:
   * drop local guesses and let the server view render. Returns false for
   * any other error.
   */
  function resyncIfStale(err: unknown): boolean {
    if (!isStaleError(err)) return false;
    setOptimisticTokens(null);
    setLocalDice(null);
    setError(null);
    setNotice("Board updated");
    reporter.record({ kind: "resync", outcome: "ok" });
    return true;
  }

  async function applyOptimisticMove(
    tokenColor: Color,
    tokenIndex: number,
    dice: number,
  ) {
    if (!me) return;
    const base = optimisticTokens ?? serverTokens;
    const mover = base.find(
      (t) => t.color === tokenColor && t.index === tokenIndex,
    );
    const dest = mover ? tryMoveSteps(mover.steps, dice) : null;
    if (mover && dest !== null) {
      const captures = findCaptureTargets(
        base,
        tokenColor,
        dest,
        isTeamMode ? "2v2" : "1v1",
      );
      const capturedKeys = new Set(
        captures.map((c) => `${c.color}:${c.index}`),
      );
      const next = base.map((t) => {
        if (t.color === tokenColor && t.index === tokenIndex) {
          return { ...t, steps: dest };
        }
        if (capturedKeys.has(`${t.color}:${t.index}`)) {
          return { ...t, steps: -1 };
        }
        return t;
      });
      optimisticSeq.current = room.eventSeq;
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
    let answered = false;
    try {
      const result = await retryIfRateLimited(() =>
        rollDice({
          roomId,
          clientId,
          turnId: room.turnId,
          expectedSeq: room.eventSeq,
        }),
      );
      answered = true;
      reportOk("roll", started);
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
        const autoPick =
          result.legalTokenMoves?.[0] ??
          ({
            color: me.color as Color,
            index: result.legalMoves[0] ?? 0,
          } satisfies TokenMoveChoice);
        await applyOptimisticMove(
          autoPick.color,
          autoPick.index,
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
      if (!answered) reportFailure("roll", started, e);
      if (!resyncIfStale(e)) {
        setError(formatConvexError(e, "Could not roll"));
        setLocalDice(null);
      }
    } finally {
      setRolling(false);
      rollLock.current = false;
    }
  }

  async function onPassTurn(color: Color) {
    if (passTargetColor !== color || !connected) return;
    setError(null);
    haptic("tap");
    const started = performance.now();
    try {
      await passTurn({
        roomId,
        clientId,
        turnId: room.turnId,
        targetColor: color,
        expectedSeq: room.eventSeq,
      });
      reportOk("pass", started);
      setLocalDice(null);
    } catch (e) {
      reportFailure("pass", started, e);
      if (!resyncIfStale(e)) {
        setError(formatConvexError(e, "Could not pass turn"));
      }
    }
  }

  async function commitMove(tokenColor: Color, tokenIndex: number) {
    if (
      !connected ||
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

    await applyOptimisticMove(tokenColor, tokenIndex, diceValue);

    const started = performance.now();
    try {
      const result = await retryIfRateLimited(() =>
        moveToken({
          roomId,
          clientId,
          tokenIndex,
          ...(tokenColor !== me.color ? { tokenColor } : {}),
          turnId: room.turnId,
          expectedSeq: room.eventSeq,
        }),
      );
      reportOk("move", started);
      if (result.captured) {
        haptic("capture");
      }
    } catch (e) {
      reportFailure("move", started, e);
      if (!resyncIfStale(e)) {
        setError(formatConvexError(e, "Illegal move"));
        setOptimisticTokens(null);
        setLocalDice({
          value: diceValue,
          rolled: true,
          turnId: room.turnId,
        });
      }
    } finally {
      moveLock.current = false;
    }
  }

  async function onSelectToken(tokenColor: Color, tokenIndex: number) {
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
    await commitMove(tokenColor, tokenIndex);
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
    if (readOnly) {
      router.push("/");
      return;
    }
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
      {(offline || meDisconnected || !connected) && (
        <div className={styles.reconnect} role="status">
          {readOnly ? "Reconnecting…" : "Reconnecting… Your seat is saved."}
        </div>
      )}

      <header className={styles.top}>
        <div className={styles.topText}>
          <div className={styles.topRow}>
            <p className={styles.label}>
              Room {room.code}
              {spectate && (
                <span className={styles.spectatingBadge} role="status">
                  Spectating · {spectate.count} watching
                </span>
              )}
            </p>
            <div className={styles.topActions}>
              {!readOnly && (
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
              )}
              <button
                type="button"
                className={styles.iconBtn}
                onClick={toggleMute}
                aria-label={muted ? "Unmute sounds" : "Mute sounds"}
              >
                {muted ? "Sound off" : "Sound on"}
              </button>
              {(room.status === "playing" || readOnly) && (
                <button
                  type="button"
                  className={styles.iconBtn}
                  disabled={busy}
                  onClick={onLeave}
                  aria-label={readOnly ? "Stop watching" : "Leave game"}
                >
                  {readOnly ? "Stop watching" : "Leave"}
                </button>
              )}
            </div>
          </div>

          {room.status === "finished" ? (
            <h2 className={styles.title}>
              {isTeamMode && room.winningTeam
                ? `Team ${room.winningTeam} wins!`
                : `${COLOR_LABEL[room.winner as Color]} wins!`}
            </h2>
          ) : (
            <h2 className={styles.title}>
              <span
                className={styles.dot}
                style={{ background: COLOR_HEX[room.currentTurn as Color] }}
              />
              {proxyTurn
                ? `${COLOR_LABEL[turnSeat]}'s turn — ${turnActorPlayer?.name ?? turnLabel} playing for teammate`
                : `${turnLabel}'s turn`}
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

      {notice && (
        <p className={styles.banner} role="status" aria-live="polite">
          {notice}
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
            p.color === turnActor &&
            room.status === "playing" &&
            p.finishRank == null &&
            !p.eliminated;
          const finished = p.finishRank != null && !p.eliminated;
          const teammate = isTeamMode
            ? teamTeammateColor(p.color as Color)
            : null;
          const teammateName = teammate
            ? players.find((x) => x.color === teammate)?.name
            : null;
          const content = (
            <>
              <span className={styles.swatch} />
              <span className={styles.playerMeta}>
                <span className={styles.playerName}>
                  {p.name}
                  {isTeamMode && p.team ? ` · ${teamLabel(p.team)}` : ""}
                  {p.isMe ? " (you)" : ""}
                  {p.eliminated
                    ? " · out"
                    : finished
                      ? ` · finished #${p.finishRank}${teammateName ? ` — ${teammateName} plays your turns` : ""}`
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
            </>
          );
          return (
            <li
              key={p._id}
              className={`${styles.player} ${isActive ? styles.active : ""} ${!p.connected && !p.isBot ? styles.away : ""} ${p.eliminated ? styles.eliminated : ""} ${finished ? styles.finished : ""}`}
              style={{ ["--c" as string]: COLOR_HEX[p.color as Color] }}
            >
              {p.isBot ? (
                content
              ) : (
                <button
                  type="button"
                  className={styles.playerButton}
                  aria-haspopup="dialog"
                  title={`View ${p.name}'s profile`}
                  onClick={() => setProfilePlayerId(p._id)}
                >
                  {content}
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {profilePlayerId &&
        (() => {
          const p = players.find((x) => x._id === profilePlayerId);
          return p ? (
            <PlayerProfileCard
              playerId={p._id}
              name={p.name}
              color={COLOR_HEX[p.color as Color]}
              onClose={closeProfile}
            />
          ) : null;
        })()}

      {room.status === "playing" && (
        <div
          className={styles.diceRow}
          style={{ ["--c" as string]: COLOR_HEX[turnActor] }}
        >
          <span className={styles.diceOwner}>
            <span className={styles.swatch} />
            {myTurn
              ? proxyTurn
                ? "Your dice (teammate's turn slot)"
                : "Your dice"
              : proxyTurn
                ? `${turnActorPlayer?.name ?? turnLabel}'s dice (for ${COLOR_LABEL[turnSeat]})`
                : `${turnLabel}'s dice`}
          </span>
          <Dice
            value={diceDisplayValue}
            color={turnActor}
            rolling={rolling || hideOpponentFace}
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
          selectable={[]}
          selectableTokens={
            connected && myTurn && diceRolled && !animating && !optimisticTokens
              ? selectableTokens
              : []
          }
          myColor={me?.color}
          activeColor={
            room.status === "playing"
              ? passedRollTo ?? turnActor
              : null
          }
          finishRanks={finishRanks}
          playerCount={players.length}
          fx={fx}
          winBurstKey={winBurstKey}
          onSelectToken={onSelectToken}
          passTargetColor={passTargetColor}
          passTargetAriaLabel={
            passTargetColor && teammatePlayer && diceValue != null
              ? `Tap to pass your ${diceValue} to ${teammatePlayer.name}`
              : undefined
          }
          onPassTurn={passTargetColor ? onPassTurn : undefined}
        />
      </div>

      <div className={styles.controls}>
        {room.status === "finished" && (
          <div className={styles.results}>
            <h3 className={styles.resultsTitle}>
              {isTeamMode ? "Final results" : "Final rankings"}
            </h3>
            <ol className={styles.rankList}>
              {(room.rankings.length > 0
                ? room.rankings
                : rankedPlayers.map((p) => p.color)
              ).map((color, i) => {
                const p = players.find((x) => x.color === color);
                const place = i + 1;
                const isWinner = color === room.winner || place === 1;
                const isLoser = place === players.length;
                const onWinningTeam =
                  isTeamMode &&
                  room.winningTeam &&
                  p?.team === room.winningTeam;
                return (
                  <li
                    key={color}
                    style={{ ["--c" as string]: COLOR_HEX[color as Color] }}
                  >
                    <span className={styles.rankNum}>{place}</span>
                    <span className={styles.swatch} />
                    {p?.name ?? COLOR_LABEL[color as Color]}
                    {isTeamMode && p?.team
                      ? ` (${teamLabel(p.team)})`
                      : ""}
                    {isTeamMode
                      ? onWinningTeam
                        ? " · winning team"
                        : " · losing team"
                      : isWinner
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
            {room.ranked && (
              <RatingResultBanner roomId={roomId} myColor={(me?.color as Color | undefined) ?? null} />
            )}
            <div className={styles.endActions}>
              {readOnly ? (
                <p className={styles.waiting}>Match over.</p>
              ) : room.ranked ? (
                <p className={styles.waiting}>Ranked match over — find a new match from home.</p>
              ) : me?.isHost ? (
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
          selectableTokens.length > 0 &&
          !animating && (
            <p className={styles.prompt}>
              {proxyTurn
                ? "Tap your or your finished teammate's glowing token"
                : "Tap a glowing token to move"}
            </p>
          )}
        {iRoll && !diceRolled && room.status === "playing" && !animating && (
          <p className={styles.prompt}>Your turn — roll the dice</p>
        )}
        {passedRollTo != null &&
          me?.color === passedRollTo &&
          diceRolled &&
          diceValue != null &&
          !animating && (
            <p className={styles.prompt}>
              Use {turnSeatPlayer?.name ?? COLOR_LABEL[turnSeat]}&apos;s{" "}
              {diceValue} — tap your token
            </p>
          )}
        {passTargetColor && teammatePlayer && diceValue != null && !animating && (
          <p className={styles.prompt}>
            {selectableTokens.length === 0
              ? `Tap ${teammatePlayer.name}'s home to pass your ${diceValue}`
              : `Or tap ${teammatePlayer.name}'s home to pass your ${diceValue}`}
          </p>
        )}
        {!myTurn && room.status === "playing" && !turnAway && (
          <p className={styles.waiting}>Waiting for {turnLabel}…</p>
        )}
        <ErrorText
          onTroubleshoot={readOnly ? undefined : () => void onTroubleshoot()}
          troubleBusy={troubleBusy}
          troubleDisabled={isTroubleshootCoolingDown()}
        >
          {error}
        </ErrorText>
      </div>
    </div>
  );
}
