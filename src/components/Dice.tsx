"use client";

import { useEffect, useState } from "react";
import styles from "./Dice.module.css";

type Props = {
  value: number | null;
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
    let n = 0;
    const id = setInterval(() => {
      n += 1;
      setSpinFace(1 + (n % 6));
    }, 70);
    return () => clearInterval(id);
  }, [rolling]);

  const shown = rolling && spinFace ? spinFace : value;
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
      className={`${styles.dice} ${rolling ? styles.rolling : ""} ${reveal && !rolling && value ? styles.reveal : ""} ${!disabled ? styles.ready : ""}`}
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
