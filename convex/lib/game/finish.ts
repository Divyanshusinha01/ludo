import {
  buildFinalRankings,
  Color,
  shouldAssignAutomaticLoser,
  teamAllTokensHome,
  teamIsSpent,
  teamOfColor,
  Team,
  TEAM_COLORS,
  TokenState,
  TeamPlayerLike,
} from "../ludo";
import type { LudoEventDraft } from "./eventValidators";
import type { GameState } from "./state";
import { teamPlayers, updateSeat } from "./state";

export function buildTeamRankings(
  winningTeam: Team,
  winnerColor: Color,
): Color[] {
  const winColors = TEAM_COLORS[winningTeam];
  const loseTeam: Team = winningTeam === "A" ? "B" : "A";
  const rankings: Color[] = [winnerColor];
  for (const c of winColors) {
    if (!rankings.includes(c)) rankings.push(c);
  }
  for (const c of TEAM_COLORS[loseTeam]) {
    rankings.push(c);
  }
  return rankings;
}

export function pickRepresentativeColor(
  players: TeamPlayerLike[],
  team: Team,
  prefer?: Color,
): Color {
  if (prefer && teamOfColor(prefer) === team) return prefer;
  for (const c of TEAM_COLORS[team]) {
    const seat = players.find((p) => p.color === c);
    if (seat && !seat.eliminated) return c;
  }
  return TEAM_COLORS[team][0]!;
}

export function draftTeamHomeWin(
  state: GameState,
  tokens: TokenState[],
  triggeringColor?: Color,
): LudoEventDraft[] | null {
  if (state.mode !== "2v2") return null;
  for (const team of ["A", "B"] as Team[]) {
    if (!teamAllTokensHome(tokens, team)) continue;
    void pickRepresentativeColor(
      teamPlayers(state),
      team,
      triggeringColor,
    );
    return [
      {
        gameId: "" as LudoEventDraft["gameId"],
        createdAt: 0,
        actor: { kind: "system" },
        eventType: "TEAM_FINISHED",
        payload: { team },
      },
      {
        gameId: "" as LudoEventDraft["gameId"],
        createdAt: 0,
        actor: { kind: "system" },
        eventType: "GAME_FINISHED",
        payload: { reason: "team_home" },
      },
    ];
  }
  return null;
}

export function draftTeamEliminationWin(state: GameState): LudoEventDraft[] | null {
  if (state.mode !== "2v2") return null;
  const players = teamPlayers(state);
  for (const spentTeam of ["A", "B"] as Team[]) {
    if (!teamIsSpent(players, spentTeam)) continue;
    const winningTeam: Team = spentTeam === "A" ? "B" : "A";
    if (teamIsSpent(players, winningTeam)) continue;
    return [
      {
        gameId: "" as LudoEventDraft["gameId"],
        createdAt: 0,
        actor: { kind: "system" },
        eventType: "GAME_FINISHED",
        payload: { reason: "team_eliminated" },
      },
    ];
  }
  return null;
}

export function playableColors(state: GameState): Color[] {
  return state.seats
    .filter((s) => !s.eliminated && s.finishRank == null)
    .map((s) => s.color);
}

export function draftSoleSurvivorWin(state: GameState): LudoEventDraft[] | null {
  const stillPlaying = playableColors(state);
  if (stillPlaying.length !== 1) return null;
  const sole = stillPlaying[0]!;
  const others = state.seats.filter((s) => s.color !== sole);
  if (others.length === 0 || !others.every((s) => s.eliminated)) return null;
  return [
    {
      gameId: "" as LudoEventDraft["gameId"],
      createdAt: 0,
      actor: { kind: "system" },
      eventType: "GAME_FINISHED",
      payload: { reason: "sole_survivor" },
    },
  ];
}

export function draftAutomaticLoserFinish(state: GameState): LudoEventDraft[] | null {
  if (!shouldAssignAutomaticLoser(state.seats)) return null;
  return [
    {
      gameId: "" as LudoEventDraft["gameId"],
      createdAt: 0,
      actor: { kind: "system" },
      eventType: "GAME_FINISHED",
      payload: { reason: "automatic_loser" },
    },
  ];
}

export function draftAllRankedFinish(state: GameState): LudoEventDraft[] | null {
  if (state.seats.length === 0) return null;
  if (!state.seats.every((s) => s.finishRank != null || s.eliminated)) {
    return null;
  }
  return [
    {
      gameId: "" as LudoEventDraft["gameId"],
      createdAt: 0,
      actor: { kind: "system" },
      eventType: "GAME_FINISHED",
      payload: { reason: "all_ranked" },
    },
  ];
}

export function assignFinishRankInState(
  state: GameState,
  color: Color,
): { state: GameState; rank: number } {
  const seat = state.seats.find((s) => s.color === color);
  if (!seat) return { state, rank: 0 };
  if (seat.finishRank != null) {
    const idx = state.rankings.indexOf(color);
    const rank = idx >= 0 ? idx + 1 : seat.finishRank;
    return { state, rank };
  }
  const rankings = [...state.rankings];
  if (!rankings.includes(color)) rankings.push(color);
  const rank = rankings.length;
  let next = updateSeat(state, color, { finishRank: rank });
  next = { ...next, rankings, winner: rank === 1 ? color : next.winner };
  return { state: next, rank };
}

export function applyGameFinishedReason(
  state: GameState,
  reason:
    | "all_home"
    | "team_home"
    | "team_eliminated"
    | "sole_survivor"
    | "automatic_loser"
    | "all_ranked"
    | "abandoned",
): GameState {
  let rankings = [...state.rankings];
  let winner = state.winner;
  let winningTeam = state.winningTeam;

  if (reason === "sole_survivor") {
    const sole = playableColors(state)[0];
    if (sole) {
      winner = sole;
      rankings = buildFinalRankings(
        rankings,
        sole,
        state.seats.map((s) => ({
          color: s.color,
          finishRank: s.finishRank,
        })),
      );
      const soleSeat = state.seats.find((s) => s.color === sole);
      if (soleSeat && soleSeat.finishRank == null) {
        const rank = rankings.indexOf(sole) + 1;
        return applyGameFinishedReason(
          updateSeat({ ...state, rankings, winner }, sole, {
            finishRank: rank,
          }),
          "all_ranked",
        );
      }
    }
  }

  if (reason === "automatic_loser") {
    const loser = state.seats.find(
      (s) => !s.eliminated && s.finishRank == null,
    );
    if (loser) {
      if (!rankings.includes(loser.color)) rankings.push(loser.color);
      for (const s of state.seats) {
        if (!rankings.includes(s.color)) rankings.push(s.color);
      }
      winner = rankings[0] ?? winner;
    }
  }

  if (reason === "all_ranked" && rankings.length === 0 && state.seats[0]) {
    rankings = buildFinalRankings(
      [],
      state.seats[0].color,
      state.seats.map((s) => ({
        color: s.color,
        finishRank: s.finishRank,
      })),
    );
  }

  for (const s of state.seats) {
    if (!rankings.includes(s.color)) rankings.push(s.color);
  }

  if (reason === "team_home" || reason === "team_eliminated") {
    if (winningTeam) {
      winner =
        winner ??
        pickRepresentativeColor(teamPlayers(state), winningTeam);
      rankings = buildTeamRankings(winningTeam, winner);
    }
  }

  if (!winner && rankings.length > 0) winner = rankings[0] ?? null;

  return {
    ...state,
    phase: "finished",
    rankings,
    winner,
    winningTeam,
    diceRolled: false,
    diceValue: state.diceValue,
    sixStreakSnapshot: null,
    passedRollTo: null,
    consecutiveSixes: 0,
    settle: null,
    finishedAt: state.finishedAt,
  };
}
