import { MutationCtx } from "../_generated/server";
import { Doc } from "../_generated/dataModel";
import {
  Color,
  Team,
  TEAM_COLORS,
  teamAllTokensHome,
  teamIsSpent,
  teamOfColor,
  TokenState,
} from "./ludo";
import { withEvent } from "./events";
import { logEvent } from "./log";

function isTeamMode(room: Doc<"rooms">): boolean {
  return room.mode === "2v2";
}

function buildTeamRankings(
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

function pickRepresentativeColor(
  players: Doc<"players">[],
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

/**
 * Ends the match when either team has all 8 tokens home (2v2).
 */
export async function maybeFinishTeamMatch(
  ctx: MutationCtx,
  room: Doc<"rooms">,
  players: Doc<"players">[],
  tokens: TokenState[],
  now: number,
  triggeringColor?: Color,
): Promise<boolean> {
  if (!isTeamMode(room)) return false;

  for (const team of ["A", "B"] as Team[]) {
    if (!teamAllTokensHome(tokens, team)) continue;

    const winnerColor = pickRepresentativeColor(
      players,
      team,
      triggeringColor,
    );
    const rankings = buildTeamRankings(team, winnerColor);
    const winnerPlayer = players.find((p) => p.color === winnerColor);
    const winLabel = `Team ${team} wins!`;

    await ctx.db.patch(room._id, {
      status: "finished",
      winner: winnerColor,
      winningTeam: team,
      rankings,
      diceRolled: false,
      sixStreakSnapshot: null,
      finishedAt: now,
      lastActivityAt: now,
      ...withEvent(
        room,
        winnerPlayer
          ? `${winnerPlayer.name} finished — ${winLabel}`
          : winLabel,
        now,
      ),
    });
    logEvent("game_finished", {
      roomCode: room.code,
      winner: winnerColor,
      winningTeam: team,
      reason: "team_all_home",
    });
    return true;
  }

  return false;
}

/**
 * When one team is fully spent (eliminated or home, but not both home) and the
 * other is not also spent, the other team wins.
 */
export async function maybeFinishTeamByElimination(
  ctx: MutationCtx,
  room: Doc<"rooms">,
  players: Doc<"players">[],
  now: number,
  extraPatch?: Record<string, unknown>,
): Promise<boolean> {
  if (!isTeamMode(room)) return false;

  for (const spentTeam of ["A", "B"] as Team[]) {
    if (!teamIsSpent(players, spentTeam)) continue;
    const winningTeam: Team = spentTeam === "A" ? "B" : "A";
    if (teamIsSpent(players, winningTeam)) continue;

    const winnerColor = pickRepresentativeColor(players, winningTeam);
    const rankings = buildTeamRankings(winningTeam, winnerColor);

    await ctx.db.patch(room._id, {
      ...extraPatch,
      status: "finished",
      winner: winnerColor,
      winningTeam,
      rankings,
      diceRolled: false,
      sixStreakSnapshot: null,
      finishedAt: now,
      lastActivityAt: now,
      ...withEvent(room, `Team ${winningTeam} wins — Team ${spentTeam} out`, now),
    });
    logEvent("game_finished", {
      roomCode: room.code,
      winner: winnerColor,
      winningTeam,
      reason: "team_elimination",
    });
    return true;
  }

  return false;
}
