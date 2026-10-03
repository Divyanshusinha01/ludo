import type { NextRequest } from "next/server";
import * as backend from "@/lib/server/authBackend";
import {
  clearSessionCookie,
  errorResponse,
  getClientIp,
  guarded,
  hashIp,
  isSameOriginPost,
  readJsonBody,
  readSessionCookie,
  serverSecret,
  sessionSuccess,
  stringField,
} from "@/lib/server/authHttp";

/** Signs out every other device; this device gets a fresh session cookie. */
export async function POST(request: NextRequest) {
  if (!isSameOriginPost(request)) return errorResponse("forbidden");
  const token = readSessionCookie(request);
  if (!token) return errorResponse("unauthorized");
  const body = await readJsonBody(request);
  const currentPassword = body && stringField(body, "currentPassword");
  const newPassword = body && stringField(body, "newPassword");
  if (!body || currentPassword === null || newPassword === null) {
    return errorResponse("badRequest");
  }

  return guarded(async () => {
    const ipHash = await hashIp(getClientIp(request.headers), serverSecret());
    const result = await backend.changePassword({
      ipHash,
      sessionToken: token,
      currentPassword,
      newPassword,
    });
    if (!result.ok) {
      const res = errorResponse(result.error, result.retryAfterMs);
      if (result.error === "unauthorized") clearSessionCookie(res);
      return res;
    }
    return sessionSuccess(result);
  });
}
