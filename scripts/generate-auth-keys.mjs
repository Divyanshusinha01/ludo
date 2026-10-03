#!/usr/bin/env node
/**
 * Generates the auth secrets. Prints env assignments; nothing is written to disk.
 *
 *   node scripts/generate-auth-keys.mjs
 *
 * Next.js (.env.local / Vercel): AUTH_JWT_PRIVATE_KEY, AUTH_SERVER_SECRET
 * Convex (npx convex env set):   AUTH_JWKS, AUTH_SERVER_SECRET (same value)
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";

const KEY_ID = "ludo-auth-1";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateJwk = { ...privateKey.export({ format: "jwk" }), alg: "RS256", kid: KEY_ID };
const publicJwk = { ...publicKey.export({ format: "jwk" }), alg: "RS256", kid: KEY_ID, use: "sig" };
const jwks = JSON.stringify({ keys: [publicJwk] });
const jwksDataUri = `data:text/plain;charset=utf-8;base64,${Buffer.from(jwks).toString("base64")}`;
const serverSecret = randomBytes(32).toString("base64url");

console.log("# --- Next.js env (.env.local and Vercel) ---");
console.log(`AUTH_JWT_PRIVATE_KEY='${JSON.stringify(privateJwk)}'`);
console.log(`AUTH_SERVER_SECRET=${serverSecret}`);
console.log("");
console.log("# --- Convex env ---");
console.log(`npx convex env set AUTH_JWKS '${jwksDataUri}'`);
console.log(`npx convex env set AUTH_SERVER_SECRET ${serverSecret}`);
