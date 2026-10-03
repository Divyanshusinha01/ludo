"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useAuthState } from "@/lib/auth";
import { ProfileStatsSkeleton } from "./ProfileStats";
import styles from "./ProfileMenu.module.css";

const ProfileMenuPanel = dynamic(
  () => import("./ProfileMenuPanel").then((m) => m.ProfileMenuPanel),
  {
    ssr: false,
    loading: () => <ProfileStatsSkeleton />,
  },
);

/** Top-right account chip; the stats popover loads Convex only when opened. */
export function ProfileMenu() {
  const auth = useAuthState();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (auth.status !== "signedIn" || !auth.profile) return null;
  const { username, displayName } = auth.profile;

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Profile: ${username}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.avatar} aria-hidden="true">
          {(displayName || username).charAt(0).toUpperCase()}
        </span>
        <span className={styles.username}>{username}</span>
      </button>
      {open && (
        <div className={styles.panel} role="dialog" aria-label="Your profile">
          <ProfileMenuPanel onClose={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}
