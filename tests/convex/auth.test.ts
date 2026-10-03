import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import { SESSION_SLIDE_INTERVAL_MS, SESSION_TTL_MS } from "../../convex/lib/authShared";
import {
  clientId,
  setClock,
  setupConvex,
  T0,
  teardownConvex,
  type DiceQueue,
  type T,
} from "./setup";
import {
  asUser,
  identityFor,
  logIn,
  PASSWORD,
  refresh,
  SERVER_SECRET,
  signUp,
  stubAuthEnv,
  tokenOf,
} from "./auth-helpers";

let t: T;
let dice: DiceQueue;

beforeEach(() => {
  ({ t, dice } = setupConvex());
  stubAuthEnv();
});

afterEach(() => {
  teardownConvex(dice);
  vi.unstubAllEnvs();
});

describe("signup", () => {
  it("creates account, profile and a session; stores only hashes", async () => {
    const res = await signUp(t, "Divsi_01", { displayName: "  Divsi  " });
    expect(res).toMatchObject({ ok: true, username: "divsi_01", displayName: "Divsi" });
    const token = tokenOf(res);
    const secret = token.split(".")[1]!;

    const rows = await t.run(async (ctx) => ({
      accounts: await ctx.db.query("accounts").collect(),
      profiles: await ctx.db.query("profiles").collect(),
      sessions: await ctx.db.query("authSessions").collect(),
    }));
    expect(rows.accounts).toHaveLength(1);
    expect(rows.accounts[0]!.username).toBe("divsi_01");
    expect(rows.accounts[0]!.passwordHash).not.toContain(PASSWORD);
    expect(rows.accounts[0]!.salt.length).toBeGreaterThan(10);
    expect(rows.profiles[0]).toMatchObject({ displayName: "Divsi", rating: 1200, gamesPlayed: 0 });
    expect(rows.sessions).toHaveLength(1);
    expect(rows.sessions[0]!.tokenHash).not.toBe(secret);
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(rows.sessions[0]!.expiresAt).toBe(T0 + SESSION_TTL_MS);
  });

  it("logs in immediately: the returned token is a valid session", async () => {
    const token = tokenOf(await signUp(t, "alice"));
    const session = await refresh(t, token);
    expect(session).toMatchObject({ ok: true, username: "alice", displayName: "alice" });
  });

  it("rejects duplicate usernames case-insensitively", async () => {
    tokenOf(await signUp(t, "alice"));
    expect(await signUp(t, "ALICE", { ipHash: "ip-other" })).toEqual({
      ok: false,
      error: "usernameTaken",
    });
  });

  it("concurrent signups for one username: exactly one wins", async () => {
    const results = await Promise.all(
      [1, 2, 3].map((i) => signUp(t, "racer", { ipHash: `ip-${i}` })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => !r.ok && r.error)).toEqual([
      "usernameTaken",
      "usernameTaken",
    ]);
    const accounts = await t.run(async (ctx) => ctx.db.query("accounts").collect());
    expect(accounts).toHaveLength(1);
  });

  it("concurrent commits for one username: the in-transaction check blocks the second", async () => {
    const draft = {
      username: "dup",
      displayName: "dup",
      passwordHash: "h",
      salt: "s",
      iterations: 1000,
      tokenHash: "t",
    };
    const [a, b] = await Promise.all([
      t.mutation(internal.authStore.createAccount, { ...draft, ipHash: "ip-a" }),
      t.mutation(internal.authStore.createAccount, { ...draft, ipHash: "ip-b" }),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
  });

  it("validates username and password", async () => {
    expect(await signUp(t, "ab")).toEqual({ ok: false, error: "invalidUsername" });
    expect(await signUp(t, "has space")).toEqual({ ok: false, error: "invalidUsername" });
    expect(await signUp(t, "x".repeat(21))).toEqual({ ok: false, error: "invalidUsername" });
    expect(await signUp(t, "valid_name", { password: "short" })).toEqual({
      ok: false,
      error: "invalidPassword",
    });
  });
});

describe("login", () => {
  beforeEach(async () => {
    tokenOf(await signUp(t, "alice"));
  });

  it("issues a new session for the right password", async () => {
    const token = tokenOf(await logIn(t, "Alice"));
    expect(await refresh(t, token)).toMatchObject({ ok: true, username: "alice" });
  });

  it("wrong password and unknown user return the same generic error", async () => {
    const wrong = await logIn(t, "alice", { password: "wrong password!" });
    const unknown = await logIn(t, "nobody", { password: PASSWORD });
    expect(wrong).toEqual({ ok: false, error: "invalidCredentials" });
    expect(unknown).toEqual(wrong);
  });

  it("rejects calls without the right server secret", async () => {
    const args = { ipHash: "ip", username: "alice", password: PASSWORD };
    await expect(
      t.action(api.auth.logIn, { ...args, serverSecret: "wrong-secret-wrong-secret" }),
    ).rejects.toThrow(/Not authorized/);
    vi.stubEnv("AUTH_SERVER_SECRET", "");
    await expect(
      t.action(api.auth.logIn, { ...args, serverSecret: "" }),
    ).rejects.toThrow(/Not authorized/);
  });
});

describe("sessions", () => {
  it("logout revokes the session everywhere at once", async () => {
    const token = tokenOf(await signUp(t, "alice"));
    const user = await asUser(t, token);
    expect(await user.query(api.auth.me, {})).toMatchObject({ username: "alice" });

    await t.action(api.auth.logOut, { serverSecret: SERVER_SECRET, sessionToken: token });
    expect(await refresh(t, token)).toEqual({ ok: false });
    // The JWT is still unexpired, but its sid no longer exists.
    expect(await user.query(api.auth.me, {})).toBeNull();
    await expect(user.mutation(api.auth.updateDisplayName, { displayName: "X" })).rejects.toThrow(
      /Not authorized/,
    );
  });

  it("rejects malformed, forged and cross-session tokens", async () => {
    const a = tokenOf(await signUp(t, "alice"));
    const b = tokenOf(await signUp(t, "bobby"));
    const [aId, aSecret] = a.split(".") as [string, string];
    const [bId] = b.split(".") as [string, string];
    for (const bad of ["", "nodot", ".x", "x.", `${aId}.${aSecret}x`, `${bId}.${aSecret}`, "a.b.c"]) {
      expect(await refresh(t, bad)).toEqual({ ok: false });
    }
  });

  it("identity with a revoked or mismatched sid is anonymous", async () => {
    const a = tokenOf(await signUp(t, "alice"));
    const b = tokenOf(await signUp(t, "bobby"));
    const ida = await identityFor(t, a);
    const idb = await identityFor(t, b);
    expect(await t.withIdentity({ subject: ida.subject, sid: idb.sid }).query(api.auth.me, {})).toBeNull();
    expect(await t.withIdentity({ subject: ida.subject }).query(api.auth.me, {})).toBeNull();
    expect(await t.query(api.auth.me, {})).toBeNull();
  });

  it("slides expiry at most once per day", async () => {
    const token = tokenOf(await signUp(t, "alice"));
    const first = await refresh(t, token);
    expect(first).toMatchObject({ ok: true, expiresAt: T0 + SESSION_TTL_MS });

    setClock(T0 + SESSION_SLIDE_INTERVAL_MS / 2);
    expect(await refresh(t, token)).toMatchObject({ expiresAt: T0 + SESSION_TTL_MS });

    const later = T0 + 2 * SESSION_SLIDE_INTERVAL_MS;
    setClock(later);
    expect(await refresh(t, token)).toMatchObject({ ok: true, expiresAt: later + SESSION_TTL_MS });
  });

  it("an expired session is rejected and cannot mutate", async () => {
    const token = tokenOf(await signUp(t, "alice"));
    const user = await asUser(t, token);
    setClock(T0 + SESSION_TTL_MS + 1);
    expect(await refresh(t, token)).toEqual({ ok: false });
    await expect(user.mutation(api.auth.updateDisplayName, { displayName: "X" })).rejects.toThrow(
      /Not authorized/,
    );
  });

  it("cleanup purges expired sessions", async () => {
    tokenOf(await signUp(t, "alice"));
    setClock(T0 + SESSION_TTL_MS + 1);
    await t.mutation(internal.cleanup.tick, {});
    const sessions = await t.run(async (ctx) => ctx.db.query("authSessions").collect());
    expect(sessions).toHaveLength(0);
  });
});

describe("profiles", () => {
  it("updateDisplayName sanitizes and getPublic exposes the profile", async () => {
    const token = tokenOf(await signUp(t, "alice"));
    const user = await asUser(t, token);
    const updated = await user.mutation(api.auth.updateDisplayName, { displayName: " Al\u0007 ice " });
    expect(updated.displayName).toBe("Al ice");
    await expect(user.mutation(api.auth.updateDisplayName, { displayName: "   " })).rejects.toThrow(
      /valid name/,
    );
    expect(await t.query(api.profiles.getPublic, { username: "ALICE" })).toMatchObject({
      username: "alice",
      displayName: "Al ice",
    });
    expect(await user.query(api.profiles.getMine, {})).toMatchObject({ displayName: "Al ice" });
    expect(await t.query(api.profiles.getMine, {})).toBeNull();
  });
});

describe("seat linking", () => {
  it("signed-in seats carry accountId and default to the display name", async () => {
    const token = tokenOf(await signUp(t, "alice", { displayName: "Alice" }));
    const user = await asUser(t, token);
    const { subject } = await identityFor(t, token);

    const created = await user.mutation(api.rooms.createRoom, { clientId: clientId(1), name: "" });
    if (!("roomId" in created)) throw new Error("pending");
    const joined = await t.mutation(api.rooms.joinRoom, {
      code: created.code,
      clientId: clientId(2),
      name: "Guest",
    });
    if (!("roomId" in joined)) throw new Error("pending");

    const players = await t.run(async (ctx) =>
      ctx.db
        .query("players")
        .withIndex("by_room", (q) => q.eq("roomId", created.roomId))
        .collect(),
    );
    const host = players.find((p) => p.clientId === clientId(1))!;
    const guest = players.find((p) => p.clientId === clientId(2))!;
    expect(host).toMatchObject({ name: "Alice", accountId: subject });
    expect(guest.accountId).toBeUndefined();
  });

  it("an account-linked seat cannot be reclaimed by name from another identity", async () => {
    const token = tokenOf(await signUp(t, "alice", { displayName: "Alice" }));
    const user = await asUser(t, token);
    const created = await t.mutation(api.rooms.createRoom, { clientId: clientId(1), name: "Host" });
    if (!("roomId" in created)) throw new Error("pending");
    await user.mutation(api.rooms.joinRoom, { code: created.code, clientId: clientId(2), name: "" });
    await t.mutation(api.rooms.markDisconnected, { roomId: created.roomId, clientId: clientId(2) });

    await expect(
      t.mutation(api.rooms.joinRoom, { code: created.code, clientId: clientId(3), name: "Alice" }),
    ).rejects.toThrow(/name is already/);

    // The same account on a new tab is allowed to ask for the seat back.
    const again = await user.mutation(api.rooms.joinRoom, {
      code: created.code,
      clientId: clientId(4),
      name: "Alice",
    });
    expect("pending" in again || "roomId" in again).toBe(true);
  });
});
