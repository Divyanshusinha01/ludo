"use client";

import { useQuery } from "convex/react";
import { useMemo, useState } from "react";
import { api } from "../../../../../convex/_generated/api";
import { useSessionId } from "@/lib/player";
import {
  createEmptyState,
  replayWithTrace,
  type LudoEvent,
} from "../../../../../convex/lib/game";
import styles from "./ReplayClient.module.css";

type Props = { code: string };

export function ReplayClient({ code }: Props) {
  const clientId = useSessionId();
  const bundle = useQuery(api.rooms.getRoomByCode, {
    code,
    clientId: clientId ?? undefined,
  });
  const roomId = bundle?.room._id;
  const eventPage = useQuery(
    api.gameEvents.listEvents,
    roomId && clientId
      ? { roomId, clientId, afterSeq: 0, limit: 500 }
      : "skip",
  );

  const events = eventPage?.events ?? [];
  const [index, setIndex] = useState(0);

  const trace = useMemo(() => {
    if (events.length === 0) return { states: [createEmptyState()], error: undefined };
    return replayWithTrace(createEmptyState(), events as LudoEvent[]);
  }, [events]);

  const state = trace.states[Math.min(index, trace.states.length - 1)];

  if (!clientId) {
    return <p className={styles.muted}>Join this room in another tab first (session required).</p>;
  }
  if (bundle === undefined) return <p>Loading room…</p>;
  if (bundle === null) return <p>Room not found.</p>;

  return (
    <div className={styles.layout}>
      <header>
        <h1>Replay — {code}</h1>
        <p className={styles.muted}>
          Head seq {bundle.room.eventSeq} · {events.length} events loaded
        </p>
        {trace.error && (
          <p className={styles.error}>
            Replay error at seq {trace.error.seq}: {trace.error.reason}
          </p>
        )}
      </header>
      <div className={styles.panes}>
        <ol className={styles.list}>
          {events.map((e: LudoEvent, i: number) => (
            <li key={e.seq}>
              <button
                type="button"
                className={i === index ? styles.active : undefined}
                onClick={() => setIndex(i + 1)}
              >
                {e.seq} · {e.eventType}
              </button>
            </li>
          ))}
        </ol>
        <pre className={styles.inspector}>
          {JSON.stringify(
            {
              selectedEvent: events[index - 1] ?? null,
              state,
            },
            null,
            2,
          )}
        </pre>
      </div>
      <div className={styles.controls}>
        <button type="button" onClick={() => setIndex((i) => Math.max(0, i - 1))}>
          Prev
        </button>
        <button
          type="button"
          onClick={() =>
            setIndex((i) => Math.min(trace.states.length - 1, i + 1))
          }
        >
          Next
        </button>
      </div>
    </div>
  );
}
