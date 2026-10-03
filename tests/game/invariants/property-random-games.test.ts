import { describe, expect, it } from "vitest";
import {
  canonicalGameState,
  createEmptyState,
  replayGame,
  replayWithTrace,
} from "../../../convex/lib/game";
import type { Color, GameMode } from "../../../convex/lib/ludo";
import { seededDice } from "../fixtures/dice";
import { assertHistoryInvariants } from "../support/invariants";
import { simulateGame, type SimOptions } from "../support/simulate";

type Config = {
  label: string;
  colors: Color[];
  mode: GameMode;
  timeoutRate?: number;
  forfeitRate?: number;
};

const CONFIGS: Config[] = [
  { label: "1v1", colors: ["red", "yellow"], mode: "1v1" },
  { label: "3p", colors: ["red", "green", "yellow"], mode: "1v1" },
  { label: "4p", colors: ["red", "green", "yellow", "blue"], mode: "1v1" },
  { label: "2v2", colors: ["red", "green", "yellow", "blue"], mode: "2v2" },
  { label: "4p timeouts+forfeits", colors: ["red", "green", "yellow", "blue"], mode: "1v1", timeoutRate: 0.04, forfeitRate: 0.005 },
  { label: "2v2 timeouts+forfeits", colors: ["red", "green", "yellow", "blue"], mode: "2v2", timeoutRate: 0.04, forfeitRate: 0.005 },
];

const SEEDS_PER_CONFIG = 40;
const BASE_SEED = 1000;

function runSeed(config: Config, seed: number) {
  const opts: SimOptions = {
    colors: config.colors,
    mode: config.mode,
    dice: seededDice(seed),
    choiceSeed: seed * 7919,
    timeoutRate: config.timeoutRate,
    forfeitRate: config.forfeitRate,
  };
  const sim = simulateGame(opts);
  expect(sim.final.phase, "game should finish").toBe("finished");

  assertHistoryInvariants(sim.events, sim.states, sim.boundaries);

  const trace = replayWithTrace(createEmptyState(), sim.events);
  expect(trace.error).toBeUndefined();
  expect(trace.states).toEqual(sim.states);

  const { state } = replayGame(createEmptyState(), sim.events);
  expect(canonicalGameState(state)).toEqual(canonicalGameState(sim.final));
  return sim;
}

describe.each(CONFIGS)("seeded random games: $label", (config) => {
  const seeds = Array.from({ length: SEEDS_PER_CONFIG }, (_, i) => BASE_SEED + i);

  it(`${SEEDS_PER_CONFIG} games: invariants after every event, replay equals step-by-step build-up`, () => {
    let events = 0;
    for (const seed of seeds) {
      try {
        events += runSeed(config, seed).events.length;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(
          `${config.label} failed at seed ${seed} ` +
            `(reproduce: simulateGame({ colors: ${JSON.stringify(config.colors)}, mode: "${config.mode}", ` +
            `dice: seededDice(${seed}), choiceSeed: ${seed * 7919}` +
            (config.timeoutRate ? `, timeoutRate: ${config.timeoutRate}` : "") +
            (config.forfeitRate ? `, forfeitRate: ${config.forfeitRate}` : "") +
            ` })): ${msg}`,
        );
      }
    }
    expect(events).toBeGreaterThan(seeds.length * 50);
  }, 120_000);
});
