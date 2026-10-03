import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { GameError, fail } from "./errors";

/** OWASP 2023 floor for PBKDF2-HMAC-SHA256. */
const DEFAULT_PBKDF2_ITERATIONS = 600_000;
const MIN_PBKDF2_ITERATIONS = 1_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;
const SESSION_SECRET_BYTES = 32;

/** Tests lower the cost through AUTH_PBKDF2_ITERATIONS; production keeps the default. */
export function pbkdf2Iterations(): number {
  const raw = Number(process.env.AUTH_PBKDF2_ITERATIONS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_PBKDF2_ITERATIONS;
  return Math.max(MIN_PBKDF2_ITERATIONS, Math.floor(raw));
}

const encoder = new TextEncoder();

export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBase64Url(bytes: number): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function newSalt(): string {
  return randomBase64Url(SALT_BYTES);
}

/** Raw session secret; only its SHA-256 is ever stored. */
export function newSessionSecret(): string {
  return randomBase64Url(SESSION_SECRET_BYTES);
}

export async function hashPassword(
  password: string,
  salt: string,
  iterations: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: base64UrlToBytes(salt), iterations },
    key,
    HASH_BITS,
  );
  return bytesToBase64Url(new Uint8Array(bits));
}

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

/** Compares every character so timing does not reveal the matching prefix. */
export function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/** Rejects calls to the credential actions that did not come from our Route Handlers. */
export function assertServerSecret(provided: string): void {
  const expected = process.env.AUTH_SERVER_SECRET;
  if (!expected || expected.length < 16 || !constantTimeEqual(provided, expected)) {
    fail(GameError.unauthorized);
  }
}

export type SignedInAccount = {
  account: Doc<"accounts">;
  profile: Doc<"profiles">;
  sessionId: Id<"authSessions">;
};

/**
 * The account behind the caller's JWT, or null when anonymous or the session
 * was revoked. Checking the session row makes logout and password change take
 * effect immediately instead of when the 10-minute JWT expires.
 *
 * Queries must not read the clock, so they pass no `now` and rely on the JWT
 * lifetime plus the token endpoint refusing expired sessions.
 */
export async function optionalAccount(
  ctx: QueryCtx | MutationCtx,
  now?: number,
): Promise<SignedInAccount | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  const sid = typeof identity.sid === "string" ? identity.sid : null;
  if (!sid) return null;
  const sessionId = ctx.db.normalizeId("authSessions", sid);
  const accountId = ctx.db.normalizeId("accounts", identity.subject);
  if (!sessionId || !accountId) return null;
  const session = await ctx.db.get(sessionId);
  if (!session || session.accountId !== accountId) return null;
  if (now !== undefined && session.expiresAt <= now) return null;
  const account = await ctx.db.get(accountId);
  if (!account || session.credentialVersion !== account.credentialVersion) return null;
  const profile = await ctx.db
    .query("profiles")
    .withIndex("by_account", (q) => q.eq("accountId", accountId))
    .unique();
  if (!profile) return null;
  return { account, profile, sessionId };
}

export async function requireAccount(
  ctx: QueryCtx | MutationCtx,
  now?: number,
): Promise<SignedInAccount> {
  const signedIn = await optionalAccount(ctx, now);
  if (!signedIn) fail(GameError.unauthorized);
  return signedIn;
}
