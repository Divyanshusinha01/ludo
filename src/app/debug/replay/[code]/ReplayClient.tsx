"use client";

import { useQueries, useQuery, type RequestForQueries } from "convex/react";
import type { FunctionReturnType } from "convex/server";
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
type EventPage = FunctionReturnType<typeof api.gameEvents.listEvents>;

/** Server-side cap on `listEvents` page size. */
export const EVENT_PAGE_SIZE = 200;

export function ReplayClient({ code }: Props) {
  const clientId = useSessionId();
  const bundle = useQuery(api.rooms.getRoomByCode, {
    code,
    clientId: clientId ?? undefined,
  });
  const roomId = bundle?.room._id;

  const [cursors, setCursors] = useState<number[]>([0]);
  const pageRequests = useMemo((): RequestForQueries => {
    if (!roomId || !clientId) return {};
    return Object.fromEntries(
      cursors.map((afterSeq) => [
        String(afterSeq),
        {
          query: api.gameEvents.listEvents,
          args: { roomId, clientId, afterSeq, limit: EVENT_PAGE_SIZE },
        },
      ]),
    );
  }, [roomId, clientId, cursors]);
  const pageResults = useQueries(pageRequests);

  const { events, loadedAllPages, nextAfterSeq } = useMemo(() => {
    const pages: EventPage[] = [];
    for (const afterSeq of cursors) {
      const page: unknown = pageResults[String(afterSeq)];
      if (page instanceof Error) throw page;
      if (page === undefined) break;
      pages.push(page as EventPage);
    }
    const loadedAll = pages.length === cursors.length;
    return {
      events: pages.flatMap((p) => p.events as LudoEvent[]),
      loadedAllPages: loadedAll,
      nextAfterSeq: loadedAll ? (pages.at(-1)?.nextAfterSeq ?? null) : null,
    };
  }, [pageResults, cursors]);

  if (nextAfterSeq !== null && !cursors.includes(nextAfterSeq)) {
    setCursors([...cursors, nextAfterSeq]);
  }

  const [index, setIndex] = useState(0);

  const trace = useMemo(() => {
    if (events.length === 0) return { states: [createEmptyState()], error: undefined };
    return replayWithTrace(createEmptyState(), events);
  }, [events]);

  const stateIndex = Math.min(index, trace.states.length - 1);
  const state = trace.states[stateIndex];

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
          {nextAfterSeq !== null || !loadedAllPages ? " (loading more…)" : ""}
        </p>
        {trace.error && (
          <p className={styles.error} role="alert">
            Replay error at seq {trace.error.seq}: {trace.error.reason}
          </p>
        )}
      </header>
      <div className={styles.panes}>
        <ol className={styles.list}>
          {events.map((e, i) => (
            <li key={e.seq}>
              <button
                type="button"
                className={i + 1 === stateIndex ? styles.active : undefined}
                aria-current={i + 1 === stateIndex ? "step" : undefined}
                onClick={() => setIndex(i + 1)}
              >
                {e.seq} · {e.eventType}
              </button>
            </li>
          ))}
        </ol>
        <pre className={styles.inspector} data-testid="replay-inspector">
          {JSON.stringify(
            {
              selectedEvent: events[stateIndex - 1] ?? null,
              state,
            },
            null,
            2,
          )}
        </pre>
      </div>
      <div className={styles.controls}>
        <button type="button" onClick={() => setIndex(Math.max(0, stateIndex - 1))}>
          Prev
        </button>
        <button
          type="button"
          onClick={() => setIndex(Math.min(trace.states.length - 1, stateIndex + 1))}
        >
          Next
        </button>
      </div>
    </div>
  );
}
