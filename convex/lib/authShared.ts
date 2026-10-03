/**
 * Auth constants shared by Convex functions and the Next.js Route Handlers.
 * Pure values only: both runtimes import this file.
 */

/** `iss` claim of the short-lived Convex JWT; must match `auth.config.ts`. */
export const JWT_ISSUER = "https://family-ludo.auth";
/** `aud` claim; Convex rejects tokens without it (`applicationID`). */
export const JWT_AUDIENCE = "family-ludo";
export const JWT_KEY_ID = "ludo-auth-1";
export const JWT_TTL_SECONDS = 10 * 60;

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Sliding expiry writes at most this often per session. */
export const SESSION_SLIDE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const SESSION_COOKIE = "ludo_session";
export const LAST_USERNAME_COOKIE = "ludo_last_username";

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 20;
export const PASSWORD_MIN = 8;
/** Bounds hashing cost of hostile input; far above any real password. */
export const PASSWORD_MAX = 256;
const USERNAME_RE = /^[a-z0-9_]+$/;

export type AuthErrorCode =
  | "invalidUsername"
  | "invalidPassword"
  | "usernameTaken"
  | "invalidCredentials"
  | "tooManyAttempts"
  | "unauthorized";

export const AUTH_ERROR_MESSAGES: Record<AuthErrorCode, string> = {
  invalidUsername: `Username must be ${USERNAME_MIN}-${USERNAME_MAX} characters: a-z, 0-9 or _`,
  invalidPassword: `Password must be at least ${PASSWORD_MIN} characters`,
  usernameTaken: "That username is taken",
  invalidCredentials: "Wrong username or password",
  tooManyAttempts: "Too many attempts — try again later",
  unauthorized: "Please sign in again",
};

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidUsername(username: string): boolean {
  return (
    username.length >= USERNAME_MIN &&
    username.length <= USERNAME_MAX &&
    USERNAME_RE.test(username)
  );
}

export function isValidPassword(password: string): boolean {
  return password.length >= PASSWORD_MIN && password.length <= PASSWORD_MAX;
}

/** `<sessionId>.<secret>`; returns null for anything malformed. */
export function parseSessionToken(
  token: string | undefined | null,
): { sessionId: string; secret: string } | null {
  if (!token || token.length > 200) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const sessionId = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId) || !/^[A-Za-z0-9_-]+$/.test(secret)) {
    return null;
  }
  return { sessionId, secret };
}
