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
  normalizeCode,
  storeName,
  useSessionId,
} from "@/lib/player";
import styles from "./room.module.css";

export function RoomClient({ code }: { code: string }) {
  const clientId = useSessionId();
  const [joinError, setJoinError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const joinAttempted = useRef(false);
  const roomCode = normalizeCode(code);

  const data = useQuery(
    api.rooms.getRoomByCode,
    clientId && roomCode.length === 6
      ? { code: roomCode, clientId }
      : "skip",
  );
  const joinRoom = useMutation(api.rooms.joinRoom);

  const roomStatus = data?.room.status;
  const hasMe = !!data?.me;
  const roomMissing = data === null;
  const roomLoading = data === undefined;

  useEffect(() => {
    joinAttempted.current = false;
  }, [roomCode, retryKey]);

  useEffect(() => {
    if (!clientId || roomLoading || roomMissing) return;
    if (hasMe || joinAttempted.current || joinError) return;
    if (roomStatus !== "lobby") return;

    joinAttempted.current = true;
    const name = getStoredName() || "Player";
    storeName(name);
    void joinRoom({
      code: roomCode,
      clientId,
      name,
    })
      .then(() => {
        setJoinError(null);
      })
      .catch((e) => {
        joinAttempted.current = false;
        setJoinError(formatConvexError(e, "Could not join"));
      });
  }, [
    clientId,
    roomLoading,
    roomMissing,
    hasMe,
    roomStatus,
    roomCode,
    joinRoom,
    retryKey,
    joinError,
  ]);

  if (!clientId || (roomCode.length === 6 && roomLoading)) {
    return <StatusText>Connecting…</StatusText>;
  }

  if (roomCode.length !== 6 || roomMissing) {
    return (
      <div className={styles.center}>
        <h1>Room not found</h1>
        <p>The code may have expired or been typed wrong.</p>
        <Link href="/">Back home</Link>
      </div>
    );
  }

  const spectatorBlocked =
    !hasMe && roomStatus !== "lobby" && !joinError;

  if (joinError || spectatorBlocked) {
    return (
      <div className={styles.center}>
        <h1>Could not join</h1>
        <p role={joinError ? "alert" : undefined}>
          {joinError ??
            "This game already started and you are not in it."}
        </p>
        {joinError && roomStatus === "lobby" && (
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

  if (!hasMe || !data) {
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
