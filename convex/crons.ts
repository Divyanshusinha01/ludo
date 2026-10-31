import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Background work is event-driven: presence sweeps are armed by in-play commits
// (lib/jobs.ts) and matchmaking polls only while someone is queued. These crons
// are slow safety nets and housekeeping, so an idle deployment stays near zero.
crons.interval("room and session housekeeping", { minutes: 15 }, internal.cleanup.tick);

crons.interval("matchmaking safety net", { minutes: 5 }, internal.matchmaking.sweep, {});

crons.interval("ops metrics rollup", { minutes: 5 }, internal.ops.rollup, {});

export default crons;
