/**
 * @pakdam/workers — admin-account cryptography (Mission Control).
 *
 * Separate from the game guest flow: admin accounts are username +
 * password rows in `admin_users`, NOT Supabase Auth and NOT the game
 * seat tokens. Why a dedicated table (decision, on evidence):
 * - The game has no user accounts at all (guest-only, codenames +
 *   device keys). Supabase Auth would add a whole second identity
 *   system (GoTrue users, JWTs, RLS policies) for three humans.
 * - Admin credentials must never share a surface with game auth: a
 *   bug in the game's token flow must not be able to mint an admin,
 *   and an admin credential must never be usable as a game seat.
 * - A dedicated table keeps the lockout counters (failed_attempts,
 *   locked_until) next to the credential, so lockout survives Worker
 *   isolate eviction — an in-memory limiter alone would reset.
 * - Cost: we own password hashing. PBKDF2-SHA256 via WebCrypto (see
 *   below) is the conservative choice for a 3-human panel.
 *
 * Password hashing — PBKDF2-SHA256, 600,000 iterations, 16-byte
 * per-user salt, 32-byte output. Justification for the parameters:
 * - 600,000 iterations is the OWASP 2023 recommendation for
 *   PBKDF2-HMAC-SHA256 (it replaced the older 310,000 figure as
 *   hardware got faster). At ~600k the verify cost is ~300–600 ms
 *   of Worker CPU per login — acceptable for a human login (a few
 *   per day), and it makes offline guessing ~600k× slower than a
 *   single SHA-256. Argon2 would be stronger but has no WebCrypto
 *   implementation in Workers; shipping a WASM Argon2 for three
 *   humans is cost without benefit. bcrypt is not in WebCrypto
 *   either. PBKDF2 via subtle.deriveBits is the strongest KDF
 *   available natively in this runtime.
 * - 16-byte salt (128 bits): a salt collision across our handful of
 *   users is negligible, and identical passwords still hash
 *   differently. 32-byte output (256 bits): matches the hash width.
 * - Format: `pbkdf2-sha256$600000$<base64url salt>$<base64url hash>`.
 *   Parameters live IN the string so a future iteration bump can
 *   verify old hashes and re-hash on next login.
 *
 * Sessions — server-side `admin_sessions` rows, 12 h absolute expiry.
 * Token format: `v1.<sessionId>.<randomHex(32)>.<hmacHex>` where the
 * HMAC is HMAC-SHA256 over `v1.<sessionId>.<random>` keyed by
 * ADMIN_SESSION_SECRET. Only the SHA-256 of the WHOLE token is
 * stored (token_hash) — the raw token is never stored, never logged,
 * never in a URL (Bearer header only, like the game's reconnect
 * tokens). Validation = HMAC check + hash lookup + expiry + user not
 * disabled. Logout deletes the row (revocation is immediate, not
 * TTL-based).
 *
 * FAIL-CLOSED SECRETS (fix round, Zara n1): when ADMIN_SESSION_SECRET
 * is unset, minting a session is REFUSED (503) unless the deployment
 * explicitly opts into dev mode with ADMIN_DEV_MODE=true. In dev mode
 * the token carries the literal signature segment `nosecret` and
 * validation is hash-lookup only, and the Worker logs an ERROR (not
 * a warning) on mint. There is no silent fallback: production without
 * the secret cannot sign anyone in, by design. The first-Owner setup
 * therefore requires ADMIN_SESSION_SECRET (or explicit dev mode) to
 * be set BEFORE setup runs — the founder runbook says so.
 */
import { randomHex, sha256Hex } from '@pakdam/shared';
import { clientIp } from './rate-limit.js';

/** PBKDF2 iterations (OWASP 2023 for PBKDF2-HMAC-SHA256). */
export const ADMIN_PBKDF2_ITERATIONS = 600_000;
/** Per-user salt length, bytes. */
export const ADMIN_PBKDF2_SALT_BYTES = 16;
/** Derived-key length, bytes. */
export const ADMIN_PBKDF2_HASH_BYTES = 32;
/** Session lifetime: 12 h absolute (no sliding refresh). */
export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** Failed logins from one (account, IP) pair before THAT PAIR locks. */
export const ADMIN_LOGIN_ATTEMPT_LIMIT = 5;
/** Pair lockout duration: 15 min. */
export const ADMIN_LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
/** Minimum admin password length (12+; fix round n6). */
export const ADMIN_MIN_PASSWORD_LENGTH = 12;
/** Minimum admin username length (the setup page enforces 3). */
export const ADMIN_MIN_USERNAME_LENGTH = 3;

/** True when the deployment explicitly opts into dev mode (ADMIN_DEV_MODE=true). Only dev mode may mint/accept `nosecret` session tokens. */
export function isAdminDevMode(env: { ADMIN_DEV_MODE?: string }): boolean {
  return env.ADMIN_DEV_MODE === 'true';
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64urlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** Hash a password. Returns the stored `pbkdf2-sha256$...` string. */
export async function hashAdminPassword(password: string): Promise<string> {
  const salt = new Uint8Array(ADMIN_PBKDF2_SALT_BYTES);
  globalThis.crypto.getRandomValues(salt);
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: salt as BufferSource,
      iterations: ADMIN_PBKDF2_ITERATIONS,
    },
    key,
    ADMIN_PBKDF2_HASH_BYTES * 8,
  );
  return [
    'pbkdf2-sha256',
    String(ADMIN_PBKDF2_ITERATIONS),
    base64urlEncode(salt),
    base64urlEncode(new Uint8Array(bits)),
  ].join('$');
}

/**
 * Verify a password against a stored hash. A malformed stored hash
 * verifies as false (never throws, never grants). Uses the iteration
 * count stored in the hash, so old hashes keep verifying after a bump.
 */
export async function verifyAdminPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false;
    const iterations = Number(parts[1]);
    if (!Number.isInteger(iterations) || iterations < 1 || iterations > 2_000_000) return false;
    const salt = base64urlDecode(parts[2] as string);
    const expected = base64urlDecode(parts[3] as string);
    const key = await globalThis.crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      'PBKDF2',
      false,
      ['deriveBits'],
    );
    const bits = await globalThis.crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
      key,
      expected.length * 8,
    );
    const actual = new Uint8Array(bits);
    if (actual.length !== expected.length) return false;
    // Constant-time compare (lengths are equal here).
    let diff = 0;
    for (let i = 0; i < actual.length; i += 1) diff |= (actual[i] as number) ^ (expected[i] as number);
    return diff === 0;
  } catch {
    return false;
  }
}

/** Is this username shaped like an admin username (3–30 chars)? */
export function isValidAdminUsername(username: unknown): username is string {
  return (
    typeof username === 'string' &&
    username.trim().length >= ADMIN_MIN_USERNAME_LENGTH &&
    username.trim().length <= 30 &&
    /^[a-zA-Z0-9._-]+$/.test(username.trim())
  );
}

/** Is this password acceptable (≥ 12 chars)? */
export function isValidAdminPassword(password: unknown): password is string {
  return typeof password === 'string' && password.length >= ADMIN_MIN_PASSWORD_LENGTH;
}

/**
 * The login-attempt identity: SHA-256 of CF-Connecting-IP (the same
 * source the HTTP rate limiter uses — rate-limit.ts clientIp).
 * The raw IP is never stored (the attempts table carries the hash
 * only). 'unknown' (no CF header, e.g. direct dev access) hashes
 * like any other value — all unknown-IP logins share one pair bucket.
 */
export async function loginIpHash(req: Request): Promise<string> {
  return sha256Hex(clientIp(req));
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface MintedAdminToken {
  /** Raw token — returned to the client ONCE, never stored, never logged. */
  token: string;
  /** SHA-256 of the raw token — the only form stored (admin_sessions.token_hash). */
  tokenHash: string;
  /** Session id (the token's first segment). */
  sessionId: string;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await globalThis.crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(message),
  );
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Mint a session token for `sessionId`. When `secret` is set the
 * token carries an HMAC signature segment. When `secret` is unset
 * the token carries the literal `nosecret` segment — but ONLY when
 * `allowInsecureDev` is true (explicit ADMIN_DEV_MODE=true); with
 * no secret and no dev mode this THROWS, so a caller that forgot
 * the fail-closed check cannot mint by accident. Callers must check
 * first and answer 503; the throw is the backstop.
 */
export async function mintAdminToken(
  sessionId: string,
  secret?: string,
  allowInsecureDev: boolean = false,
): Promise<MintedAdminToken> {
  if (!secret && !allowInsecureDev) {
    throw new Error('ADMIN_SESSION_SECRET is not set and dev mode is off — refusing to mint an admin session.');
  }
  const random = randomHex(32);
  const unsigned = `v1.${sessionId}.${random}`;
  const sig = secret ? await hmacHex(secret, unsigned) : 'nosecret';
  const token = `${unsigned}.${sig}`;
  return { token, tokenHash: await sha256Hex(token), sessionId };
}

/** Parse a presented token into its segments (null when malformed). */
export function parseAdminToken(
  token: string,
): { sessionId: string; random: string; sig: string } | null {
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  const [, sessionId, random, sig] = parts as [string, string, string, string];
  if (!sessionId || !random || !sig) return null;
  return { sessionId, random, sig };
}

/**
 * Constant-time string equality. A length mismatch is false, never
 * an exception — the caller must not leak which of the two failed.
 * The same XOR-accumulate loop verifyAdminTokenSignature uses for
 * HMAC segments; the setup-token comparison uses it too (fix-round
 * hardening: the old plain `!==` leaked the comparison through
 * timing).
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ (b.charCodeAt(i) as number);
  }
  return diff === 0;
}

/**
 * Verify the HMAC segment of a presented token. Returns true when
 * the token carries a valid signature for `secret`. A `nosecret`
 * segment verifies ONLY when `allowInsecureDev` is true (explicit
 * dev mode) — in production a nosecret token is rejected outright,
 * even if it was minted before the secret was set. A forged
 * signature with a configured secret fails closed.
 */
export async function verifyAdminTokenSignature(
  token: string,
  secret?: string,
  allowInsecureDev: boolean = false,
): Promise<boolean> {
  const parsed = parseAdminToken(token);
  if (!parsed) return false;
  if (!secret) return allowInsecureDev && parsed.sig === 'nosecret';
  const unsigned = `v1.${parsed.sessionId}.${parsed.random}`;
  const expected = await hmacHex(secret, unsigned);
  return timingSafeEqual(expected, parsed.sig);
}

// ---------------------------------------------------------------------------
// Login lockout — per (account, IP) pair (fix round, Zara B2)
// ---------------------------------------------------------------------------

/**
 * Is this (account, IP) pair locked right now? Pure function over
 * the admin_login_attempts row, so the rule is testable without a
 * DB. A lockout is set after ADMIN_LOGIN_ATTEMPT_LIMIT failures
 * FROM THAT PAIR and lasts ADMIN_LOGIN_LOCKOUT_MS; a stale
 * locked_until in the past is not a lock.
 *
 * There is deliberately NO account-level lockout any more: the old
 * admin_users.failed_attempts/locked_until columns let an attacker
 * lock the Owner out indefinitely from arbitrary IPs (five wrong
 * passwords, no CAPTCHA). A pair lockout only ever locks the
 * attacker's own IP — the Owner logs in from their own IP
 * unaffected, and a distributed attacker needs a fresh IP per five
 * guesses (the HTTP per-IP login limiter, 5/15 min, is the outer
 * control on top).
 */
export function isPairLocked(
  failedAttempts: number,
  lockedUntil: string | null,
  nowMs: number = Date.now(),
): boolean {
  if (failedAttempts < ADMIN_LOGIN_ATTEMPT_LIMIT) return false;
  if (!lockedUntil) return false;
  return Date.parse(lockedUntil) > nowMs;
}

/**
 * After a failed login for a pair, what should the pair's row
 * carry? The 5th failure arms a 15-min lockout for that pair;
 * earlier failures only count.
 */
export function nextPairLoginState(
  failedAttempts: number,
  nowMs: number = Date.now(),
): { failedAttempts: number; lockedUntil: string | null } {
  const next = failedAttempts + 1;
  if (next >= ADMIN_LOGIN_ATTEMPT_LIMIT) {
    return { failedAttempts: next, lockedUntil: new Date(nowMs + ADMIN_LOGIN_LOCKOUT_MS).toISOString() };
  }
  return { failedAttempts: next, lockedUntil: null };
}

/** Is a session row expired (12 h absolute)? */
export function isSessionExpired(expiresAt: string, nowMs: number = Date.now()): boolean {
  return Date.parse(expiresAt) <= nowMs;
}
