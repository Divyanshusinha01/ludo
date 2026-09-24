"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Lobby } from "@/components/Lobby";
import { GameScreen } from "@/components/GameScreen";
import {
  getOrCreateClientId,
  getStoredName,
  storeName,
} from "@/lib/player";
import styles from "./room.module.css";

export function RoomClient({ code }: { code: string }) {
  const data = useQuery(api.rooms.getRoomByCode, { code });
  const joinRoom = useMutation(api.rooms.joinRoom);
  const [clientId, setClientId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const joinAttempted = useRef(false);

  useEffect(() => {
    setClientId(getOrCreateClientId());
  }, []);

  useEffect(() => {
    if (!clientId || data === undefined || data === null) return;
    if (joinAttempted.current) return;
    if (data.players.some((p) => p.clientId === clientId)) {
      joinAttempted.current = true;
      return;
    }

    joinAttempted.current = true;
    (async () => {
      try {
        const name = getStoredName() || "Player";
        storeName(name);
        await joinRoom({ code, clientId, name });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not join");
      }
    })();
  }, [clientId, data, code, joinRoom]);

  if (data === undefined) {
    return <p className={styles.muted}>Connecting…</p>;
  }

  if (data === null) {
    return (
      <div className={styles.center}>
        <h1>Room not found</h1>
        <a href="/">Back home</a>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.center}>
        <h1>Could not join</h1>
        <p>{error}</p>
        <a href="/">Back home</a>
      </div>
    );
  }

  if (!clientId) {
    return <p className={styles.muted}>Joining room…</p>;
  }

  const me = data.players.find((p) => p.clientId === clientId);
  if (!me) {
    return <p className={styles.muted}>Joining room…</p>;
  }

  if (data.room.status === "lobby") {
    return (
      <Lobby roomId={data.room._id} clientId={clientId} code={data.room.code} />
    );
  }

  return <GameScreen roomId={data.room._id} clientId={clientId} />;
}
