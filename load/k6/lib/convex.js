// Thin wrapper over Convex's public HTTP API (POST /api/mutation|query).
import http from "k6/http";
import { Counter, Rate, Trend } from "k6/metrics";
import { CONFIG } from "../config.js";
import { GameError } from "../../../convex/lib/errors.ts";

export const mutationLatency = new Trend("mutation_latency", true);
export const queryLatency = new Trend("query_latency", true);
export const mutations = new Counter("mutations");
export const errors = new Rate("errors");
export const staleRejections = new Counter("stale_rejections");

// Same stable codes as errorCodeFor in convex/lib/metrics.ts.
const CODE_OVERRIDES = { staleAction: "stale", rateLimited: "rate_limited" };
const KNOWN_ERRORS = Object.keys(GameError).map((key) => ({
  message: GameError[key],
  code: CODE_OVERRIDES[key] || key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
}));

export function errorCodeFor(message) {
  const hit = KNOWN_ERRORS.find((e) => message.includes(e.message));
  return hit ? hit.code : "internal";
}

export function outcomeForCode(code) {
  if (code === "stale") return "stale";
  if (code === "rate_limited") return "rate_limited";
  if (code === "internal") return "error";
  return "rejected";
}

function request(type, path, args, expected) {
  const res = http.post(
    `${CONFIG.convexUrl}/api/${type}`,
    JSON.stringify({ path, args, format: "json" }),
    { headers: { "Content-Type": "application/json" }, tags: { name: path } },
  );
  const latencyMs = res.timings.duration;
  (type === "mutation" ? mutationLatency : queryLatency).add(latencyMs, { fn: path });
  if (type === "mutation") mutations.add(1);

  let body = null;
  try {
    body = res.json();
  } catch {
    body = null;
  }

  let result;
  if (body && body.status === "success") {
    result = { ok: true, value: body.value, code: null, message: "", latencyMs };
  } else {
    const message =
      body && typeof body.errorMessage === "string"
        ? body.errorMessage
        : `HTTP ${res.status}`;
    const code = body ? errorCodeFor(message) : `http_${res.status}`;
    result = { ok: false, value: null, code, message, latencyMs };
    if (code === "stale") staleRejections.add(1);
  }

  const unexpected = !result.ok && !expected.includes(result.code);
  errors.add(unexpected, { fn: path });
  if (unexpected) {
    console.warn(`unexpected ${path} ${result.code}: ${result.message.slice(0, 160)}`);
  }
  return result;
}

/** `expected` lists error codes that are part of the scenario, not errors. */
export function mutation(path, args, expected = []) {
  return request("mutation", path, args, expected);
}

export function query(path, args, expected = []) {
  return request("query", path, args, expected);
}
