// Load-test configuration. Every knob comes from an environment variable
// (`k6 run -e ROOMS=25 ...`) so the same scripts serve smoke and step-up runs.

function env(name, fallback) {
  const raw = __ENV[name];
  return raw === undefined || raw === "" ? fallback : raw;
}

function int(name, fallback) {
  const n = parseInt(env(name, String(fallback)), 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer`);
  return n;
}

function num(name, fallback) {
  const n = parseFloat(env(name, String(fallback)));
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

export const CONFIG = {
  /** Local `npx convex dev --local` backend by default. */
  convexUrl: env("CONVEX_URL", "http://127.0.0.1:3210").replace(/\/+$/, ""),
  /** One virtual user per room. */
  rooms: int("ROOMS", 5),
  playersPerRoom: Math.min(4, Math.max(2, int("PLAYERS_PER_ROOM", 4))),
  duration: env("DURATION", "2m"),
  /** Gameplay actions per room before it is abandoned and a new room starts. */
  maxActions: int("MAX_ACTIONS", 600),
  /** Pause between a room's actions; 0 hammers the backend as fast as it answers. */
  thinkMs: int("THINK_MS", 250),
  /** Per-seat heartbeat cadence (server ignores < 5s, marks away after 45s). */
  heartbeatMs: int("HEARTBEAT_MS", 15000),
  /** Reconnect storms per room in reconnect.js. */
  storms: int("STORMS", 3),
  /** Feed client latencies into ops.reportClientEvents like the browser does. */
  reportClientMetrics: env("REPORT_CLIENT_METRICS", "1") !== "0",
  p95Ms: num("P95_MS", 500),
  p99Ms: num("P99_MS", 1000),
  maxErrorRate: num("MAX_ERROR_RATE", 0.01),
  minReconnectSuccess: num("MIN_RECONNECT_SUCCESS", 0.99),
  /** Free-form label stored in the summary (e.g. machine name). */
  label: env("LABEL", ""),
};

export const SUMMARY_TREND_STATS = ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"];

export function baseThresholds() {
  return {
    mutation_latency: [`p(95)<${CONFIG.p95Ms}`, `p(99)<${CONFIG.p99Ms}`],
    errors: [`rate<${CONFIG.maxErrorRate}`],
  };
}
