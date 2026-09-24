/** Lightweight Web Audio beeps — no asset files required. */

const MUTE_KEY = "ludo-muted";

let audioCtx: AudioContext | null = null;
let muted = false;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    if (!audioCtx) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      audioCtx = new AC();
    }
    if (audioCtx.state === "suspended") {
      void audioCtx.resume();
    }
    return audioCtx;
  } catch {
    return null;
  }
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
}

function beep(
  freq: number,
  durationMs: number,
  type: OscillatorType = "sine",
  gain = 0.08,
  when = 0,
) {
  if (isMuted()) return;
  const ctx = getCtx();
  if (!ctx) return;
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
  | "threeSixes";

export function playSound(kind: SoundKind) {
  switch (kind) {
    case "turn":
      beep(880, 90, "square", 0.06);
      break;
    case "roll":
      beep(220, 40, "triangle", 0.05);
      beep(330, 40, "triangle", 0.05, 0.05);
      beep(440, 50, "triangle", 0.05, 0.1);
      break;
    case "move":
      beep(520, 45, "sine", 0.05);
      break;
    case "capture":
      beep(180, 80, "sawtooth", 0.07);
      beep(120, 100, "sawtooth", 0.06, 0.08);
      break;
    case "home":
      beep(660, 70, "sine", 0.07);
      beep(880, 90, "sine", 0.07, 0.08);
      break;
    case "win":
      beep(523, 100, "sine", 0.08);
      beep(659, 100, "sine", 0.08, 0.12);
      beep(784, 160, "sine", 0.09, 0.24);
      break;
    case "timeout":
      beep(200, 120, "triangle", 0.06);
      break;
    case "threeSixes":
      beep(300, 80, "square", 0.05);
      beep(200, 120, "square", 0.05, 0.1);
      break;
  }
}
