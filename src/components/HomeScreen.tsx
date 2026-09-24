"use client";

import { FormEvent, useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "../../convex/_generated/api";
import {
  getOrCreateClientId,
  getStoredName,
  storeName,
} from "@/lib/player";
import styles from "./HomeScreen.module.css";

export function HomeScreen() {
  const router = useRouter();
  const createRoom = useMutation(api.rooms.createRoom);
  const joinRoom = useMutation(api.rooms.joinRoom);
  const [mode, setMode] = useState<"home" | "join">("home");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientId, setClientId] = useState("");

  useEffect(() => {
    setClientId(getOrCreateClientId());
    setName(getStoredName());
  }, []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    if (!clientId) return;
    setBusy(true);
    setError(null);
    try {
      storeName(name);
      const res = await createRoom({ clientId, name });
      router.push(`/room/${res.code}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create");
    } finally {
      setBusy(false);
    }
  }

  async function onJoin(e: FormEvent) {
    e.preventDefault();
    if (!clientId) return;
    setBusy(true);
    setError(null);
    try {
      storeName(name);
      const res = await joinRoom({
        clientId,
        name,
        code: code.replace(/\D/g, "").slice(0, 6),
      });
      router.push(`/room/${res.code}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to join");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.shell}>
      <div className={styles.hero}>
        <p className={styles.brand}>Family Ludo</p>
        <h1 className={styles.headline}>Four phones. One board.</h1>
        <p className={styles.sub}>
          Create a room, share the code, and play together in realtime.
        </p>
      </div>

      {mode === "home" ? (
        <div className={styles.actions}>
          <label className={styles.field}>
            Your name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={20}
              placeholder="e.g. Divsi"
              autoComplete="nickname"
            />
          </label>
          <button
            type="button"
            className={styles.primary}
            disabled={busy || !name.trim()}
            onClick={onCreate}
          >
            Create game
          </button>
          <button
            type="button"
            className={styles.secondary}
            disabled={busy || !name.trim()}
            onClick={() => setMode("join")}
          >
            Join game
          </button>
        </div>
      ) : (
        <form className={styles.actions} onSubmit={onJoin}>
          <label className={styles.field}>
            Your name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={20}
              placeholder="e.g. Divsi"
              autoComplete="nickname"
            />
          </label>
          <label className={styles.field}>
            Room code
            <input
              value={code}
              onChange={(e) =>
                setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
              }
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="6-digit code"
              maxLength={6}
              autoComplete="one-time-code"
            />
          </label>
          <button
            type="submit"
            className={styles.primary}
            disabled={busy || !name.trim() || code.length !== 6}
          >
            Join room
          </button>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => setMode("home")}
          >
            Back
          </button>
        </form>
      )}

      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
