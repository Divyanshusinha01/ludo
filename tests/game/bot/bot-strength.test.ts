import { describe, expect, it } from "vitest";
import { pickBotMove } from "../../../convex/lib/bot";
import type { GameCommand, GameState } from "../../../convex/lib/game";
import type { Color } from "../../../convex/lib/ludo";
import { mulberry32, seededDice } from "../fixtures/dice";
import { applyCommand, legalChoices, nextCommand, simulateGame } from "../support/simulate";

const GAMES = 200;
/** Measured 171/200 (85.5%) on 2026-10-11; the floor catches heuristic regressions. */
const MIN_WIN_RATE = 0.75;
const COLORS: Color[] = ["red", "yellow"];

/** The bot's heuristic pick when it is the mover, otherwise a uniformly random legal command. */
function commandFor(state: GameState, bot: Color, dice: () => number, rng: () => number): GameCommand {
  const random = nextCommand(state, dice, rng);
  if (random.type !== "MoveToken" || random.actorColor !== bot) return random;
  const legal = legalChoices(state);
  const preferred = pickBotMove(state.tokens, bot, state.diceValue!);
  const pick = legal.find((m) => m.color === bot && m.index === preferred) ?? legal[0]!;
  return { type: "MoveToken", actorColor: bot, tokenColor: pick.color, tokenIndex: pick.index };
}

function playBotVsRandom(seed: number, bot: Color): Color {
  const start = simulateGame({ colors: COLORS, dice: seededDice(seed), maxEvents: 0 });
  const dice = seededDice(seed);
  const rng = mulberry32(seed ^ 0x9e3779b9);
  let state = start.final;
  const events = [...start.events];
  while (state.phase === "playing") {
    if (events.length > 20_000) throw new Error(`seed ${seed} did not finish`);
    const step = applyCommand(state, events, commandFor(state, bot, dice, rng));
    events.push(...step.added);
    state = step.state;
  }
  if (!state.winner) throw new Error(`seed ${seed} finished without a winner`);
  return state.winner;
}

describe("bot strength (seeded, bot vs random-legal opponent)", () => {
  it(`wins at least ${MIN_WIN_RATE * 100}% of ${GAMES} 1v1 games, alternating seats`, () => {
    let botWins = 0;
    for (let seed = 1; seed <= GAMES; seed++) {
      // Alternate seats so first-move advantage cancels out.
      const bot = COLORS[seed % 2]!;
      if (playBotVsRandom(seed, bot) === bot) botWins++;
    }
    const winRate = botWins / GAMES;
    console.info(`bot win rate vs random-legal: ${botWins}/${GAMES} (${(winRate * 100).toFixed(1)}%)`);
    expect(winRate).toBeGreaterThanOrEqual(MIN_WIN_RATE);
  });

  it("is deterministic for a fixed seed", () => {
    expect(playBotVsRandom(42, "red")).toBe(playBotVsRandom(42, "red"));
  });
});
