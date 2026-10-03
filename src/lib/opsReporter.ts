import {
  clampLatency,
  errorCodeFor,
  outcomeForCode,
  type MetricKind,
  type MetricOutcome,
} from "../../convex/lib/metrics";

export type OpsEvent = {
  kind: MetricKind;
  outcome: MetricOutcome;
  latencyMs?: number;
  code?: string;
  message?: string;
};

export type OpsSend = (events: OpsEvent[]) => Promise<{ accepted: number }>;

export const OPS_FLUSH_MS = 15_000;
/** Server-side cap per reportClientEvents call. */
export const OPS_BATCH_MAX = 50;
/** Oldest events are dropped beyond this so a long outage can't grow memory. */
export const OPS_QUEUE_MAX = 200;

/** Server error message without Convex's "Uncaught Error:" wrapping. */
export function convexErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return "";
  const m = err.message.match(/Uncaught Error:\s*(.+?)(?:\s+at\s|$)/);
  return (m?.[1] ?? err.message).trim();
}

export function classifyError(err: unknown): {
  outcome: MetricOutcome;
  code: string;
  message: string;
} {
  const message = convexErrorMessage(err);
  const code = errorCodeFor(message);
  return { outcome: outcomeForCode(code), code, message };
}

export function isStaleError(err: unknown): boolean {
  return classifyError(err).code === "stale";
}

/**
 * Batches client-observed outcomes for `ops.reportClientEvents`. Sends are
 * serialized; a rate-limited (accepted: 0) or failed batch is requeued once
 * the next flush comes around.
 */
export class OpsReporter {
  private queue: OpsEvent[] = [];
  private sending = false;

  constructor(private send: OpsSend | null = null) {}

  /** Swap the transport, e.g. when the room or session changes. */
  setSend(send: OpsSend): void {
    this.send = send;
  }

  record(event: OpsEvent): void {
    const next: OpsEvent = { kind: event.kind, outcome: event.outcome };
    if (event.latencyMs !== undefined) next.latencyMs = clampLatency(event.latencyMs);
    if (event.code !== undefined) next.code = event.code;
    if (event.message) next.message = event.message;
    this.queue.push(next);
    if (this.queue.length > OPS_QUEUE_MAX) {
      this.queue.splice(0, this.queue.length - OPS_QUEUE_MAX);
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  async flush(): Promise<void> {
    const send = this.send;
    if (!send || this.sending || this.queue.length === 0) return;
    this.sending = true;
    const batch = this.queue.splice(0, OPS_BATCH_MAX);
    try {
      const { accepted } = await send(batch);
      if (accepted === 0) this.requeue(batch);
    } catch {
      this.requeue(batch);
    } finally {
      this.sending = false;
    }
  }

  private requeue(batch: OpsEvent[]): void {
    this.queue = [...batch, ...this.queue].slice(-OPS_QUEUE_MAX);
  }
}
