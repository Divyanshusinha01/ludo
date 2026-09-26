"use client";

import dynamic from "next/dynamic";
import { ConvexClientProvider } from "./ConvexClientProvider";
import type { HomeOnlineMode } from "./HomeOnlineFlow";
import styles from "./HomeScreen.module.css";

const HomeOnlineFlow = dynamic(
  () => import("./HomeOnlineFlow").then((m) => m.HomeOnlineFlow),
  {
    loading: () => (
      <p className={styles.hint} role="status">
        Loading online play…
      </p>
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
