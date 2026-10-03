import { ConvexHttpClient } from "convex/browser";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";
import { AuthConfigError, serverSecret } from "./authHttp";

/**
 * Server-to-server calls from the Route Handlers to the secret-gated Convex
 * auth actions. The raw session token only ever travels over this channel and
 * in the httpOnly cookie.
 */

export type SessionResult = FunctionReturnType<typeof api.auth.logIn>;
export type RefreshResult = FunctionReturnType<typeof api.auth.refreshSession>;

let client: ConvexHttpClient | null = null;

function convex(): ConvexHttpClient {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new AuthConfigError("NEXT_PUBLIC_CONVEX_URL is not set");
  client ??= new ConvexHttpClient(url);
  return client;
}

export async function signUp(args: {
  ipHash: string;
  username: string;
  password: string;
  displayName?: string;
}): Promise<SessionResult> {
  return await convex().action(api.auth.signUp, { serverSecret: serverSecret(), ...args });
}

export async function logIn(args: {
  ipHash: string;
  username: string;
  password: string;
}): Promise<SessionResult> {
  return await convex().action(api.auth.logIn, { serverSecret: serverSecret(), ...args });
}

export async function changePassword(args: {
  ipHash: string;
  sessionToken: string;
  currentPassword: string;
  newPassword: string;
}): Promise<SessionResult> {
  return await convex().action(api.auth.changePassword, {
    serverSecret: serverSecret(),
    ...args,
  });
}

export async function logOut(sessionToken: string): Promise<void> {
  await convex().action(api.auth.logOut, { serverSecret: serverSecret(), sessionToken });
}

export async function refreshSession(sessionToken: string): Promise<RefreshResult> {
  return await convex().action(api.auth.refreshSession, {
    serverSecret: serverSecret(),
    sessionToken,
  });
}
