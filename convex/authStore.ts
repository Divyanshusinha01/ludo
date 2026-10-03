import { internalMutation, internalQuery, MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { constantTimeEqual } from "./lib/auth";
import { SESSION_SLIDE_INTERVAL_MS, SESSION_TTL_MS } from "./lib/authShared";
import {
  checkLimit,
  checkLimits,
  LIMITS,
  limitKeys,
  recordAttempt,
  resetAttempts,
  type LimitPolicy,
} from "./lib/rateLimit";
import { INITIAL_RATING } from "./lib/profile";

/**
 * Internal-only credential storage behind the secret-gated actions in auth.ts.
 * Nothing here is callable from a browser, so these functions may read
 * password hashes and token hashes.
 */

export const MAX_ACTIVE_SESSIONS = 10;

const failureValidator = v.object({
  ok: v.literal(false),
  error: v.union(
    v.literal("usernameTaken"),
    v.literal("invalidCredentials"),
    v.literal("tooManyAttempts"),
    v.literal("unauthorized"),
  ),
  retryAfterMs: v.optional(v.number()),
});

const sessionIssuedValidator = v.union(
  v.object({
    ok: v.literal(true),
    sessionId: v.id("authSessions"),
    expiresAt: v.number(),
    username: v.string(),
    displayName: v.string(),
  }),
  failureValidator,
);

const credentialsValidator = v.object({
  accountId: v.id("accounts"),
  username: v.string(),
  passwordHash: v.string(),
  salt: v.string(),
  iterations: v.number(),
});

function loginChecks(ipHash: string, username: string): Array<[string, LimitPolicy]> {
  return [
    [limitKeys.ipUser(ipHash, username), LIMITS.ipUser],
    [limitKeys.ip(ipHash), LIMITS.ip],
    [limitKeys.user(username), LIMITS.user],
  ];
}

async function recordLoginFailure(
  ctx: MutationCtx,
  ipHash: string,
  username: string,
  now: number,
) {
  for (const [key, policy] of loginChecks(ipHash, username)) {
    await recordAttempt(ctx, key, policy, now);
  }
}

function tooMany(retryAfterMs: number) {
  return { ok: false as const, error: "tooManyAttempts" as const, retryAfterMs };
}

/** Inserts a session and revokes the oldest ones beyond MAX_ACTIVE_SESSIONS. */
async function issueSession(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
  credentialVersion: number,
  tokenHash: string,
  now: number,
): Promise<{ sessionId: Id<"authSessions">; expiresAt: number }> {
  const expiresAt = now + SESSION_TTL_MS;
  const sessionId = await ctx.db.insert("authSessions", {
    accountId,
    tokenHash,
    credentialVersion,
    createdAt: now,
    expiresAt,
    lastUsedAt: now,
  });
  await recordAttempt(ctx, limitKeys.session(accountId), LIMITS.sessionCreate, now);
  const sessions = await ctx.db
    .query("authSessions")
    .withIndex("by_account", (q) => q.eq("accountId", accountId))
    .take(MAX_ACTIVE_SESSIONS + 20);
  if (sessions.length > MAX_ACTIVE_SESSIONS) {
    sessions.sort((a, b) => a.createdAt - b.createdAt);
    for (const old of sessions.slice(0, sessions.length - MAX_ACTIVE_SESSIONS)) {
      await ctx.db.delete(old._id);
    }
  }
  return { sessionId, expiresAt };
}

async function profileFor(ctx: MutationCtx, accountId: Id<"accounts">) {
  return await ctx.db
    .query("profiles")
    .withIndex("by_account", (q) => q.eq("accountId", accountId))
    .unique();
}

export const signupPrecheck = internalQuery({
  args: { ipHash: v.string(), username: v.string(), now: v.number() },
  returns: v.object({ blockedMs: v.union(v.number(), v.null()), taken: v.boolean() }),
  handler: async (ctx, args) => {
    const blockedMs = await checkLimit(
      ctx,
      limitKeys.signupIp(args.ipHash),
      LIMITS.signupIp,
      args.now,
    );
    const existing = await ctx.db
      .query("accounts")
      .withIndex("by_username", (q) => q.eq("username", args.username))
      .first();
    return { blockedMs, taken: existing !== null };
  },
});

export const createAccount = internalMutation({
  args: {
    username: v.string(),
    displayName: v.string(),
    passwordHash: v.string(),
    salt: v.string(),
    iterations: v.number(),
    ipHash: v.string(),
    tokenHash: v.string(),
  },
  returns: sessionIssuedValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const signupKey = limitKeys.signupIp(args.ipHash);
    const blocked = await checkLimit(ctx, signupKey, LIMITS.signupIp, now);
    if (blocked !== null) return tooMany(blocked);

    // Read inside the transaction: two concurrent signups for one name both
    // read this index range, so OCC retries the loser, which then sees the winner.
    const existing = await ctx.db
      .query("accounts")
      .withIndex("by_username", (q) => q.eq("username", args.username))
      .first();
    if (existing) return { ok: false as const, error: "usernameTaken" as const };

    const accountId = await ctx.db.insert("accounts", {
      username: args.username,
      passwordHash: args.passwordHash,
      salt: args.salt,
      iterations: args.iterations,
      credentialVersion: 1,
      createdAt: now,
    });
    await ctx.db.insert("profiles", {
      accountId,
      username: args.username,
      displayName: args.displayName,
      rating: INITIAL_RATING,
      peakRating: INITIAL_RATING,
      gamesPlayed: 0,
      wins: 0,
      ratedGames: 0,
      tokensCaptured: 0,
      tokensLost: 0,
      createdAt: now,
      lastActiveAt: now,
    });
    await recordAttempt(ctx, signupKey, LIMITS.signupIp, now);
    const session = await issueSession(ctx, accountId, 1, args.tokenHash, now);
    return {
      ok: true as const,
      ...session,
      username: args.username,
      displayName: args.displayName,
    };
  },
});

export const loginPrecheck = internalQuery({
  args: { ipHash: v.string(), username: v.string(), now: v.number() },
  returns: v.object({
    blockedMs: v.union(v.number(), v.null()),
    credentials: v.union(credentialsValidator, v.null()),
  }),
  handler: async (ctx, args) => {
    const blockedMs = await checkLimits(ctx, loginChecks(args.ipHash, args.username), args.now);
    const account = await ctx.db
      .query("accounts")
      .withIndex("by_username", (q) => q.eq("username", args.username))
      .first();
    return {
      blockedMs,
      credentials: account
        ? {
            accountId: account._id,
            username: account.username,
            passwordHash: account.passwordHash,
            salt: account.salt,
            iterations: account.iterations,
          }
        : null,
    };
  },
});

export const completeLogin = internalMutation({
  args: {
    ipHash: v.string(),
    username: v.string(),
    /** Present only when the password matched this account's hash. */
    verified: v.optional(
      v.object({ accountId: v.id("accounts"), passwordHash: v.string() }),
    ),
    tokenHash: v.string(),
  },
  returns: sessionIssuedValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const blocked = await checkLimits(ctx, loginChecks(args.ipHash, args.username), now);
    if (blocked !== null) return tooMany(blocked);

    const account = args.verified ? await ctx.db.get(args.verified.accountId) : null;
    // The hash must still be current: a password change between hashing and
    // this commit invalidates the attempt.
    const success =
      !!account &&
      !!args.verified &&
      account.username === args.username &&
      constantTimeEqual(account.passwordHash, args.verified.passwordHash);
    if (!success || !account) {
      await recordLoginFailure(ctx, args.ipHash, args.username, now);
      return { ok: false as const, error: "invalidCredentials" as const };
    }

    const sessionBlocked = await checkLimit(
      ctx,
      limitKeys.session(account._id),
      LIMITS.sessionCreate,
      now,
    );
    if (sessionBlocked !== null) return tooMany(sessionBlocked);

    await resetAttempts(ctx, limitKeys.ipUser(args.ipHash, args.username));
    const session = await issueSession(
      ctx,
      account._id,
      account.credentialVersion,
      args.tokenHash,
      now,
    );
    const profile = await profileFor(ctx, account._id);
    if (profile) await ctx.db.patch(profile._id, { lastActiveAt: now });
    return {
      ok: true as const,
      ...session,
      username: account.username,
      displayName: profile?.displayName ?? account.username,
    };
  },
});

/** Loads a live session by id and verifies the secret's hash. */
async function liveSession(
  ctx: QueryCtx | MutationCtx,
  sessionIdRaw: string,
  tokenHash: string,
  now: number,
) {
  const sessionId = ctx.db.normalizeId("authSessions", sessionIdRaw);
  if (!sessionId) return null;
  const session = await ctx.db.get(sessionId);
  if (!session || !constantTimeEqual(session.tokenHash, tokenHash)) return null;
  if (session.expiresAt <= now) return null;
  const account = await ctx.db.get(session.accountId);
  if (!account || account.credentialVersion !== session.credentialVersion) return null;
  return { session, account };
}

export const passwordChangePrecheck = internalQuery({
  args: { sessionId: v.string(), tokenHash: v.string(), ipHash: v.string(), now: v.number() },
  returns: v.union(
    v.object({
      blockedMs: v.union(v.number(), v.null()),
      credentials: credentialsValidator,
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const live = await liveSession(ctx, args.sessionId, args.tokenHash, args.now);
    if (!live) return null;
    const { account } = live;
    return {
      blockedMs: await checkLimits(ctx, loginChecks(args.ipHash, account.username), args.now),
      credentials: {
        accountId: account._id,
        username: account.username,
        passwordHash: account.passwordHash,
        salt: account.salt,
        iterations: account.iterations,
      },
    };
  },
});

export const completePasswordChange = internalMutation({
  args: {
    sessionId: v.string(),
    tokenHash: v.string(),
    ipHash: v.string(),
    /** Hash of the submitted current password, computed with the stored salt. */
    currentHash: v.string(),
    newPasswordHash: v.string(),
    newSalt: v.string(),
    iterations: v.number(),
    newTokenHash: v.string(),
  },
  returns: sessionIssuedValidator,
  handler: async (ctx, args) => {
    const now = Date.now();
    const live = await liveSession(ctx, args.sessionId, args.tokenHash, now);
    if (!live) return { ok: false as const, error: "unauthorized" as const };
    const { account } = live;

    const blocked = await checkLimits(ctx, loginChecks(args.ipHash, account.username), now);
    if (blocked !== null) return tooMany(blocked);

    if (!constantTimeEqual(account.passwordHash, args.currentHash)) {
      await recordLoginFailure(ctx, args.ipHash, account.username, now);
      return { ok: false as const, error: "invalidCredentials" as const };
    }

    const credentialVersion = account.credentialVersion + 1;
    await ctx.db.patch(account._id, {
      passwordHash: args.newPasswordHash,
      salt: args.newSalt,
      iterations: args.iterations,
      credentialVersion,
      passwordChangedAt: now,
    });
    // Sign out every device, including this one; the caller gets a fresh session.
    for (;;) {
      const batch = await ctx.db
        .query("authSessions")
        .withIndex("by_account", (q) => q.eq("accountId", account._id))
        .take(100);
      if (batch.length === 0) break;
      for (const s of batch) await ctx.db.delete(s._id);
    }
    await resetAttempts(ctx, limitKeys.ipUser(args.ipHash, account.username));
    const session = await issueSession(
      ctx,
      account._id,
      credentialVersion,
      args.newTokenHash,
      now,
    );
    const profile = await profileFor(ctx, account._id);
    return {
      ok: true as const,
      ...session,
      username: account.username,
      displayName: profile?.displayName ?? account.username,
    };
  },
});

/**
 * Validates a cookie session for the token endpoint and slides its expiry
 * (writing at most once per SESSION_SLIDE_INTERVAL_MS).
 */
export const touchSession = internalMutation({
  args: { sessionId: v.string(), tokenHash: v.string() },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      accountId: v.id("accounts"),
      sessionId: v.id("authSessions"),
      expiresAt: v.number(),
      username: v.string(),
      displayName: v.string(),
    }),
    v.object({ ok: v.literal(false) }),
  ),
  handler: async (ctx, args) => {
    const now = Date.now();
    const live = await liveSession(ctx, args.sessionId, args.tokenHash, now);
    if (!live) return { ok: false as const };
    const { session, account } = live;
    let expiresAt = session.expiresAt;
    const profile = await profileFor(ctx, account._id);
    if (now - session.lastUsedAt >= SESSION_SLIDE_INTERVAL_MS) {
      expiresAt = now + SESSION_TTL_MS;
      await ctx.db.patch(session._id, { lastUsedAt: now, expiresAt });
      if (profile) await ctx.db.patch(profile._id, { lastActiveAt: now });
    }
    return {
      ok: true as const,
      accountId: account._id,
      sessionId: session._id,
      expiresAt,
      username: account.username,
      displayName: profile?.displayName ?? account.username,
    };
  },
});

export const revokeSession = internalMutation({
  args: { sessionId: v.string(), tokenHash: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const sessionId = ctx.db.normalizeId("authSessions", args.sessionId);
    if (!sessionId) return null;
    const session = await ctx.db.get(sessionId);
    if (session && constantTimeEqual(session.tokenHash, args.tokenHash)) {
      await ctx.db.delete(session._id);
    }
    return null;
  },
});
