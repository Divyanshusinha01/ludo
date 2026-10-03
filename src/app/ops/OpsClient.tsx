"use client";

import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Component, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { api } from "../../../convex/_generated/api";
import { minuteOf } from "../../../convex/lib/metrics";
import styles from "./ops.module.css";

type Dashboard = FunctionReturnType<typeof api.ops.dashboard>;

export const OPS_TOKEN_KEY = "ludo.opsDashboardToken";
const CLOCK_POLL_MS = 5_000;
const PER_MINUTE_ROWS = 15;

const tokenListeners = new Set<() => void>();

function readToken(): string | null {
  try {
    return sessionStorage.getItem(OPS_TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeToken(token: string | null): void {
  try {
    if (token === null) sessionStorage.removeItem(OPS_TOKEN_KEY);
    else sessionStorage.setItem(OPS_TOKEN_KEY, token);
  } catch {
    // Storage unavailable (private mode): the token lives only until reload.
  }
  for (const listener of tokenListeners) listener();
}

function subscribeToken(listener: () => void): () => void {
  tokenListeners.add(listener);
  return () => tokenListeners.delete(listener);
}

function subscribeClock(listener: () => void): () => void {
  const id = setInterval(listener, CLOCK_POLL_MS);
  return () => clearInterval(id);
}

/** Current minute bucket; queries cannot read the clock, so the client passes it. */
function useNowMinute(): number | null {
  return useSyncExternalStore(
    subscribeClock,
    () => minuteOf(Date.now()),
    () => null,
  );
}

function useStoredToken(): string | null | undefined {
  return useSyncExternalStore(subscribeToken, readToken, () => undefined);
}

export function OpsClient() {
  const token = useStoredToken();
  const [rejected, setRejected] = useState(false);

  if (token === undefined) return <p className={styles.muted}>Loading…</p>;
  if (token === null) {
    return (
      <TokenGate
        rejected={rejected}
        onSubmit={(value) => {
          setRejected(false);
          writeToken(value);
        }}
      />
    );
  }
  return (
    <QueryErrorBoundary
      key={token}
      onError={() => {
        setRejected(true);
        writeToken(null);
      }}
    >
      <DashboardView token={token} onSignOut={() => writeToken(null)} />
    </QueryErrorBoundary>
  );
}

function TokenGate({
  rejected,
  onSubmit,
}: {
  rejected: boolean;
  onSubmit: (token: string) => void;
}) {
  const [value, setValue] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (trimmed) onSubmit(trimmed);
  };
  return (
    <form className={styles.gate} onSubmit={submit}>
      <h1>Ops dashboard</h1>
      <label htmlFor="ops-token">Dashboard token</label>
      <input
        id="ops-token"
        type="password"
        autoComplete="off"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      {rejected && (
        <p className={styles.error} role="alert">
          Token rejected or dashboard unavailable.
        </p>
      )}
      <button type="submit" disabled={!value.trim()}>
        Open dashboard
      </button>
    </form>
  );
}

class QueryErrorBoundary extends Component<
  { onError: () => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onError();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function DashboardView({ token, onSignOut }: { token: string; onSignOut: () => void }) {
  const nowMinute = useNowMinute();
  const data = useQuery(
    api.ops.dashboard,
    nowMinute === null ? "skip" : { token, nowMinute },
  );

  return (
    <div className={styles.layout}>
      <header className={styles.header}>
        <div>
          <h1>Ops dashboard</h1>
          {data && (
            <p className={styles.muted}>
              Window {formatTime(data.windowStart)} – {formatTime(data.windowEnd)} UTC
            </p>
          )}
        </div>
        <button type="button" onClick={onSignOut}>
          Sign out
        </button>
      </header>
      {data === undefined ? (
        <p className={styles.muted}>Loading metrics…</p>
      ) : data.hasData ? (
        <DashboardBody data={data} />
      ) : (
        <p className={styles.empty} data-testid="ops-empty">
          No data in this window. Metrics appear after real traffic and the next
          minute rollup.
        </p>
      )}
    </div>
  );
}

function DashboardBody({ data }: { data: Dashboard }) {
  const { gauges, totals } = data;
  const recentMinutes = data.perMinute.slice(-PER_MINUTE_ROWS).reverse();
  return (
    <>
      <section className={styles.cards} aria-label="Summary">
        <Stat label="Active rooms" value={gauges ? String(gauges.activeRooms) : null} />
        <Stat label="Active players" value={gauges ? String(gauges.activePlayers) : null} />
        <Stat
          label="Connected players"
          value={gauges ? String(gauges.connectedPlayers) : null}
        />
        <Stat label="Error rate" value={formatRate(data.errorRate)} />
        <Stat label="Reconnect success" value={formatRate(data.reconnectSuccessRate)} />
        <Stat label="Stale mutations" value={String(totals.stale)} />
        <Stat label="Resyncs" value={String(totals.resyncs)} />
        <Stat label="Server mutations" value={String(totals.mutations)} />
      </section>

      <section aria-label="Latency">
        <h2>Client latency by kind</h2>
        {data.latency.length === 0 ? (
          <p className={styles.muted}>No latency samples.</p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Kind</th>
                <th>Samples</th>
                <th>p50</th>
                <th>p95</th>
                <th>p99</th>
              </tr>
            </thead>
            <tbody>
              {data.latency.map((row) => (
                <tr key={row.kind}>
                  <td>{row.kind}</td>
                  <td>{row.count}</td>
                  <td>{formatMs(row.p50)}</td>
                  <td>{formatMs(row.p95)}</td>
                  <td>{formatMs(row.p99)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-label="Per minute">
        <h2>Per minute</h2>
        {recentMinutes.length === 0 ? (
          <p className={styles.muted}>No rolled-up minutes.</p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Minute (UTC)</th>
                <th>Server mutations</th>
                <th>Client calls</th>
                <th>Failures</th>
                <th>Stale</th>
              </tr>
            </thead>
            <tbody>
              {recentMinutes.map((m) => (
                <tr key={m.minute}>
                  <td>{formatTime(m.minute)}</td>
                  <td>{m.mutations}</td>
                  <td>{m.clientCalls}</td>
                  <td>{m.failures}</td>
                  <td>{m.stale}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-label="Recent errors">
        <h2>Recent errors</h2>
        {data.recentErrors.length === 0 ? (
          <p className={styles.muted}>No errors recorded.</p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Time (UTC)</th>
                <th>Kind</th>
                <th>Code</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {data.recentErrors.map((e, i) => (
                <tr key={`${e.at}-${i}`}>
                  <td>{formatTime(e.at)}</td>
                  <td>{e.kind}</td>
                  <td>{e.code}</td>
                  <td>{e.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string | null }) {
  return (
    <div className={styles.card}>
      <span className={styles.cardLabel}>{label}</span>
      <span className={value === null ? styles.muted : styles.cardValue}>
        {value ?? "no data"}
      </span>
    </div>
  );
}

function formatTime(at: number): string {
  return new Date(at).toISOString().slice(11, 16);
}

function formatMs(ms: number): string {
  return `${Math.round(ms)} ms`;
}

function formatRate(rate: number | null): string | null {
  return rate === null ? null : `${(rate * 100).toFixed(1)}%`;
}
