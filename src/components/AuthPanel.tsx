"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { Button, ErrorText } from "./ui";
import { logIn, logOut, signUp, useAuthState } from "@/lib/auth";
import styles from "./AuthPanel.module.css";

type Tab = "login" | "signup";

/**
 * Optional account sign-in. A remembered device shows the signed-in state
 * with no form; after logout or expiry the login form is prefilled with the
 * last username. Anonymous play never needs this.
 */
export function AuthPanel() {
  const auth = useAuthState();
  const [expanded, setExpanded] = useState(false);
  const [tabChoice, setTab] = useState<Tab | null>(null);
  const [usernameDraft, setUsername] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (auth.status === "loading") {
    return (
      <p className={styles.hint} role="status">
        Checking sign-in…
      </p>
    );
  }

  if (auth.status === "signedIn" && auth.profile) {
    return (
      <section className={styles.panel} aria-label="Account">
        <div className={styles.signedIn}>
          <p className={styles.who}>
            Signed in as <strong>{auth.profile.displayName}</strong>{" "}
            <span className={styles.handle}>@{auth.profile.username}</span>
          </p>
          <div className={styles.links}>
            <Link href="/profile">Profile</Link>
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => {
                setPassword("");
                void logOut();
              }}
            >
              Log out
            </button>
          </div>
        </div>
      </section>
    );
  }

  const remembered = auth.lastUsername;
  const tab: Tab = tabChoice ?? (remembered ? "login" : "signup");
  const username = usernameDraft ?? (tab === "login" ? remembered : "");
  const open = expanded || !!remembered;

  if (!open) {
    return (
      <section className={styles.panel} aria-label="Account">
        <Button type="button" variant="secondary" onClick={() => setExpanded(true)}>
          Sign in or create account
        </Button>
        <p className={styles.hint}>Optional — keeps your name and stats on this device.</p>
      </section>
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const result =
      tab === "login"
        ? await logIn(username, password)
        : await signUp(username, password, displayName);
    setBusy(false);
    if (result.ok) {
      setPassword("");
      setUsername(null);
      setDisplayName("");
    } else {
      setError(result.message);
    }
  }

  return (
    <section className={styles.panel} aria-label="Account">
      <div className={styles.tabs} role="tablist" aria-label="Account mode">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "login"}
          className={styles.tab}
          onClick={() => {
            setTab("login");
            setError(null);
          }}
        >
          Log in
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "signup"}
          className={styles.tab}
          onClick={() => {
            setTab("signup");
            setError(null);
          }}
        >
          Sign up
        </button>
      </div>
      <form className={styles.form} onSubmit={onSubmit}>
        <label className={styles.field}>
          Username
          <input
            name="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={20}
          />
        </label>
        <label className={styles.field}>
          Password
          <input
            name="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={tab === "login" ? "current-password" : "new-password"}
            maxLength={256}
          />
        </label>
        {tab === "signup" && (
          <label className={styles.field}>
            Display name (optional)
            <input
              name="displayName"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              autoComplete="nickname"
              maxLength={20}
            />
          </label>
        )}
        <Button
          type="submit"
          variant="primary"
          disabled={busy || !username.trim() || !password}
        >
          {tab === "login" ? "Log in" : "Create account"}
        </Button>
      </form>
      <ErrorText>{error}</ErrorText>
    </section>
  );
}
