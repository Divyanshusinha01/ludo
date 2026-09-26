"use client";

import { useSyncExternalStore } from "react";
import {
  canUseWebGL,
  prefer2DGameGraphics,
  prefersReducedMotion,
} from "@/lib/webgl";
import {
  isWebGL3DDisabled,
  subscribeWebGL3D,
} from "@/lib/webgl3dState";

function subscribe(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", onStoreChange);
  const offWebGL = subscribeWebGL3D(onStoreChange);
  return () => {
    mq.removeEventListener("change", onStoreChange);
    offWebGL();
  };
}

function base3DEnabled(): boolean {
  return (
    canUseWebGL() &&
    !prefersReducedMotion() &&
    !prefer2DGameGraphics() &&
    !isWebGL3DDisabled()
  );
}

function getBoardSnapshot() {
  return base3DEnabled();
}

function getServerSnapshot() {
  return false;
}

/** 3D token overlay on the board (one WebGL surface per screen). */
export function useCanUse3DBoard(): boolean {
  return useSyncExternalStore(subscribe, getBoardSnapshot, getServerSnapshot);
}

/** CSS dice only — avoids a second WebGL context alongside the board. */
export function useCanUse3DDice(): boolean {
  return false;
}

/** @deprecated Use useCanUse3DBoard or useCanUse3DDice. */
export function useCanUse3D(): boolean {
  return useCanUse3DBoard();
}
