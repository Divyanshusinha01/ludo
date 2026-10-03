"use client";

import { useEffect, useRef, useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "../../convex/_generated/api";
import { QUEUES, QUEUE_NAMES, type QueueName } from "../../convex/lib/matchmaking";
import { useAuthState } from "@/lib/auth";
import { formatConvexError, useSessionId } from "@/lib/player";
import { Button, ErrorText } from "./ui";
import styles from "./HomeScreen.module.css";

/** Well inside STALE_TICKET_MS so one dropped ping never expires the ticket. */
const PING_INTERVAL_MS = 5_000;

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function roomHref(code: string, roomId: string): string {
  return `/room/${code}?rid=${roomId}`;
}

export function MatchmakingPanel({ disabled = false }: { disabled?: boolean }) {
  const router = useRouter();
  const { status: authStatus } = useAuthState();
  const { isAuthenticated } = useConvexAuth();
  const clientId = useSessionId();
  const signedIn = authStatus === "signedIn" && isAuthenticated;
  const status = useQuery(api.matchmaking.queueStatus, signedIn ? {} : "skip");
  const joinQueue = useMutation(api.matchmaking.joinQueue);
  const leaveQueue = useMutation(api.matchmaking.leaveQueue);
  const queuePing = useMutation(api.matchmaking.queuePing);
  const [queue, setQueue] = useState<QueueName>("duel");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  /** Only the tab that pressed Find match jumps into the room when matched. */
  const searchingHere = useRef(false);

  const waiting = status?.status === "waiting";

  useEffect(() => {
    if (status?.status !== "matched" || !searchingHere.current) return;
    searchingHere.current = false;
    router.push(roomHref(status.code, status.roomId));
  }, [status, router]);

  useEffect(() => {
    if (!waiting) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    const ping = window.setInterval(() => {
      void queuePing({}).catch(() => {});
    }, PING_INTERVAL_MS);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(ping);
    };
  }, [waiting, queuePing]);

  // Leaving the page cancels the search; a ticket that already matched is kept.
  useEffect(() => {
    if (!waiting) return;
    const onHide = () => {
      if (searchingHere.current) void leaveQueue({}).catch(() => {});
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [waiting, leaveQueue]);

  useEffect(
    () => () => {
      if (searchingHere.current) void leaveQueue({}).catch(() => {});
    },
    [leaveQueue],
  );

  async function onFind() {
    if (!clientId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await joinQueue({ clientId, queue });
      if (result.status === "matched" || result.status === "inGame") {
        router.push(roomHref(result.code, result.roomId));
        return;
      }
      searchingHere.current = true;
      setNow(Date.now());
    } catch (err) {
      setError(formatConvexError(err, "Could not join the queue"));
    } finally {
      setBusy(false);
    }
  }

  async function onCancel() {
    setBusy(true);
    setError(null);
    try {
      const result = await leaveQueue({});
      searchingHere.current = false;
      if (result.status === "matched") router.push(roomHref(result.code, result.roomId));
    } catch (err) {
      setError(formatConvexError(err, "Could not cancel"));
    } finally {
      setBusy(false);
    }
  }

  if (authStatus === "loading" || (authStatus === "signedIn" && !isAuthenticated)) return null;

  if (!signedIn) {
    return (
      <section className={styles.fieldGroup} aria-label="Ranked match">
        <p className={styles.hint}>Sign in on the home screen to play ranked matches.</p>
      </section>
    );
  }

  if (status?.status === "matched" || status?.status === "inGame") {
    return (
      <section className={styles.fieldGroup} aria-label="Ranked match">
        <p className={styles.hint} role="status">
          You have a ranked game in progress.
        </p>
        <Button
          type="button"
          variant="primary"
          onClick={() => router.push(roomHref(status.code, status.roomId))}
        >
          Rejoin game
        </Button>
      </section>
    );
  }

  if (waiting) {
    return (
      <section className={styles.fieldGroup} aria-label="Ranked match">
        <p className={styles.hint} role="status">
          Searching for {QUEUES[status.queue].label}…{" "}
          <span aria-label="Time searching">
            {formatElapsed(now ? now - status.joinedAt : 0)}
          </span>
        </p>
        <Button type="button" variant="secondary" disabled={busy} onClick={() => void onCancel()}>
          Cancel search
        </Button>
        <ErrorText>{error}</ErrorText>
      </section>
    );
  }

  return (
    <section className={styles.fieldGroup} aria-label="Ranked match">
      <fieldset className={styles.fieldGroup}>
        <legend>Ranked match</legend>
        <div className={styles.optionList} role="radiogroup" aria-label="Ranked queue">
          {QUEUE_NAMES.map((name) => (
            <label key={name} className={styles.option}>
              <input
                type="radio"
                name="rankedQueue"
                checked={queue === name}
                onChange={() => setQueue(name)}
              />
              {QUEUES[name].label}
            </label>
          ))}
        </div>
      </fieldset>
      <Button
        type="button"
        variant="primary"
        disabled={disabled || busy || !clientId || status === undefined}
        onClick={() => void onFind()}
      >
        Find match
      </Button>
      <ErrorText>{error}</ErrorText>
    </section>
  );
}
