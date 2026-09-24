/** Light haptic pulses for supported phones (no-op elsewhere). */
export function haptic(kind: "tap" | "roll" | "capture" | "win" = "tap") {
  if (typeof navigator === "undefined" || !navigator.vibrate) return;
  const pattern =
    kind === "roll"
      ? [12, 30, 18]
      : kind === "capture"
        ? [20, 40, 35]
        : kind === "win"
          ? [30, 50, 30, 50, 60]
          : [10];
  try {
    navigator.vibrate(pattern);
  } catch {
    /* unsupported / denied */
  }
}
