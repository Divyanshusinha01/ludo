"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Lobby } from "@/components/Lobby";
import { GameScreen } from "@/components/GameScreen";
import { Button, StatusText } from "@/components/ui";
import {
  formatConvexError,
  getStoredName,
  storeName,
  useSessionId,
} from "@/lib/player";
import styles from "./room.module.css";

export function RoomClient({ code }: { code: string }) {
  const clientId = useSessionId();
  const [joinError, setJoinError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const joinAttempted = useRef(false);

  const data = useQuery(
    api.rooms.getRoomByCode,
    clientId ? { code: code.toUpperCase(), clientId } : "skip",
  );
  const joinRoom = useMutation(api.rooms.joinRoom);

  useEffect(() => {
    joinAttempted.current = false;
  }, [code, retryKey]);

  useEffect(() => {
    if (!clientId || data === undefined || data === null) return;
    if (data.me || joinAttempted.current) return;
    if (data.room.status !== "lobby") return;

    joinAttempted.current = true;
    const name = getStoredName() || "Player";
    storeName(name);
    let cancelled = false;
    void joinRoom({
      code: code.toUpperCase(),
      clientId,
      name,
    })
      .then(() => {
        if (!cancelled) setJoinError(null);
      })
      .catch((e) => {
        if (!cancelled) {
          joinAttempted.current = false;
          setJoinError(formatConvexError(e, "Could not join"));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [clientId, data, code, joinRoom, retryKey]);

  if (!clientId || data === undefined) {
    return <StatusText>Connecting…</StatusText>;
  }

  if (data === null) {
    return (
      <div className={styles.center}>
        <h1>Room not found</h1>
        <p>The code may have expired or been typed wrong.</p>
        <Link href="/">Back home</Link>
      </div>
    );
  }

  const spectatorBlocked =
    !data.me && data.room.status !== "lobby" && !joinError;

  if (joinError || spectatorBlocked) {
    return (
      <div className={styles.center}>
        <h1>Could not join</h1>
        <p role={joinError ? "alert" : undefined}>
          {joinError ??
            "This game already started and you are not in it."}
        </p>
        {joinError && data.room.status === "lobby" && (
          <Button
            variant="primary"
            onClick={() => {
              setJoinError(null);
              setRetryKey((k) => k + 1);
            }}
          >
            Try again
          </Button>
        )}
        <Link href="/">Back home</Link>
      </div>
    );
  }

  if (!data.me) {
    return <StatusText>Joining room…</StatusText>;
  }

  if (data.room.status === "lobby") {
    return (
      <Lobby
        roomId={data.room._id}
        clientId={clientId}
        code={data.room.code}
      />
    );
  }

  return <GameScreen roomId={data.room._id} clientId={clientId} />;
}
