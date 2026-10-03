"use client";

import dynamic from "next/dynamic";
import { FormEvent, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { Button, ErrorText, StatusText } from "@/components/ui";

const Lobby = dynamic(
  () => import("@/components/Lobby").then((m) => m.Lobby),
  { loading: () => <StatusText>Loading lobby…</StatusText> },
);
const GameScreen = dynamic(
  () => import("@/components/GameScreen").then((m) => m.GameScreen),
  { loading: () => <StatusText>Loading game…</StatusText> },
);
const ChatPanel = dynamic(
  () => import("@/components/ChatPanel").then((m) => m.ChatPanel),
  { ssr: false },
);
const VoicePanel = dynamic(
  () => import("@/components/VoicePanel").then((m) => m.VoicePanel),
  { ssr: false },
);
import {
  COLOR_HEX,
  formatConvexError,
  normalizeCode,
  storeName,
  takePendingJoinName,
  usePendingJoinName,
  useSessionId,
} from "@/lib/player";
import {
  buildTroubleSnapshot,
  isTroubleshootCoolingDown,
  runTroubleshoot,
} from "@/lib/troubleshoot";
import { useAuthState } from "@/lib/auth";
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
  const { profile } = useAuthState();
  const [nameDraft, setName] = useState<string | null>(null);
  const name = nameDraft ?? profile?.displayName ?? "";
  const pendingJoinName = usePendingJoinName();
  const [joining, setJoining] = useState(false);
  const [joinTeam, setJoinTeam] = useState<"A" | "B" | null>(null);
  const [offline, setOffline] = useState(false);
  const [troubleBusy, setTroubleBusy] = useState(false);
  const [pendingRequestId, setPendingRequestId] =
    useState<Id<"rejoinRequests"> | null>(null);
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
  const reportTrouble = useMutation(api.trouble.reportTrouble);

  const requestStatus = useQuery(
    api.rooms.getRejoinRequestStatus,
    pendingRequestId ? { requestId: pendingRequestId } : "skip",
  );

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

  // Approved rejoin: seat clientId now matches — clear pending state.
  useEffect(() => {
    if (data?.me && pendingRequestId) {
      setPendingRequestId(null);
      setJoinError(null);
    }
  }, [data?.me, pendingRequestId]);

  // Denied / expired request — let the user retry.
  useEffect(() => {
    if (!pendingRequestId || !requestStatus) return;
    if (requestStatus.status === "denied") {
      setPendingRequestId(null);
      setJoinError("Host denied your rejoin request — try again or use a different name");
    }
  }, [pendingRequestId, requestStatus]);

  const roomStatus = data?.room.status;
  const hasMe = !!data?.me;
  const roomMissing = data === null;
  const roomLoading = data === undefined;

  // Home "Join game" already collected a name — join once, no prefill UI.
  useEffect(() => {
    if (!clientId || roomLoading || roomMissing || hasMe) return;
    if (pendingRequestId || pendingJoinTried.current || joining) return;
    // Auto-join only in lobby; mid-game rejoin needs explicit name entry.
    if (roomStatus !== "lobby") return;
    if (data?.room.mode === "2v2") return;

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
        .then((result) => {
          if (cancelled) return;
          if ("pending" in result && result.pending) {
            setPendingRequestId(result.requestId);
          }
        })
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
    pendingRequestId,
    data?.room.mode,
  ]);

  // Ranked seats belong to the account: a signed-in owner opening the room in
  // a new tab takes the seat back without typing a name or asking a host.
  const rankedRoom = !!data?.room.ranked;
  const { isAuthenticated: signedIn } = useConvexAuth();
  const rankedReclaimTried = useRef(false);
  const displayName = profile?.displayName ?? "";
  useEffect(() => {
    if (!clientId || !rankedRoom || !signedIn || hasMe) return;
    if (rankedReclaimTried.current) return;
    rankedReclaimTried.current = true;
    void Promise.resolve().then(() => {
      setJoining(true);
      setJoinError(null);
      void joinRoom({ code: roomCode, clientId, name: displayName })
        .catch((err) => setJoinError(formatConvexError(err, "Could not rejoin")))
        .finally(() => setJoining(false));
    });
  }, [clientId, rankedRoom, signedIn, hasMe, joinRoom, roomCode, displayName]);

  async function onJoin(e: FormEvent) {
    e.preventDefault();
    if (!clientId || joining) return;
    const trimmed = (pendingJoinName || name).trim();
    if (!trimmed) {
      setJoinError("Enter your name");
      return;
    }
    setJoining(true);
    setJoinError(null);
    try {
      storeName(trimmed);
      if (pendingJoinName) takePendingJoinName();
      const result = await joinRoom({
        code: roomCode,
        clientId,
        name: trimmed,
        ...(data?.room.mode === "2v2" && joinTeam ? { team: joinTeam } : {}),
      });
      if ("pending" in result && result.pending) {
        setPendingRequestId(result.requestId);
      }
    } catch (err) {
      setJoinError(formatConvexError(err, "Could not join"));
    } finally {
      setJoining(false);
    }
  }

  async function onTroubleshoot() {
    if (!clientId || troubleBusy || isTroubleshootCoolingDown()) return;
    setTroubleBusy(true);
    // No roomId — join screen is pre-seat; membership check would fail.
    const snapshot = buildTroubleSnapshot({
      clientId,
      code: roomCode,
      screen: "join",
      lastError: joinError ?? undefined,
      roomStatus: data?.room.status,
      offline,
    });
    await runTroubleshoot({
      report: (s) => reportTrouble(s),
      snapshot,
      clearLocal: () => {
        setJoinError(null);
        setJoining(false);
        setPendingRequestId(null);
      },
    });
  }

  if (roomCode.length === 6 && roomLoading && clientId) {
    return <StatusText>Connecting…</StatusText>;
  }

  if (!clientId) {
    return <StatusText>Starting session…</StatusText>;
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

  if (pendingRequestId && !hasMe) {
    return (
      <div className={styles.center}>
        <h1>Waiting for host…</h1>
        <p>
          Your rejoin request was sent. The host needs to allow you back in.
        </p>
        <StatusText>Waiting for approval…</StatusText>
        <Button
          variant="secondary"
          onClick={() => {
            setPendingRequestId(null);
            setJoinError(null);
          }}
        >
          Cancel
        </Button>
        <Link href="/">Back home</Link>
      </div>
    );
  }

  if (!hasMe) {
    if (joining) {
      return <StatusText>Joining room…</StatusText>;
    }
    if (rankedRoom) {
      return (
        <div className={styles.center}>
          <h1>Ranked game {roomCode}</h1>
          <p>
            {signedIn
              ? "Only the matched players can sit in this game."
              : "This is a ranked game. Sign in with the account that was matched to rejoin."}
          </p>
          <ErrorText>{joinError}</ErrorText>
          <Link href="/">Back home</Link>
        </div>
      );
    }
    const midGame = roomStatus === "playing" || roomStatus === "finished";
    const teamMode = data?.room.mode === "2v2" && roomStatus === "lobby";
    const teamACount =
      data?.players.filter((p) => p.team === "A").length ?? 0;
    const teamBCount =
      data?.players.filter((p) => p.team === "B").length ?? 0;
    const joinNameReady = !!(pendingJoinName || name.trim());
    return (
      <div className={styles.center}>
        <h1>{midGame ? `Rejoin room ${roomCode}` : `Join room ${roomCode}`}</h1>
        <p>
          {midGame
            ? "Game already in progress — enter the same name you used before to request a rejoin."
            : teamMode && pendingJoinName
              ? "Choose your team — your name is already set from home."
              : teamMode
                ? "Pick a team and enter your name."
                : "Type your name to sit down."}
        </p>
        <form className={styles.joinForm} onSubmit={onJoin}>
          {teamMode && (
            <fieldset className={styles.fieldGroup}>
              <legend>Pick your team</legend>
              <div className={styles.optionList} role="radiogroup" aria-label="Team">
                <label
                  className={`${styles.option} ${teamACount >= 2 ? styles.optionDisabled : ""}`}
                >
                  <input
                    type="radio"
                    name="joinTeam"
                    checked={joinTeam === "A"}
                    disabled={teamACount >= 2}
                    onChange={() => setJoinTeam("A")}
                  />
                  <span className={styles.optionBody}>
                    <span className={styles.optionTitle}>Team A</span>
                    <span className={styles.optionMeta}>
                      Red & Yellow ·{" "}
                      {teamACount >= 2 ? "Full" : `${teamACount}/2 seats`}
                    </span>
                    <span className={styles.teamSwatches} aria-hidden>
                      <span
                        className={styles.teamSwatch}
                        style={{ background: COLOR_HEX.red }}
                      />
                      <span
                        className={styles.teamSwatch}
                        style={{ background: COLOR_HEX.yellow }}
                      />
                    </span>
                  </span>
                </label>
                <label
                  className={`${styles.option} ${teamBCount >= 2 ? styles.optionDisabled : ""}`}
                >
                  <input
                    type="radio"
                    name="joinTeam"
                    checked={joinTeam === "B"}
                    disabled={teamBCount >= 2}
                    onChange={() => setJoinTeam("B")}
                  />
                  <span className={styles.optionBody}>
                    <span className={styles.optionTitle}>Team B</span>
                    <span className={styles.optionMeta}>
                      Green & Blue ·{" "}
                      {teamBCount >= 2 ? "Full" : `${teamBCount}/2 seats`}
                    </span>
                    <span className={styles.teamSwatches} aria-hidden>
                      <span
                        className={styles.teamSwatch}
                        style={{ background: COLOR_HEX.green }}
                      />
                      <span
                        className={styles.teamSwatch}
                        style={{ background: COLOR_HEX.blue }}
                      />
                    </span>
                  </span>
                </label>
              </div>
            </fieldset>
          )}
          {pendingJoinName && !midGame ? (
            <p className={styles.joinAsName}>
              Joining as <strong>{pendingJoinName}</strong>
            </p>
          ) : (
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
          )}
          <Button
            type="submit"
            variant="primary"
            disabled={
              joining ||
              !joinNameReady ||
              !clientId ||
              (teamMode && !joinTeam)
            }
          >
            {midGame ? "Request rejoin" : "Join game"}
          </Button>
        </form>
        <ErrorText
          onTroubleshoot={() => void onTroubleshoot()}
          troubleBusy={troubleBusy}
          troubleDisabled={isTroubleshootCoolingDown()}
        >
          {joinError}
        </ErrorText>
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

  const mePlayer = data.players.find((p) => p.isMe);

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
      {!data.room.vsComputer && mePlayer && (
        <VoicePanel
          roomId={data.room._id}
          clientId={clientId}
          myColor={mePlayer.color}
          players={data.players.map((p) => ({
            name: p.name,
            color: p.color,
            isMe: p.isMe,
            isBot: p.isBot,
          }))}
        />
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
