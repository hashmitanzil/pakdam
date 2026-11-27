/**
 * @pakdam/workers — admin Supabase client (Mission Control).
 *
 * A tiny generic PostgREST client for the admin tables. Unlike the
 * game persist helpers in supabase.ts (best-effort by design — the DO
 * stays the authority), admin reads/writes are LOAD-BEARING: admin
 * data lives in Supabase, so a failed call is a real failure and the
 * caller must answer 503, never silently pretend success. Every
 * helper returns null/false on failure and never throws.
 *
 * Tables live in migrations 0009_admin.sql / 0010_admin_billing.sql.
 * The service-role key is used (admin data has no RLS guest path —
 * RLS is HELD for the whole project per 0001_init.sql; the Worker is
 * the only reader/writer and enforces RBAC itself).
 *
 * NEVER stored here: raw coordinates (no admin table has a lat/lng
 * column — grep-proven, see docs/admin-console.md), raw tokens of any
 * kind (hashes only), raw passwords (PBKDF2 hashes only), card data
 * (no card data ever touches our servers — billing is future).
 */
import type { SupabaseEnv } from './supabase.js';

export type SbRow = Record<string, unknown>;

function sbHeaders(env: SupabaseEnv): Record<string, string> | null {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
}

/** Is admin storage configured at all? */
export function isAdminStorageConfigured(env: SupabaseEnv): boolean {
  return Boolean(env.SUPABASE_URL) && Boolean(env.SUPABASE_SERVICE_ROLE_KEY);
}

/** GET rows: `sbSelect(env, 'admin_users', 'select=*&username=eq.foo')`. */
export async function sbSelect(
  env: SupabaseEnv,
  table: string,
  query: string,
): Promise<SbRow[] | null> {
  const headers = sbHeaders(env);
  if (!headers) return null;
  try {
    const res = await fetch(`${env.SUPABASE_URL as string}/rest/v1/${table}?${query}`, {
      headers,
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as unknown;
    return Array.isArray(rows) ? (rows as SbRow[]) : null;
  } catch {
    return null;
  }
}

/** POST rows (insert). Returns the inserted rows (return=representation). */
export async function sbInsert(
  env: SupabaseEnv,
  table: string,
  rows: SbRow | SbRow[],
): Promise<SbRow[] | null> {
  const headers = sbHeaders(env);
  if (!headers) return null;
  try {
    const res = await fetch(`${env.SUPABASE_URL as string}/rest/v1/${table}`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=representation' },
      body: JSON.stringify(rows),
    });
    if (!res.ok) return null;
    const out = (await res.json()) as unknown;
    return Array.isArray(out) ? (out as SbRow[]) : null;
  } catch {
    return null;
  }
}

/** PATCH rows matching `query` (e.g. `id=eq.…`). Returns updated rows. */
export async function sbPatch(
  env: SupabaseEnv,
  table: string,
  query: string,
  patch: SbRow,
): Promise<SbRow[] | null> {
  const headers = sbHeaders(env);
  if (!headers) return null;
  try {
    const res = await fetch(`${env.SUPABASE_URL as string}/rest/v1/${table}?${query}`, {
      method: 'PATCH',
      headers: { ...headers, Prefer: 'return=representation' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) return null;
    const out = (await res.json()) as unknown;
    return Array.isArray(out) ? (out as SbRow[]) : null;
  } catch {
    return null;
  }
}

/** DELETE rows matching `query`. Returns true on HTTP success. */
export async function sbDelete(
  env: SupabaseEnv,
  table: string,
  query: string,
): Promise<boolean> {
  const headers = sbHeaders(env);
  if (!headers) return false;
  try {
    const res = await fetch(`${env.SUPABASE_URL as string}/rest/v1/${table}?${query}`, {
      method: 'DELETE',
      headers,
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Call a Postgres function via PostgREST (`POST /rest/v1/rpc/<fn>`).
 * Returns the parsed JSON body on HTTP success, null on any failure.
 * Used for the atomic setup RPC (migration 0011): the function
 * returns a structured {"ok": ...} object instead of raising, so
 * the caller can tell "already set up" from "storage down".
 */
export async function sbRpc(
  env: SupabaseEnv,
  fn: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const headers = sbHeaders(env);
  if (!headers) return null;
  try {
    const res = await fetch(`${env.SUPABASE_URL as string}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(args),
    });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

/** Delete every session row for one admin user (revocation). */
export async function revokeAdminSessions(env: SupabaseEnv, userId: string): Promise<boolean> {
  return sbDelete(env, 'admin_sessions', `user_id=eq.${encodeURIComponent(userId)}`);
}

/** COUNT helper: select only the id column and count the rows. */
export async function sbCount(
  env: SupabaseEnv,
  table: string,
  query: string,
): Promise<number | null> {
  const rows = await sbSelect(env, table, query);
  return rows === null ? null : rows.length;
}

/**
 * Exact row count via PostgREST `Prefer: count=exact` (the
 * Content-Range header carries `0-N/total`). Returns null on any
 * failure. Use for dashboard totals — never fetch all rows to count.
 */
export async function sbCountExact(
  env: SupabaseEnv,
  table: string,
  query: string,
): Promise<number | null> {
  const headers = sbHeaders(env);
  if (!headers) return null;
  try {
    const res = await fetch(`${env.SUPABASE_URL as string}/rest/v1/${table}?${query}`, {
      headers: { ...headers, Prefer: 'count=exact' },
    });
    if (!res.ok) return null;
    const range = res.headers.get('Content-Range');
    if (!range) return null;
    const total = Number(range.split('/')[1]);
    return Number.isFinite(total) ? total : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Blocks enforcement (shared by the admin console and the game join path)
// ---------------------------------------------------------------------------

export interface ActiveBlock {
  id: string;
  deviceId: string | null;
  playerId: string | null;
  reconnectTokenHash: string | null;
  action: 'ban' | 'suspend';
  reason: string | null;
  expiresAt: string | null;
}

/**
 * Is this reconnect-token hash actively blocked? The join path calls
 * this BEFORE the DO add-player op: a banned seat rejoining with its
 * stored reconnect token is refused 403. A fresh join with no token
 * cannot be matched to a block — there is no device key in the game
 * today, so a ban binds to the seat credential, not the hardware.
 * That limitation is stated in docs/admin-console.md; it is not
 * hidden. A block whose expires_at passed is not active.
 */
export async function isReconnectHashBlocked(
  env: SupabaseEnv,
  reconnectTokenHash: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (!reconnectTokenHash) return false;
  const rows = await sbSelect(
    env,
    'blocks',
    `select=id,expires_at&reconnect_token_hash=eq.${encodeURIComponent(reconnectTokenHash)}`,
  );
  if (!rows) return false;
  return rows.some((r) => {
    const exp = r['expires_at'];
    return typeof exp !== 'string' || Date.parse(exp) > nowMs;
  });
}

/** Active blocks for one player (ban/suspend status in the directory). */
export async function activeBlocksForPlayer(
  env: SupabaseEnv,
  playerId: string,
  nowMs: number = Date.now(),
): Promise<ActiveBlock[]> {
  // Narrow column list (n7): never select=* — the reconnect-token
  // hash is needed for the join gate, but no other column is.
  const rows = await sbSelect(
    env,
    'blocks',
    `select=id,device_id,player_id,reconnect_token_hash,action,reason,expires_at&player_id=eq.${encodeURIComponent(playerId)}&order=blocked_at.desc`,
  );
  if (!rows) return [];
  return rows
    .filter((r) => {
      const exp = r['expires_at'];
      return typeof exp !== 'string' || Date.parse(exp) > nowMs;
    })
    .map((r) => ({
      id: String(r['id'] ?? ''),
      deviceId: typeof r['device_id'] === 'string' ? (r['device_id'] as string) : null,
      playerId: typeof r['player_id'] === 'string' ? (r['player_id'] as string) : null,
      reconnectTokenHash:
        typeof r['reconnect_token_hash'] === 'string' ? (r['reconnect_token_hash'] as string) : null,
      action: r['action'] === 'suspend' ? 'suspend' : 'ban',
      reason: typeof r['reason'] === 'string' ? (r['reason'] as string) : null,
      expiresAt: typeof r['expires_at'] === 'string' ? (r['expires_at'] as string) : null,
    }));
}

// ---------------------------------------------------------------------------
// Per-(account + IP) login attempts (migration 0011, Zara B2)
// ---------------------------------------------------------------------------

export interface LoginAttemptRow {
  id: string;
  username: string;
  ipHash: string;
  failedAttempts: number;
  lockedUntil: string | null;
}

/**
 * Read the attempt row for one (username, ipHash) pair, or null.
 * A missing table (0011 not applied yet) reads as "no attempts" —
 * the HTTP per-IP login limiter is the backstop until the migration
 * lands, and the failure is visible in the login response only as
 * the lockout not arming (never as a 503 for a legitimate login).
 */
export async function getLoginAttempt(
  env: SupabaseEnv,
  username: string,
  ipHash: string,
): Promise<LoginAttemptRow | null> {
  const rows = await sbSelect(
    env,
    'admin_login_attempts',
    `select=id,username,ip_hash,failed_attempts,locked_until&username=eq.${encodeURIComponent(username)}&ip_hash=eq.${encodeURIComponent(ipHash)}&limit=1`,
  );
  const row = rows?.[0];
  if (!row) return null;
  return {
    id: String(row['id']),
    username: String(row['username']),
    ipHash: String(row['ip_hash']),
    failedAttempts: typeof row['failed_attempts'] === 'number' ? (row['failed_attempts'] as number) : 0,
    lockedUntil: typeof row['locked_until'] === 'string' ? (row['locked_until'] as string) : null,
  };
}

/**
 * Record one failed login for a pair. Read-then-write with a
 * conflict retry: if the insert loses a race against another
 * failure for the same pair (the (username, ip_hash) unique
 * constraint), the row is re-read and patched instead. Returns the
 * new state, or null when storage failed (the login still answers
 * 401 — a failed lockout write must never lock a legitimate user
 * out or grant access; it only means this failure was not counted).
 */
export async function recordFailedLoginAttempt(
  env: SupabaseEnv,
  username: string,
  ipHash: string,
  next: { failedAttempts: number; lockedUntil: string | null },
): Promise<{ failedAttempts: number; lockedUntil: string | null } | null> {
  const existing = await getLoginAttempt(env, username, ipHash);
  if (existing) {
    const patched = await sbPatch(
      env,
      'admin_login_attempts',
      `id=eq.${encodeURIComponent(existing.id)}`,
      { failed_attempts: next.failedAttempts, locked_until: next.lockedUntil, updated_at: new Date().toISOString() },
    );
    return patched === null ? null : next;
  }
  const inserted = await sbInsert(env, 'admin_login_attempts', {
    username,
    ip_hash: ipHash,
    failed_attempts: next.failedAttempts,
    locked_until: next.lockedUntil,
  });
  if (inserted !== null) return next;
  // Lost a race (or the table is missing): re-read; if the row is
  // there now, patch it. Otherwise this failure is not counted.
  const raced = await getLoginAttempt(env, username, ipHash);
  if (!raced) return null;
  const patched = await sbPatch(
    env,
    'admin_login_attempts',
    `id=eq.${encodeURIComponent(raced.id)}`,
    { failed_attempts: next.failedAttempts, locked_until: next.lockedUntil, updated_at: new Date().toISOString() },
  );
  return patched === null ? null : next;
}

/** Clear the attempt row for a pair (successful login from that IP). */
export async function clearLoginAttempts(
  env: SupabaseEnv,
  username: string,
  ipHash: string,
): Promise<void> {
  await sbDelete(
    env,
    'admin_login_attempts',
    `username=eq.${encodeURIComponent(username)}&ip_hash=eq.${encodeURIComponent(ipHash)}`,
  );
}

// ---------------------------------------------------------------------------
// Scheduled retention (called from the Worker scheduled handler)
// ---------------------------------------------------------------------------

/**
 * Delete expired admin sessions. Best-effort; returns false when
 * storage is unconfigured or the delete fails.
 */
export async function deleteExpiredAdminSessions(env: SupabaseEnv): Promise<boolean> {
  const now = new Date().toISOString();
  return sbDelete(env, 'admin_sessions', `expires_at=lt.${encodeURIComponent(now)}`);
}

/**
 * Delete admin audit rows older than 180 days. NOTE the deliberate
 * difference from the 7-day GAME log retention (deleteOldLogs in
 * supabase.ts): game logs are high-volume telemetry; the admin audit
 * log is a compliance record (CERT-In / DPDP evidence) and is kept
 * 180 days. See docs/admin-console.md §compliance.
 */
export async function deleteOldAdminAudit(env: SupabaseEnv): Promise<boolean> {
  const cutoff = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
  return sbDelete(env, 'admin_audit_log', `created_at=lt.${encodeURIComponent(cutoff)}`);
}

/**
 * Delete login-attempt rows older than 24 h. A lockout lasts 15 min,
 * so a 24 h cutoff never deletes a live lock; it only stops the
 * table growing by one row per (username, IP) pair that ever failed.
 */
export async function deleteOldLoginAttempts(env: SupabaseEnv): Promise<boolean> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  return sbDelete(env, 'admin_login_attempts', `updated_at=lt.${encodeURIComponent(cutoff)}`);
}
