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

export async function POST(request: NextRequest) {
  if (!isSameOriginPost(request)) return errorResponse("forbidden");
  const body = await readJsonBody(request);
  const username = body && stringField(body, "username");
  const password = body && stringField(body, "password");
  if (!body || username === null || password === null) return errorResponse("badRequest");

  return guarded(async () => {
    const ipHash = await hashIp(getClientIp(request.headers), serverSecret());
    const result = await backend.logIn({ ipHash, username, password });
    if (!result.ok) return errorResponse(result.error, result.retryAfterMs);
    return sessionSuccess(result);
  });
}
