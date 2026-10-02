import { useEffect, useRef, useState } from "react";
import type { Color } from "@/lib/player";
import { FINISHED_STEPS } from "../../convex/lib/ludo";
import { playSound } from "@/lib/sounds";

export type AnimToken = {
  color: Color;
  index: number;
  steps: number;
};

/** Per-cell walk duration — keep in sync with Board CSS transition. */
export const STEP_MS = 70;
const CAPTURE_PAUSE_MS = 100;

function tokenKey(t: { color: string; index: number }) {
  return `${t.color}-${t.index}`;
}

function signature(tokens: AnimToken[]) {
  return tokens
    .map((t) => `${t.color}:${t.index}:${t.steps}`)
    .sort()
    .join("|");
}

/** Max track cells moved in one dice roll — snap only beyond this (reconnect backlog). */
export const MAX_ANIMATED_MOVE_STEPS = 6;

/** Board cells moved in one job (yard exit/capture counts as one hop). */
export function moveStepDistance(from: number, to: number): number {
  if (from === to) return 0;
  if (from === -1 || to === -1) return 1;
  return to - from;
}

/** Intermediate steps from `from` to `to` (exclusive of from, inclusive of to). */
export function stepsAlongPath(from: number, to: number): number[] {
  if (from === to) return [];
  if (from === -1) return [to];
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
  const generationRef = useRef(0);
  const sig = signature(serverTokens);

  useEffect(() => {
    const prev = prevRef.current;
    if (signature(prev) === sig) {
      return;
    }

    const tokens = serverTokens;
    const snapToServer = () => {
      generationRef.current += 1;
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
          j.kind === "move" &&
          moveStepDistance(j.from, j.to) > MAX_ANIMATED_MOVE_STEPS,
      );
    if (shouldSnap) {
      snapToServer();
      return;
    }

    const snapshot = serverTokens;
    const gen = ++generationRef.current;
    chainRef.current = chainRef.current.then(async () => {
      if (gen !== generationRef.current) return;
      setAnimating(true);
      let working = [...prevRef.current];

      // Prefer mover first, then returns (captures)
      jobs.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "move" ? -1 : 1));

      for (const job of jobs) {
        if (gen !== generationRef.current) return;
        if (job.kind === "return") {
          setFx({ captureKey: job.key });
          playSound("capture");
          await sleep(CAPTURE_PAUSE_MS);
          if (gen !== generationRef.current) return;
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
        let stepIdx = 0;
        for (const step of path) {
          if (gen !== generationRef.current) return;
          working = working.map((t) =>
            tokenKey(t) === job.key ? { ...t, steps: step } : t,
          );
          setDisplay([...working]);
          // Sound every other step to avoid audio thrash on mobile.
          if (stepIdx % 2 === 0) playSound("move");
          stepIdx += 1;
          if (step === FINISHED_STEPS) {
            setFx({ homeKey: job.key });
            playSound("home");
            await sleep(STEP_MS + 40);
            setFx({});
          } else {
            await sleep(STEP_MS);
          }
        }
        setFx({});
      }

      if (gen !== generationRef.current) return;
      prevRef.current = snapshot;
      setDisplay(snapshot);
      setAnimating(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sig captures token state
  }, [sig]);

  return { displayTokens: display, animating, fx };
}
