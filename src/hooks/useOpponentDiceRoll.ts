"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { playSound } from "@/lib/sounds";

type DiceSnap = {
  turnId: number;
  diceRolled: boolean;
  diceValue: number | null;
};

export function shouldAnimateRemoteRoll(prev: DiceSnap, next: DiceSnap): boolean {
  if (next.diceValue === null) return false;

  if (next.turnId !== prev.turnId) {
    return next.diceRolled;
  }

  const becameRolled = !prev.diceRolled && next.diceRolled;
  const rollAgain =
    prev.diceRolled &&
    !next.diceRolled &&
    next.diceValue !== null;
  const faceChangedWhilePending =
    !next.diceRolled && prev.diceValue !== next.diceValue;

  return becameRolled || rollAgain || faceChangedWhilePending;
}

function clearTimer(ref: React.MutableRefObject<ReturnType<typeof setTimeout> | null>) {
  if (ref.current) {
    clearTimeout(ref.current);
    ref.current = null;
  }
}

/**
 * When another player rolls (or a bot rolls offline), the server/state updates
 * with the final face immediately. Run the same spin + reveal as a local roll.
 */
export function useOpponentDiceRoll(options: {
  playing: boolean;
  myTurn: boolean;
  rolling: boolean;
  turnId: number;
  diceRolled: boolean;
  diceValue: number | null;
  rollLock: React.MutableRefObject<boolean>;
  minSpinMs: number;
  revealMs: number;
  setRolling: (rolling: boolean) => void;
  setReveal: (reveal: boolean) => void;
}): { hideOpponentFace: boolean } {
  const {
    playing,
    myTurn,
    rolling,
    turnId,
    diceRolled,
    diceValue,
    rollLock,
    minSpinMs,
    revealMs,
    setRolling,
    setReveal,
  } = options;

  const prevRef = useRef<DiceSnap | null>(null);
  const spinUntilRef = useRef(0);
  const remoteSpinRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const snap: DiceSnap = { turnId, diceRolled, diceValue };
  const prevSnap = prevRef.current;

  const pendingRemoteRoll =
    playing &&
    !myTurn &&
    !rollLock.current &&
    prevSnap !== null &&
    shouldAnimateRemoteRoll(prevSnap, snap);

  const hideOpponentFace = !myTurn && (rolling || pendingRemoteRoll);

  useEffect(() => {
    return () => {
      clearTimer(timerRef);
      clearTimer(revealTimerRef);
    };
  }, []);

  useLayoutEffect(() => {
    function finishRemoteSpin() {
      clearTimer(timerRef);
      remoteSpinRef.current = false;
      spinUntilRef.current = 0;
      setRolling(false);
      setReveal(true);
      clearTimer(revealTimerRef);
      revealTimerRef.current = setTimeout(() => {
        revealTimerRef.current = null;
        setReveal(false);
      }, revealMs);
    }

    function cancelRemoteSpin() {
      clearTimer(timerRef);
      clearTimer(revealTimerRef);
      remoteSpinRef.current = false;
      spinUntilRef.current = 0;
      setRolling(false);
      setReveal(false);
    }

    function scheduleSpinFinish() {
      clearTimer(timerRef);
      const wait = Math.max(0, spinUntilRef.current - Date.now());
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (Date.now() < spinUntilRef.current) {
          scheduleSpinFinish();
          return;
        }
        finishRemoteSpin();
      }, wait);
    }

    const next = snap;

    if (!playing) {
      if (remoteSpinRef.current) {
        cancelRemoteSpin();
      }
      prevRef.current = next;
      return;
    }

    if (myTurn && remoteSpinRef.current && !rollLock.current) {
      cancelRemoteSpin();
    }

    const prev = prevRef.current;

    if (prev && !myTurn && !rollLock.current && shouldAnimateRemoteRoll(prev, next)) {
      clearTimer(revealTimerRef);
      setReveal(false);

      spinUntilRef.current = Math.max(
        spinUntilRef.current,
        Date.now() + minSpinMs,
      );
      remoteSpinRef.current = true;
      setRolling(true);
      playSound("roll");
      scheduleSpinFinish();
    }

    prevRef.current = next;
  }, [
    playing,
    myTurn,
    turnId,
    diceRolled,
    diceValue,
    rollLock,
    minSpinMs,
    revealMs,
    setRolling,
    setReveal,
  ]);

  return { hideOpponentFace };
}
