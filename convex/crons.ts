import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "presence and room cleanup",
  { seconds: 30 },
  internal.cleanup.tick,
);

crons.interval("ops metrics rollup", { minutes: 1 }, internal.ops.rollup, {});

export default crons;
