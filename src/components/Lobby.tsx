"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { useRoomPresence } from "@/hooks/useRoomPresence";
import { Button, ErrorText, StatusText } from "./ui";
import {
  COLOR_HEX,
  COLOR_LABEL,
  formatConvexError,
  type Color,
} from "@/lib/player";
import styles from "./Lobby.module.css";

type Props = {
  roomId: Id<"rooms">;
  clientId: string;
  code: string;
};

export function Lobby({ roomId, clientId, code }: Props) {
  const router = useRouter();
  const data = useQuery(api.rooms.getRoom, { roomId, clientId });
  const startGame = useMutation(api.rooms.startGame);
  const leaveRoom = useMutation(api.rooms.leaveRoom);
  const kickPlayer = useMutation(api.rooms.kickPlayer);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [kickBusy, setKickBusy] = useState<Color | null>(null);

  useRoomPresence(roomId, clientId);

  if (!data) {
    return <StatusText>Loading lobby…</StatusText>;
  }

  const { room, players, me } = data;
  const isHost = !!me?.isHost;
  const canStart = players.length >= 2 && isHost;

  async function onStart() {
    setError(null);
    setBusy(true);
    try {
      await startGame({ roomId, clientId });
    } catch (e) {
      setError(formatConvexError(e, "Could not start"));
    } finally {
      setBusy(false);
    }
  }

  async function onLeave() {
    setBusy(true);
    try {
      await leaveRoom({ roomId, clientId });
      router.push("/");
    } catch (e) {
      setError(formatConvexError(e, "Could not leave"));
      setBusy(false);
    }
  }

  async function onKick(color: Color) {
    setError(null);
    setKickBusy(color);
    try {
      await kickPlayer({ roomId, clientId, targetColor: color });
    } catch (e) {
      setError(formatConvexError(e, "Could not remove player"));
    } finally {
      setKickBusy(null);
    }
  }

  async function onShare() {
    const shareData = {
      title: "Family Ludo",
      text: `Join my Ludo game — code ${code}`,
      url: typeof window !== "undefined" ? window.location.href : undefined,
    };
    try {
      if (navigator.share) {
        await navigator.share(shareData);
        return;
      }
    } catch {
      /* fall through to copy */
    }
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy code");
    }
  }

  return (
    <section className={styles.lobby}>
      <header className={styles.header}>
        <p className={styles.label}>Room code</p>
        <h1 className={styles.code}>{code}</h1>
        <p className={styles.hint}>Share this code with your family</p>
        <div className={styles.shareRow}>
          <Button variant="secondary" onClick={onShare}>
            {copied ? "Copied!" : "Copy / share"}
          </Button>
          <Button variant="secondary" onClick={onLeave} disabled={busy}>
            Leave
          </Button>
        </div>
      </header>

      <ul className={styles.list}>
        {(["red", "green", "yellow", "blue"] as Color[]).map((color) => {
          const p = players.find((x) => x.color === color);
          return (
            <li
              key={color}
              className={styles.seat}
              style={{ ["--seat" as string]: COLOR_HEX[color] }}
            >
              <span className={styles.swatch} />
              <div>
                <strong>
                  {COLOR_LABEL[color]}
                  {p?.isMe ? " (you)" : ""}
                  {p?.isHost ? " · host" : ""}
                </strong>
                <p>{p ? p.name : "Waiting…"}</p>
              </div>
              <div className={styles.seatActions}>
                <span className={styles.badge}>
                  {p ? (p.connected ? "Online" : "Away") : "Empty"}
                </span>
                {isHost && p && !p.isMe && (
                  <button
                    type="button"
                    className={styles.kick}
                    disabled={kickBusy === color}
                    onClick={() => onKick(color)}
                  >
                    Remove
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {isHost ? (
        <Button
          variant="ink"
          disabled={!canStart || busy}
          onClick={onStart}
          style={{ width: "100%" }}
        >
          {players.length >= 2
            ? `Start game (${players.length} players)`
            : `Need at least 2 players (${players.length}/2)`}
        </Button>
      ) : (
        <p className={styles.muted}>
          Waiting for host to start… ({players.length} joined)
        </p>
      )}

      {room.lastEvent && (
        <p className={styles.event} aria-live="polite">
          {room.lastEvent}
        </p>
      )}
      <ErrorText>{error}</ErrorText>
    </section>
  );
}
