"use client";

import { useMutation } from "convex/react";
import { useEffect, useRef } from "react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { HEARTBEAT_MIN_INTERVAL_MS } from "../../convex/lib/session";

export const HEARTBEAT_MS = 20_000;
/** Second heartbeat after a wake-up, once the server's soft window has passed. */
export const WAKE_RETRY_MS = HEARTBEAT_MIN_INTERVAL_MS + 250;
/** Consecutive "gone" replies before the loop stops (a single miss may be a race). */
export const GONE_STRIKES = 2;

/**
 * How often the seat is refreshed:
 * - `live`: every HEARTBEAT_MS, including in a background tab (an active game
 *   needs it so AFK and underpopulated rules see the player).
 * - `visible`: every HEARTBEAT_MS, but only while the tab is visible (lobbies).
 * - `idle`: no interval at all (finished games); wake-ups and pagehide still work.
 */
export type PresenceCadence = "live" | "visible" | "idle";

/**
 * Keep presence alive while a room screen is mounted. Spectators pass
 * `enabled: false`. The interval stops for good once the server answers "gone"
 * (room deleted or seat left) and restarts on the next wake-up.
 */
export function useRoomPresence(
  roomId: Id<"rooms">,
  clientId: string,
  enabled = true,
  cadence: PresenceCadence = "live",
) {
  const heartbeat = useMutation(api.rooms.heartbeat);
  const markDisconnected = useMutation(api.rooms.markDisconnected);
  // Read by the interval without restarting the effect (and re-sending an
  // immediate heartbeat) every time the phase changes.
  const cadenceRef = useRef(cadence);
  useEffect(() => {
    cadenceRef.current = cadence;
  }, [cadence]);

  useEffect(() => {
    if (!enabled) return;
    let strikes = 0;
    let id: ReturnType<typeof setInterval> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const stop = () => {
      if (id !== undefined) clearInterval(id);
      id = undefined;
    };
    const send = () => {
      heartbeat({ roomId, clientId }).then(
        (status) => {
          strikes = status === "gone" ? strikes + 1 : 0;
          if (strikes >= GONE_STRIKES) stop();
        },
        () => {},
      );
    };
    const tick = () => {
      const mode = cadenceRef.current;
      if (mode === "idle") return;
      if (mode === "visible" && document.visibilityState === "hidden") return;
      send();
    };
    const start = () => {
      if (id === undefined) id = setInterval(tick, HEARTBEAT_MS);
    };

    if (cadenceRef.current !== "idle") send();
    start();
    // pagehide may have marked the seat away. The server ignores heartbeats
    // inside its soft window even for an away seat, so send one now and one
    // just after the window instead of waiting for the next interval.
    const wake = () => {
      strikes = 0;
      start();
      send();
      clearTimeout(retry);
      retry = setTimeout(send, WAKE_RETRY_MS);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") wake();
    };
    const onUnload = () => {
      void markDisconnected({ roomId, clientId });
    };
    window.addEventListener("pagehide", onUnload);
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stop();
      clearTimeout(retry);
      window.removeEventListener("pagehide", onUnload);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [roomId, clientId, heartbeat, markDisconnected, enabled]);
}
