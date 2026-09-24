import {
  canRelease,
  createInitialTokens,
  findCaptureTarget,
  getLegalMoves,
  hasWon,
  tryMoveSteps,
} from "../convex/lib/ludo";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

function run() {
  assert(canRelease(6), "6 releases");
  assert(!canRelease(5), "5 does not release");
  assert(tryMoveSteps(-1, 6) === 0, "release to start");
  assert(tryMoveSteps(-1, 3) === null, "cannot release without 6");
  assert(tryMoveSteps(50, 6) === 56, "exact finish from near end");
  assert(tryMoveSteps(55, 2) === null, "overshoot blocked");

  const tokens = createInitialTokens();
  assert(tokens.length === 16, "16 tokens");
  assert(getLegalMoves(tokens, "red", 5).length === 0, "no moves without 6");
  assert(getLegalMoves(tokens, "red", 6).length === 4, "all yard tokens can leave on 6");

  // Capture on non-safe cell
  tokens[0]!.steps = 5; // red at abs 5
  const green = tokens.find((t) => t.color === "green" && t.index === 0)!;
  // green start 13; steps such that abs = 5 → (13 + s) % 52 = 5 → s = 44
  green.steps = 44;
  const cap = findCaptureTarget(tokens, "red", 5);
  assert(cap?.color === "green", "captures green on overlapping cell");

  // Safe cell no capture
  tokens[0]!.steps = 0; // red start abs 0 — safe
  green.steps = 39; // (13+39)%52 = 0
  assert(findCaptureTarget(tokens, "red", 0) === null, "no capture on safe");

  // Win
  const winners = createInitialTokens().map((t) =>
    t.color === "blue" ? { ...t, steps: 56 } : t,
  );
  assert(hasWon(winners, "blue"), "blue wins");
  assert(!hasWon(winners, "red"), "red not won");

  console.log("All ludo logic tests passed.");
}

run();
