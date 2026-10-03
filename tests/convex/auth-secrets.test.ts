import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../convex/_generated/api";
import * as authModule from "../../convex/auth";
import * as authStore from "../../convex/authStore";
import * as profilesModule from "../../convex/profiles";
import { clientId, setupConvex, teardownConvex, type DiceQueue, type T } from "./setup";
import { asUser, logIn, PASSWORD, signUp, stubAuthEnv, tokenOf } from "./auth-helpers";

let t: T;
let dice: DiceQueue;

const FORBIDDEN_KEYS = new Set([
  "passwordHash",
  "salt",
  "iterations",
  "tokenHash",
  "credentialVersion",
  "token",
  "sessionToken",
  "secret",
  "password",
  "clientId",
]);

beforeEach(() => {
  ({ t, dice } = setupConvex());
  stubAuthEnv();
});

afterEach(() => {
  teardownConvex(dice);
  vi.unstubAllEnvs();
});

/** Every key path and string value in a JSON-like result. */
function walk(value: unknown, path: string, out: { keys: string[]; strings: string[] }) {
  if (typeof value === "string") out.strings.push(value);
  else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.keys.push(k);
      walk(v, `${path}.${k}`, out);
    }
  }
  return out;
}

type Registered = { isQuery?: boolean; isMutation?: boolean; isAction?: boolean; isPublic?: boolean; isInternal?: boolean };

describe("secret hygiene", () => {
  it("credential reads and writes are internal-only", () => {
    const exported = Object.entries(authStore).filter(
      ([, f]) => typeof f === "function" && ((f as Registered).isQuery || (f as Registered).isMutation),
    );
    expect(exported.length).toBeGreaterThan(5);
    for (const [name, f] of exported) {
      expect({ name, internal: (f as Registered).isInternal }).toEqual({ name, internal: true });
    }
  });

  it("every public auth action requires the server secret", () => {
    const actions = Object.entries(authModule).filter(([, f]) => (f as Registered).isAction);
    expect(actions.map(([name]) => name).sort()).toEqual([
      "changePassword",
      "logIn",
      "logOut",
      "refreshSession",
      "signUp",
    ]);
    for (const [name, f] of actions) {
      const fn = f as unknown as { exportArgs: () => string };
      const args = JSON.parse(fn.exportArgs()) as { value: Record<string, unknown> };
      expect({ name, gated: "serverSecret" in args.value }).toEqual({ name, gated: true });
    }
  });

  it("public queries and mutations never return credentials, hashes or tokens", async () => {
    const token = tokenOf(await signUp(t, "alice", { displayName: "Alice" }));
    const second = tokenOf(await logIn(t, "alice"));
    const user = await asUser(t, token);

    const created = await user.mutation(api.rooms.createRoom, { clientId: clientId(1), name: "" });
    if (!("roomId" in created)) throw new Error("pending");
    const joined = await t.mutation(api.rooms.joinRoom, {
      code: created.code,
      clientId: clientId(2),
      name: "Guest",
    });

    const results: Record<string, unknown> = {
      me: await user.query(api.auth.me, {}),
      meAnon: await t.query(api.auth.me, {}),
      getMine: await user.query(api.profiles.getMine, {}),
      getPublic: await t.query(api.profiles.getPublic, { username: "alice" }),
      updateDisplayName: await user.mutation(api.auth.updateDisplayName, { displayName: "Al" }),
      createRoom: created,
      joinRoom: joined,
      getRoom: await user.query(api.rooms.getRoom, { roomId: created.roomId, clientId: clientId(1) }),
      getRoomByCode: await t.query(api.rooms.getRoomByCode, { code: created.code }),
      joinQueue: await user.mutation(api.matchmaking.joinQueue, { clientId: clientId(3), queue: "duel" }),
      queueStatus: await user.query(api.matchmaking.queueStatus, {}),
      queuePing: await user.mutation(api.matchmaking.queuePing, {}),
      leaveQueue: await user.mutation(api.matchmaking.leaveQueue, {}),
      queueStatusAnon: await t.query(api.matchmaking.queueStatus, {}),
      listMine: await user.query(api.history.listMine, { paginationOpts: { numItems: 10, cursor: null } }),
      leaderboard: await t.query(api.history.leaderboard, {}),
      getRoomResult: await t.query(api.history.getRoomResult, { roomId: created.roomId }),
      listLive: await t.query(api.spectate.listLive, {}),
      getSpectatorRoom: await t.query(api.spectate.getSpectatorRoom, { code: created.code }),
      spectatorPing: await t.mutation(api.spectate.spectatorPing, { roomId: created.roomId, spectatorId: clientId(4) }),
      leaveSpectate: await t.mutation(api.spectate.leaveSpectate, { roomId: created.roomId, spectatorId: clientId(4) }),
    };
    expect(results.me).not.toBeNull();

    const secrets = await t.run(async (ctx) => {
      const accounts = await ctx.db.query("accounts").collect();
      const sessions = await ctx.db.query("authSessions").collect();
      return [
        ...accounts.flatMap((a) => [a.passwordHash, a.salt]),
        ...sessions.map((s) => s.tokenHash),
      ];
    });
    const forbiddenValues = [
      ...secrets,
      token,
      second,
      token.split(".")[1]!,
      second.split(".")[1]!,
      PASSWORD,
    ];

    for (const [fn, result] of Object.entries(results)) {
      const { keys, strings } = walk(result, fn, { keys: [], strings: [] });
      const badKeys = keys.filter((k) => FORBIDDEN_KEYS.has(k));
      expect({ fn, badKeys }).toEqual({ fn, badKeys: [] });
      const serialized = JSON.stringify(result);
      for (const value of forbiddenValues) {
        expect({ fn, leaked: serialized.includes(value) }).toEqual({ fn, leaked: false });
      }
      expect(strings.some((s) => s.length > 30 && forbiddenValues.includes(s))).toBe(false);
    }
  });

  it("profiles module exposes only whitelisted fields", () => {
    expect(Object.keys(profilesModule).sort()).toEqual(["getMine", "getPublic"]);
  });
});
