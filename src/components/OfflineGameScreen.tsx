"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  findCaptureTargets,
  getLegalMoves,
  tryMoveSteps,
} from "../../convex/lib/ludo";
import { useOfflineGame } from "@/hooks/useOfflineGame";
import { useOpponentDiceRoll } from "@/hooks/useOpponentDiceRoll";
import {
  useTokenAnimation,
  type AnimToken,
} from "@/hooks/useTokenAnimation";
import { haptic } from "@/lib/haptics";
import { bindAudioUnlock, isMuted, playSound, setMuted } from "@/lib/sounds";
import { Board } from "./Board";
import { Dice } from "./Dice";
import { Button, ErrorText } from "./ui";
import { COLOR_HEX, COLOR_LABEL, type Color } from "@/lib/player";
import styles from "./GameScreen.module.css";

const ROLL_MIN_SPIN_MS = 220;
const ROLL_REVEAL_MS = 320;
const AUTO_MOVE_DELAY_MS = 260;

type LocalDice = {
  value: number;
  rolled: boolean;
  turnId: number;
};

function tokenSig(tokens: AnimToken[]) {
  return tokens
    .map((t) => `${t.color}:${t.index}:${t.steps}`)
    .sort()
    .join("|");
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

type Props = {
  onStartNew: () => void;
};

export function OfflineGameScreen(props: Props) {
  const game = useOfflineGame();
  if (!game.bundle) return null;
  return <OfflineGameScreenInner {...props} game={game} data={game.bundle} />;
}

type InnerProps = Props & {
  game: ReturnType<typeof useOfflineGame>;
  data: NonNullable<ReturnType<typeof useOfflineGame>["bundle"]>;
};

function OfflineGameScreenInner({ onStartNew, game, data }: InnerProps) {
  const { roll, move, rematch, leave, resetGame } = game;
  const [rolling, setRolling] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [muted, setMutedState] = useState(() =>
    typeof window !== "undefined" ? isMuted() : false,
  );
  const [localDice, setLocalDice] = useState<LocalDice | null>(null);
  const [optimisticTokens, setOptimisticTokens] = useState<AnimToken[] | null>(
    null,
  );
  const lastTurnId = useRef<number | null>(null);
  const winPlayed = useRef(false);
  const [winBurstKey, setWinBurstKey] = useState(0);
  const rollLock = useRef(false);
  const moveLock = useRef(false);

  useEffect(() => {
    bindAudioUnlock();
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

  const selectable = useMemo(() => {
    if (!data.me) return [] as number[];
    const rolled = localDice ? localDice.rolled : data.room.diceRolled;
    const diceValue = localDice ? localDice.value : data.room.diceValue;
    if (!rolled || diceValue === null) return [] as number[];
    if (data.me.color !== data.room.currentTurn) return [];
    if (data.room.status !== "playing") return [];
    if (animating || optimisticTokens) return [];
    const mePlayer = data.players.find((p) => p.isMe);
    if (mePlayer?.finishRank != null) return [];
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
    players.find((p) => p.color === me.color)?.finishRank == null;
  const canRoll =
    myTurn && !diceRolled && !rolling && !animating && !optimisticTokens;

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

  const turnLabel = COLOR_LABEL[room.currentTurn as Color];
  const turnPlayer = players.find((p) => p.color === room.currentTurn);
  const botThinking =
    room.status === "playing" && !!turnPlayer?.isBot && !myTurn;
  const threeSixesBanner = /three 6s/i.test(room.lastEvent ?? "");

  async function applyOptimisticMove(tokenIndex: number, dice: number) {
    if (!me) return;
    const base = optimisticTokens ?? serverTokens;
    const mover = base.find(
      (t) => t.color === me.color && t.index === tokenIndex,
    );
    const dest = mover ? tryMoveSteps(mover.steps, dice) : null;
    if (mover && dest !== null) {
      const captures = findCaptureTargets(base, me.color, dest);
      const capturedKeys = new Set(
        captures.map((c) => `${c.color}:${c.index}`),
      );
      const next = base.map((t) => {
        if (t.color === me.color && t.index === tokenIndex) {
          return { ...t, steps: dest };
        }
        if (capturedKeys.has(`${t.color}:${t.index}`)) {
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
      const result = roll();
      if (!result) throw new Error("Could not roll");
      const elapsed = performance.now() - started;
      if (elapsed < ROLL_MIN_SPIN_MS) {
        await sleep(ROLL_MIN_SPIN_MS - elapsed);
      }
      if (result.threeSixes) playSound("threeSixes");

      if (result.skipped) {
        setLocalDice(null);
      } else if (result.rollAgain) {
        setLocalDice({
          value: result.value,
          rolled: false,
          turnId: room.turnId,
        });
      } else if (result.autoMoved && result.autoMove && me) {
        setLocalDice({
          value: result.value,
          rolled: true,
          turnId: room.turnId,
        });
        setReveal(true);
        setTimeout(() => setReveal(false), ROLL_REVEAL_MS);
        await sleep(AUTO_MOVE_DELAY_MS);
        await applyOptimisticMove(result.legalMoves[0] ?? 0, result.value);
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
      setError(e instanceof Error ? e.message : "Could not roll");
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
      const result = move(tokenIndex);
      if (!result) throw new Error("Illegal move");
      if (result.captured) {
        haptic("capture");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Illegal move");
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

  async function onSelectToken(_color: Color, tokenIndex: number) {
    await commitMove(tokenIndex);
  }

  function onRematch() {
    setError(null);
    setBusy(true);
    try {
      rematch();
      setLocalDice(null);
      setOptimisticTokens(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start rematch");
    } finally {
      setBusy(false);
    }
  }

  function onLeave() {
    setBusy(true);
    leave();
  }

  function onReset() {
    resetGame();
    onStartNew();
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
      : botThinking
        ? "Thinking…"
        : `Pass device to ${turnPlayer?.name ?? turnLabel}`;

  const rankedPlayers = [...players].sort((a, b) => {
    const ra = a.finishRank ?? 50;
    const rb = b.finishRank ?? 50;
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
    (p) => p.finishRank != null && room.status === "playing",
  );

  const passAndPlayBanner =
    room.status === "playing" &&
    turnPlayer &&
    !turnPlayer.isBot &&
    !myTurn;

  return (
    <div className={styles.game}>
      <header className={styles.top}>
        <div className={styles.topText}>
          <div className={styles.topRow}>
            <p className={styles.label}>Offline · LOCAL</p>
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
                  className={styles.iconBtn}
                  disabled={busy}
                  onClick={onReset}
                  aria-label="Reset game"
                >
                  Reset
                </button>
              )}
              <button
                type="button"
                className={styles.iconBtn}
                disabled={busy}
                onClick={onLeave}
                aria-label="Leave game"
              >
                Leave
              </button>
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
              {myTurn ? " — your seat" : botThinking ? " — computer" : ""}
            </h2>
          )}
        </div>
      </header>

      {myTurn && room.status === "playing" && (
        <div className={styles.yourTurn} role="status">
          YOUR TURN
        </div>
      )}

      {passAndPlayBanner && (
        <p className={styles.banner} role="status">
          Pass the device to {turnPlayer.name}
        </p>
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
          {turnPlayer?.name ?? "Computer"} (computer) is thinking…
        </p>
      )}

      <ul className={styles.players}>
        {players.map((p) => {
          const isActive =
            p.color === room.currentTurn &&
            room.status === "playing" &&
            p.finishRank == null;
          const finished = p.finishRank != null;
          return (
            <li
              key={p._id}
              className={`${styles.player} ${isActive ? styles.active : ""} ${finished ? styles.finished : ""}`}
              style={{ ["--c" as string]: COLOR_HEX[p.color as Color] }}
            >
              <span className={styles.swatch} />
              <span className={styles.playerMeta}>
                <span className={styles.playerName}>
                  {p.name}
                  {p.isMe ? " (acting)" : ""}
                  {finished
                    ? ` · #${p.finishRank}`
                    : p.isBot
                      ? isActive
                        ? " · turn"
                        : ""
                      : isActive
                        ? " · turn"
                        : ""}
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
            value={diceDisplayValue}
            color={room.currentTurn as Color}
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
          winBurstKey={winBurstKey}
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
                        : ""}
                  </li>
                );
              })}
            </ol>
            <div className={styles.endActions}>
              <Button variant="ink" disabled={busy} onClick={onRematch}>
                Play again
              </Button>
              <Button variant="secondary" disabled={busy} onClick={onStartNew}>
                Start new local game
              </Button>
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
        {!myTurn && room.status === "playing" && !botThinking && (
          <p className={styles.waiting}>
            Waiting for {turnPlayer?.name ?? turnLabel}…
          </p>
        )}
        <ErrorText>{error}</ErrorText>
      </div>
    </div>
  );
}
