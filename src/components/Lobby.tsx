"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { useRoomPresence } from "@/hooks/useRoomPresence";
import { Button, ErrorText } from "./ui";
import {
  COLOR_HEX,
  COLOR_LABEL,
  formatConvexError,
  type Color,
} from "@/lib/player";
import {
  buildTroubleSnapshot,
  isTroubleshootCoolingDown,
  runTroubleshoot,
} from "@/lib/troubleshoot";
import { RejoinRequests } from "./RejoinRequests";
import styles from "./Lobby.module.css";

export type RoomBundle = NonNullable<FunctionReturnType<typeof api.rooms.getRoom>>;

type Props = {
  data: RoomBundle;
  roomId: Id<"rooms">;
  clientId: string;
  code: string;
};

export function Lobby({ data, roomId, clientId, code }: Props) {
  const router = useRouter();
  const startGame = useMutation(api.rooms.startGame);
  const leaveRoom = useMutation(api.rooms.leaveRoom);
  const kickPlayer = useMutation(api.rooms.kickPlayer);
  const addBot = useMutation(api.rooms.addBot);
  const reportTrouble = useMutation(api.trouble.reportTrouble);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [troubleBusy, setTroubleBusy] = useState(false);
  const [kickBusy, setKickBusy] = useState<Color | null>(null);
  const [addBotBusy, setAddBotBusy] = useState<Color | "any" | null>(null);

  useRoomPresence(roomId, clientId);

  const { room, players, me } = data;
  const isHost = !!me?.isHost;
  const isTeamMode = room.mode === "2v2";
  const teamAFull = players.filter((p) => p.team === "A").length === 2;
  const teamBFull = players.filter((p) => p.team === "B").length === 2;
  const canStart =
    isHost &&
    (isTeamMode ? players.length === 4 && teamAFull && teamBFull : players.length >= 2);
  const canAddBot =
    isHost &&
    !room.vsComputer &&
    players.length < 4 &&
    addBotBusy === null &&
    !busy;

  async function onTroubleshoot() {
    if (troubleBusy || isTroubleshootCoolingDown()) return;
    setTroubleBusy(true);
    const snapshot = buildTroubleSnapshot({
      clientId,
      roomId,
      code,
      screen: "lobby",
      lastError: error ?? undefined,
      roomStatus: room.status,
    });
    await runTroubleshoot({
      report: (s) => reportTrouble(s),
      snapshot,
      clearLocal: () => {
        setError(null);
        setBusy(false);
        setKickBusy(null);
        setAddBotBusy(null);
      },
    });
  }

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

  async function onAddBot(seatColor?: Color) {
    setError(null);
    setAddBotBusy(seatColor ?? "any");
    try {
      await addBot({
        roomId,
        clientId,
        ...(seatColor ? { color: seatColor } : {}),
      });
    } catch (e) {
      setError(formatConvexError(e, "Could not add computer"));
    } finally {
      setAddBotBusy(null);
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

      {(() => {
        const renderSeat = (color: Color) => {
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
                  {p?.isBot ? " · computer" : ""}
                </strong>
                <p>{p ? p.name : "Waiting…"}</p>
              </div>
              <div className={styles.seatActions}>
                <span className={styles.badge}>
                  {p
                    ? p.isBot
                      ? "Computer"
                      : p.connected
                        ? "Online"
                        : "Away"
                    : "Empty"}
                </span>
                {isHost && !p && !room.vsComputer && (
                  <button
                    type="button"
                    className={styles.fillBot}
                    disabled={!canAddBot || addBotBusy === color}
                    onClick={() => onAddBot(color)}
                  >
                    {addBotBusy === color ? "Adding…" : "Add computer"}
                  </button>
                )}
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
        };

        if (isTeamMode) {
          return (
            <>
              <h2 className={styles.teamHeading}>Team A</h2>
              <ul className={styles.list}>
                {(["red", "yellow"] as Color[]).map(renderSeat)}
              </ul>
              <h2 className={styles.teamHeading}>Team B</h2>
              <ul className={styles.list}>
                {(["green", "blue"] as Color[]).map(renderSeat)}
              </ul>
            </>
          );
        }

        return (
          <ul className={styles.list}>
            {(["red", "green", "yellow", "blue"] as Color[]).map(renderSeat)}
          </ul>
        );
      })()}

      <RejoinRequests roomId={roomId} clientId={clientId} isHost={isHost} />

      {isHost && !room.vsComputer && !isTeamMode && (
        <Button
          variant="secondary"
          disabled={!canAddBot}
          onClick={() => onAddBot()}
          style={{ width: "100%" }}
        >
          {players.length >= 4
            ? "Room full"
            : addBotBusy === "any"
              ? "Adding…"
              : "Add computer"}
        </Button>
      )}

      {isHost ? (
        <Button
          variant="ink"
          disabled={!canStart || busy}
          onClick={onStart}
          style={{ width: "100%" }}
        >
          {isTeamMode
            ? canStart
              ? "Start 2v2 game"
              : `Need 2 per team (${players.length}/4)`
            : players.length >= 2
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
      <ErrorText
        onTroubleshoot={() => void onTroubleshoot()}
        troubleBusy={troubleBusy}
        troubleDisabled={isTroubleshootCoolingDown()}
      >
        {error}
      </ErrorText>
    </section>
  );
}
