"use client";

import { useEffect, useState } from "react";
import { COLOR_HEX, type Color } from "@/lib/player";
import styles from "./Dice.module.css";

type Props = {
  value: number | null;
  /** House color of the player whose turn it is. */
  color: Color;
  rolling?: boolean;
  disabled?: boolean;
  waitingLabel?: string;
  /** Emphasize the revealed number after a roll. */
  reveal?: boolean;
  onRoll: () => void;
};

const FACES: Record<number, number[]> = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

export function Dice({
  value,
  color,
  rolling,
  disabled,
  waitingLabel,
  reveal,
  onRoll,
}: Props) {
  const [spinFace, setSpinFace] = useState<number | null>(null);

  useEffect(() => {
    if (!rolling) {
      setSpinFace(null);
      return;
    }
    // Start immediately so the "Roll" hint doesn't linger for a frame.
    let last = 1 + Math.floor(Math.random() * 6);
    setSpinFace(last);
    const id = setInterval(() => {
      let next = 1 + Math.floor(Math.random() * 6);
      // Avoid repeating the same face so the spin reads as motion.
      if (next === last) next = (next % 6) + 1;
      last = next;
      setSpinFace(next);
    }, 40);
    return () => clearInterval(id);
  }, [rolling]);

  // While rolling, animate with spinFace; otherwise show the server value.
  const shown = rolling ? (spinFace ?? value) : value;
  const pips =
    shown && shown >= 1 && shown <= 6 ? FACES[shown] : [];
  const label = disabled
    ? waitingLabel ??
      (value ? `Dice showing ${value}` : "Waiting to roll")
    : value
      ? `Dice showing ${value}. Tap to roll`
      : "Roll dice";

  return (
    <button
      type="button"
      className={`${styles.dice} ${rolling ? styles.rolling : ""} ${reveal && !rolling && value ? styles.reveal : ""} ${!disabled && !rolling ? styles.ready : ""}`}
      style={{ ["--dice-c" as string]: COLOR_HEX[color] }}
      onClick={onRoll}
      disabled={disabled}
      aria-label={label}
      aria-disabled={disabled}
    >
      <span className={styles.face}>
        {pips?.map((i) => (
          <span key={i} className={`${styles.pip} ${styles[`p${i}`]}`} />
        ))}
        {!shown && <span className={styles.hint}>Roll</span>}
      </span>
    </button>
  );
}
