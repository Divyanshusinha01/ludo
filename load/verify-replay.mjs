// After a load run: replay the event log of the newest rooms and compare it
// with their live state via internal gameEvents:verifyReplay.
// Usage: node load/verify-replay.mjs [sampleSize]
// Env: DEPLOYMENT (default local), POOL = rooms to sample from (default 200),
// ORDER = desc (newest, default) | asc (oldest).
// With CONVEX_AGENT_MODE=anonymous and no DEPLOYMENT, the CLI's own local
// deployment is used (it rejects `--deployment local` in that mode).
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const sample = Number(process.argv[2] ?? process.env.SAMPLE ?? 20);
const anonymous = process.env.CONVEX_AGENT_MODE === "anonymous";
const deployment = process.env.DEPLOYMENT ?? (anonymous ? null : "local");
const deploymentArgs = deployment ? ["--deployment", deployment] : [];
// Run the CLI through node directly: a Windows shell would strip JSON quotes.
const cli = fileURLToPath(new URL("../node_modules/convex/bin/main.js", import.meta.url));

function convex(args) {
  try {
    return execFileSync(process.execPath, [cli, ...args, ...deploymentArgs], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    // Node 24 on Windows can abort the CLI during exit, after it has printed
    // its full result (libuv assertion). Any other failure is real.
    if (/UV_HANDLE_CLOSING/.test(String(err.stderr)) && err.stdout) return err.stdout;
    throw err;
  }
}

const pool = Number(process.env.POOL ?? 200);

const order = process.env.ORDER === "asc" ? "asc" : "desc";

const recent = convex(["data", "rooms", "--limit", String(pool), "--order", order, "--format", "jsonLines"])
  .split(/\r?\n/)
  .filter((l) => l.trim().startsWith("{"))
  .map((l) => JSON.parse(l))
  .filter((r) => r.eventSeq !== undefined);
// Spread the sample over the pool so older runs (long gameplay logs) are covered too.
const step = Math.max(1, recent.length / sample);
const rooms = [];
for (let i = 0; i < recent.length && rooms.length < sample; i += step) {
  rooms.push(recent[Math.floor(i)]);
}

let failed = 0;
for (const room of rooms) {
  const out = convex(["run", "gameEvents:verifyReplay", JSON.stringify({ roomId: room._id })]);
  const result = JSON.parse(out.slice(out.indexOf("{")));
  if (!result.ok) failed++;
  console.log(
    `${room.code} status=${room.status} head=${result.headSeq} ${result.ok ? "ok" : `DIFF ${result.diffs.join("; ")}`}`,
  );
}
console.log(`verifyReplay: ${rooms.length - failed}/${rooms.length} rooms ok`);
process.exit(failed > 0 || rooms.length === 0 ? 1 : 0);
