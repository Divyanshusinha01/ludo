"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useCanUse3DDice } from "@/hooks/useCanUse3D";
import { COLOR_HEX, type Color } from "@/lib/player";
import styles from "./Dice.module.css";

const Dice3D = dynamic(
  () => import("./Dice3D").then((m) => m.Dice3D),
  { ssr: false },
);

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
  const use3D = useCanUse3DDice();
  const [spinFace, setSpinFace] = useState<number | null>(null);

  useEffect(() => {
    if (!rolling || use3D) {
      setSpinFace(null);
      return;
    }
    // CSS fallback spin — start immediately so "Roll" doesn't linger.
    let last = 1 + Math.floor(Math.random() * 6);
    setSpinFace(last);
    const id = setInterval(() => {
      let next = 1 + Math.floor(Math.random() * 6);
      if (next === last) next = (next % 6) + 1;
      last = next;
      setSpinFace(next);
    }, 40);
    return () => clearInterval(id);
  }, [rolling, use3D]);

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
      className={`${styles.dice} ${rolling ? styles.rolling : ""} ${reveal && !rolling && value ? styles.reveal : ""} ${!disabled && !rolling ? styles.ready : ""} ${use3D ? styles.dice3d : ""}`}
      style={{ ["--dice-c" as string]: COLOR_HEX[color] }}
      onClick={onRoll}
      disabled={disabled}
      aria-label={label}
      aria-disabled={disabled}
    >
      {use3D ? (
        <span className={styles.canvasWrap} aria-hidden>
          <Dice3D value={value} color={color} rolling={rolling} />
          {!value && !rolling && (
            <span className={styles.hint}>Roll</span>
          )}
        </span>
      ) : (
        <span className={styles.face}>
          {pips?.map((i) => (
            <span key={i} className={`${styles.pip} ${styles[`p${i}`]}`} />
          ))}
          {!shown && <span className={styles.hint}>Roll</span>}
        </span>
      )}
    </button>
  );
}
