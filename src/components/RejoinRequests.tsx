"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { COLOR_HEX, COLOR_LABEL, formatConvexError, type Color } from "@/lib/player";
import { Button } from "./ui";
import styles from "./RejoinRequests.module.css";

type Props = {
  roomId: Id<"rooms">;
  clientId: string;
  /** Only render when the caller is the current host. */
  isHost: boolean;
};

export function RejoinRequests({ roomId, clientId, isHost }: Props) {
  const requests = useQuery(
    api.rooms.listPendingRejoinRequests,
    isHost ? { roomId, clientId } : "skip",
  );
  const respond = useMutation(api.rooms.respondRejoinRequest);
  const [busyId, setBusyId] = useState<Id<"rejoinRequests"> | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!isHost || !requests || requests.length === 0) return null;

  async function onRespond(
    requestId: Id<"rejoinRequests">,
    approve: boolean,
  ) {
    setError(null);
    setBusyId(requestId);
    try {
      await respond({ requestId, clientId, approve });
    } catch (e) {
      setError(formatConvexError(e, "Could not respond"));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className={styles.panel} role="region" aria-label="Rejoin requests">
      <h2 className={styles.title}>Rejoin requests</h2>
      <ul className={styles.list}>
        {requests.map((req) => (
          <li
            key={req._id}
            className={styles.item}
            style={{
              ["--c" as string]: COLOR_HEX[req.playerColor as Color],
            }}
          >
            <div className={styles.info}>
              <strong>{req.requesterName}</strong>
              <span>
                wants to reclaim {COLOR_LABEL[req.playerColor as Color]}
              </span>
            </div>
            <div className={styles.actions}>
              <Button
                variant="ink"
                disabled={busyId === req._id}
                onClick={() => void onRespond(req._id, true)}
              >
                Allow
              </Button>
              <Button
                variant="secondary"
                disabled={busyId === req._id}
                onClick={() => void onRespond(req._id, false)}
              >
                Deny
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
