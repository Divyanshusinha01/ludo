// Steady gameplay: one virtual user per room, driving every seat through real
// legal moves until the match ends or MAX_ACTIONS is reached, then a new room.
import exec from "k6/execution";
import { Gauge } from "k6/metrics";
import { baseThresholds, CONFIG, SUMMARY_TREND_STATS } from "./config.js";
import { flushReports, playStep, setupRoom, think } from "./lib/room.js";
import { makeSummary } from "./lib/summary.js";

const activeRooms = new Gauge("active_rooms");
const activePlayers = new Gauge("active_players");

/** Consecutive non-acting steps before a room is treated as stuck. */
const MAX_IDLE_STEPS = 20;

export const options = {
  scenarios: {
    gameplay: {
      executor: "constant-vus",
      vus: CONFIG.rooms,
      duration: CONFIG.duration,
      gracefulStop: "10s",
    },
  },
  thresholds: baseThresholds(),
  summaryTrendStats: SUMMARY_TREND_STATS,
};

export default function gameplay() {
  const room = setupRoom();
  if (!room) {
    think();
    return;
  }
  activeRooms.add(exec.instance.vusActive);
  activePlayers.add(exec.instance.vusActive * CONFIG.playersPerRoom);

  let idle = 0;
  while (room.actions < CONFIG.maxActions && idle < MAX_IDLE_STEPS) {
    const outcome = playStep(room);
    if (outcome === "finished") break;
    idle = outcome === "acted" ? 0 : idle + 1;
    think();
  }
  flushReports(room);
}

export const handleSummary = makeSummary("gameplay");
