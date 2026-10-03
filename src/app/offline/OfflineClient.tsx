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
import { Button, Loader } from "@/components/ui";
import { BoardHeroImage } from "@/components/BoardHeroImage";
import styles from "@/components/HomeScreen.module.css";

type Mode = "prompt" | "setup" | "game";

function readHasSavedGame(): boolean {
  return loadOfflineGame() !== null;
}

const noopSubscribe = () => () => {};

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
  // The save lives in localStorage, so the server can't know which screen to
  // show; waiting for hydration avoids flashing setup before the resume prompt.
  const hydrated = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
  const [chosenMode, setMode] = useState<Mode | null>(null);
  const mode: Mode = chosenMode ?? (hasSavedGame ? "prompt" : "setup");

  useEffect(() => {
    router.prefetch("/");
  }, [router]);

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

  if (!hydrated) {
    return <Loader fill label="Setting up the table…" />;
  }

  if (mode === "prompt" && hasSavedGame) {
    return (
      <div key="prompt" className={`${styles.shell} swap-in`}>
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

  if (mode === "setup" || !state) {
    return (
      <div key="setup" className="swap-in">
        <OfflineSetup
          onStart={(initial) => {
            startGame(initial);
            setMode("game");
          }}
          onBack={() => router.push("/")}
        />
      </div>
    );
  }

  return (
    <div key="game" className="route-in">
      <OfflineGameScreen
        onStartNew={() => {
          resetGame();
          setMode("setup");
        }}
      />
    </div>
  );
}
