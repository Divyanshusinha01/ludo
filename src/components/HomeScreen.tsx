"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "./ui";
import { bindAudioUnlock } from "@/lib/sounds";
import { InstallHint } from "./InstallHint";
import { AuthPanel } from "./AuthPanel";
import { HomeOnlineGate } from "./HomeOnlineGate";
import type { HomeOnlineMode } from "./HomeOnlineFlow";
import styles from "./HomeScreen.module.css";

export function HomeScreen() {
  const router = useRouter();
  const [mode, setMode] = useState<"home" | HomeOnlineMode>("home");
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    bindAudioUnlock();
  }, []);

  useEffect(() => {
    const sync = () => setOffline(!navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  useEffect(() => {
    if (offline && mode !== "home") {
      setMode("home");
    }
  }, [offline, mode]);

  useEffect(() => {
    const prefetch = () => {
      void import("./HomeOnlineGate");
    };
    const win = window as Window & {
      requestIdleCallback?: (
        cb: IdleRequestCallback,
        opts?: IdleRequestOptions,
      ) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (win.requestIdleCallback) {
      const id = win.requestIdleCallback(prefetch, { timeout: 2500 });
      return () => win.cancelIdleCallback?.(id);
    }
    const id = window.setTimeout(prefetch, 1200);
    return () => window.clearTimeout(id);
  }, []);

  return (
    <div className={styles.shell}>
      <div className={styles.hero}>
        <p className={styles.brand}>Family Ludo</p>
        <h1 className={styles.headline}>Family phones. One board.</h1>
        <p className={styles.sub}>
          Create a room, share the code, and play with 2–4 people in realtime —
          or play offline on one device.
        </p>
      </div>

      {mode === "home" ? (
        <div className={styles.actions}>
          <Button
            type="button"
            variant="primary"
            disabled={offline}
            onClick={() => {
              if (offline) return;
              setMode("online");
            }}
          >
            Play Online
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={offline}
            onClick={() => {
              if (offline) return;
              setMode("multiplayer");
            }}
          >
            Play Multiplayer
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => router.push("/offline")}
          >
            Play Offline
          </Button>
          {offline && (
            <p className={styles.hint} role="status">
              No internet — online play is unavailable. Use Play Offline.
            </p>
          )}
          {!offline && <AuthPanel />}
        </div>
      ) : (
        <HomeOnlineGate
          mode={mode}
          offline={offline}
          onModeChange={setMode}
        />
      )}

      <InstallHint />
    </div>
  );
}
