"use client";

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { BOT_THINK_MS, pickBotMove } from "../../convex/lib/bot";
import {
  isBotTurn,
  moveToken,
  rematch as rematchEngine,
  rollDice,
} from "@/lib/offline/engine";
import {
  clearOfflineGame,
  loadOfflineGame,
  saveOfflineGame,
  subscribeOfflineGame,
} from "@/lib/offline/storage";
import { toOfflineBundle, type OfflineGameState } from "@/lib/offline/types";

function getSnapshot(): OfflineGameState | null {
  return loadOfflineGame();
}

export function useOfflineGame() {
  const router = useRouter();
  const state = useSyncExternalStore(
    subscribeOfflineGame,
    getSnapshot,
    () => null,
  );
  const botTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const bundle = useMemo(
    () => (state ? toOfflineBundle(state) : null),
    [state],
  );

  const persist = useCallback((next: OfflineGameState) => {
    saveOfflineGame(next);
  }, []);

  const clearBotTimer = useCallback(() => {
    if (botTimer.current) {
      clearTimeout(botTimer.current);
      botTimer.current = null;
    }
  }, []);

  const scheduleBotTurn = useCallback(
    (snapshot: OfflineGameState) => {
      clearBotTimer();
      if (!isBotTurn(snapshot) || snapshot.status !== "playing") return;

      const runBotStep = () => {
        botTimer.current = null;
        let current = loadOfflineGame();
        if (!current || !isBotTurn(current) || current.status !== "playing") {
          return;
        }

        try {
          if (!current.diceRolled) {
            const { state: afterRoll, result } = rollDice(current);
            persist(afterRoll);
            if (afterRoll.status !== "playing" || !isBotTurn(afterRoll)) {
              return;
            }
            if (result.rollAgain || !afterRoll.diceRolled) {
              botTimer.current = setTimeout(runBotStep, BOT_THINK_MS);
              return;
            }
            current = afterRoll;
          }

          if (current.diceRolled && current.diceValue !== null) {
            const choice = pickBotMove(
              current.tokens,
              current.currentTurn,
              current.diceValue,
            );
            if (choice === null) return;
            const { state: afterMove } = moveToken(current, choice);
            persist(afterMove);
            if (isBotTurn(afterMove) && afterMove.status === "playing") {
              botTimer.current = setTimeout(runBotStep, BOT_THINK_MS);
            }
          }
        } catch {
          /* stale or illegal — ignore */
        }
      };

      botTimer.current = setTimeout(runBotStep, BOT_THINK_MS);
    },
    [clearBotTimer, persist],
  );

  useEffect(() => {
    if (state && isBotTurn(state)) {
      scheduleBotTurn(state);
    }
    return clearBotTimer;
  }, [state, scheduleBotTurn, clearBotTimer]);

  const roll = useCallback(() => {
    const current = loadOfflineGame();
    if (!current) return null;
    const { state: next, result } = rollDice(current);
    persist(next);
    if (isBotTurn(next)) scheduleBotTurn(next);
    return result;
  }, [persist, scheduleBotTurn]);

  const move = useCallback(
    (tokenIndex: number) => {
      const current = loadOfflineGame();
      if (!current) return null;
      const { state: next, result } = moveToken(current, tokenIndex);
      persist(next);
      if (isBotTurn(next)) scheduleBotTurn(next);
      return result;
    },
    [persist, scheduleBotTurn],
  );

  const rematch = useCallback(() => {
    const current = loadOfflineGame();
    if (!current) return;
    const next = rematchEngine(current);
    persist(next);
    if (isBotTurn(next)) scheduleBotTurn(next);
  }, [persist, scheduleBotTurn]);

  const leave = useCallback(() => {
    clearBotTimer();
    clearOfflineGame();
    router.push("/");
  }, [clearBotTimer, router]);

  const resetGame = useCallback(() => {
    clearBotTimer();
    clearOfflineGame();
  }, [clearBotTimer]);

  const startGame = useCallback(
    (initial: OfflineGameState) => {
      persist(initial);
      if (isBotTurn(initial)) scheduleBotTurn(initial);
    },
    [persist, scheduleBotTurn],
  );

  return {
    state,
    bundle,
    roll,
    move,
    rematch,
    leave,
    resetGame,
    startGame,
  };
}
