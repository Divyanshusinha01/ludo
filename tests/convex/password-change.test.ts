import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { LIMITS, limitKeys } from "../../convex/lib/rateLimit";
import { setupConvex, teardownConvex, T0, type DiceQueue, type T } from "./setup";
import {
  asUser,
  attemptRow,
  identityFor,
  logIn,
  PASSWORD,
  refresh,
  SERVER_SECRET,
  sessionCount,
  signUp,
  stubAuthEnv,
  tokenOf,
} from "./auth-helpers";

let t: T;
let dice: DiceQueue;
const NEW_PASSWORD = "brand new password";

beforeEach(() => {
  ({ t, dice } = setupConvex());
  stubAuthEnv();
});

afterEach(() => {
  teardownConvex(dice);
  vi.unstubAllEnvs();
});

function change(
  token: string,
  currentPassword: string,
  newPassword = NEW_PASSWORD,
  ipHash = "ip-pw",
) {
  return t.action(api.auth.changePassword, {
    serverSecret: SERVER_SECRET,
    ipHash,
    sessionToken: token,
    currentPassword,
    newPassword,
  });
}

describe("changePassword", () => {
  it("revokes every old session and issues one new one", async () => {
    const phone = tokenOf(await signUp(t, "alice"));
    const laptop = tokenOf(await logIn(t, "alice"));
    const phoneUser = await asUser(t, phone);
    const laptopUser = await asUser(t, laptop);

    const res = await change(phone, PASSWORD);
    const fresh = tokenOf(res);

    expect(await refresh(t, phone)).toEqual({ ok: false });
    expect(await refresh(t, laptop)).toEqual({ ok: false });
    expect(await phoneUser.query(api.auth.me, {})).toBeNull();
    expect(await laptopUser.query(api.auth.me, {})).toBeNull();
    expect(await sessionCount(t, "alice")).toBe(1);

    expect(await refresh(t, fresh)).toMatchObject({ ok: true, username: "alice" });
    expect(await (await asUser(t, fresh)).query(api.auth.me, {})).toMatchObject({
      username: "alice",
    });

    expect(await logIn(t, "alice")).toEqual({ ok: false, error: "invalidCredentials" });
    tokenOf(await logIn(t, "alice", { password: NEW_PASSWORD }));

    const account = await t.run(async (ctx) => ctx.db.query("accounts").first());
    expect(account).toMatchObject({ credentialVersion: 2, passwordChangedAt: T0 });
  });

  it("rejects a wrong current password, counts it, and locks after the limit", async () => {
    const token = tokenOf(await signUp(t, "alice"));
    expect(await change(token, "not my password")).toEqual({
      ok: false,
      error: "invalidCredentials",
    });
    expect((await attemptRow(t, limitKeys.ipUser("ip-pw", "alice")))?.count).toBe(1);

    for (let i = 1; i < LIMITS.ipUser.limit; i++) await change(token, "not my password");
    expect(await change(token, PASSWORD)).toMatchObject({ ok: false, error: "tooManyAttempts" });
    // Nothing changed: the old password and session still work.
    expect(await refresh(t, token)).toMatchObject({ ok: true });
  });

  it("rejects invalid sessions and weak new passwords", async () => {
    const token = tokenOf(await signUp(t, "alice"));
    expect(await change("garbage", PASSWORD)).toEqual({ ok: false, error: "unauthorized" });
    expect(await change(`${token}x`, PASSWORD)).toEqual({ ok: false, error: "unauthorized" });
    expect(await change(token, PASSWORD, "short")).toEqual({ ok: false, error: "invalidPassword" });
  });

  it("a session issued at an older credential version is rejected", async () => {
    const token = tokenOf(await signUp(t, "alice"));
    const { subject } = await identityFor(t, token);
    const staleSid = await t.run(async (ctx) =>
      ctx.db.insert("authSessions", {
        accountId: subject as Id<"accounts">,
        tokenHash: "irrelevant",
        credentialVersion: 0,
        createdAt: T0,
        expiresAt: T0 + 1e9,
        lastUsedAt: T0,
      }),
    );
    expect(
      await t.withIdentity({ subject, sid: staleSid }).query(api.auth.me, {}),
    ).toBeNull();
  });
});
