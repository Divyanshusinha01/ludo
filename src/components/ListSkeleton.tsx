import { LoadingLabel, Skeleton } from "./Skeleton";
import styles from "./MatchHistory.module.css";

/** Placeholder for the history and leaderboard lists, sized like their rows. */
export function ListSkeleton({
  title,
  label,
  rows = 4,
}: {
  title: string;
  label: string;
  rows?: number;
}) {
  return (
    <section className={styles.section}>
      <h2 className={styles.heading}>{title}</h2>
      <LoadingLabel>{label}</LoadingLabel>
      <ol className={styles.list} aria-hidden="true">
        {Array.from({ length: rows }, (_, i) => (
          <li key={i} className={`${styles.row} ${styles.skeletonRow}`}>
            <div className={styles.main}>
              <Skeleton width="55%" height="0.95rem" />
              <Skeleton width="35%" height="0.7rem" />
            </div>
            <Skeleton width="2.5rem" height="0.85rem" />
            <Skeleton width="2.25rem" height="1.1rem" />
          </li>
        ))}
      </ol>
    </section>
  );
}
