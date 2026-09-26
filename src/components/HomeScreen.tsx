"use client";

import { FormEvent, useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "../../convex/_generated/api";
import { Button, ErrorText } from "./ui";
import {
  formatConvexError,
  normalizeCode,
  setPendingJoinName,
  storeName,
  useSessionId,
} from "@/lib/player";
import {
  buildTroubleSnapshot,
  isTroubleshootCoolingDown,
  runTroubleshoot,
} from "@/lib/troubleshoot";
import { bindAudioUnlock } from "@/lib/sounds";
import { InstallHint } from "./InstallHint";
import styles from "./HomeScreen.module.css";

export function HomeScreen() {
  const router = useRouter();
  const createRoom = useMutation(api.rooms.createRoom);
  const reportTrouble = useMutation(api.trouble.reportTrouble);
  const [mode, setMode] = useState<"home" | "online" | "create" | "join">(
    "home",
  );
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [troubleBusy, setTroubleBusy] = useState(false);
  const clientId = useSessionId();

  useEffect(() => {
    bindAudioUnlock();
  }, []);

  async function onTroubleshoot() {
    if (!clientId || troubleBusy || isTroubleshootCoolingDown()) return;
    setTroubleBusy(true);
    const snapshot = buildTroubleSnapshot({
      clientId,
      code: code || undefined,
      screen: "home",
      lastError: error ?? undefined,
    });
    await runTroubleshoot({
      report: (s) => reportTrouble(s),
      snapshot,
      clearLocal: () => {
        setError(null);
        setBusy(false);
      },
    });
  }
  async function onCreate(e: FormEvent) {
    e.preventDefault();
    if (!clientId) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Enter your name");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      storeName(trimmed);
      const res = await createRoom({ clientId, name: trimmed });
      router.push(`/room/${res.code}?rid=${res.roomId}`);
    } catch (err) {
      setError(formatConvexError(err, "Failed to create"));
    } finally {
      setBusy(false);
    }
  }

  function onJoin(e: FormEvent) {
    e.preventDefault();
    if (!clientId) return;
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Enter your name");
      return;
    }
    storeName(trimmed);
    setPendingJoinName(trimmed);
    const normalized = normalizeCode(code);
    if (normalized.length !== 6) {
      setError("Enter a 6-character room code");
      return;
    }
    // RoomClient owns join — avoids double-join races with Home.
    router.push(`/room/${normalized}`);
  }

  return (
    <div className={styles.shell}>
      <div className={styles.hero}>
        <p className={styles.brand}>Family Ludo</p>
        <h1 className={styles.headline}>Family phones. One board.</h1>
        <p className={styles.sub}>
          Create a room, share the code, and play with 2–4 people in realtime —
          or play offline on one device.
        </p>
      </div>

      {mode === "home" ? (
        <div className={styles.actions}>
          <Button
            type="button"
            variant="primary"
            disabled={busy}
            onClick={() => {
              setError(null);
              setMode("online");
            }}
          >
            Play Online
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => router.push("/offline")}
          >
            Play Offline
          </Button>
        </div>
      ) : mode === "online" ? (
        <div className={styles.actions}>
          <Button
            type="button"
            variant="primary"
            disabled={busy || !clientId}
            onClick={() => {
              setError(null);
              setMode("create");
            }}
          >
            Create Game
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={busy || !clientId}
            onClick={() => {
              setError(null);
              setMode("join");
            }}
          >
            Join Game
          </Button>
          {!clientId && (
            <p className={styles.hint} role="status">
              Preparing session…
            </p>
          )}
          <Button
            type="button"
            variant="secondary"
            onClick={() => setMode("home")}
          >
            Back
          </Button>
        </div>
      ) : mode === "create" ? (
        <form className={styles.actions} onSubmit={onCreate}>
          <label className={styles.field}>
            Your name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={20}
              placeholder="e.g. Divsi"
              autoComplete="off"
            />
          </label>
          {!clientId && (
            <p className={styles.hint} role="status">
              Preparing session…
            </p>
          )}
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !name.trim() || !clientId}
          >
            Create game
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => setMode("online")}
          >
            Back
          </Button>
        </form>
      ) : (
        <form className={styles.actions} onSubmit={onJoin}>
          <label className={styles.field}>
            Your name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={20}
              placeholder="e.g. Divsi"
              autoComplete="off"
            />
          </label>
          <label className={styles.field}>
            Room code
            <input
              value={code}
              onChange={(e) => setCode(normalizeCode(e.target.value))}
              inputMode="text"
              autoCapitalize="characters"
              placeholder="6-character code"
              maxLength={6}
              autoComplete="one-time-code"
            />
          </label>
          <Button
            type="submit"
            variant="primary"
            disabled={
              busy || !name.trim() || code.length !== 6 || !clientId
            }
          >
            Join room
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => setMode("online")}
          >
            Back
          </Button>
        </form>
      )}

      <ErrorText
        onTroubleshoot={
          clientId ? () => void onTroubleshoot() : undefined
        }
        troubleBusy={troubleBusy}
        troubleDisabled={isTroubleshootCoolingDown()}
      >
        {error}
      </ErrorText>
      <InstallHint />
    </div>
  );
}
