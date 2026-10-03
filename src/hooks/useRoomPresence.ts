"use client";

import { useMutation } from "convex/react";
import { useEffect } from "react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { HEARTBEAT_MIN_INTERVAL_MS } from "../../convex/lib/session";

export const HEARTBEAT_MS = 20_000;
/** Second heartbeat after a wake-up, once the server's soft window has passed. */
export const WAKE_RETRY_MS = HEARTBEAT_MIN_INTERVAL_MS + 250;

/** Keep presence alive while a room screen is mounted. Spectators pass `enabled: false`. */
export function useRoomPresence(roomId: Id<"rooms">, clientId: string, enabled = true) {
  const heartbeat = useMutation(api.rooms.heartbeat);
  const markDisconnected = useMutation(api.rooms.markDisconnected);

  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      void heartbeat({ roomId, clientId });
    };
    tick();
    const id = setInterval(tick, HEARTBEAT_MS);
    let retry: ReturnType<typeof setTimeout> | undefined;
    // pagehide may have marked the seat away. The server ignores heartbeats
    // inside its soft window even for an away seat, so send one now and one
    // just after the window instead of waiting for the next interval.
    const wake = () => {
      tick();
      clearTimeout(retry);
      retry = setTimeout(tick, WAKE_RETRY_MS);
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
      clearInterval(id);
      clearTimeout(retry);
      window.removeEventListener("pagehide", onUnload);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [roomId, clientId, heartbeat, markDisconnected, enabled]);
}
