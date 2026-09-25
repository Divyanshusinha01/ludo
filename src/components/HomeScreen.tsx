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
import { bindAudioUnlock } from "@/lib/sounds";
import { InstallHint } from "./InstallHint";
import styles from "./HomeScreen.module.css";

export function HomeScreen() {
  const router = useRouter();
  const createRoom = useMutation(api.rooms.createRoom);
  const createVsComputer = useMutation(api.rooms.createVsComputer);
  const [mode, setMode] = useState<"home" | "join" | "computer">("home");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [botCount, setBotCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clientId = useSessionId();

  useEffect(() => {
    bindAudioUnlock();
  }, []);

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

  async function onVsComputer(e: FormEvent) {
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
      const res = await createVsComputer({
        clientId,
        name: trimmed,
        botCount,
      });
      router.push(`/room/${res.code}?rid=${res.roomId}`);
    } catch (err) {
      setError(formatConvexError(err, "Failed to start"));
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
          or challenge the computer.
        </p>
      </div>

      {mode === "home" ? (
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
            disabled={busy || !clientId}
            onClick={() => setMode("join")}
          >
            Join game
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={busy || !name.trim() || !clientId}
            onClick={() => {
              setError(null);
              setMode("computer");
            }}
          >
            Play vs computer
          </Button>
        </form>
      ) : mode === "computer" ? (
        <form className={styles.actions} onSubmit={onVsComputer}>
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
          <fieldset className={styles.botCount}>
            <legend>Computer opponents</legend>
            <div className={styles.botCountRow} role="group">
              {([1, 2, 3] as const).map((n) => (
                <button
                  key={n}
                  type="button"
                  className={
                    botCount === n ? styles.botCountActive : styles.botCountBtn
                  }
                  aria-pressed={botCount === n}
                  onClick={() => setBotCount(n)}
                >
                  {n}
                </button>
              ))}
            </div>
          </fieldset>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !name.trim() || !clientId}
          >
            Start game
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => setMode("home")}
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
            onClick={() => setMode("home")}
          >
            Back
          </Button>
        </form>
      )}

      <ErrorText>{error}</ErrorText>
      <InstallHint />
    </div>
  );
}
