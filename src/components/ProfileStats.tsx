import type { FunctionReturnType } from "convex/server";
import type { api } from "../../convex/_generated/api";
import { LoadingLabel, Skeleton, fadeInClass } from "./Skeleton";
import styles from "./ProfileStats.module.css";

export type PublicProfile = NonNullable<FunctionReturnType<typeof api.profiles.getMine>>;

const LABELS = ["Games", "Wins", "Losses", "Win rate", "Captured", "Lost", "Rating", "Peak"];

export function ProfileStats({ profile }: { profile: PublicProfile }) {
  const losses = Math.max(0, profile.gamesPlayed - profile.wins);
  const winRate =
    profile.gamesPlayed > 0 ? `${Math.round((profile.wins / profile.gamesPlayed) * 100)}%` : "—";
  const values: Array<string | number> = [
    profile.gamesPlayed,
    profile.wins,
    losses,
    winRate,
    profile.tokensCaptured,
    profile.tokensLost,
    profile.rating,
    profile.peakRating,
  ];
  return (
    <dl className={`${styles.stats} ${fadeInClass}`} aria-label="Stats">
      {LABELS.map((label, i) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{values[i]}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ProfileStatsSkeleton() {
  return (
    <div>
      <LoadingLabel>Loading stats…</LoadingLabel>
      <dl className={styles.stats} aria-hidden="true">
        {LABELS.map((label) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              <Skeleton width="60%" height="1lh" style={{ margin: "0 auto" }} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
