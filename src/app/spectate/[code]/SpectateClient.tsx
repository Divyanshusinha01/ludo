"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { GameError } from "../../../../convex/lib/errors";
import { Loader } from "@/components/ui";
import { useSpectatorPresence } from "@/hooks/useSpectatorPresence";
import { normalizeCode, useSessionId } from "@/lib/player";
import styles from "../../room/[code]/room.module.css";

const GameScreen = dynamic(
  () => import("@/components/GameScreen").then((m) => m.GameScreen),
  { loading: () => <Loader fill label="Loading game…" /> },
);

export function SpectateClient({ code }: { code: string }) {
  const spectatorId = useSessionId();
  const roomCode = normalizeCode(code);
  const data = useQuery(
    api.spectate.getSpectatorRoom,
    roomCode.length === 6 ? { code: roomCode } : "skip",
  );
  const status = data?.view.room.status;
  const watchable = status === "playing" || status === "finished";
  const joinError = useSpectatorPresence(data?.view.room._id ?? null, spectatorId, watchable);

  if (roomCode.length !== 6 || data === null) {
    return (
      <div className={styles.center}>
        <h1>Game not found</h1>
        <p>The code may have expired, been typed wrong, or belong to a game that can&apos;t be watched.</p>
        <Link href="/">Back home</Link>
      </div>
    );
  }

  if (data === undefined || !spectatorId) {
    return <Loader fill label="Connecting…" />;
  }

  if (status === "lobby") {
    return (
      <div className={styles.center}>
        <h1>Game {roomCode}</h1>
        <p>This game hasn&apos;t started yet. The board appears here as soon as it does.</p>
        <Link href="/">Back home</Link>
      </div>
    );
  }

  if (joinError) {
    return (
      <div className={styles.center}>
        <h1>Can&apos;t watch game {roomCode}</h1>
        <p role="alert">{joinError}</p>
        {joinError === GameError.spectatorIsPlayer && (
          <Link href={`/room/${roomCode}`}>Go to your seat</Link>
        )}
        <Link href="/">Back home</Link>
      </div>
    );
  }

  return (
    <div className="route-in">
      <GameScreen
        data={data.view}
        roomId={data.view.room._id}
        clientId={spectatorId}
        spectate={{ count: data.spectators }}
      />
    </div>
  );
}
