/** True when a WebGL (or WebGL2) context can be created. */
export function canUseWebGL(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    return !!(
      canvas.getContext("webgl2") ||
      canvas.getContext("webgl") ||
      canvas.getContext("experimental-webgl")
    );
  } catch {
    return false;
  }
}

/** True when the user prefers reduced motion. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Touch-first devices often fail with two simultaneous WebGL canvases
 * (dice + board overlay). Prefer CSS/SVG there for reliability.
 */
export function prefer2DGameGraphics(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia("(pointer: coarse)").matches) return true;
  const nav = navigator as Navigator & { deviceMemory?: number };
  if (nav.deviceMemory != null && nav.deviceMemory <= 4) return true;
  return false;
}
