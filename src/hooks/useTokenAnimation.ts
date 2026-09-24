import { useEffect, useRef, useState } from "react";
import type { Color } from "@/lib/player";
import { FINISHED_STEPS } from "../../convex/lib/ludo";
import { playSound } from "@/lib/sounds";

export type AnimToken = {
  color: Color;
  index: number;
  steps: number;
};

const STEP_MS = 120;
const CAPTURE_PAUSE_MS = 200;

function tokenKey(t: { color: string; index: number }) {
  return `${t.color}-${t.index}`;
}

function signature(tokens: AnimToken[]) {
  return tokens
    .map((t) => `${t.color}:${t.index}:${t.steps}`)
    .sort()
    .join("|");
}

/** Intermediate steps from `from` to `to` (exclusive of from, inclusive of to). */
export function stepsAlongPath(from: number, to: number): number[] {
  if (from === to) return [];
  if (from === -1) {
    const path: number[] = [];
    for (let s = 0; s <= to; s++) path.push(s);
    return path;
  }
  if (to === -1) return [-1];
  const path: number[] = [];
  for (let s = from + 1; s <= to; s++) path.push(s);
  return path;
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/**
 * Visual token layer that walks one cell at a time when server state jumps.
 * Block dice/token input while `animating` is true.
 */
export function useTokenAnimation(serverTokens: AnimToken[]) {
  const [display, setDisplay] = useState<AnimToken[]>(serverTokens);
  const [animating, setAnimating] = useState(false);
  const [fx, setFx] = useState<{
    captureKey?: string;
    homeKey?: string;
    leaveKey?: string;
  }>({});
  const prevRef = useRef<AnimToken[]>(serverTokens);
  const chainRef = useRef(Promise.resolve());
  const sig = signature(serverTokens);

  useEffect(() => {
    const prev = prevRef.current;
    if (signature(prev) === sig) {
      return;
    }

    const tokens = serverTokens;
    const snapToServer = () => {
      prevRef.current = tokens;
      // Defer so we never setState synchronously inside the effect body.
      setTimeout(() => {
        setDisplay(tokens);
        setAnimating(false);
        setFx({});
      }, 0);
    };

    // Rematch / seat change — snap
    if (prev.length !== serverTokens.length) {
      snapToServer();
      return;
    }

    const prevMap = new Map(prev.map((t) => [tokenKey(t), t]));
    type Job = {
      key: string;
      from: number;
      to: number;
      kind: "move" | "return";
    };
    const jobs: Job[] = [];

    for (const t of serverTokens) {
      const old = prevMap.get(tokenKey(t));
      if (!old || old.steps === t.steps) continue;
      if (t.steps < old.steps || (t.steps === -1 && old.steps >= 0)) {
        jobs.push({
          key: tokenKey(t),
          from: old.steps,
          to: t.steps,
          kind: "return",
        });
      } else {
        jobs.push({
          key: tokenKey(t),
          from: old.steps,
          to: t.steps,
          kind: "move",
        });
      }
    }

    if (jobs.length === 0) {
      snapToServer();
      return;
    }

    // Reconnect / multi-turn backlog: snap to authoritative state instead of
    // replaying a long or ambiguous animation chain.
    const shouldSnap =
      jobs.length > 2 ||
      jobs.some(
        (j) =>
          j.kind === "move" && stepsAlongPath(j.from, j.to).length > 6,
      );
    if (shouldSnap) {
      snapToServer();
      return;
    }

    const snapshot = serverTokens;
    chainRef.current = chainRef.current.then(async () => {
      setAnimating(true);
      let working = [...prevRef.current];

      // Prefer mover first, then returns (captures)
      jobs.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "move" ? -1 : 1));

      for (const job of jobs) {
        if (job.kind === "return") {
          setFx({ captureKey: job.key });
          playSound("capture");
          await sleep(CAPTURE_PAUSE_MS);
          working = working.map((t) =>
            tokenKey(t) === job.key ? { ...t, steps: job.to } : t,
          );
          setDisplay([...working]);
          setFx({});
          await sleep(STEP_MS);
          continue;
        }

        if (job.from === -1) {
          setFx({ leaveKey: job.key });
        }

        const path = stepsAlongPath(job.from, job.to);
        for (const step of path) {
          working = working.map((t) =>
            tokenKey(t) === job.key ? { ...t, steps: step } : t,
          );
          setDisplay([...working]);
          playSound("move");
          if (step === FINISHED_STEPS) {
            setFx({ homeKey: job.key });
            playSound("home");
            await sleep(STEP_MS + 60);
            setFx({});
          } else {
            await sleep(STEP_MS);
          }
        }
        setFx({});
      }

      prevRef.current = snapshot;
      setDisplay(snapshot);
      setAnimating(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sig captures token state
  }, [sig]);

  return { displayTokens: display, animating, fx };
}
