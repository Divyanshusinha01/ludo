// Room lifecycle and turn driving for one virtual user that controls every seat.
import { sleep } from "k6";
import { CONFIG } from "../config.js";
import { mutation, outcomeForCode, query } from "./convex.js";

/** Server-side ACTION_MIN_INTERVAL_MS is 100; keep a margin for clock jitter. */
const ACTION_GAP_MS = 120;
/** Browser cadence (OPS_FLUSH_MS in src/lib/opsReporter.ts); server minimum is 5000. */
const REPORT_GAP_MS = 15000;
/** Server-side MAX_METRICS_BATCH. */
const MAX_REPORT_BATCH = 50;

const KIND_BY_PATH = {
  "rooms:createRoom": "create",
  "rooms:joinRoom": "join",
  "rooms:startGame": "start",
  "rooms:heartbeat": "heartbeat",
  "game:rollDice": "roll",
  "game:moveToken": "move",
};

export function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function newSeat(index) {
  return {
    clientId: uuid(),
    name: `Load${index}`,
    color: null,
    lastActionAt: 0,
    lastHeartbeatAt: 0,
    lastReportAt: 0,
    reports: [],
  };
}

/** Queue a client-observed outcome for ops.reportClientEvents. */
export function recordClientEvent(seat, kind, result, outcomeOverride) {
  if (!CONFIG.reportClientMetrics) return;
  const outcome = outcomeOverride || (result.ok ? "ok" : outcomeForCode(result.code));
  const event = { kind, outcome };
  if (result.latencyMs !== undefined) event.latencyMs = Math.round(result.latencyMs);
  if (outcome === "rejected" || outcome === "error") {
    event.code = result.code;
    event.message = result.message.slice(0, 200);
  }
  seat.reports.push(event);
  // Keep a recent sample per flush window rather than an unbounded backlog.
  if (seat.reports.length > MAX_REPORT_BATCH) seat.reports.shift();
}

function seatMutation(seat, path, args, expected = []) {
  const result = mutation(path, args, expected);
  const kind = KIND_BY_PATH[path];
  if (kind) recordClientEvent(seat, kind, result);
  return result;
}

export function flushReports(room, force = false) {
  if (!CONFIG.reportClientMetrics) return;
  const now = Date.now();
  for (const seat of room.seats) {
    if (seat.reports.length === 0) continue;
    if (!force && now - seat.lastReportAt < REPORT_GAP_MS) continue;
    if (force && now - seat.lastReportAt < REPORT_GAP_MS) {
      sleep((REPORT_GAP_MS - (now - seat.lastReportAt)) / 1000);
    }
    const events = seat.reports.splice(0, MAX_REPORT_BATCH);
    seat.lastReportAt = Date.now();
    mutation("ops:reportClientEvents", {
      roomId: room.roomId,
      clientId: seat.clientId,
      events,
    });
  }
}

/** Create a room, seat every player, start the match. Null on failure. */
export function setupRoom() {
  const seats = [];
  for (let i = 0; i < CONFIG.playersPerRoom; i++) seats.push(newSeat(i));
  const host = seats[0];

  const created = seatMutation(host, "rooms:createRoom", {
    clientId: host.clientId,
    name: host.name,
  });
  if (!created.ok) return null;
  const { roomId, code } = created.value;
  host.color = created.value.color;
  const room = { roomId, code, seats, byColor: { [host.color]: host }, actions: 0 };

  for (const seat of seats.slice(1)) {
    const joined = seatMutation(seat, "rooms:joinRoom", {
      code,
      clientId: seat.clientId,
      name: seat.name,
    });
    if (!joined.ok || !joined.value.color) return null;
    seat.color = joined.value.color;
    room.byColor[seat.color] = seat;
  }

  const started = seatMutation(host, "rooms:startGame", {
    roomId,
    clientId: host.clientId,
  });
  if (!started.ok) return null;
  const now = Date.now();
  for (const seat of seats) seat.lastHeartbeatAt = now;
  return room;
}

export function getView(room, seat = room.seats[0]) {
  const res = query("rooms:getRoom", { roomId: room.roomId, clientId: seat.clientId });
  return res.ok ? res.value : null;
}

export function heartbeat(room, seat) {
  const res = seatMutation(seat, "rooms:heartbeat", {
    roomId: room.roomId,
    clientId: seat.clientId,
  });
  // The server spaces heartbeats by its own processing time, which can be
  // anywhere up to the response, so measure the gap from the response.
  seat.lastHeartbeatAt = Date.now();
  return res;
}

export function heartbeatDue(room) {
  const now = Date.now();
  for (const seat of room.seats) {
    if (now - seat.lastHeartbeatAt >= CONFIG.heartbeatMs) heartbeat(room, seat);
  }
}

function waitActionGap(seat) {
  const wait = ACTION_GAP_MS - (Date.now() - seat.lastActionAt);
  if (wait > 0) sleep(wait / 1000);
}

export function roll(room, seat, view, expected = []) {
  waitActionGap(seat);
  const res = seatMutation(
    seat,
    "game:rollDice",
    {
      roomId: room.roomId,
      clientId: seat.clientId,
      turnId: view.room.turnId,
      expectedSeq: view.room.eventSeq,
    },
    expected,
  );
  seat.lastActionAt = Date.now();
  return res;
}

export function move(room, seat, view, choice, expected = []) {
  waitActionGap(seat);
  const res = seatMutation(
    seat,
    "game:moveToken",
    {
      roomId: room.roomId,
      clientId: seat.clientId,
      tokenIndex: choice.index,
      tokenColor: choice.color,
      turnId: view.room.turnId,
      expectedSeq: view.room.eventSeq,
    },
    expected,
  );
  seat.lastActionAt = Date.now();
  return res;
}

/**
 * Read the authoritative view and take the next legal action for whoever is
 * on turn. Returns "finished", "acted", "idle" or "error".
 */
export function playStep(room) {
  heartbeatDue(room);
  flushReports(room);
  const view = getView(room);
  if (!view) return "error";
  if (view.room.status === "finished") return "finished";
  const seat = room.byColor[view.room.currentTurn];
  if (!seat) return "error";

  if (!view.room.diceRolled) {
    room.actions++;
    return roll(room, seat, view).ok ? "acted" : "error";
  }

  const legal = query("game:getLegalTokenIndexes", {
    roomId: room.roomId,
    clientId: seat.clientId,
  });
  if (!legal.ok) return "error";
  if (legal.value.length === 0) return "idle";
  const choice = legal.value[Math.floor(Math.random() * legal.value.length)];
  room.actions++;
  return move(room, seat, view, choice).ok ? "acted" : "error";
}

export function think() {
  if (CONFIG.thinkMs > 0) sleep(CONFIG.thinkMs / 1000);
}
