/**
 * Join idempotency keys — reliability spec Gap 4 (§5), join dedupe.
 *
 * One key per join attempt, generated ONCE (`crypto.randomUUID()`) and
 * stored in localStorage keyed per room+codename BEFORE sending, sent
 * as the `Idempotency-Key` header on `POST /v1/rooms/:id/join` and
 * `POST /v1/rooms/join-by-code`. The server caches the join response —
 * including the reconnect token — by the key for 10 min; a retry with
 * the same key gets the cached response, token included, and the seat
 * is restored, not duplicated (the stranded-seat case: first join
 * response lost in transit → retry used to 403 "name taken").
 *
 * The key is NOT the reconnect token (which stays in sessionStorage,
 * mirrored for rejoin in `rejoin-token.ts`) and is useless after the
 * server's 10-min cache expires. A stored key is reused only within
 * that 10-min window; older keys are replaced with a fresh one. A
 * successful join clears its key — the seat is obtained, so any later
 * join is a new attempt with a fresh key (reusing a stale key after a
 * leave could return the dead seat's cached response).
 *
 * Key scope: (room, codename) — for join-by-code the room is the code
 * until the server resolves it, so the key is stored under the code
 * there. Same room + same codename = same seat intent, so reuse is
 * safe; a different codename always gets a fresh key.
 */
export const JOIN_KEY_TTL_MS = 600_000;

const JOIN_KEY_PREFIX = 'pakdam.join-key.v1.';

function keyFor(scope: string, codename: string): string {
  return `${JOIN_KEY_PREFIX}${scope.toLowerCase()}::${codename.trim().toLowerCase()}`;
}

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

interface StoredJoinKey {
  key: string;
  storedAtMs: number;
}

function readStored(scope: string, codename: string): StoredJoinKey | null {
  if (!isBrowser()) return null;
  try {
    const raw = window.localStorage.getItem(keyFor(scope, codename));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as StoredJoinKey).key !== 'string' ||
      typeof (parsed as StoredJoinKey).storedAtMs !== 'number'
    ) {
      return null;
    }
    return parsed as StoredJoinKey;
  } catch {
    return null;
  }
}

/**
 * The key to send for this join attempt: a stored key from a previous
 * attempt within the 10-min server-cache window (a retry after a lost
 * response), else a fresh UUID stored BEFORE sending. Never mints a
 * fresh key when a live one exists — that would defeat the dedupe.
 */
export function getOrCreateJoinKey(scope: string, codename: string): string {
  const stored = readStored(scope, codename);
  if (stored && Date.now() - stored.storedAtMs < JOIN_KEY_TTL_MS) {
    return stored.key;
  }
  const key = crypto.randomUUID();
  if (isBrowser()) {
    try {
      window.localStorage.setItem(
        keyFor(scope, codename),
        JSON.stringify({ key, storedAtMs: Date.now() } satisfies StoredJoinKey),
      );
    } catch {
      // Storage unavailable — the join still goes out with the fresh
      // key; only the lost-response retry loses its dedupe.
    }
  }
  return key;
}

/** Clear the stored key after a successful join (the seat is obtained). */
export function clearJoinKey(scope: string, codename: string): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.removeItem(keyFor(scope, codename));
  } catch {
    // Already gone or storage unavailable.
  }
}
