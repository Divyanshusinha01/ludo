"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { LAST_USERNAME_COOKIE } from "../../convex/lib/authShared";

/**
 * Device sign-in state. The long-lived session lives in an httpOnly cookie the
 * page cannot read; this module only ever holds the short-lived Convex JWT, in
 * memory, fetched from GET /api/auth/token.
 */

export type AuthProfile = { username: string; displayName: string };

export type AuthState = {
  status: "loading" | "signedIn" | "signedOut";
  profile: AuthProfile | null;
  /** From the non-sensitive `ludo_last_username` cookie; prefills the login form. */
  lastUsername: string;
};

export type AuthActionResult = { ok: true } | { ok: false; message: string };

/** Refresh this long before the JWT's own expiry. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

const SERVER_STATE: AuthState = { status: "loading", profile: null, lastUsername: "" };

let state: AuthState = SERVER_STATE;
let accessToken: { value: string; expiresAt: number } | null = null;
let inflight: Promise<string | null> | null = null;
let bootstrapped = false;
const listeners = new Set<() => void>();

function readLastUsername(): string {
  if (typeof document === "undefined") return "";
  const prefix = `${LAST_USERNAME_COOKIE}=`;
  for (const part of document.cookie.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      try {
        return decodeURIComponent(trimmed.slice(prefix.length)).slice(0, 20);
      } catch {
        return "";
      }
    }
  }
  return "";
}

function setState(next: Partial<AuthState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function signedIn(profile: AuthProfile) {
  setState({ status: "signedIn", profile, lastUsername: profile.username });
}

function signedOut() {
  accessToken = null;
  setState({ status: "signedOut", profile: null, lastUsername: readLastUsername() });
}

type TokenResponse = {
  ok: true;
  token: string;
  expiresAt: number;
  profile: AuthProfile;
};

async function requestToken(): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch("/api/auth/token", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    // Offline: keep the current state; Convex will ask again later.
    if (state.status === "loading") signedOut();
    return null;
  }
  if (!res.ok) {
    signedOut();
    return null;
  }
  const body = (await res.json()) as TokenResponse;
  accessToken = { value: body.token, expiresAt: body.expiresAt };
  signedIn(body.profile);
  return body.token;
}

/** Used by ConvexProviderWithAuth; deduplicates concurrent refreshes. */
export function fetchAccessToken(forceRefresh: boolean): Promise<string | null> {
  if (
    !forceRefresh &&
    accessToken &&
    accessToken.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()
  ) {
    return Promise.resolve(accessToken.value);
  }
  inflight ??= requestToken().finally(() => {
    inflight = null;
  });
  return inflight;
}

function bootstrap() {
  if (bootstrapped || typeof window === "undefined") return;
  bootstrapped = true;
  state = { ...state, lastUsername: readLastUsername() };
  void fetchAccessToken(false);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAuthState(): AuthState {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => state,
    () => SERVER_STATE,
  );
  useEffect(() => {
    bootstrap();
  }, []);
  return snapshot;
}

/** Shape expected by `ConvexProviderWithAuth`'s `useAuth` prop. */
export function useConvexAuthBridge() {
  const { status } = useAuthState();
  const fetchToken = useCallback(
    ({ forceRefreshToken }: { forceRefreshToken: boolean }) =>
      fetchAccessToken(forceRefreshToken),
    [],
  );
  return useMemo(
    () => ({
      isLoading: status === "loading",
      isAuthenticated: status === "signedIn",
      fetchAccessToken: fetchToken,
    }),
    [status, fetchToken],
  );
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function errorBody(res: Response): Promise<{ error?: string; message: string }> {
  try {
    const body = (await res.json()) as { error?: string; message?: string };
    return { error: body.error, message: body.message || "Something went wrong — try again" };
  } catch {
    return { message: "Something went wrong — try again" };
  }
}

async function sessionAction(path: string, body: unknown): Promise<AuthActionResult> {
  let res: Response;
  try {
    res = await postJson(path, body);
  } catch {
    return { ok: false, message: "No connection — try again" };
  }
  if (!res.ok) {
    const { error, message } = await errorBody(res);
    if (error === "unauthorized") signedOut();
    return { ok: false, message };
  }
  const data = (await res.json()) as { profile: AuthProfile };
  accessToken = null;
  signedIn(data.profile);
  void fetchAccessToken(true);
  return { ok: true };
}

export function signUp(
  username: string,
  password: string,
  displayName?: string,
): Promise<AuthActionResult> {
  return sessionAction("/api/auth/signup", {
    username,
    password,
    ...(displayName?.trim() ? { displayName: displayName.trim() } : {}),
  });
}

export function logIn(username: string, password: string): Promise<AuthActionResult> {
  return sessionAction("/api/auth/login", { username, password });
}

export function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<AuthActionResult> {
  return sessionAction("/api/auth/password", { currentPassword, newPassword });
}

export async function logOut(): Promise<void> {
  try {
    await postJson("/api/auth/logout", {});
  } catch {
    /* cookie stays until it expires; local state still signs out */
  }
  signedOut();
}

/** Keep the cached profile in sync after `auth.updateDisplayName`. */
export function setLocalDisplayName(displayName: string) {
  if (state.profile) setState({ profile: { ...state.profile, displayName } });
}

/** Test hook: forget all module state. */
export function resetAuthForTests() {
  state = SERVER_STATE;
  accessToken = null;
  inflight = null;
  bootstrapped = false;
}
