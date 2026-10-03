"use client";

import dynamic from "next/dynamic";
import { ConvexClientProvider } from "./ConvexClientProvider";
import type { HomeOnlineMode } from "./HomeOnlineFlow";
import { LoadingLabel, Skeleton } from "./Skeleton";
import styles from "./HomeScreen.module.css";

const HomeOnlineFlow = dynamic(
  () => import("./HomeOnlineFlow").then((m) => m.HomeOnlineFlow),
  {
    loading: () => (
      <div className={`${styles.actions} ${styles.delayedReveal}`}>
        <LoadingLabel>Loading online play…</LoadingLabel>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} height="3.1rem" style={{ borderRadius: 999 }} />
        ))}
      </div>
    ),
  },
);

type Props = {
  mode: HomeOnlineMode;
  offline: boolean;
  onModeChange: (mode: "home" | HomeOnlineMode) => void;
};

/** Loads Convex + online forms only when the user chooses Play Online. */
export function HomeOnlineGate(props: Props) {
  return (
    <ConvexClientProvider>
      <HomeOnlineFlow {...props} />
    </ConvexClientProvider>
  );
}
