"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { AuthPanel } from "@/components/AuthPanel";
import { Leaderboard, LeaderboardSkeleton } from "@/components/Leaderboard";
import { MatchHistory, MatchHistorySkeleton } from "@/components/MatchHistory";
import { ProfileStats, ProfileStatsSkeleton } from "@/components/ProfileStats";
import { Skeleton } from "@/components/Skeleton";
import { Button, ErrorText } from "@/components/ui";
import {
  changePassword,
  logOut,
  setLocalDisplayName,
  useAuthState,
} from "@/lib/auth";
import { formatConvexError } from "@/lib/player";
import styles from "./profile.module.css";

export function ProfileClient() {
  const auth = useAuthState();
  // The Convex client sends the token ahead of queued queries, so there is no
  // need to wait a round-trip for useConvexAuth() to confirm it first.
  const profile = useQuery(api.profiles.getMine, auth.status === "signedIn" ? {} : "skip");
  const updateDisplayName = useMutation(api.auth.updateDisplayName);

  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [nameBusy, setNameBusy] = useState(false);
  const [nameMessage, setNameMessage] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMessage, setPwMessage] = useState<string | null>(null);
  const [pwError, setPwError] = useState<string | null>(null);

  if (auth.status === "loading") return <ProfileSkeleton />;

  if (auth.status === "signedOut") {
    return (
      <div className={styles.shell}>
        <h1 className={styles.title}>Your profile</h1>
        <p className={styles.muted}>Sign in to see your profile.</p>
        <AuthPanel />
        <Leaderboard />
        <Link href="/">Back home</Link>
      </div>
    );
  }

  const displayName = nameDraft ?? profile?.displayName ?? auth.profile?.displayName ?? "";

  async function onSaveName(e: FormEvent) {
    e.preventDefault();
    setNameBusy(true);
    setNameError(null);
    setNameMessage(null);
    try {
      const updated = await updateDisplayName({ displayName });
      setLocalDisplayName(updated.displayName);
      setNameDraft(null);
      setNameMessage("Saved");
    } catch (err) {
      setNameError(formatConvexError(err, "Could not save name"));
    } finally {
      setNameBusy(false);
    }
  }

  async function onChangePassword(e: FormEvent) {
    e.preventDefault();
    setPwBusy(true);
    setPwError(null);
    setPwMessage(null);
    const result = await changePassword(currentPassword, newPassword);
    setPwBusy(false);
    if (result.ok) {
      setCurrentPassword("");
      setNewPassword("");
      setPwMessage("Password changed — other devices were signed out");
    } else {
      setPwError(result.message);
    }
  }

  return (
    <div className={styles.shell}>
      <h1 className={styles.title}>{profile?.displayName ?? auth.profile?.displayName}</h1>
      <p className={styles.muted}>@{auth.profile?.username}</p>

      {profile ? <ProfileStats profile={profile} /> : <ProfileStatsSkeleton />}

      <MatchHistory />
      <Leaderboard highlight={auth.profile?.username} />

      <form className={styles.form} onSubmit={onSaveName} aria-label="Display name">
        <label className={styles.field}>
          Display name
          <input
            value={displayName}
            onChange={(e) => setNameDraft(e.target.value)}
            maxLength={20}
            autoComplete="nickname"
          />
        </label>
        <Button type="submit" variant="secondary" disabled={nameBusy || !displayName.trim()}>
          Save name
        </Button>
        {nameMessage && <p className={styles.muted} role="status">{nameMessage}</p>}
        <ErrorText>{nameError}</ErrorText>
      </form>

      <form className={styles.form} onSubmit={onChangePassword} aria-label="Change password">
        <label className={styles.field}>
          Current password
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
            maxLength={256}
          />
        </label>
        <label className={styles.field}>
          New password
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
            maxLength={256}
          />
        </label>
        <Button
          type="submit"
          variant="secondary"
          disabled={pwBusy || !currentPassword || newPassword.length < 8}
        >
          Change password
        </Button>
        {pwMessage && <p className={styles.muted} role="status">{pwMessage}</p>}
        <ErrorText>{pwError}</ErrorText>
      </form>

      <div className={styles.footer}>
        <Link href="/">Back home</Link>
        <Button type="button" variant="ink" onClick={() => void logOut()}>
          Log out
        </Button>
      </div>
    </div>
  );
}

function ProfileSkeleton() {
  return (
    <div className={styles.shell} aria-busy="true">
      <Skeleton width="60%" height="2.4rem" />
      <Skeleton width="35%" height="1.2rem" />
      <ProfileStatsSkeleton />
      <MatchHistorySkeleton />
      <LeaderboardSkeleton />
    </div>
  );
}
