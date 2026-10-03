"use client";

import { useConvex, useMutation } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import type { OpsReporter } from "@/lib/opsReporter";

type PendingReconnect = { startedAt: number; lastSeenSeq: number };

/**
 * Tracks the Convex WebSocket and resyncs after a reconnect. Each reconnect
 * records exactly one `reconnect` sample: `ok` once the room view is back at
 * or past the last head seen before the drop, `error` if the heartbeat fails
 * or the socket drops again first.
 *
 * A resolved mutation guarantees subscriptions already reflect it, so the
 * heartbeat's completion is the point where `getRoom` is authoritative again.
 */
export function useConnectionResync({
  roomId,
  clientId,
  eventSeq,
  reporter,
  seated = true,
}: {
  roomId: Id<"rooms">;
  clientId: string;
  eventSeq: number;
  reporter: OpsReporter;
  /** Spectators only track the socket; they have no seat to heartbeat. */
  seated?: boolean;
}): { connected: boolean } {
  const client = useConvex();
  const heartbeat = useMutation(api.rooms.heartbeat);
  const [connected, setConnected] = useState(
    () => client.connectionState().isWebSocketConnected,
  );
  const currentSeq = useRef(eventSeq);
  const lastSeenSeq = useRef(eventSeq);
  const pending = useRef<PendingReconnect | null>(null);
  const resynced = useRef<PendingReconnect | null>(null);

  useEffect(() => {
    currentSeq.current = eventSeq;
    lastSeenSeq.current = Math.max(lastSeenSeq.current, eventSeq);
    const done = resynced.current;
    if (done && eventSeq >= done.lastSeenSeq) {
      resynced.current = null;
      reporter.record({
        kind: "reconnect",
        outcome: "ok",
        latencyMs: performance.now() - done.startedAt,
      });
    }
  }, [eventSeq, reporter]);

  useEffect(() => {
    let wasConnected = client.connectionState().isWebSocketConnected;

    const failPending = (message: string) => {
      const attempt = pending.current ?? resynced.current;
      pending.current = null;
      resynced.current = null;
      if (!attempt) return;
      reporter.record({
        kind: "reconnect",
        outcome: "error",
        latencyMs: performance.now() - attempt.startedAt,
        code: "internal",
        message,
      });
    };

    const onReconnect = () => {
      if (!seated) return;
      const attempt: PendingReconnect = {
        startedAt: performance.now(),
        lastSeenSeq: lastSeenSeq.current,
      };
      pending.current = attempt;
      heartbeat({ roomId, clientId }).then(
        () => {
          if (pending.current !== attempt) return;
          pending.current = null;
          if (currentSeq.current >= attempt.lastSeenSeq) {
            reporter.record({
              kind: "reconnect",
              outcome: "ok",
              latencyMs: performance.now() - attempt.startedAt,
            });
          } else {
            resynced.current = attempt;
          }
        },
        () => {
          if (pending.current === attempt) failPending("Reconnect heartbeat failed");
        },
      );
    };

    const unsubscribe = client.subscribeToConnectionState((state) => {
      const now = state.isWebSocketConnected;
      if (now === wasConnected) return;
      wasConnected = now;
      setConnected(now);
      if (now) onReconnect();
      else failPending("Disconnected again before resync");
    });
    return unsubscribe;
  }, [client, heartbeat, roomId, clientId, reporter, seated]);

  return { connected };
}
