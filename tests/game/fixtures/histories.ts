import type { LudoEvent } from "../../../convex/lib/game";
import type { Color, GameMode } from "../../../convex/lib/ludo";
import { simulateGame, type SimResult } from "../support/simulate";
import { seededDice } from "./dice";
import { ev, seatSnapshot, seqify, startBodies } from "./events";

/** Created room with host + one guest, still in the lobby. */
export function lobbyHistory(): LudoEvent[] {
  return seqify([
    ev.gameCreated(),
    ev.playerJoined(seatSnapshot("red")),
    ev.playerJoined(seatSnapshot("yellow")),
  ]);
}

export function startedHistory(
  colors: Color[] = ["red", "yellow"],
  mode: GameMode = "1v1",
): LudoEvent[] {
  return seqify(startBodies(colors, mode));
}

export const started1v1 = () => startedHistory(["red", "yellow"]);
export const started4p = () =>
  startedHistory(["red", "green", "yellow", "blue"]);
export const started3p = () => startedHistory(["red", "green", "yellow"]);
export const started2v2 = () =>
  startedHistory(["red", "green", "yellow", "blue"], "2v2");

/** Short hand-scripted opening: red releases a token with a 6, rolls again, moves 3. */
export function scriptedOpening1v1(): LudoEvent[] {
  return seqify([
    ...startBodies(["red", "yellow"]),
    ev.diceRolled("red", 6),
    ev.tokenMoved("red", "red", 0),
    ev.extraTurn("red", "six"),
    ev.diceRolled("red", 3),
    ev.tokenMoved("red", "red", 0),
    ev.turnEnded("moved"),
    ev.turnStarted("yellow"),
    ev.diceRolled("yellow", 2),
    ev.turnEnded("no_moves"),
    ev.turnStarted("red"),
  ]);
}

const cache = new Map<string, SimResult>();

/** Complete game played through `decide` with seeded dice (memoised). */
export function finishedGame(
  seed: number,
  colors: Color[] = ["red", "yellow"],
  mode: GameMode = "1v1",
): SimResult {
  const key = `${seed}:${colors.join(",")}:${mode}`;
  let sim = cache.get(key);
  if (!sim) {
    sim = simulateGame({ colors, mode, dice: seededDice(seed), choiceSeed: seed });
    cache.set(key, sim);
  }
  return sim;
}

/**
 * A seeded game cut at the last transaction boundary at or before `n` events —
 * a realistic mid-game history that replays cleanly.
 */
export function midGame(seed: number, n = 120): LudoEvent[] {
  const sim = finishedGame(seed);
  const cut = Math.max(...[...sim.boundaries].filter((b) => b <= n));
  return sim.events.slice(0, cut);
}
