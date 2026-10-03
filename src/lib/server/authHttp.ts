import { NextResponse, type NextRequest } from "next/server";
import {
  AUTH_ERROR_MESSAGES,
  LAST_USERNAME_COOKIE,
  SESSION_COOKIE,
  type AuthErrorCode,
} from "../../../convex/lib/authShared";

const LAST_USERNAME_MAX_AGE_S = 365 * 24 * 60 * 60;
const MAX_BODY_BYTES = 4_096;

export class AuthConfigError extends Error {}

export function serverSecret(): string {
  const secret = process.env.AUTH_SERVER_SECRET;
  if (!secret || secret.length < 16) throw new AuthConfigError("AUTH_SERVER_SECRET is not set");
  return secret;
}

/**
 * Client IP from platform headers: Vercel sets `x-forwarded-for` with the
 * real client as the first hop; `x-real-ip` is the fallback for other proxies.
 */
export function getClientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  if (first) return first.slice(0, 64);
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real.slice(0, 64);
  return "unknown";
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Keyed hash so Convex never stores a raw IP and hashes cannot be reversed by brute force. */
export async function hashIp(ip: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`ip:${ip}`));
  return toBase64Url(new Uint8Array(sig)).slice(0, 32);
}

function expectedOrigins(request: NextRequest): Set<string> {
  const origins = new Set<string>([new URL(request.url).origin]);
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (host) {
    const proto =
      request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ??
      new URL(request.url).protocol.replace(":", "");
    origins.add(`${proto}://${host}`);
  }
  return origins;
}

/**
 * State-changing routes: browsers always send `Origin` on POST, so require it
 * to be ours. Together with SameSite=Lax this blocks cross-site requests.
 */
export function isSameOriginPost(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  return expectedOrigins(request).has(origin);
}

/**
 * Same-origin GET fetches may omit `Origin`, so also accept a matching
 * `Sec-Fetch-Site`. Anything that identifies itself as cross-site is refused.
 */
export function isSameOriginGet(request: NextRequest): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  const origin = request.headers.get("origin");
  if (origin && !expectedOrigins(request).has(origin)) return false;
  return true;
}

export async function readJsonBody(request: NextRequest): Promise<Record<string, unknown> | null> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) return null;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function stringField(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" ? value : null;
}

const STATUS: Record<AuthErrorCode | "badRequest" | "forbidden" | "authUnavailable", number> = {
  invalidUsername: 400,
  invalidPassword: 400,
  usernameTaken: 409,
  invalidCredentials: 401,
  tooManyAttempts: 429,
  unauthorized: 401,
  badRequest: 400,
  forbidden: 403,
  authUnavailable: 503,
};

const EXTRA_MESSAGES = {
  badRequest: "Invalid request",
  forbidden: "Forbidden",
  authUnavailable: "Sign-in is unavailable right now",
};

export function errorResponse(
  error: AuthErrorCode | keyof typeof EXTRA_MESSAGES,
  retryAfterMs?: number,
): NextResponse {
  const message =
    error in EXTRA_MESSAGES
      ? EXTRA_MESSAGES[error as keyof typeof EXTRA_MESSAGES]
      : AUTH_ERROR_MESSAGES[error as AuthErrorCode];
  const res = NextResponse.json(
    { ok: false, error, message, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
    { status: STATUS[error] },
  );
  if (retryAfterMs !== undefined) {
    res.headers.set("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  }
  res.headers.set("Cache-Control", "no-store");
  return res;
}

function secureCookies(): boolean {
  return process.env.NODE_ENV === "production";
}

export function setSessionCookie(res: NextResponse, token: string, expiresAt: number): void {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "lax",
    path: "/",
    maxAge,
  });
}

export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

/** Non-sensitive hint used to prefill the login form after logout or expiry. */
export function setLastUsernameCookie(res: NextResponse, username: string): void {
  res.cookies.set(LAST_USERNAME_COOKIE, username, {
    httpOnly: false,
    secure: secureCookies(),
    sameSite: "lax",
    path: "/",
    maxAge: LAST_USERNAME_MAX_AGE_S,
  });
}

export function readSessionCookie(request: NextRequest): string | null {
  return request.cookies.get(SESSION_COOKIE)?.value || null;
}

/** Misconfiguration or Convex outages surface as a generic 503, never as details. */
export async function guarded(handler: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await handler();
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "auth_route_error",
        kind: err instanceof AuthConfigError ? "config" : "upstream",
        message: err instanceof AuthConfigError ? err.message : undefined,
      }),
    );
    return errorResponse("authUnavailable");
  }
}

export function sessionSuccess(
  result: { token: string; expiresAt: number; username: string; displayName: string },
): NextResponse {
  const res = NextResponse.json({
    ok: true,
    profile: { username: result.username, displayName: result.displayName },
  });
  res.headers.set("Cache-Control", "no-store");
  setSessionCookie(res, result.token, result.expiresAt);
  setLastUsernameCookie(res, result.username);
  return res;
}
