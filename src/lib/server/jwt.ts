import {
  JWT_AUDIENCE,
  JWT_ISSUER,
  JWT_KEY_ID,
  JWT_TTL_SECONDS,
} from "../../../convex/lib/authShared";
import { AuthConfigError } from "./authHttp";

let cachedKey: { raw: string; key: Promise<CryptoKey> } | null = null;

/** AUTH_JWT_PRIVATE_KEY is the RSA private key as a JWK JSON string. */
function signingKey(): Promise<CryptoKey> {
  const raw = process.env.AUTH_JWT_PRIVATE_KEY;
  if (!raw) throw new AuthConfigError("AUTH_JWT_PRIVATE_KEY is not set");
  if (cachedKey?.raw !== raw) {
    let jwk: JsonWebKey;
    try {
      jwk = JSON.parse(raw) as JsonWebKey;
    } catch {
      throw new AuthConfigError("AUTH_JWT_PRIVATE_KEY is not valid JWK JSON");
    }
    cachedKey = {
      raw,
      key: crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"],
      ),
    };
  }
  return cachedKey.key;
}

function base64UrlEncode(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Short-lived RS256 token Convex verifies through `convex/auth.config.ts`. */
export async function signAccessToken(
  accountId: string,
  sessionId: string,
  nowMs: number = Date.now(),
): Promise<{ token: string; expiresAt: number }> {
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + JWT_TTL_SECONDS;
  const header = { alg: "RS256", typ: "JWT", kid: JWT_KEY_ID };
  const payload = {
    iss: JWT_ISSUER,
    aud: JWT_AUDIENCE,
    sub: accountId,
    sid: sessionId,
    iat,
    exp,
  };
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    await signingKey(),
    new TextEncoder().encode(signingInput),
  );
  return {
    token: `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`,
    expiresAt: exp * 1000,
  };
}
