import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  JWT_AUDIENCE,
  JWT_ISSUER,
  JWT_TTL_SECONDS,
  LAST_USERNAME_COOKIE,
  SESSION_COOKIE,
} from "../../convex/lib/authShared";

const backend = vi.hoisted(() => ({
  signUp: vi.fn(),
  logIn: vi.fn(),
  changePassword: vi.fn(),
  logOut: vi.fn(),
  refreshSession: vi.fn(),
}));
vi.mock("@/lib/server/authBackend", () => backend);

const { POST: signup } = await import("@/app/api/auth/signup/route");
const { POST: login } = await import("@/app/api/auth/login/route");
const { POST: logout } = await import("@/app/api/auth/logout/route");
const { POST: password } = await import("@/app/api/auth/password/route");
const { GET: token } = await import("@/app/api/auth/token/route");
const { getClientIp, hashIp } = await import("@/lib/server/authHttp");

const ORIGIN = "http://localhost:3000";
const SECRET = "route-test-secret-0123456789";
const DAY_S = 24 * 60 * 60;
let publicKey: CryptoKey;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  publicKey = pair.publicKey;
  process.env.AUTH_JWT_PRIVATE_KEY = JSON.stringify(
    await crypto.subtle.exportKey("jwk", pair.privateKey),
  );
});

beforeEach(() => {
  vi.stubEnv("AUTH_SERVER_SECRET", SECRET);
  for (const fn of Object.values(backend)) fn.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function req(
  path: string,
  opts: {
    method?: string;
    body?: unknown;
    origin?: string | null;
    cookie?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const headers: Record<string, string> = {
    "x-forwarded-for": "203.0.113.7, 10.0.0.1",
    ...opts.headers,
  };
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.cookie) headers.cookie = opts.cookie;
  return new NextRequest(`${ORIGIN}${path}`, {
    method: opts.method ?? "POST",
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

const okSession = {
  ok: true as const,
  token: "sess123.secretABC",
  expiresAt: 0,
  username: "alice",
  displayName: "Alice",
};

function freshSession() {
  return { ...okSession, expiresAt: Date.now() + 30 * DAY_S * 1000 };
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

describe("getClientIp", () => {
  it("prefers the first x-forwarded-for hop, then x-real-ip, then unknown", () => {
    expect(getClientIp(new Headers({ "x-forwarded-for": " 1.2.3.4 , 5.6.7.8" }))).toBe("1.2.3.4");
    expect(getClientIp(new Headers({ "x-real-ip": "9.9.9.9" }))).toBe("9.9.9.9");
    expect(getClientIp(new Headers())).toBe("unknown");
  });

  it("hashIp is keyed and never returns the raw address", async () => {
    const a = await hashIp("1.2.3.4", SECRET);
    expect(a).not.toContain("1.2.3.4");
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(await hashIp("1.2.3.4", SECRET)).toBe(a);
    expect(await hashIp("1.2.3.4", `${SECRET}x`)).not.toBe(a);
  });
});

describe("POST /api/auth/signup", () => {
  it("sets an httpOnly 30-day session cookie and returns no token", async () => {
    backend.signUp.mockResolvedValue(freshSession());
    const res = await signup(req("/api/auth/signup", { body: { username: "alice", password: "pw12345678" } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, profile: { username: "alice", displayName: "Alice" } });
    expect(JSON.stringify(body)).not.toContain("secretABC");

    const cookie = res.cookies.get(SESSION_COOKIE)!;
    expect(cookie.value).toBe("sess123.secretABC");
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("lax");
    expect(cookie.path).toBe("/");
    expect(cookie.secure).toBe(false);
    expect(cookie.maxAge).toBeGreaterThan(30 * DAY_S - 5);
    expect(cookie.maxAge).toBeLessThanOrEqual(30 * DAY_S);

    const last = res.cookies.get(LAST_USERNAME_COOKIE)!;
    expect(last.value).toBe("alice");
    expect(last.httpOnly).toBe(false);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const call = backend.signUp.mock.calls[0]![0];
    expect(call.ipHash).toBe(await hashIp("203.0.113.7", SECRET));
    expect(JSON.stringify(call)).not.toContain("203.0.113.7");
  });

  it("marks the cookie Secure in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    backend.signUp.mockResolvedValue(freshSession());
    const res = await signup(req("/api/auth/signup", { body: { username: "alice", password: "pw12345678" } }));
    expect(res.cookies.get(SESSION_COOKIE)!.secure).toBe(true);
  });

  it("maps a taken username to 409 without a cookie", async () => {
    backend.signUp.mockResolvedValue({ ok: false, error: "usernameTaken" });
    const res = await signup(req("/api/auth/signup", { body: { username: "alice", password: "pw12345678" } }));
    expect(res.status).toBe(409);
    expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });

  it("rejects bad bodies before calling Convex", async () => {
    const res = await signup(req("/api/auth/signup", { body: { username: 5, password: "x" } }));
    expect(res.status).toBe(400);
    expect(backend.signUp).not.toHaveBeenCalled();
  });

  it("returns 503 when the server secret is not configured", async () => {
    vi.stubEnv("AUTH_SERVER_SECRET", "");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await signup(req("/api/auth/signup", { body: { username: "alice", password: "pw12345678" } }));
    expect(res.status).toBe(503);
    expect(backend.signUp).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe("origin checks", () => {
  it("POST without Origin or with a foreign Origin is refused", async () => {
    for (const origin of [null, "https://evil.example"]) {
      for (const handler of [signup, login, logout, password]) {
        const res = await handler(
          req("/api/auth/x", { origin, body: { username: "a", password: "b" }, cookie: `${SESSION_COOKIE}=a.b` }),
        );
        expect(res.status).toBe(403);
      }
    }
    for (const fn of Object.values(backend)) expect(fn).not.toHaveBeenCalled();
  });

  it("token endpoint refuses cross-site fetches", async () => {
    const res = await token(
      req("/api/auth/token", {
        method: "GET",
        origin: null,
        cookie: `${SESSION_COOKIE}=a.b`,
        headers: { "sec-fetch-site": "cross-site" },
      }),
    );
    expect(res.status).toBe(403);
    expect(backend.refreshSession).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/login", () => {
  it("success sets the cookie", async () => {
    backend.logIn.mockResolvedValue(freshSession());
    const res = await login(req("/api/auth/login", { body: { username: "alice", password: "pw12345678" } }));
    expect(res.status).toBe(200);
    expect(res.cookies.get(SESSION_COOKIE)?.value).toBe("sess123.secretABC");
  });

  it("generic 401 for bad credentials, 429 with Retry-After when locked", async () => {
    backend.logIn.mockResolvedValueOnce({ ok: false, error: "invalidCredentials" });
    const bad = await login(req("/api/auth/login", { body: { username: "alice", password: "nope" } }));
    expect(bad.status).toBe(401);
    expect((await bad.json()).message).toBe("Wrong username or password");
    expect(bad.cookies.get(SESSION_COOKIE)).toBeUndefined();

    backend.logIn.mockResolvedValueOnce({ ok: false, error: "tooManyAttempts", retryAfterMs: 90_500 });
    const locked = await login(req("/api/auth/login", { body: { username: "alice", password: "nope" } }));
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBe("91");
  });
});

describe("POST /api/auth/logout", () => {
  it("revokes the session and clears the cookie", async () => {
    backend.logOut.mockResolvedValue(undefined);
    const res = await logout(req("/api/auth/logout", { body: {}, cookie: `${SESSION_COOKIE}=sess123.secretABC` }));
    expect(res.status).toBe(200);
    expect(backend.logOut).toHaveBeenCalledWith("sess123.secretABC");
    const cookie = res.cookies.get(SESSION_COOKIE)!;
    expect(cookie.value).toBe("");
    expect(cookie.maxAge).toBe(0);
  });

  it("still clears the cookie when Convex is unreachable", async () => {
    backend.logOut.mockRejectedValue(new Error("down"));
    const res = await logout(req("/api/auth/logout", { body: {}, cookie: `${SESSION_COOKIE}=a.b` }));
    expect(res.status).toBe(200);
    expect(res.cookies.get(SESSION_COOKIE)!.maxAge).toBe(0);
  });
});

describe("POST /api/auth/password", () => {
  it("requires a session cookie", async () => {
    const res = await password(req("/api/auth/password", { body: { currentPassword: "a", newPassword: "b" } }));
    expect(res.status).toBe(401);
    expect(backend.changePassword).not.toHaveBeenCalled();
  });

  it("sets the new session cookie on success", async () => {
    backend.changePassword.mockResolvedValue({ ...freshSession(), token: "sess999.newSecret" });
    const res = await password(
      req("/api/auth/password", {
        body: { currentPassword: "old password", newPassword: "new password" },
        cookie: `${SESSION_COOKIE}=sess123.secretABC`,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.cookies.get(SESSION_COOKIE)?.value).toBe("sess999.newSecret");
    expect(backend.changePassword.mock.calls[0]![0].sessionToken).toBe("sess123.secretABC");
  });

  it("clears the cookie when the session is no longer valid", async () => {
    backend.changePassword.mockResolvedValue({ ok: false, error: "unauthorized" });
    const res = await password(
      req("/api/auth/password", {
        body: { currentPassword: "a", newPassword: "new password" },
        cookie: `${SESSION_COOKIE}=a.b`,
      }),
    );
    expect(res.status).toBe(401);
    expect(res.cookies.get(SESSION_COOKIE)!.maxAge).toBe(0);
  });
});

describe("GET /api/auth/token", () => {
  const sameOrigin = { method: "GET", origin: null, headers: { "sec-fetch-site": "same-origin" } };

  it("401 without a cookie, without calling Convex", async () => {
    const res = await token(req("/api/auth/token", sameOrigin));
    expect(res.status).toBe(401);
    expect(backend.refreshSession).not.toHaveBeenCalled();
  });

  it("forged or revoked cookies get 401 and the cookie is cleared", async () => {
    backend.refreshSession.mockResolvedValue({ ok: false });
    const res = await token(req("/api/auth/token", { ...sameOrigin, cookie: `${SESSION_COOKIE}=forged.value` }));
    expect(res.status).toBe(401);
    expect(res.cookies.get(SESSION_COOKIE)!.maxAge).toBe(0);
  });

  it("valid cookie: returns a verifiable 10-minute RS256 JWT and re-issues the cookie", async () => {
    const expiresAt = Date.now() + 30 * DAY_S * 1000;
    backend.refreshSession.mockResolvedValue({
      ok: true,
      accountId: "acc_1",
      sessionId: "sess123",
      expiresAt,
      username: "alice",
      displayName: "Alice",
    });
    const res = await token(
      req("/api/auth/token", { ...sameOrigin, cookie: `${SESSION_COOKIE}=sess123.secretABC` }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.profile).toEqual({ username: "alice", displayName: "Alice" });

    const [h, p, s] = (body.token as string).split(".") as [string, string, string];
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      b64urlToBytes(s),
      new TextEncoder().encode(`${h}.${p}`),
    );
    expect(valid).toBe(true);
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
    const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
    expect(header.alg).toBe("RS256");
    expect(claims).toMatchObject({ iss: JWT_ISSUER, aud: JWT_AUDIENCE, sub: "acc_1", sid: "sess123" });
    expect(claims.exp - claims.iat).toBe(JWT_TTL_SECONDS);
    expect(body.expiresAt).toBe(claims.exp * 1000);

    const cookie = res.cookies.get(SESSION_COOKIE)!;
    expect(cookie.value).toBe("sess123.secretABC");
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.maxAge).toBeGreaterThan(30 * DAY_S - 5);
  });

  it("returns 503 when the signing key is missing", async () => {
    const saved = process.env.AUTH_JWT_PRIVATE_KEY;
    delete process.env.AUTH_JWT_PRIVATE_KEY;
    backend.refreshSession.mockResolvedValue({
      ok: true,
      accountId: "acc_1",
      sessionId: "sess123",
      expiresAt: Date.now() + 1000,
      username: "alice",
      displayName: "Alice",
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await token(req("/api/auth/token", { ...sameOrigin, cookie: `${SESSION_COOKIE}=a.b` }));
    expect(res.status).toBe(503);
    consoleError.mockRestore();
    process.env.AUTH_JWT_PRIVATE_KEY = saved;
  });
});
