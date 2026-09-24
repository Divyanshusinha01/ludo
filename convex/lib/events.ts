/** Bounded on-room activity log shared with every client. */

export type GameEvent = { at: number; text: string };

export const MAX_GAME_EVENTS = 100;

type EventSource = { events?: GameEvent[] };

export function withEvents(
  room: EventSource,
  texts: string[],
  now: number,
): { lastEvent: string; events: GameEvent[] } {
  const filtered = texts.map((t) => t.trim()).filter((t) => t.length > 0);
  let events = room.events ?? [];
  for (const text of filtered) {
    events = [...events, { at: now, text }];
  }
  if (events.length > MAX_GAME_EVENTS) {
    events = events.slice(-MAX_GAME_EVENTS);
  }
  const lastEvent = filtered[filtered.length - 1] ?? room.events?.at(-1)?.text ?? "";
  return { lastEvent, events };
}

export function withEvent(room: EventSource, text: string, now: number) {
  return withEvents(room, [text], now);
}

/** Replace the log (game start / rematch). */
export function freshEvents(texts: string[], now: number) {
  return withEvents({ events: [] }, texts, now);
}
