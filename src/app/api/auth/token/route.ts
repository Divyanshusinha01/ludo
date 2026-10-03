import { NextResponse, type NextRequest } from "next/server";
import * as backend from "@/lib/server/authBackend";
import {
  clearSessionCookie,
  errorResponse,
  guarded,
  isSameOriginGet,
  readSessionCookie,
  setLastUsernameCookie,
  setSessionCookie,
} from "@/lib/server/authHttp";
import { signAccessToken } from "@/lib/server/jwt";

/**
 * Exchanges the httpOnly session cookie for a short-lived Convex JWT that the
 * page keeps in memory only. Each call slides the session and re-issues the
 * cookie, so a regularly used device stays signed in.
 */
export async function GET(request: NextRequest) {
  if (!isSameOriginGet(request)) return errorResponse("forbidden");
  const token = readSessionCookie(request);
  if (!token) return errorResponse("unauthorized");

  return guarded(async () => {
    const session = await backend.refreshSession(token);
    if (!session.ok) {
      const res = errorResponse("unauthorized");
      clearSessionCookie(res);
      return res;
    }
    const access = await signAccessToken(session.accountId, session.sessionId);
    const res = NextResponse.json({
      ok: true,
      token: access.token,
      expiresAt: access.expiresAt,
      profile: { username: session.username, displayName: session.displayName },
    });
    res.headers.set("Cache-Control", "no-store");
    setSessionCookie(res, token, session.expiresAt);
    setLastUsernameCookie(res, session.username);
    return res;
  });
}
