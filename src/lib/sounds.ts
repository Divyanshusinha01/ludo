/** Lightweight Web Audio beeps — no asset files required. */

const MUTE_KEY = "ludo-muted";

let audioCtx: AudioContext | null = null;
let muted = false;
let unlockBound = false;

function createCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    return new AC();
  } catch {
    return null;
  }
}

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!audioCtx) {
    audioCtx = createCtx();
  }
  return audioCtx;
}

/**
 * Browsers (esp. Chrome/Edge on laptop) start AudioContext suspended until a
 * user gesture. Call this from clicks / pointerdown, and await before beeps.
 */
export async function unlockAudio(): Promise<boolean> {
  const ctx = getCtx();
  if (!ctx) return false;
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch {
      return false;
    }
  }
  return ctx.state === "running";
}

/** Install one-shot listeners so the first tap/key unlocks audio globally. */
export function bindAudioUnlock(): void {
  if (typeof window === "undefined" || unlockBound) return;
  unlockBound = true;
  const onGesture = () => {
    void unlockAudio();
  };
  window.addEventListener("pointerdown", onGesture, {
    capture: true,
    passive: true,
  });
  window.addEventListener("keydown", onGesture, {
    capture: true,
    passive: true,
  });
}

export function isMuted(): boolean {
  if (typeof window === "undefined") return false;
  if (muted) return true;
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setMuted(value: boolean) {
  muted = value;
  try {
    localStorage.setItem(MUTE_KEY, value ? "1" : "0");
  } catch {
    /* ignore */
  }
  if (!value) {
    void unlockAudio();
  }
}

function beep(
  ctx: AudioContext,
  freq: number,
  durationMs: number,
  type: OscillatorType = "sine",
  gain = 0.08,
  when = 0,
) {
  const t0 = ctx.currentTime + when;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + durationMs / 1000);
  osc.connect(g);
  g.connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + durationMs / 1000 + 0.02);
}

export type SoundKind =
  | "turn"
  | "roll"
  | "move"
  | "capture"
  | "home"
  | "win"
  | "timeout"
  | "threeSixes"
  | "unmute";

function schedule(kind: SoundKind, ctx: AudioContext) {
  switch (kind) {
    case "turn":
      beep(ctx, 880, 90, "square", 0.06);
      break;
    case "roll":
      beep(ctx, 220, 40, "triangle", 0.05);
      beep(ctx, 330, 40, "triangle", 0.05, 0.05);
      beep(ctx, 440, 50, "triangle", 0.05, 0.1);
      break;
    case "move":
      beep(ctx, 520, 45, "sine", 0.05);
      break;
    case "capture":
      beep(ctx, 180, 80, "sawtooth", 0.07);
      beep(ctx, 120, 100, "sawtooth", 0.06, 0.08);
      break;
    case "home":
      beep(ctx, 660, 70, "sine", 0.07);
      beep(ctx, 880, 90, "sine", 0.07, 0.08);
      break;
    case "win":
      beep(ctx, 523, 100, "sine", 0.08);
      beep(ctx, 659, 100, "sine", 0.08, 0.12);
      beep(ctx, 784, 160, "sine", 0.09, 0.24);
      break;
    case "timeout":
      beep(ctx, 200, 120, "triangle", 0.06);
      break;
    case "threeSixes":
      beep(ctx, 300, 80, "square", 0.05);
      beep(ctx, 200, 120, "square", 0.05, 0.1);
      break;
    case "unmute":
      beep(ctx, 660, 70, "sine", 0.07);
      break;
  }
}

export function playSound(kind: SoundKind) {
  if (isMuted() && kind !== "unmute") return;
  // Fast path: avoid async unlock work on every token step (mobile lag).
  const ctx = getCtx();
  if (ctx && ctx.state === "running") {
    schedule(kind, ctx);
    return;
  }
  void unlockAudio().then((ok) => {
    if (!ok) return;
    const ready = getCtx();
    if (!ready || ready.state !== "running") return;
    schedule(kind, ready);
  });
}
