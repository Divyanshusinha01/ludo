"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { bindAudioUnlock } from "@/lib/sounds";
import { InstallHint } from "./InstallHint";
import { AuthPanel } from "./AuthPanel";
import { HomeOnlineGate } from "./HomeOnlineGate";
import type { HomeOnlineMode } from "./HomeOnlineFlow";
import styles from "./HomeScreen.module.css";

const TRACK_CELLS = 13;
const TRACK_TOKENS = [
  { cell: 1, color: "red", delay: 0 },
  { cell: 4, color: "green", delay: 120 },
  { cell: 8, color: "yellow", delay: 240 },
  { cell: 11, color: "blue", delay: 360 },
] as const;

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
    <div className={`${styles.shell} ${styles.home}`}>
      <div className={styles.hero}>
        <p className={styles.brand}>
          <span className={styles.brandLudo}>Ludo</span>
        </p>
        <div className={styles.track} aria-hidden="true">
          {Array.from({ length: TRACK_CELLS }, (_, i) => {
            const token = TRACK_TOKENS.find((t) => t.cell === i);
            return (
              <span key={i} className={styles.cell}>
                {token && (
                  <span
                    className={`${styles.token} ${styles[token.color]}`}
                    style={{ animationDelay: `${token.delay}ms` }}
                  />
                )}
              </span>
            );
          })}
        </div>
        <h1 className={styles.headline}>Pass the dice, not the phone.</h1>
        <p className={styles.sub}>
          Open a room, share the code, and race 2–4 friends in realtime. Want
          new rivals? Jump into Multiplayer to get matched with players
          worldwide. No signal? Huddle round one device and play offline.
        </p>
      </div>

      {mode === "home" ? (
        <div className={styles.actions}>
          <nav className={styles.modes} aria-label="Game modes">
            <ModeRow
              color="red"
              name="Private Room"
              desc={offline ? "Needs internet" : "Share a code with 2–4 friends"}
              disabled={offline}
              onClick={() => setMode("online")}
            />
            <ModeRow
              color="blue"
              name="Play Multiplayer"
              desc={offline ? "Needs internet" : "Get matched with players worldwide"}
              disabled={offline}
              onClick={() => setMode("multiplayer")}
            />
            <ModeRow
              color="green"
              name="Play Offline"
              desc="Pass one device around the table"
              onClick={() => router.push("/offline")}
            />
          </nav>
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

function ModeRow({
  color,
  name,
  desc,
  disabled,
  onClick,
}: {
  color: "red" | "green" | "yellow" | "blue";
  name: string;
  desc: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={styles.mode}
      disabled={disabled}
      onClick={onClick}
    >
      <span className={`${styles.modeToken} ${styles[color]}`} aria-hidden="true" />
      <span className={styles.modeText}>
        <span className={styles.modeName}>{name}</span>
        <span className={styles.modeDesc}>{desc}</span>
      </span>
      <span className={styles.modeArrow} aria-hidden="true">
        →
      </span>
    </button>
  );
}
