import { expect, vi } from "vitest";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { parseSessionToken } from "../../convex/lib/authShared";
import type { T } from "./setup";

export const SERVER_SECRET = "test-server-secret-0123456789abcdef";
export const PASSWORD = "correct horse battery";

/** Server secret for the gated actions, and a cheap PBKDF2 cost so tests stay fast. */
export function stubAuthEnv(): void {
  vi.stubEnv("AUTH_SERVER_SECRET", SERVER_SECRET);
  vi.stubEnv("AUTH_PBKDF2_ITERATIONS", "1000");
}

export async function signUp(
  t: T,
  username: string,
  opts: { password?: string; ipHash?: string; displayName?: string } = {},
) {
  return await t.action(api.auth.signUp, {
    serverSecret: SERVER_SECRET,
    ipHash: opts.ipHash ?? "ip-signup",
    username,
    password: opts.password ?? PASSWORD,
    ...(opts.displayName !== undefined ? { displayName: opts.displayName } : {}),
  });
}

export async function logIn(
  t: T,
  username: string,
  opts: { password?: string; ipHash?: string } = {},
) {
  return await t.action(api.auth.logIn, {
    serverSecret: SERVER_SECRET,
    ipHash: opts.ipHash ?? "ip-login",
    username,
    password: opts.password ?? PASSWORD,
  });
}

export async function refresh(t: T, sessionToken: string) {
  return await t.action(api.auth.refreshSession, {
    serverSecret: SERVER_SECRET,
    sessionToken,
  });
}

export function tokenOf(result: { ok: boolean } & Partial<{ token: string }>): string {
  expect(result.ok).toBe(true);
  return result.token!;
}

/** What the Route Handler would put in the JWT for this cookie token. */
export async function identityFor(t: T, token: string) {
  const parsed = parseSessionToken(token);
  if (!parsed) throw new Error("bad token");
  const session = await t.run(async (ctx) =>
    ctx.db.get(parsed.sessionId as Id<"authSessions">),
  );
  if (!session) throw new Error("session missing");
  return { subject: session.accountId as string, sid: parsed.sessionId };
}

/** A convex-test client acting with the JWT minted for `token`. */
export async function asUser(t: T, token: string) {
  return t.withIdentity(await identityFor(t, token));
}

export async function attemptRow(t: T, key: string) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("authAttempts")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique(),
  );
}

export async function sessionCount(t: T, username: string): Promise<number> {
  return await t.run(async (ctx) => {
    const account = await ctx.db
      .query("accounts")
      .withIndex("by_username", (q) => q.eq("username", username))
      .unique();
    if (!account) return 0;
    const rows = await ctx.db
      .query("authSessions")
      .withIndex("by_account", (q) => q.eq("accountId", account._id))
      .collect();
    return rows.length;
  });
}
