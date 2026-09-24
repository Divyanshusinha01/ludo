"use client";

import { useState, useSyncExternalStore } from "react";
import styles from "./InstallHint.module.css";

const DISMISS_KEY = "ludo_hide_install_hint";

function isStandalone(): boolean {
  const media = window.matchMedia("(display-mode: standalone)").matches;
  const ios =
    "standalone" in navigator &&
    Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
  return media || ios;
}

function isPhoneLike(): boolean {
  return window.matchMedia("(max-width: 720px), (pointer: coarse)").matches;
}

function readVisible(): boolean {
  try {
    if (localStorage.getItem(DISMISS_KEY) === "1") return false;
  } catch {
    return false;
  }
  if (isStandalone() || !isPhoneLike()) return false;
  return true;
}

/** One-line tip for adding the site to the home screen on phones. */
export function InstallHint() {
  const storeVisible = useSyncExternalStore(
    () => () => {},
    readVisible,
    () => false,
  );
  const [hidden, setHidden] = useState(false);

  if (!storeVisible || hidden) return null;

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* private mode */
    }
    setHidden(true);
  }

  return (
    <p className={styles.hint} role="note">
      <span>
        Add to Home Screen for full-screen play (Share → Add, or browser menu).
      </span>
      <button type="button" className={styles.dismiss} onClick={dismiss}>
        Got it
      </button>
    </p>
  );
}
