"use client";

import { FormEvent, useState } from "react";
import { seatingColors } from "../../convex/lib/ludo";
import { botDisplayName } from "../../convex/lib/bot";
import { createOfflineGame } from "@/lib/offline/engine";
import { COLOR_HEX, COLOR_LABEL } from "@/lib/player";
import { Button, ErrorText } from "./ui";
import { BoardHeroImage } from "./BoardHeroImage";
import styles from "./OfflineSetup.module.css";

type SeatDraft = {
  name: string;
  isBot: boolean;
};

type Props = {
  onStart: (state: ReturnType<typeof createOfflineGame>) => void;
  onBack?: () => void;
};

function defaultSeats(count: number): SeatDraft[] {
  return seatingColors(count).map((_, i) => ({
    name: i === 0 ? "Player 1" : i === 1 ? "Player 2" : `Player ${i + 1}`,
    isBot: false,
  }));
}

export function OfflineSetup({ onStart, onBack }: Props) {
  const [playerCount, setPlayerCount] = useState(2);
  const [seats, setSeats] = useState<SeatDraft[]>(() =>
    defaultSeats(2),
  );
  const [error, setError] = useState<string | null>(null);

  function setCount(count: number) {
    setPlayerCount(count);
    setSeats(defaultSeats(count));
    setError(null);
  }

  function updateSeat(index: number, patch: Partial<SeatDraft>) {
    setSeats((prev) =>
      prev.map((s, i) => {
        if (i !== index) return s;
        const next = { ...s, ...patch };
        if (patch.isBot === true) {
          const botIndex = prev.slice(0, index).filter((x) => x.isBot).length;
          next.name = botDisplayName(botIndex);
        } else if (patch.isBot === false && s.isBot) {
          next.name = `Player ${index + 1}`;
        }
        return next;
      }),
    );
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const colors = seatingColors(playerCount);
    const configured = seats.slice(0, playerCount).map((s, i) => ({
      color: colors[i]!,
      name: s.isBot ? botDisplayName(seats.slice(0, i).filter((x) => x.isBot).length) : s.name.trim() || `Player ${i + 1}`,
      isBot: s.isBot,
    }));

    if (!configured.some((s) => !s.isBot)) {
      setError("Add at least one human player");
      return;
    }

    for (const s of configured) {
      if (!s.isBot && !s.name.trim()) {
        setError("Enter a name for each human player");
        return;
      }
    }

    try {
      const state = createOfflineGame(configured);
      onStart(state);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start game");
    }
  }

  const colors = seatingColors(playerCount);

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <BoardHeroImage />
        <p className={styles.brand}>Play offline</p>
        <p className={styles.sub}>
          Pass the device between humans on the couch, or mix in computer
          opponents. Progress saves on this device automatically.
        </p>
      </header>

      <fieldset className={styles.field}>
        <legend>Players at the table</legend>
        <div className={styles.countRow} role="group" aria-label="Player count">
          {([2, 3, 4] as const).map((n) => (
            <button
              key={n}
              type="button"
              className={
                playerCount === n ? styles.countActive : styles.countBtn
              }
              aria-pressed={playerCount === n}
              onClick={() => setCount(n)}
            >
              {n}
            </button>
          ))}
        </div>
      </fieldset>

      <form className={styles.actions} onSubmit={onSubmit}>
        <ul className={styles.seats}>
          {colors.map((color, i) => {
            const seat = seats[i]!;
            return (
              <li
                key={color}
                className={`${styles.seat} swap-in`}
                style={{ ["--c" as string]: COLOR_HEX[color] }}
              >
                <div className={styles.seatHead}>
                  <span className={styles.swatch} />
                  {COLOR_LABEL[color]}
                </div>
                <div className={styles.toggleRow} role="group">
                  <button
                    type="button"
                    className={
                      !seat.isBot ? styles.toggleActive : styles.toggle
                    }
                    aria-pressed={!seat.isBot}
                    onClick={() => updateSeat(i, { isBot: false })}
                  >
                    Human
                  </button>
                  <button
                    type="button"
                    className={
                      seat.isBot ? styles.toggleActive : styles.toggle
                    }
                    aria-pressed={seat.isBot}
                    onClick={() => updateSeat(i, { isBot: true })}
                  >
                    Computer
                  </button>
                </div>
                {!seat.isBot && (
                  <label className={styles.field}>
                    Name
                    <input
                      value={seat.name}
                      onChange={(e) =>
                        updateSeat(i, { name: e.target.value.slice(0, 20) })
                      }
                      maxLength={20}
                      autoComplete="off"
                    />
                  </label>
                )}
              </li>
            );
          })}
        </ul>

        <Button type="submit" variant="primary">
          Start local game
        </Button>
        {onBack && (
          <Button type="button" variant="secondary" onClick={onBack}>
            Back home
          </Button>
        )}
        <ErrorText>{error}</ErrorText>
      </form>
    </div>
  );
}
