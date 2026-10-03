import { action, mutation, query } from "./_generated/server";
import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import {
  assertServerSecret,
  hashPassword,
  newSalt,
  newSessionSecret,
  optionalAccount,
  pbkdf2Iterations,
  requireAccount,
  sha256Base64Url,
} from "./lib/auth";
import {
  isValidPassword,
  isValidUsername,
  normalizeUsername,
  parseSessionToken,
} from "./lib/authShared";
import { GameError, fail } from "./lib/errors";
import { cleanDisplayName, publicProfileValidator, toPublicProfile } from "./lib/profile";

/**
 * Credential actions. Only our Next.js Route Handlers may call them: they hold
 * AUTH_SERVER_SECRET and supply the client IP (as a keyed hash), which Convex
 * cannot see over the WebSocket. Hashing runs here, outside any transaction;
 * the internal mutations in authStore.ts re-check limits and commit.
 */

/** Fixed salt for unknown usernames so a miss costs the same as a hit. */
const DUMMY_SALT = "bHVkby1kdW1teS1zYWx0";

const authFailure = v.object({
  ok: v.literal(false),
  error: v.union(
    v.literal("invalidUsername"),
    v.literal("invalidPassword"),
    v.literal("usernameTaken"),
    v.literal("invalidCredentials"),
    v.literal("tooManyAttempts"),
    v.literal("unauthorized"),
  ),
  retryAfterMs: v.optional(v.number()),
});

/** `token` is `<sessionId>.<secret>`; it goes straight into the httpOnly cookie. */
const sessionResult = v.union(
  v.object({
    ok: v.literal(true),
    token: v.string(),
    expiresAt: v.number(),
    username: v.string(),
    displayName: v.string(),
  }),
  authFailure,
);

type SessionResult = Infer<typeof sessionResult>;

const refreshResult = v.union(
  v.object({
    ok: v.literal(true),
    accountId: v.string(),
    sessionId: v.string(),
    expiresAt: v.number(),
    username: v.string(),
    displayName: v.string(),
  }),
  v.object({ ok: v.literal(false) }),
);

const ipHashArg = v.string();

function checkIpHash(ipHash: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(ipHash)) fail(GameError.unauthorized);
  return ipHash;
}

export const signUp = action({
  args: {
    serverSecret: v.string(),
    ipHash: ipHashArg,
    username: v.string(),
    password: v.string(),
    displayName: v.optional(v.string()),
  },
  returns: sessionResult,
  handler: async (ctx, args): Promise<SessionResult> => {
    assertServerSecret(args.serverSecret);
    const ipHash = checkIpHash(args.ipHash);
    const username = normalizeUsername(args.username);
    if (!isValidUsername(username)) return { ok: false as const, error: "invalidUsername" as const };
    if (!isValidPassword(args.password)) {
      return { ok: false as const, error: "invalidPassword" as const };
    }
    const displayName = cleanDisplayName(args.displayName ?? "") ?? username;

    const pre = await ctx.runQuery(internal.authStore.signupPrecheck, {
      ipHash,
      username,
      now: Date.now(),
    });
    if (pre.blockedMs !== null) {
      return { ok: false as const, error: "tooManyAttempts" as const, retryAfterMs: pre.blockedMs };
    }
    if (pre.taken) return { ok: false as const, error: "usernameTaken" as const };

    const salt = newSalt();
    const iterations = pbkdf2Iterations();
    const passwordHash = await hashPassword(args.password, salt, iterations);
    const secret = newSessionSecret();
    const result = await ctx.runMutation(internal.authStore.createAccount, {
      username,
      displayName,
      passwordHash,
      salt,
      iterations,
      ipHash,
      tokenHash: await sha256Base64Url(secret),
    });
    if (!result.ok) return result;
    return {
      ok: true as const,
      token: `${result.sessionId}.${secret}`,
      expiresAt: result.expiresAt,
      username: result.username,
      displayName: result.displayName,
    };
  },
});

export const logIn = action({
  args: {
    serverSecret: v.string(),
    ipHash: ipHashArg,
    username: v.string(),
    password: v.string(),
  },
  returns: sessionResult,
  handler: async (ctx, args): Promise<SessionResult> => {
    assertServerSecret(args.serverSecret);
    const ipHash = checkIpHash(args.ipHash);
    const username = normalizeUsername(args.username);
    // Malformed input cannot match an account; answer like any wrong password.
    if (!isValidUsername(username) || args.password.length > 256) {
      return { ok: false as const, error: "invalidCredentials" as const };
    }

    const pre = await ctx.runQuery(internal.authStore.loginPrecheck, {
      ipHash,
      username,
      now: Date.now(),
    });
    if (pre.blockedMs !== null) {
      return { ok: false as const, error: "tooManyAttempts" as const, retryAfterMs: pre.blockedMs };
    }

    const creds = pre.credentials;
    const computed = await hashPassword(
      args.password,
      creds?.salt ?? DUMMY_SALT,
      creds?.iterations ?? pbkdf2Iterations(),
    );
    const secret = newSessionSecret();
    const result = await ctx.runMutation(internal.authStore.completeLogin, {
      ipHash,
      username,
      // completeLogin compares against the stored hash in constant time.
      ...(creds ? { verified: { accountId: creds.accountId, passwordHash: computed } } : {}),
      tokenHash: await sha256Base64Url(secret),
    });
    if (!result.ok) return result;
    return {
      ok: true as const,
      token: `${result.sessionId}.${secret}`,
      expiresAt: result.expiresAt,
      username: result.username,
      displayName: result.displayName,
    };
  },
});

export const changePassword = action({
  args: {
    serverSecret: v.string(),
    ipHash: ipHashArg,
    sessionToken: v.string(),
    currentPassword: v.string(),
    newPassword: v.string(),
  },
  returns: sessionResult,
  handler: async (ctx, args): Promise<SessionResult> => {
    assertServerSecret(args.serverSecret);
    const ipHash = checkIpHash(args.ipHash);
    const parsed = parseSessionToken(args.sessionToken);
    if (!parsed) return { ok: false as const, error: "unauthorized" as const };
    if (!isValidPassword(args.newPassword)) {
      return { ok: false as const, error: "invalidPassword" as const };
    }
    if (args.currentPassword.length > 256) {
      return { ok: false as const, error: "invalidCredentials" as const };
    }
    const tokenHash = await sha256Base64Url(parsed.secret);
    const pre = await ctx.runQuery(internal.authStore.passwordChangePrecheck, {
      sessionId: parsed.sessionId,
      tokenHash,
      ipHash,
      now: Date.now(),
    });
    if (!pre) return { ok: false as const, error: "unauthorized" as const };
    if (pre.blockedMs !== null) {
      return { ok: false as const, error: "tooManyAttempts" as const, retryAfterMs: pre.blockedMs };
    }

    const currentHash = await hashPassword(
      args.currentPassword,
      pre.credentials.salt,
      pre.credentials.iterations,
    );
    const salt = newSalt();
    const iterations = pbkdf2Iterations();
    const newPasswordHash = await hashPassword(args.newPassword, salt, iterations);
    const secret = newSessionSecret();
    const result = await ctx.runMutation(internal.authStore.completePasswordChange, {
      sessionId: parsed.sessionId,
      tokenHash,
      ipHash,
      currentHash,
      newPasswordHash,
      newSalt: salt,
      iterations,
      newTokenHash: await sha256Base64Url(secret),
    });
    if (!result.ok) return result;
    return {
      ok: true as const,
      token: `${result.sessionId}.${secret}`,
      expiresAt: result.expiresAt,
      username: result.username,
      displayName: result.displayName,
    };
  },
});

export const logOut = action({
  args: { serverSecret: v.string(), sessionToken: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertServerSecret(args.serverSecret);
    const parsed = parseSessionToken(args.sessionToken);
    if (!parsed) return null;
    await ctx.runMutation(internal.authStore.revokeSession, {
      sessionId: parsed.sessionId,
      tokenHash: await sha256Base64Url(parsed.secret),
    });
    return null;
  },
});

/** Called by GET /api/auth/token: validates the cookie and slides its expiry. */
export const refreshSession = action({
  args: { serverSecret: v.string(), sessionToken: v.string() },
  returns: refreshResult,
  handler: async (ctx, args): Promise<Infer<typeof refreshResult>> => {
    assertServerSecret(args.serverSecret);
    const parsed = parseSessionToken(args.sessionToken);
    if (!parsed) return { ok: false as const };
    const result = await ctx.runMutation(internal.authStore.touchSession, {
      sessionId: parsed.sessionId,
      tokenHash: await sha256Base64Url(parsed.secret),
    });
    if (!result.ok) return { ok: false as const };
    return {
      ok: true as const,
      accountId: result.accountId,
      sessionId: result.sessionId,
      expiresAt: result.expiresAt,
      username: result.username,
      displayName: result.displayName,
    };
  },
});

export const me = query({
  args: {},
  returns: v.union(publicProfileValidator, v.null()),
  handler: async (ctx) => {
    const signedIn = await optionalAccount(ctx);
    return signedIn ? toPublicProfile(signedIn.profile) : null;
  },
});

export const updateDisplayName = mutation({
  args: { displayName: v.string() },
  returns: publicProfileValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const { profile } = await requireAccount(ctx, now);
    const displayName = cleanDisplayName(args.displayName);
    if (!displayName) fail(GameError.invalidName);
    await ctx.db.patch(profile._id, { displayName, lastActiveAt: now });
    return toPublicProfile({ ...profile, displayName, lastActiveAt: now });
  },
});
