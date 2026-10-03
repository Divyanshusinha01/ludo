import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import { MAX_ACTIVE_SESSIONS } from "../../convex/authStore";
import { LIMITS, limitKeys } from "../../convex/lib/rateLimit";
import { setClock, setupConvex, T0, teardownConvex, type DiceQueue, type T } from "./setup";
import {
  attemptRow,
  logIn,
  PASSWORD,
  refresh,
  sessionCount,
  signUp,
  stubAuthEnv,
  tokenOf,
} from "./auth-helpers";

let t: T;
let dice: DiceQueue;
const WRONG = "definitely wrong";
const MINUTE = 60_000;

beforeEach(async () => {
  ({ t, dice } = setupConvex());
  stubAuthEnv();
  tokenOf(await signUp(t, "alice"));
});

afterEach(() => {
  teardownConvex(dice);
  vi.unstubAllEnvs();
});

async function failTimes(n: number, opts: { username?: string; ipHash?: string } = {}) {
  for (let i = 0; i < n; i++) {
    const res = await logIn(t, opts.username ?? "alice", { password: WRONG, ipHash: opts.ipHash });
    expect(res).toEqual({ ok: false, error: "invalidCredentials" });
  }
}

describe("per IP + username", () => {
  it("locks after 5 failures; a locked key rejects even the right password", async () => {
    await failTimes(LIMITS.ipUser.limit, { ipHash: "ip-1" });
    const before = await sessionCount(t, "alice");
    const res = await logIn(t, "alice", { ipHash: "ip-1" });
    expect(res).toMatchObject({ ok: false, error: "tooManyAttempts" });
    expect(!res.ok && res.retryAfterMs).toBeGreaterThan(14 * MINUTE);
    expect(await sessionCount(t, "alice")).toBe(before);
    // Another IP is unaffected by this key.
    tokenOf(await logIn(t, "alice", { ipHash: "ip-2" }));
  });

  it("unlocks when the lock expires", async () => {
    await failTimes(LIMITS.ipUser.limit, { ipHash: "ip-1" });
    setClock(T0 + LIMITS.ipUser.lockMs + 1);
    tokenOf(await logIn(t, "alice", { ipHash: "ip-1" }));
  });

  it("success resets the ip+user counter", async () => {
    await failTimes(4, { ipHash: "ip-1" });
    tokenOf(await logIn(t, "alice", { ipHash: "ip-1" }));
    expect(await attemptRow(t, limitKeys.ipUser("ip-1", "alice"))).toBeNull();
    await failTimes(4, { ipHash: "ip-1" });
    tokenOf(await logIn(t, "alice", { ipHash: "ip-1" }));
  });

  it("concurrent failed attempts are each counted exactly once", async () => {
    const results = await Promise.all(
      Array.from({ length: LIMITS.ipUser.limit }, () =>
        logIn(t, "alice", { password: WRONG, ipHash: "ip-race" }),
      ),
    );
    expect(results.every((r) => !r.ok && r.error === "invalidCredentials")).toBe(true);
    const row = await attemptRow(t, limitKeys.ipUser("ip-race", "alice"));
    expect(row?.count).toBe(LIMITS.ipUser.limit);
    expect(row?.lockedUntil).toBe(T0 + LIMITS.ipUser.lockMs);
  });
});

describe("per IP", () => {
  it("one IP spraying across usernames is locked", async () => {
    for (let i = 0; i < LIMITS.ip.limit; i++) {
      await failTimes(1, { username: `user_${i}`, ipHash: "ip-spray" });
    }
    const res = await logIn(t, "alice", { ipHash: "ip-spray" });
    expect(res).toMatchObject({ ok: false, error: "tooManyAttempts" });
  });
});

describe("per username", () => {
  it("distributed attempts lock the username from every IP, existing or not", async () => {
    for (let i = 0; i < LIMITS.user.limit; i++) {
      await failTimes(1, { ipHash: `ip-d${i}` });
    }
    expect(await logIn(t, "alice", { ipHash: "ip-fresh" })).toMatchObject({
      ok: false,
      error: "tooManyAttempts",
    });

    for (let i = 0; i < LIMITS.user.limit; i++) {
      await failTimes(1, { username: "ghost_user", ipHash: `ip-g${i}` });
    }
    // Same answer for a username that does not exist.
    expect(await logIn(t, "ghost_user", { ipHash: "ip-fresh2" })).toMatchObject({
      ok: false,
      error: "tooManyAttempts",
    });
  });
});

describe("session creation", () => {
  it("caps new sessions per account per 10 minutes (signup counts)", async () => {
    for (let i = 1; i < LIMITS.sessionCreate.limit; i++) {
      tokenOf(await logIn(t, "alice", { ipHash: `ip-s${i}` }));
    }
    expect(await logIn(t, "alice", { ipHash: "ip-s9" })).toMatchObject({
      ok: false,
      error: "tooManyAttempts",
    });
    setClock(T0 + LIMITS.sessionCreate.windowMs + 1);
    tokenOf(await logIn(t, "alice", { ipHash: "ip-s9" }));
  });

  it("keeps at most 10 active sessions, revoking the oldest", async () => {
    const first = (await t.run(async (ctx) => ctx.db.query("authSessions").first()))!;
    let now = T0;
    for (let i = 0; i < MAX_ACTIVE_SESSIONS; i++) {
      if (i % (LIMITS.sessionCreate.limit - 1) === 0) {
        now += LIMITS.sessionCreate.windowMs + 1;
        setClock(now);
      }
      tokenOf(await logIn(t, "alice", { ipHash: `ip-m${i}` }));
    }
    expect(await sessionCount(t, "alice")).toBe(MAX_ACTIVE_SESSIONS);
    expect(await t.run(async (ctx) => ctx.db.get(first._id))).toBeNull();
  });

  it("signup is limited to 5 accounts per IP per hour", async () => {
    for (let i = 0; i < LIMITS.signupIp.limit; i++) {
      tokenOf(await signUp(t, `farm_${i}`, { ipHash: "ip-farm" }));
    }
    expect(await signUp(t, "farm_x", { ipHash: "ip-farm" })).toMatchObject({
      ok: false,
      error: "tooManyAttempts",
    });
    setClock(T0 + LIMITS.signupIp.windowMs + 1);
    tokenOf(await signUp(t, "farm_x", { ipHash: "ip-farm" }));
  });
});

describe("server secret", () => {
  it("every credential action rejects a missing or wrong secret", async () => {
    const token = tokenOf(await logIn(t, "alice"));
    for (const serverSecret of ["", "nope", "test-server-secret-0123456789abcdeX"]) {
      await expect(
        t.action(api.auth.signUp, { serverSecret, ipHash: "ip", username: "zed", password: PASSWORD }),
      ).rejects.toThrow(/Not authorized/);
      await expect(
        t.action(api.auth.logIn, { serverSecret, ipHash: "ip", username: "alice", password: PASSWORD }),
      ).rejects.toThrow(/Not authorized/);
      await expect(
        t.action(api.auth.changePassword, {
          serverSecret,
          ipHash: "ip",
          sessionToken: token,
          currentPassword: PASSWORD,
          newPassword: "another password",
        }),
      ).rejects.toThrow(/Not authorized/);
      await expect(
        t.action(api.auth.logOut, { serverSecret, sessionToken: token }),
      ).rejects.toThrow(/Not authorized/);
      await expect(
        t.action(api.auth.refreshSession, { serverSecret, sessionToken: token }),
      ).rejects.toThrow(/Not authorized/);
    }
    expect(await refresh(t, token)).toMatchObject({ ok: true });
  });

  it("cleanup purges stale attempt rows but keeps active locks", async () => {
    await failTimes(1, { ipHash: "ip-old" });
    setClock(T0 + 3 * 60 * MINUTE);
    await failTimes(LIMITS.ipUser.limit, { ipHash: "ip-new" });
    await t.mutation(internal.cleanup.tick, {});
    expect(await attemptRow(t, limitKeys.ipUser("ip-old", "alice"))).toBeNull();
    expect(await attemptRow(t, limitKeys.ipUser("ip-new", "alice"))).not.toBeNull();
  });
});
