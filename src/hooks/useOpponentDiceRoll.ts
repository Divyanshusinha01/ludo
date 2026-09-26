"use client";

import { useEffect, useRef } from "react";
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
    !next.diceRolled &&
    prev.diceValue !== next.diceValue &&
    prev.diceValue !== null;

  return becameRolled || rollAgain || faceChangedWhilePending;
}

/**
 * When another player rolls (or a bot rolls offline), the server/state updates
 * with the final face immediately. Run the same spin + reveal as a local roll.
 */
export function useOpponentDiceRoll(options: {
  playing: boolean;
  myTurn: boolean;
  turnId: number;
  diceRolled: boolean;
  diceValue: number | null;
  rollLock: React.MutableRefObject<boolean>;
  minSpinMs: number;
  revealMs: number;
  setRolling: (rolling: boolean) => void;
  setReveal: (reveal: boolean) => void;
}) {
  const {
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
  } = options;

  const prevRef = useRef<DiceSnap | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (revealTimerRef.current) clearTimeout(revealTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const next: DiceSnap = { turnId, diceRolled, diceValue };

    if (!playing) {
      prevRef.current = next;
      return;
    }

    const prev = prevRef.current;
    prevRef.current = next;

    if (!prev || myTurn || rollLock.current) return;

    if (!shouldAnimateRemoteRoll(prev, next)) return;

    if (timerRef.current) clearTimeout(timerRef.current);
    if (revealTimerRef.current) clearTimeout(revealTimerRef.current);

    setReveal(false);
    setRolling(true);
    playSound("roll");

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setRolling(false);
      setReveal(true);
      revealTimerRef.current = setTimeout(() => {
        revealTimerRef.current = null;
        setReveal(false);
      }, revealMs);
    }, minSpinMs);
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
}
