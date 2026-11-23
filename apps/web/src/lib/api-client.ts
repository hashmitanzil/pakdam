/**
 * Idempotent-only HTTP retries — reliability spec Gap 4 (§5), client half.
 *
 * `fetchWithRetry` is the ONE retry wrapper for Worker HTTP calls. It
 * returns the final `Response` (after retries are exhausted) and never
 * reads the body — callers keep their existing `!response.ok` handling
 * (`LiveHttpError`, `readLiveErrorMessage`, the 403 host-token re-mint
 * in `postHost`) exactly as it is. A 403 is never retried here, so the
 * existing re-mint retry is never double-wrapped.
 *
 * Rules (spec §5):
 * - GET / PUT / DELETE: retried, max 3 attempts, exponential backoff
 *   500 ms → 5 s, only on 408 / 429 / 500 / 502 / 503 / 504, honouring
 *   `Retry-After` (seconds) when present.
 * - POST: attempted ONCE unless the caller supplies an idempotency key,
 *   in which case it is retried under the same rules. The key is
 *   generated ONCE per user action by the caller (`crypto.randomUUID()`)
 *   and reused across retries — never `Date.now()` per attempt — and
 *   sent as the `Idempotency-Key` header. The server caches the result
 *   keyed by it (join + join-by-code first).
 * - A failed attempt that throws (network down) is retried like a 503
 *   for GET/PUT/DELETE and for a keyed POST; an unkeyed POST throws
 *   after the first attempt.
 */
export interface FetchWithRetryOptions {
  /** Per-user-action idempotency key (POST only). Generated once by the caller. */
  idempotencyKey?: string;
  /** Max attempts including the first. Default 3 for retryable methods. */
  maxAttempts?: number;
}

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Delay before the next attempt. A `Retry-After` header (seconds, as
 * the Worker sends for DO rate limits) wins over the exponential
 * backoff — the server is telling us when to retry. Otherwise
 * exponential: 500 ms, 1 s, 2 s, 4 s, capped at 5 s.
 */
export function retryDelayMs(
  attempt: number,
  response?: { headers?: { get(name: string): string | null } } | null,
): number {
  const retryAfter = response?.headers?.get('Retry-After');
  if (retryAfter !== null && retryAfter !== undefined) {
    const seconds = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 30_000);
    }
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) {
      return Math.min(Math.max(dateMs - Date.now(), 0), 30_000);
    }
  }
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS);
}

function isRetryableMethod(method: string, idempotencyKey?: string): boolean {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'PUT' || m === 'DELETE') return true;
  // POST retries ONLY with a caller-supplied idempotency key.
  if (m === 'POST') return idempotencyKey !== undefined && idempotencyKey.length > 0;
  return false;
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  options: FetchWithRetryOptions = {},
): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  const retryable = isRetryableMethod(method, options.idempotencyKey);
  const maxAttempts = retryable ? (options.maxAttempts ?? 3) : 1;
  const headers = new Headers(init.headers ?? {});
  if (options.idempotencyKey) {
    headers.set('Idempotency-Key', options.idempotencyKey);
  }
  let lastResponse: Response | null = null;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, { ...init, method, headers });
      if (RETRYABLE_STATUSES.has(response.status) && attempt < maxAttempts) {
        lastResponse = response;
        await sleep(retryDelayMs(attempt, response));
        continue;
      }
      return response;
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        await sleep(retryDelayMs(attempt, null));
        continue;
      }
      throw err;
    }
  }
  // Unreachable in practice (the loop returns or throws), but keep the
  // type checker honest: the last retryable response, else the error.
  if (lastResponse) return lastResponse;
  throw lastError ?? new Error('Request failed.');
}

/** True when this status is retried by `fetchWithRetry` (test helper). */
export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status);
}
