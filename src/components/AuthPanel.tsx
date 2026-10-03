"use client";

import { FormEvent, useId, useState } from "react";
import { Button, ErrorText } from "./ui";
import { logIn, signUp, useAuthState } from "@/lib/auth";
import styles from "./AuthPanel.module.css";

type Tab = "login" | "signup";

/**
 * Optional account sign-in. Renders nothing once signed in (the profile menu
 * takes over); after logout or expiry the login form is prefilled with the
 * last username. Anonymous play never needs this.
 */
export function AuthPanel() {
  const auth = useAuthState();
  const [expanded, setExpanded] = useState(false);
  const [tabChoice, setTab] = useState<Tab | null>(null);
  const [usernameDraft, setUsername] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const passwordId = useId();
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

  if (auth.status === "signedIn") return null;

  const remembered = auth.lastUsername;
  const tab: Tab = tabChoice ?? (remembered ? "login" : "signup");
  const username = usernameDraft ?? (tab === "login" ? remembered : "");
  const open = expanded || !!remembered;

  if (!open) {
    return (
      <section className={styles.collapsed} aria-label="Account">
        <button type="button" className={styles.signInLink} onClick={() => setExpanded(true)}>
          Sign in or create account
        </button>
        <span className={styles.hint}>Optional — keeps your name and stats.</span>
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
      setShowPassword(false);
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
        <div className={styles.field}>
          <label htmlFor={passwordId}>Password</label>
          <div className={styles.passwordWrap}>
            <input
              id={passwordId}
              name="password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={tab === "login" ? "current-password" : "new-password"}
              autoCapitalize="none"
              spellCheck={false}
              maxLength={256}
            />
            <button
              type="button"
              className={styles.reveal}
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
              aria-controls={passwordId}
              onClick={() => setShowPassword((v) => !v)}
            >
              {showPassword ? "Hide" : "Show"}
            </button>
          </div>
        </div>
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
