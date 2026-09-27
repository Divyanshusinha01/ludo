"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { OfflineGameScreen } from "@/components/OfflineGameScreen";
import { OfflineSetup } from "@/components/OfflineSetup";
import type { OfflineGameState } from "@/lib/offline/types";
import {
  clearOfflineGame,
  loadOfflineGame,
  saveOfflineGame,
  subscribeOfflineGame,
} from "@/lib/offline/storage";
import { Button } from "@/components/ui";
import { BoardHeroImage } from "@/components/BoardHeroImage";
import styles from "@/components/HomeScreen.module.css";

type Mode = "prompt" | "setup" | "game";

function readHasSavedGame(): boolean {
  return loadOfflineGame() !== null;
}

export function OfflineClient() {
  const router = useRouter();
  const state = useSyncExternalStore(
    subscribeOfflineGame,
    loadOfflineGame,
    () => null,
  );
  const hasSavedGame = useSyncExternalStore(
    subscribeOfflineGame,
    readHasSavedGame,
    () => false,
  );
  const [mode, setMode] = useState<Mode>("setup");

  useEffect(() => {
    if (hasSavedGame) {
      setMode((current) => (current === "setup" ? "prompt" : current));
    }
  }, [hasSavedGame]);

  const startGame = useCallback((initial: OfflineGameState) => {
    saveOfflineGame(initial);
  }, []);

  const resetGame = useCallback(() => {
    clearOfflineGame();
  }, []);

  const beginSetup = useCallback(() => {
    resetGame();
    setMode("setup");
  }, [resetGame]);

  const resumeSaved = useCallback(() => {
    setMode("game");
  }, []);

  if (mode === "prompt" && hasSavedGame) {
    return (
      <div className={styles.shell}>
        <div className={styles.hero}>
          <BoardHeroImage />
          <p className={styles.brand}>Play offline</p>
          <h1 className={styles.headline}>Saved game on this device</h1>
          <p className={styles.sub}>
            Continue where you left off, or clear the save and set up a new
            local table.
          </p>
        </div>
        <div className={styles.actions}>
          <Button type="button" variant="primary" onClick={resumeSaved}>
            Resume game
          </Button>
          <Button type="button" variant="secondary" onClick={beginSetup}>
            Start new game
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => router.push("/")}
          >
            Back home
          </Button>
        </div>
      </div>
    );
  }

  if (mode === "game" && !state) {
    return (
      <OfflineSetup
        onStart={(initial) => {
          startGame(initial);
          setMode("game");
        }}
        onBack={() => router.push("/")}
      />
    );
  }

  if (mode === "setup" || !state) {
    return (
      <OfflineSetup
        onStart={(initial) => {
          startGame(initial);
          setMode("game");
        }}
        onBack={() => router.push("/")}
      />
    );
  }

  return (
    <OfflineGameScreen
      onStartNew={() => {
        resetGame();
        setMode("setup");
      }}
    />
  );
}
