"use client";

import { useSyncExternalStore } from "react";
import { canUseWebGL, prefersReducedMotion } from "@/lib/webgl";

function subscribe(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", onStoreChange);
  return () => mq.removeEventListener("change", onStoreChange);
}

function getSnapshot() {
  return canUseWebGL() && !prefersReducedMotion();
}

function getServerSnapshot() {
  return false;
}

/**
 * Prefer CSS / static fallbacks when WebGL is unavailable or the user
 * prefers reduced motion (no tumble / hop / particle FX).
 */
export function useCanUse3D(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
