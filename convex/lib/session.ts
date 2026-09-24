/** UUID v4-ish session ids from crypto.randomUUID(). */
const CLIENT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const MAX_CLIENT_ID_LEN = 64;
export const CREATE_RATE_WINDOW_MS = 15_000;

export function assertValidClientId(clientId: string): string {
  const id = clientId.trim();
  if (!id) throw new Error("Missing session");
  if (id.length > MAX_CLIENT_ID_LEN) throw new Error("Invalid session");
  if (!CLIENT_ID_RE.test(id)) throw new Error("Invalid session");
  return id;
}
