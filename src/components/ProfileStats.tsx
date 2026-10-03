import type { FunctionReturnType } from "convex/server";
import type { api } from "../../convex/_generated/api";
import styles from "./ProfileStats.module.css";

export type PublicProfile = NonNullable<FunctionReturnType<typeof api.profiles.getMine>>;

export function ProfileStats({ profile }: { profile: PublicProfile }) {
  const losses = Math.max(0, profile.gamesPlayed - profile.wins);
  const winRate =
    profile.gamesPlayed > 0 ? `${Math.round((profile.wins / profile.gamesPlayed) * 100)}%` : "—";
  const stats: Array<[string, string | number]> = [
    ["Games", profile.gamesPlayed],
    ["Wins", profile.wins],
    ["Losses", losses],
    ["Win rate", winRate],
    ["Captured", profile.tokensCaptured],
    ["Lost", profile.tokensLost],
    ["Rating", profile.rating],
    ["Peak", profile.peakRating],
  ];
  return (
    <dl className={styles.stats} aria-label="Stats">
      {stats.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
