"use client";

import styles from "./Dice.module.css";

type Props = {
  value: number | null;
  rolling?: boolean;
  disabled?: boolean;
  waitingLabel?: string;
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
  onRoll,
}: Props) {
  const pips = value && value >= 1 && value <= 6 ? FACES[value] : [];
  const label = disabled
    ? waitingLabel ??
      (value ? `Dice showing ${value}` : "Waiting to roll")
    : value
      ? `Dice showing ${value}. Tap to roll`
      : "Roll dice";

  return (
    <button
      type="button"
      className={`${styles.dice} ${rolling ? styles.rolling : ""}`}
      onClick={onRoll}
      disabled={disabled}
      aria-label={label}
    >
      <span className={styles.face}>
        {pips?.map((i) => (
          <span key={i} className={`${styles.pip} ${styles[`p${i}`]}`} />
        ))}
        {!value && <span className={styles.hint}>Roll</span>}
      </span>
    </button>
  );
}
