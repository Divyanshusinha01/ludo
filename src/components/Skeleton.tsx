import type { CSSProperties } from "react";
import styles from "./Skeleton.module.css";

export const fadeInClass = styles.fadeIn;

export function Skeleton({
  width = "100%",
  height = "1em",
  style,
}: {
  width?: CSSProperties["width"];
  height?: CSSProperties["height"];
  style?: CSSProperties;
}) {
  return <span aria-hidden="true" className={styles.block} style={{ width, height, ...style }} />;
}

/** Announces the pending state to screen readers while skeletons are on screen. */
export function LoadingLabel({ children }: { children: string }) {
  return (
    <span role="status" aria-live="polite" className={styles.srOnly}>
      {children}
    </span>
  );
}
