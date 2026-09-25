"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { Lobby } from "@/components/Lobby";
import { GameScreen } from "@/components/GameScreen";
import { ChatPanel } from "@/components/ChatPanel";
import { Button, ErrorText, StatusText } from "@/components/ui";
import {
  formatConvexError,
  normalizeCode,
  storeName,
  takePendingJoinName,
  useSessionId,
} from "@/lib/player";
import styles from "./room.module.css";

function isRoomId(value: string | undefined): value is Id<"rooms"> {
  // Convex document ids are non-empty opaque strings.
  return typeof value === "string" && value.length >= 16 && value.length <= 64;
}

export function RoomClient({
  code,
  roomIdHint,
}: {
  code: string;
  roomIdHint?: string;
}) {
  const clientId = useSessionId();
  const [joinError, setJoinError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [joining, setJoining] = useState(false);
  const [offline, setOffline] = useState(false);
  const pendingJoinTried = useRef(false);
  const roomCode = normalizeCode(code);
  const knownRoomId = isRoomId(roomIdHint) ? roomIdHint : null;

  // Prefer room id from create/vs-computer navigate — skips code lookup.
  const dataById = useQuery(
    api.rooms.getRoom,
    clientId && knownRoomId ? { roomId: knownRoomId, clientId } : "skip",
  );
  const dataByCode = useQuery(
    api.rooms.getRoomByCode,
    clientId && !knownRoomId && roomCode.length === 6
      ? { code: roomCode, clientId }
      : "skip",
  );
  const data = knownRoomId ? dataById : dataByCode;
  const joinRoom = useMutation(api.rooms.joinRoom);

  useEffect(() => {
    const sync = () => setOffline(!navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  const roomStatus = data?.room.status;
  const hasMe = !!data?.me;
  const roomMissing = data === null;
  const roomLoading = data === undefined;

  // Home "Join game" already collected a name — join once, no prefill UI.
  useEffect(() => {
    if (!clientId || roomLoading || roomMissing || hasMe) return;
    if (roomStatus !== "lobby" || pendingJoinTried.current || joining) return;

    const pending = takePendingJoinName();
    if (!pending) return;

    pendingJoinTried.current = true;
    let cancelled = false;
    // Defer state updates out of the synchronous effect body.
    void Promise.resolve().then(() => {
      if (cancelled) return;
      setJoining(true);
      setJoinError(null);
      void joinRoom({ code: roomCode, clientId, name: pending })
        .catch((err) => {
          pendingJoinTried.current = false;
          setJoinError(formatConvexError(err, "Could not join"));
          setName("");
        })
        .finally(() => {
          if (!cancelled) setJoining(false);
        });
    });
    return () => {
      cancelled = true;
    };
  }, [
    clientId,
    roomLoading,
    roomMissing,
    hasMe,
    roomStatus,
    roomCode,
    joinRoom,
    joining,
  ]);

  async function onJoin(e: FormEvent) {
    e.preventDefault();
    if (!clientId || joining) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setJoinError("Enter your name");
      return;
    }
    setJoining(true);
    setJoinError(null);
    try {
      storeName(trimmed);
      await joinRoom({
        code: roomCode,
        clientId,
        name: trimmed,
      });
    } catch (err) {
      setJoinError(formatConvexError(err, "Could not join"));
    } finally {
      setJoining(false);
    }
  }

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

  // Stale/mismatched ?rid= — fall through as not found rather than wrong seat.
  if (data && data.room.code !== roomCode) {
    return (
      <div className={styles.center}>
        <h1>Room not found</h1>
        <p>The code may have expired or been typed wrong.</p>
        <Link href="/">Back home</Link>
      </div>
    );
  }

  if (!hasMe && roomStatus !== "lobby") {
    return (
      <div className={styles.center}>
        <h1>Could not join</h1>
        <p>This game already started and you are not in it.</p>
        <Link href="/">Back home</Link>
      </div>
    );
  }

  if (!hasMe && roomStatus === "lobby") {
    if (joining) {
      return <StatusText>Joining room…</StatusText>;
    }
    return (
      <div className={styles.center}>
        <h1>Join room {roomCode}</h1>
        <p>Type your name to sit down.</p>
        <form className={styles.joinForm} onSubmit={onJoin}>
          <label className={styles.field}>
            Your name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={20}
              placeholder="e.g. Divsi"
              autoComplete="off"
              autoFocus
            />
          </label>
          <Button
            type="submit"
            variant="primary"
            disabled={joining || !name.trim() || !clientId}
          >
            Join game
          </Button>
        </form>
        <ErrorText>{joinError}</ErrorText>
        <Link href="/">Back home</Link>
      </div>
    );
  }

  if (!hasMe || !data) {
    return <StatusText>Joining room…</StatusText>;
  }

  if (offline) {
    return (
      <div className={styles.center}>
        <h1>Reconnecting…</h1>
        <p>Your seat is saved. Waiting for network…</p>
      </div>
    );
  }

  return (
    <>
      {data.room.status === "lobby" ? (
        <Lobby
          data={data}
          roomId={data.room._id}
          clientId={clientId}
          code={data.room.code}
        />
      ) : (
        <GameScreen data={data} roomId={data.room._id} clientId={clientId} />
      )}
      <ChatPanel
        roomId={data.room._id}
        clientId={clientId}
        players={data.players.map((p) => ({
          name: p.name,
          color: p.color,
          isMe: p.isMe,
          isBot: p.isBot,
        }))}
      />
    </>
  );
}
