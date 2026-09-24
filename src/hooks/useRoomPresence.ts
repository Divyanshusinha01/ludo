"use client";

import { useMutation } from "convex/react";
import { useEffect } from "react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";

export const HEARTBEAT_MS = 20_000;

/** Keep presence alive while a room screen is mounted. */
export function useRoomPresence(roomId: Id<"rooms">, clientId: string) {
  const heartbeat = useMutation(api.rooms.heartbeat);
  const markDisconnected = useMutation(api.rooms.markDisconnected);

  useEffect(() => {
    const tick = () => {
      void heartbeat({ roomId, clientId });
    };
    tick();
    const id = setInterval(tick, HEARTBEAT_MS);
    const onUnload = () => {
      void markDisconnected({ roomId, clientId });
    };
    window.addEventListener("pagehide", onUnload);
    return () => {
      clearInterval(id);
      window.removeEventListener("pagehide", onUnload);
    };
  }, [roomId, clientId, heartbeat, markDisconnected]);
}
