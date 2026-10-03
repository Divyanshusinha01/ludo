// Reconnect storm: every seat drops, fires a mutation from its outdated view
// (must be rejected as stale), resyncs, heartbeats back in, and the room then
// continues with a successful action at the fresh eventSeq.
import { check, sleep } from "k6";
import exec from "k6/execution";
import { Gauge, Rate } from "k6/metrics";
import { baseThresholds, CONFIG, SUMMARY_TREND_STATS } from "./config.js";
import { mutation, query } from "./lib/convex.js";
import {
  flushReports,
  getView,
  heartbeat,
  move,
  playStep,
  recordClientEvent,
  roll,
  setupRoom,
  think,
} from "./lib/room.js";
import { makeSummary } from "./lib/summary.js";

const activeRooms = new Gauge("active_rooms");
const activePlayers = new Gauge("active_players");
const reconnectSuccess = new Rate("reconnect_success");

/** Server-side HEARTBEAT_MIN_INTERVAL_MS is 5000; earlier heartbeats are ignored. */
const HEARTBEAT_GAP_MS = 5100;
/** Steps allowed for the turn to move on so the old view is really outdated. */
const MAX_ADVANCE_STEPS = 60;

export const options = {
  scenarios: {
    reconnect: {
      executor: "constant-vus",
      vus: CONFIG.rooms,
      duration: CONFIG.duration,
      gracefulStop: "30s",
    },
  },
  thresholds: {
    ...baseThresholds(),
    reconnect_success: [`rate>=${CONFIG.minReconnectSuccess}`],
  },
  summaryTrendStats: SUMMARY_TREND_STATS,
};

/** Play until the turn has moved past `oldView`. False if the match ended. */
function advancePast(room, oldView) {
  for (let i = 0; i < MAX_ADVANCE_STEPS; i++) {
    const outcome = playStep(room);
    if (outcome === "finished") return false;
    think();
    const view = getView(room);
    if (!view || view.room.status !== "playing") return false;
    if (view.room.turnId !== oldView.room.turnId) return view;
  }
  return false;
}

function freshAction(room, view) {
  const seat = room.byColor[view.room.currentTurn];
  if (!seat) return false;
  if (!view.room.diceRolled) return roll(room, seat, view).ok;
  const legal = query("game:getLegalTokenIndexes", {
    roomId: room.roomId,
    clientId: seat.clientId,
  });
  if (!legal.ok || legal.value.length === 0) return legal.ok;
  return move(room, seat, view, legal.value[0]).ok;
}

function storm(room) {
  const oldView = getView(room);
  if (!oldView || oldView.room.status !== "playing") return false;
  const headView = advancePast(room, oldView);
  if (!headView) return false;
  const headSeq = headView.room.eventSeq;

  const status = new Map();
  for (const seat of room.seats) {
    const startedAt = Date.now();
    mutation("rooms:markDisconnected", { roomId: room.roomId, clientId: seat.clientId });

    const stale = roll(room, seat, oldView, ["stale"]);
    const staleRejected = !stale.ok && stale.code === "stale";
    check(stale, { "outdated view rejected as stale": () => staleRejected });

    const resync = query("rooms:getRoom", { roomId: room.roomId, clientId: seat.clientId });
    const caughtUp =
      resync.ok &&
      resync.value !== null &&
      resync.value.room.eventSeq >= headSeq &&
      resync.value.me !== null &&
      resync.value.me.color === seat.color;
    check(resync, { "resync reaches the authoritative head": () => caughtUp });
    if (resync.ok) recordClientEvent(seat, "resync", resync);

    status.set(seat, { startedAt, ok: staleRejected && caughtUp });
  }

  const newest = Math.max(...room.seats.map((s) => s.lastHeartbeatAt));
  const wait = HEARTBEAT_GAP_MS - (Date.now() - newest);
  if (wait > 0) sleep(wait / 1000);
  for (const seat of room.seats) heartbeat(room, seat);

  const after = getView(room);
  const fresh = after !== null && after.room.status === "playing" && freshAction(room, after);
  check(fresh, { "action at fresh eventSeq succeeds": (ok) => ok === true });

  for (const seat of room.seats) {
    const s = status.get(seat);
    const player = after && after.players.find((p) => p.color === seat.color);
    const connected = !!player && player.connected;
    check(connected, { "seat connected after heartbeat": (c) => c });
    const ok = s.ok && connected && fresh;
    reconnectSuccess.add(ok);
    recordClientEvent(
      seat,
      "reconnect",
      { ok, latencyMs: Date.now() - s.startedAt, code: ok ? null : "internal", message: "reconnect failed" },
      ok ? "ok" : "error",
    );
  }
  return true;
}

export default function reconnectStorm() {
  const room = setupRoom();
  if (!room) {
    think();
    return;
  }
  activeRooms.add(exec.instance.vusActive);
  activePlayers.add(exec.instance.vusActive * CONFIG.playersPerRoom);

  for (let i = 0; i < CONFIG.storms; i++) {
    if (!storm(room)) break;
  }
  flushReports(room, true);
}

export const handleSummary = makeSummary("reconnect", ["reconnect_success", "checks"]);
