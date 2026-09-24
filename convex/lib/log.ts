/**
 * Structured production logs. Never include secrets or full session ids.
 */
export function logEvent(
  event: string,
  fields: Record<string, string | number | boolean | null | undefined> = {},
) {
  const safe: Record<string, string | number | boolean | null> = { event };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (key === "clientId" && typeof value === "string") {
      safe.clientId = value.slice(0, 8);
      continue;
    }
    safe[key] = value;
  }
  console.log(JSON.stringify(safe));
}
