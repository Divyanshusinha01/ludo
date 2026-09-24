import {
  canRelease,
  createInitialTokens,
  decideRollOutcome,
  findCaptureTarget,
  gainsExtraTurn,
  getLegalMoves,
  hasWon,
  isBarrierAbsolute,
  nextColorAmong,
  stackFanOffset,
  tryMoveSteps,
  absoluteTrackPosition,
} from "../convex/lib/ludo";
import { assertValidClientId } from "../convex/lib/session";
import { normalizeCode } from "../src/lib/player";
import {
  tokenStackKey,
  tokenSvgPosition,
} from "../src/lib/boardGeometry";

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
  assert(tryMoveSteps(54, 2) === 56, "exact finish from 54");

  const tokens = createInitialTokens();
  assert(tokens.length === 16, "16 tokens");
  assert(getLegalMoves(tokens, "red", 5).length === 0, "no moves without 6");
  assert(
    getLegalMoves(tokens, "red", 6).length === 4,
    "all yard tokens can leave on 6",
  );

  const two = createInitialTokens(["red", "blue"]);
  assert(two.length === 8, "2-colour game has 8 tokens");
  assert(nextColorAmong("red", ["red", "blue"]) === "blue", "2p turn order");
  assert(nextColorAmong("blue", ["red", "blue"]) === "red", "2p wraps");

  // Capture on non-safe cell
  tokens[0]!.steps = 5; // red at abs 5
  const green = tokens.find((t) => t.color === "green" && t.index === 0)!;
  green.steps = 44; // abs 5
  const cap = findCaptureTarget(tokens, "red", 5);
  assert(cap?.color === "green", "captures green on overlapping cell");

  // Safe cell no capture
  tokens[0]!.steps = 0;
  green.steps = 39;
  assert(findCaptureTarget(tokens, "red", 0) === null, "no capture on safe");

  // Barrier: two greens stacked — uncapturable and blocks landing
  const barrierTokens = createInitialTokens();
  const g0 = barrierTokens.find((t) => t.color === "green" && t.index === 0)!;
  const g1 = barrierTokens.find((t) => t.color === "green" && t.index === 1)!;
  // Place both greens at abs 5 → steps such that (13+s)%52 = 5 → s = 44
  g0.steps = 44;
  g1.steps = 44;
  const abs5 = absoluteTrackPosition("green", 44);
  assert(abs5 === 5, "green steps 44 → abs 5");
  assert(isBarrierAbsolute(barrierTokens, 5, "red"), "2 greens form barrier");
  assert(
    findCaptureTarget(barrierTokens, "red", 5) === null,
    "cannot capture barrier",
  );
  const red0 = barrierTokens.find((t) => t.color === "red" && t.index === 0)!;
  red0.steps = 0; // at start; dice 5 lands at steps 5 = abs 5
  assert(
    !getLegalMoves(barrierTokens, "red", 5).includes(0),
    "cannot land on barrier",
  );

  // Path-through barrier is allowed: landing check only at destination
  red0.steps = 3; // dice 3 would land at 6, past abs 5 barrier
  assert(
    getLegalMoves(barrierTokens, "red", 3).includes(0),
    "can pass over barrier cell mid-path",
  );

  // Extra-turn scenarios are mutation-level; capture target still works alone
  const lone = createInitialTokens();
  lone[0]!.steps = 5;
  const loneGreen = lone.find((t) => t.color === "green" && t.index === 0)!;
  loneGreen.steps = 44;
  assert(findCaptureTarget(lone, "red", 5)?.color === "green", "lone capture");

  // Win
  const winners = createInitialTokens().map((t) =>
    t.color === "blue" ? { ...t, steps: 56 } : t,
  );
  assert(hasWon(winners, "blue"), "blue wins");
  assert(!hasWon(winners, "red"), "red not won");

  // Roll decision tree (mutation policy)
  assert(
    decideRollOutcome(6, 2, 4).kind === "three_sixes",
    "third 6 skips",
  );
  assert(
    decideRollOutcome(6, 1, 0).kind === "no_moves_six",
    "6 with no moves rolls again",
  );
  assert(
    decideRollOutcome(4, 0, 0).kind === "no_moves",
    "non-6 with no moves ends turn",
  );
  assert(decideRollOutcome(5, 0, 2).kind === "ok", "normal roll ok");
  assert(gainsExtraTurn(6, false), "6 gains extra turn");
  assert(gainsExtraTurn(3, true), "capture gains extra turn");
  assert(!gainsExtraTurn(3, false), "plain move no extra");

  // Session validation
  assertValidClientId("550e8400-e29b-41d4-a716-446655440000");
  let threw = false;
  try {
    assertValidClientId("not-a-uuid");
  } catch {
    threw = true;
  }
  assert(threw, "rejects bad clientId");

  // Code normalize + stack fan-out
  assert(normalizeCode("ab-12!") === "AB12", "normalize code");
  assert(stackFanOffset(0, 1).x === 0, "single stack no offset");
  assert(stackFanOffset(0, 2).x !== 0 || stackFanOffset(0, 2).y !== 0, "pair fans");

  const a = { color: "red" as const, index: 0, steps: 5 };
  const b = { color: "blue" as const, index: 0, steps: 18 }; // abs 5 for blue? start 39+18=57%52=5
  assert(
    tokenStackKey(a.color, a.index, a.steps) ===
      tokenStackKey(b.color, b.index, b.steps),
    "same track cell shares stack key",
  );
  const posA = tokenSvgPosition("red", 0, 5, 0, 2);
  const posB = tokenSvgPosition("blue", 0, 18, 1, 2);
  assert(posA.x !== posB.x || posA.y !== posB.y, "stacked tokens fan apart");

  console.log("All ludo logic tests passed.");
}

run();
