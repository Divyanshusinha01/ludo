import type { NextRequest } from "next/server";
import * as backend from "@/lib/server/authBackend";
import {
  errorResponse,
  getClientIp,
  guarded,
  hashIp,
  isSameOriginPost,
  readJsonBody,
  serverSecret,
  sessionSuccess,
  stringField,
} from "@/lib/server/authHttp";

/** Creates the account and signs the device in with the same response. */
export async function POST(request: NextRequest) {
  if (!isSameOriginPost(request)) return errorResponse("forbidden");
  const body = await readJsonBody(request);
  const username = body && stringField(body, "username");
  const password = body && stringField(body, "password");
  if (!body || username === null || password === null) return errorResponse("badRequest");
  const displayName = stringField(body, "displayName") ?? undefined;

  return guarded(async () => {
    const ipHash = await hashIp(getClientIp(request.headers), serverSecret());
    const result = await backend.signUp({
      ipHash,
      username,
      password,
      ...(displayName !== undefined ? { displayName } : {}),
    });
    if (!result.ok) return errorResponse(result.error, result.retryAfterMs);
    return sessionSuccess(result);
  });
}
