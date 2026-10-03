import type { AuthConfig } from "convex/server";
import { JWT_AUDIENCE, JWT_ISSUER } from "./lib/authShared";

/**
 * Short-lived RS256 JWTs minted by GET /api/auth/token. AUTH_JWKS holds the
 * public JWKS (generate with `node scripts/generate-auth-keys.mjs`), either as
 * a `data:` URI or raw JSON, so no network fetch is needed. Convex refuses to
 * push this file while AUTH_JWKS is unset on the deployment; the empty
 * fallback only applies to local tooling such as convex-test.
 */
const rawJwks = process.env.AUTH_JWKS;

function jwksUri(raw: string): string {
  if (raw.startsWith("data:")) return raw;
  return `data:text/plain;charset=utf-8;base64,${btoa(raw)}`;
}

export default {
  providers: rawJwks
    ? [
        {
          type: "customJwt",
          applicationID: JWT_AUDIENCE,
          issuer: JWT_ISSUER,
          jwks: jwksUri(rawJwks),
          algorithm: "RS256",
        },
      ]
    : [],
} satisfies AuthConfig;
