"use client";

import { useEffect, useRef } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { ProfileStats } from "./ProfileStats";
import styles from "./PlayerProfileCard.module.css";

type Props = {
  playerId: Id<"players">;
  name: string;
  color: string;
  onClose: () => void;
};

/** Modal game profile for a seated player, opened from the in-game player list. */
export function PlayerProfileCard({ playerId, name, color, onClose }: Props) {
  const profile = useQuery(api.profiles.getForPlayer, { playerId });
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus();
    };
  }, [onClose]);

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div
        className={styles.card}
        role="dialog"
        aria-modal="true"
        aria-label={`${name}'s profile`}
        style={{ ["--c" as string]: color }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <span className={styles.avatar} aria-hidden="true">
            {(profile?.displayName || name).charAt(0).toUpperCase()}
          </span>
          <div className={styles.titles}>
            <p className={styles.name}>{profile?.displayName ?? name}</p>
            {profile && <p className={styles.handle}>@{profile.username}</p>}
          </div>
          <button
            ref={closeRef}
            type="button"
            className={styles.close}
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        {profile === undefined ? (
          <p className={styles.status} role="status">
            Loading profile…
          </p>
        ) : profile === null ? (
          <p className={styles.status}>
            Playing as a guest — no game profile yet.
          </p>
        ) : (
          <ProfileStats profile={profile} />
        )}
      </div>
    </div>
  );
}
