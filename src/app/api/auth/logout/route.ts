import { NextResponse, type NextRequest } from "next/server";
import * as backend from "@/lib/server/authBackend";
import {
  clearSessionCookie,
  errorResponse,
  isSameOriginPost,
  readSessionCookie,
} from "@/lib/server/authHttp";

export async function POST(request: NextRequest) {
  if (!isSameOriginPost(request)) return errorResponse("forbidden");
  const token = readSessionCookie(request);
  if (token) {
    try {
      await backend.logOut(token);
    } catch {
      // The cookie is cleared regardless; the row expires or is purged later.
    }
  }
  const res = NextResponse.json({ ok: true });
  res.headers.set("Cache-Control", "no-store");
  clearSessionCookie(res);
  return res;
}
