"use client";

import { useMutation } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { SPECTATOR_PING_MS } from "../../convex/lib/spectate";
import { formatConvexError } from "@/lib/player";

/**
 * Registers this tab as a watcher while `active`, pings to stay counted, and
 * leaves on unmount / pagehide. Returns the join error for this room, if any.
 */
export function useSpectatorPresence(
  roomId: Id<"rooms"> | null,
  spectatorId: string,
  active: boolean,
): string | null {
  const join = useMutation(api.spectate.joinSpectate);
  const ping = useMutation(api.spectate.spectatorPing);
  const leave = useMutation(api.spectate.leaveSpectate);
  const [failure, setFailure] = useState<{ roomId: Id<"rooms">; message: string } | null>(null);

  useEffect(() => {
    if (!active || !roomId || !spectatorId) return;
    let cancelled = false;
    join({ roomId, spectatorId }).then(
      () => {
        if (!cancelled) setFailure(null);
      },
      (err: unknown) => {
        if (!cancelled) setFailure({ roomId, message: formatConvexError(err, "Could not watch this game") });
      },
    );
    const tick = () => {
      void ping({ roomId, spectatorId }).catch(() => {});
    };
    const id = setInterval(tick, SPECTATOR_PING_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    const onHide = () => {
      void leave({ roomId, spectatorId }).catch(() => {});
    };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("online", tick);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("online", tick);
      document.removeEventListener("visibilitychange", onVisible);
      onHide();
    };
  }, [active, roomId, spectatorId, join, ping, leave]);

  return failure && failure.roomId === roomId ? failure.message : null;
}
