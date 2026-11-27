/**
 * @pakdam/workers — Admin Console (Mission Control) HTTP handlers.
 *
 * Server side of the FIXED contract in apps/web/src/lib/admin/
 * admin-client.ts + packages/shared/src/admin.ts (Meera's client
 * shapes are the authority — response bodies are the bare payloads
 * the client types expect, NOT the game's `{ ok: true, ... }`
 * envelope; errors use the standard `{ error, code }` envelope).
 *
 * Enforcement rules (all server-side, never trust the client):
 * - Every /v1/admin/* route except the three public reads and the
 *   auth routes requires a valid admin session (Bearer token) AND
 *   the route's permission from the shared matrix (adminCan).
 * - Every MUTATING admin action writes an admin_audit_log row, and
 *   so do RBAC denials (403), auth events, Owner live-location
 *   views, and BULK/LIST reads (overview, rooms, players, flags,
 *   safety, metrics, audit, announcements, users, directory lists —
 *   so a silent bulk exfiltration leaves a trail). Single
 *   -item/detail reads are still NOT individually logged (they would
 *   drown the log); full per-read logging remains a founder call —
 *   see docs/admin-console.md OPEN-3. This is a deliberate,
 *   documented deviation from the brief's "every endpoint writes an
 *   audit row".
 * - Audit writes are retried once and failures are LOUD: a failed
 *   audit write logs a console.error and increments a health
 *   counter surfaced in the overview (auditHealth) — an audit row
 *   is never silently lost (fix round M4).
 * - Fail-closed secrets (fix round n1/n9): minting an admin session
 *   REFUSES when ADMIN_SESSION_SECRET is unset, unless the deploy
 *   explicitly opts into dev mode (ADMIN_DEV_MODE=true). Setup
 *   REFUSES when ADMIN_SETUP_TOKEN is unset. A console warning is
 *   not a control — these are refusals.
 * - Admin storage (Supabase) is LOAD-BEARING here, unlike the game's
 * - Admin storage (Supabase) is LOAD-BEARING here, unlike the game's
 *   best-effort persists: when Supabase is unconfigured or a query
 *   fails, admin endpoints answer 503, never a silent empty success.
 *   The three PUBLIC reads are the exception — they fall back to the
 *   shared defaults so the game home page keeps working.
 * - No raw coordinates are stored, logged, or returned by any admin
 *   table/endpoint except GET /v1/admin/players/:id/location
 *   (Owner-only, in-session only). The audit row for a location view
 *   records THAT it happened, by whom, when — never the coordinates.
 * - No password hashes are ever returned (users endpoints map rows
 *   to a public shape first). No card data exists anywhere.
 *
 * Billing & Accounts (founder scope addition 2026-11-25): the
 * billing endpoints and the data-requests / login-methods endpoints
 * are flag-gated and return the not-available shape while their
 * flags are OFF — with empty, honest data (never fake revenue or
 * fake users). The users-directory list/detail/ban/suspend/unban
 * are REAL today (guest players + blocks) and are NOT flag-gated:
 * the directory reads live guest data that already exists.
 */
import {
  ADMIN_CONFIG_DEFAULTS,
  ADMIN_CONFIG_LIMITS,
  ADMIN_FLAG_DEFS,
  ADMIN_FUTURE_FLAGS,
  FUTURE_UPGRADE_MESSAGE,
  HOST_PASS_PLAN,
  adminCan,
  adminConfigError,
  pickPublicAnnouncement,
  type AdminAnnouncement,
  type AdminFlag,
  type AdminFlagKey,
  type AdminFutureFlagKey,
  type AdminGameConfig,
  type AdminMe,
  type AdminPermission,
  type AdminRole,
} from '@pakdam/shared';
import { newId, sha256Hex } from '@pakdam/shared';
import {
  ADMIN_SESSION_TTL_MS,
  hashAdminPassword,
  isAdminDevMode,
  isPairLocked,
  isValidAdminPassword,
  isValidAdminUsername,
  loginIpHash,
  mintAdminToken,
  nextPairLoginState,
  timingSafeEqual,
  verifyAdminPassword,
  verifyAdminTokenSignature,
} from './admin-auth.js';
import {
  activeBlocksForPlayer,
  clearLoginAttempts,
  getLoginAttempt,
  isAdminStorageConfigured,
  recordFailedLoginAttempt,
  revokeAdminSessions,
  sbCount,
  sbCountExact,
  sbDelete,
  sbInsert,
  sbPatch,
  sbRpc,
  sbSelect,
  type SbRow,
} from './admin-db.js';
import { clearRuntimeFlagCache, getRuntimeFlags } from './admin-flags.js';
import {
  bearerToken,
  callDo,
  doError,
  err,
  isUuid,
  json,
  parseBody,
  type HttpContext,
} from './http.js';

/** Live room phases (a room in any of these counts as a live game). */
const LIVE_PHASES = [
  'LOBBY',
  'READY_CHECK',
  'COUNTDOWN',
  'HEAD_START',
  'ACTIVE',
  'SAFETY_PAUSED',
  'RESOLVING',
] as const;

/**
 * Phases in which the room host is protected from erasure (fix round
 * M3-A, 2026-11-26): the live phases PLUS 'DRAFT'. DRAFT is NOT a live
 * game — the overview's live-games count keeps it out — but a draft
 * still has a host, and erasing that host orphans the draft: no host
 * succession exists before LOBBY, so the draft could never start and
 * nobody could cancel it from inside the game. The host of a DRAFT
 * room is therefore refused 409 HOST_PROTECTED like a live-room host;
 * the Owner cancels the draft first (DRAFT → CANCELLED is a legal
 * transition, via the existing admin cancel), then erases. Terminal
 * phases (COMPLETED / CANCELLED / ABANDONED / EXPIRED) stay erasable:
 * "end or cancel first" is impossible for a room that already ended.
 */
const HOST_GUARD_PHASES = [...LIVE_PHASES, 'DRAFT'] as const;

/** Scrub page size for the erase JSONB scrub (fix round M3-4): the
 * scrub pages through the table instead of trusting one capped
 * select, so residue past the cap can never be reported as deleted. */
export const ERASE_SCRUB_PAGE_SIZE = 1000;

/** The Cloudflare free-plan Durable Objects daily cap (from the founder's Cloudflare usage email, 2026-11-22: 100,000/day). */
export const DO_DAILY_CAP = 100_000;

/**
 * The DO request meter is NOT queryable from the Worker without a
 * Cloudflare API token — there is no such binding, and inventing a
 * meter would be fake data. These endpoints report 0 for
 * doRequestsToday plus this note; the founder reads real usage in
 * the Cloudflare dashboard. See docs/admin-console.md.
 */
export const DO_METER_NOTE =
  'Cloudflare DO request usage is not queryable from the Worker — see the Cloudflare dashboard.';

/** 503 when admin storage is not configured. */
function storageUnavailable(): Response {
  return err('Admin storage is not set up yet — Supabase is not configured on this Worker.', 503, undefined, 'STORAGE_UNAVAILABLE');
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

// ---------------------------------------------------------------------------
// Auth: session validation + permission gate
// ---------------------------------------------------------------------------

export interface AdminIdentity {
  id: string;
  username: string;
  role: AdminRole;
  /** True when the account must rotate its password before doing anything else (fix round B3 re-review). */
  mustChangePassword: boolean;
}

type AuthResult =
  | { ok: true; user: AdminIdentity }
  | { ok: false; response: Response };

/**
 * Validate the Bearer admin session. Returns the identity or a 401.
 * Checks, in order: token present + well-formed, HMAC signature
 * (when ADMIN_SESSION_SECRET is configured), session row exists by
 * token hash, session not expired, user exists and is not disabled.
 * An expired session row is deleted on sight.
 *
 * FORCED ROTATION (fix round B3 re-review): when the user's
 * must_change_password flag is set, the session is refused with 403
 * PASSWORD_CHANGE_REQUIRED on every route EXCEPT the change-password
 * endpoint and logout — pass { allowMustChangePassword: true } for
 * those two callers. Login itself is NOT gated (it must succeed so
 * the client can redirect the user to the change page); the flag is
 * reported on the login response. The setup-created Owner is born
 * with the flag false, so the setup flow is unaffected.
 */
export async function authenticateAdmin(
  req: Request,
  ctx: HttpContext,
  opts?: { allowMustChangePassword?: boolean },
): Promise<AuthResult> {
  const token = bearerToken(req);
  if (!token) return { ok: false, response: err('Sign in to use the admin panel.', 401, undefined, 'UNAUTHORIZED') };
  const env = ctx.env as HttpContext['env'] & { ADMIN_SESSION_SECRET?: string; ADMIN_DEV_MODE?: string };
  const sigOk = await verifyAdminTokenSignature(token, env.ADMIN_SESSION_SECRET, isAdminDevMode(env));
  if (!sigOk) return { ok: false, response: err('Sign in to use the admin panel.', 401, undefined, 'UNAUTHORIZED') };
  if (!isAdminStorageConfigured(ctx.env)) return { ok: false, response: storageUnavailable() };
  const tokenHash = await sha256Hex(token);
  const sessions = await sbSelect(
    ctx.env,
    'admin_sessions',
    `select=id,user_id,expires_at&token_hash=eq.${encodeURIComponent(tokenHash)}`,
  );
  const session = sessions?.[0];
  if (!session) return { ok: false, response: err('Sign in to use the admin panel.', 401, undefined, 'UNAUTHORIZED') };
  const expiresAt = session['expires_at'];
  if (typeof expiresAt !== 'string' || Date.parse(expiresAt) <= Date.now()) {
    ctx.ctx.waitUntil(sbDelete(ctx.env, 'admin_sessions', `id=eq.${encodeURIComponent(String(session['id']))}`));
    return { ok: false, response: err('Your session ended. Sign in again.', 401, undefined, 'SESSION_EXPIRED') };
  }
  const users = await sbSelect(
    ctx.env,
    'admin_users',
    `select=id,username,role,disabled,must_change_password&id=eq.${encodeURIComponent(String(session['user_id']))}`,
  );
  const row = users?.[0];
  if (!row || row['disabled'] === true) {
    return { ok: false, response: err('Sign in to use the admin panel.', 401, undefined, 'UNAUTHORIZED') };
  }
  const role = row['role'];
  if (role !== 'owner' && role !== 'admin' && role !== 'staff') {
    return { ok: false, response: err('Sign in to use the admin panel.', 401, undefined, 'UNAUTHORIZED') };
  }
  const mustChangePassword = row['must_change_password'] === true;
  if (mustChangePassword && !opts?.allowMustChangePassword) {
    writeAudit(ctx, {
      actorId: String(row['id']),
      actorRole: role as AdminRole,
      action: 'admin.auth.passwordChangeRequired',
      target: null,
      detail: 'refused: password change required before any other admin action',
    });
    return { ok: false, response: err('You must change your password before using the admin panel.', 403, undefined, 'PASSWORD_CHANGE_REQUIRED') };
  }
  return {
    ok: true,
    user: { id: String(row['id']), username: String(row['username']), role: role as AdminRole, mustChangePassword },
  };
}

/**
 * Audit-write health (fix round M4). writeAudit never fails the
 * action it logs, but a failed audit write is never silent either:
 * the insert is retried once, and a second failure logs a
 * console.error AND increments this counter. The overview exposes
 * it (auditHealth) so the founder can see a broken audit pipeline.
 * Counters are per-isolate (in-memory); the audit rows themselves
 * are the durable record.
 */
let auditWriteFailures = 0;
let lastAuditWriteFailureAt: string | null = null;

export function getAuditHealth(): { writeFailures: number; lastWriteFailureAt: string | null } {
  return { writeFailures: auditWriteFailures, lastWriteFailureAt: lastAuditWriteFailureAt };
}

async function persistAuditRow(
  ctx: HttpContext,
  input: { actorId: string | null; actorRole: string | null; action: string; target: string | null; detail: string | null },
): Promise<void> {
  const row = {
    actor_id: input.actorId,
    actor_role: input.actorRole,
    action: input.action,
    target: input.target,
    detail: input.detail,
  };
  let inserted = await sbInsert(ctx.env, 'admin_audit_log', row);
  if (inserted === null) {
    // One retry — a transient Supabase blip must not eat an audit row.
    await new Promise((resolve) => setTimeout(resolve, 250));
    inserted = await sbInsert(ctx.env, 'admin_audit_log', row);
  }
  if (inserted === null) {
    auditWriteFailures += 1;
    lastAuditWriteFailureAt = new Date().toISOString();
    console.error(
      `ADMIN AUDIT WRITE FAILED (failure #${auditWriteFailures}): action=${input.action} actor=${input.actorId ?? 'system'} target=${input.target ?? '—'}. The action still ran — the audit row is LOST unless the caller retried it. Check Supabase now.`,
    );
  }
}

/** Write one admin_audit_log row (via waitUntil; retried once, failures loud — see persistAuditRow). */
export function writeAudit(
  ctx: HttpContext,
  input: { actorId: string | null; actorRole: string | null; action: string; target: string | null; detail: string | null },
): void {
  ctx.ctx.waitUntil(persistAuditRow(ctx, input));
}

/**
 * Authenticate + enforce one permission. Returns the identity, or a
 * Response to return directly (401 / 403 / 503). A 403 is audit-logged
 * (denied) when the caller could be identified. `opts` passes
 * through to authenticateAdmin — the change-password endpoint is
 * the only requireAdmin caller that sets allowMustChangePassword.
 */
export async function requireAdmin(
  req: Request,
  ctx: HttpContext,
  permission: AdminPermission,
  opts?: { allowMustChangePassword?: boolean },
): Promise<{ ok: true; user: AdminIdentity } | { ok: false; response: Response }> {
  const auth = await authenticateAdmin(req, ctx, opts);
  if (!auth.ok) return auth;
  if (!adminCan(auth.user.role, permission)) {
    // Denials log as `admin.<permission>` — the same `admin.*`
    // namespace as every mutation action (fix round item 9: the old
    // bare permission string made 'players.erase' (denial) and
    // 'admin.players.erase' (success) look like different actions).
    writeAudit(ctx, {
      actorId: auth.user.id,
      actorRole: auth.user.role,
      action: `admin.${permission}`,
      target: null,
      detail: 'denied: role lacks this permission',
    });
    return { ok: false, response: err("You don't have permission for this.", 403, undefined, 'FORBIDDEN') };
  }
  return auth;
}

// ---------------------------------------------------------------------------
// Auth endpoints
// ---------------------------------------------------------------------------

/** A well-formed dummy hash so a wrong-username login costs the same PBKDF2 work as a wrong-password one (no user-enumeration timing). */
const DUMMY_HASH = `pbkdf2-sha256$600000$AAAAAAAAAAAAAAAAAAAAAA$${'A'.repeat(43)}`;

/** POST /v1/admin/auth/login — {username, password} → {token, username, role, mustChangePassword}.
 *
 * Lockout is per (account, IP) pair (fix round B2 — there is NO
 * account-level lockout any more, so an attacker from arbitrary IPs
 * can never lock the Owner out). Timing oracle: EVERY failure path
 * runs exactly one PBKDF2 — unknown username, disabled account,
 * locked pair (dummy hash FIRST, then the 423), wrong password
 * (real hash) — so a locked account does not answer faster than a
 * wrong password. Fail-closed secret: minting refuses when
 * ADMIN_SESSION_SECRET is unset and dev mode is off (503).
 */
export async function handleAdminLogin(req: Request, ctx: HttpContext): Promise<Response> {
  const parsed = await parseBody(req);
  if (!parsed.ok) return parsed.response;
  const username = asString(parsed.body['username']);
  const password = asString(parsed.body['password']);
  if (!username || !password) {
    return err('Username and password are required.', 400, undefined, 'INVALID_CREDENTIALS');
  }
  if (!isAdminStorageConfigured(ctx.env)) return storageUnavailable();
  const env = ctx.env as HttpContext['env'] & { ADMIN_SESSION_SECRET?: string; ADMIN_DEV_MODE?: string };
  const devMode = isAdminDevMode(env);
  const ipHash = await loginIpHash(req);
  const trimmed = username.trim();
  // Narrow column list (n7): the hash is needed to verify, but no
  // other column is fetched (the old select=* over-fetched).
  const users = await sbSelect(
    ctx.env,
    'admin_users',
    `select=id,username,role,password_hash,disabled,must_change_password&username=eq.${encodeURIComponent(trimmed)}`,
  );
  if (users === null) return storageUnavailable();
  const row = users[0];
  // Unknown username: run the same PBKDF2 work, then answer the same 401.
  if (!row) {
    await verifyAdminPassword(password, DUMMY_HASH);
    return err('Wrong username or password. Check both and try again.', 401, undefined, 'INVALID_CREDENTIALS');
  }
  // A disabled account answers exactly like a wrong password (no leak).
  if (row['disabled'] === true) {
    await verifyAdminPassword(password, DUMMY_HASH);
    return err('Wrong username or password. Check both and try again.', 401, undefined, 'INVALID_CREDENTIALS');
  }
  // Pair lockout: only THIS (account, IP) is locked. The dummy
  // PBKDF2 runs FIRST so the 423 costs the same work as a 401.
  const attempt = await getLoginAttempt(ctx.env, trimmed, ipHash);
  if (attempt && isPairLocked(attempt.failedAttempts, attempt.lockedUntil)) {
    await verifyAdminPassword(password, DUMMY_HASH);
    return err('Too many wrong tries from this device — wait 15 minutes and try again.', 423, undefined, 'ACCOUNT_LOCKED');
  }
  const passwordHash = typeof row['password_hash'] === 'string' ? (row['password_hash'] as string) : '';
  const good = await verifyAdminPassword(password, passwordHash);
  if (!good) {
    const next = nextPairLoginState(attempt?.failedAttempts ?? 0);
    await recordFailedLoginAttempt(ctx.env, trimmed, ipHash, next);
    if (next.lockedUntil) {
      return err('Too many wrong tries from this device — wait 15 minutes and try again.', 423, undefined, 'ACCOUNT_LOCKED');
    }
    return err('Wrong username or password. Check both and try again.', 401, undefined, 'INVALID_CREDENTIALS');
  }
  const userId = String(row['id']);
  const role = row['role'] as AdminRole;
  // Fail closed on the session secret BEFORE minting anything.
  if (!env.ADMIN_SESSION_SECRET && !devMode) {
    console.error('ADMIN SESSION SECRET NOT CONFIGURED: refusing to mint an admin session. Set it (wrangler secret put ADMIN_SESSION_SECRET) or explicitly opt into dev mode (ADMIN_DEV_MODE=true).');
    return err('Admin sign-in is not configured — the session secret is missing. Ask the Owner to set ADMIN_SESSION_SECRET.', 503, undefined, 'SESSION_SECRET_UNCONFIGURED');
  }
  if (!env.ADMIN_SESSION_SECRET && devMode) {
    console.error('ADMIN DEV MODE: minting a nosecret admin session (ADMIN_SESSION_SECRET unset). Dev only — never run production like this.');
  }
  const sessionId = newId();
  const minted = await mintAdminToken(sessionId, env.ADMIN_SESSION_SECRET, devMode);
  const expiresAt = new Date(Date.now() + ADMIN_SESSION_TTL_MS).toISOString();
  const inserted = await sbInsert(ctx.env, 'admin_sessions', {
    id: sessionId,
    user_id: userId,
    token_hash: minted.tokenHash,
    expires_at: expiresAt,
  });
  if (!inserted) return storageUnavailable();
  await clearLoginAttempts(ctx.env, trimmed, ipHash);
  await sbPatch(ctx.env, 'admin_users', `id=eq.${encodeURIComponent(userId)}`, {
    last_login_at: new Date().toISOString(),
  });
  writeAudit(ctx, { actorId: userId, actorRole: role, action: 'admin.login', target: null, detail: null });
  return json({
    ok: true,
    token: minted.token,
    username: String(row['username']),
    role,
    mustChangePassword: row['must_change_password'] === true,
  });
}

/** POST /v1/admin/auth/logout — deletes the session row (revocation). Best-effort: always 200.
 * Logout stays available to flagged accounts (authenticateAdmin with
 * allowMustChangePassword) — a user who must rotate must still be
 * able to sign out instead of being trapped in the panel. */
export async function handleAdminLogout(req: Request, ctx: HttpContext): Promise<Response> {
  const auth = await authenticateAdmin(req, ctx, { allowMustChangePassword: true });
  if (!auth.ok) return json({ ok: true });
  const token = bearerToken(req);
  if (token) {
    const tokenHash = await sha256Hex(token);
    await sbDelete(ctx.env, 'admin_sessions', `token_hash=eq.${encodeURIComponent(tokenHash)}`);
  }
  writeAudit(ctx, { actorId: auth.user.id, actorRole: auth.user.role, action: 'admin.logout', target: null, detail: null });
  return json({ ok: true });
}

/** GET /v1/admin/auth/me — {username, role, mustChangePassword}.
 * A flagged account is refused here too (403 PASSWORD_CHANGE_REQUIRED,
 * via authenticateAdmin) — /me is an admin route like any other; the
 * client shell treats a non-401 failure as "trust the stored session",
 * so the change-password page still renders. */
export async function handleAdminMe(req: Request, ctx: HttpContext): Promise<Response> {
  const auth = await authenticateAdmin(req, ctx);
  if (!auth.ok) return auth.response;
  const me: AdminMe = { username: auth.user.username, role: auth.user.role, mustChangePassword: auth.user.mustChangePassword };
  return json(me);
}

/**
 * POST /v1/admin/auth/setup — first Owner account. Works ONLY when
 * zero admin_users exist (409 afterwards — the endpoint becomes
 * inert). Body: {username, password, setupToken}.
 *
 * FAIL-CLOSED (fix round B1): ADMIN_SETUP_TOKEN is REQUIRED. When
 * it is not configured, setup is REFUSED outright (503) — there is
 * no "allow with a warning" path any more. When it IS configured,
 * an absent OR wrong setupToken → 403, no exceptions (absent and
 * wrong answer identically, so there is no oracle). The setup page
 * sends the token (Meera added the field).
 *
 * TOCTOU (fix round B1): the zero-admins check + insert run inside
 * the admin_setup_owner() Postgres function (migration 0011), which
 * takes a transaction-scoped advisory lock — two concurrent first
 * setups serialize, and the loser gets already_setup (409). The
 * Worker NEVER does select-then-insert here.
 */
export async function handleAdminSetup(req: Request, ctx: HttpContext): Promise<Response> {
  const parsed = await parseBody(req);
  if (!parsed.ok) return parsed.response;
  const username = asString(parsed.body['username']);
  const password = asString(parsed.body['password']);
  const setupToken = asString(parsed.body['setupToken']);
  if (!username || !isValidAdminUsername(username)) {
    return err('Pick a username with at least 3 characters (letters, digits, . _ -).', 400);
  }
  if (!isValidAdminPassword(password)) {
    return err('Pick a password with at least 12 characters.', 400);
  }
  if (!isAdminStorageConfigured(ctx.env)) return storageUnavailable();
  const env = ctx.env as HttpContext['env'] & { ADMIN_SETUP_TOKEN?: string; ADMIN_SESSION_SECRET?: string; ADMIN_DEV_MODE?: string };
  // Fail closed: no setup token configured → no setup, ever.
  if (!env.ADMIN_SETUP_TOKEN) {
    console.error('ADMIN SETUP REFUSED: ADMIN_SETUP_TOKEN is not configured. Set it (wrangler secret put ADMIN_SETUP_TOKEN) before first-Owner setup.');
    return err('Setup is not configured — set ADMIN_SETUP_TOKEN first, then try again.', 503, undefined, 'SETUP_TOKEN_UNCONFIGURED');
  }
  // Absent and wrong answer identically (no oracle). The comparison
  // is constant-time (timingSafeEqual — same loop as the session
  // HMAC check), so a wrong token of any length answers identically.
  if (!setupToken || !timingSafeEqual(setupToken, env.ADMIN_SETUP_TOKEN)) {
    return err('Setup token is wrong.', 403, undefined, 'FORBIDDEN');
  }
  // The session secret is needed to mint the setup session — fail
  // fast BEFORE creating the Owner, so a missing secret cannot
  // strand a half-set-up account.
  const devMode = isAdminDevMode(env);
  if (!env.ADMIN_SESSION_SECRET && !devMode) {
    console.error('ADMIN SETUP REFUSED: ADMIN_SESSION_SECRET is not set (and dev mode is off) — the setup session cannot be minted. Set it first.');
    return err('Setup cannot mint a session — ADMIN_SESSION_SECRET is missing. Set it first.', 503, undefined, 'SESSION_SECRET_UNCONFIGURED');
  }
  const passwordHash = await hashAdminPassword(password);
  // Atomic, DB-level: advisory lock + zero-admin check + insert in
  // one RPC call. Never select-then-insert here (TOCTOU).
  const created = (await sbRpc(ctx.env, 'admin_setup_owner', {
    p_username: username.trim(),
    p_password_hash: passwordHash,
  })) as { ok?: unknown; id?: unknown; error?: unknown } | null;
  if (created === null) return storageUnavailable();
  if (created.ok !== true) {
    if (created.error === 'already_setup') {
      return err('An Owner account already exists — sign in instead.', 409, undefined, 'SETUP_ALREADY_DONE');
    }
    return storageUnavailable();
  }
  const userId = String(created.id ?? '');
  if (!userId) return storageUnavailable();
  if (!env.ADMIN_SESSION_SECRET && devMode) {
    console.error('ADMIN DEV MODE: minting a nosecret admin session for setup (ADMIN_SESSION_SECRET unset). Dev only — never run production like this.');
  }
  const sessionId = newId();
  const minted = await mintAdminToken(sessionId, env.ADMIN_SESSION_SECRET, devMode);
  const sessionInserted = await sbInsert(ctx.env, 'admin_sessions', {
    id: sessionId,
    user_id: userId,
    token_hash: minted.tokenHash,
    expires_at: new Date(Date.now() + ADMIN_SESSION_TTL_MS).toISOString(),
  });
  if (!sessionInserted) return storageUnavailable();
  writeAudit(ctx, {
    actorId: userId,
    actorRole: 'owner',
    action: 'admin.setup',
    target: null,
    detail: null,
  });
  return json({ ok: true, token: minted.token, username: username.trim(), role: 'owner' }, 201);
}

/**
 * POST /v1/admin/auth/change-password — SELF-SERVICE for any signed-in
 * admin (users.changePassword is held by every role — fix round B3
 * re-review). {currentPassword, newPassword} → re-hashes with PBKDF2
 * and revokes ALL sessions for the caller (including the one making
 * this call — the client must sign in again with the new password).
 * A password change also clears must_change_password.
 *
 * OWN PASSWORD ONLY: the endpoint operates solely on the caller's
 * session identity (gate.user.id) and takes NO target-user parameter
 * of any kind — there is nothing in the request that could select
 * another account, so a non-Owner can never change anyone else's
 * password through it. Changing another account's password stays
 * Owner-only via PUT /v1/admin/users/:id {password} (users.manage),
 * which forces rotation on next login.
 *
 * A flagged account (must_change_password) reaches this endpoint
 * because requireAdmin is called with allowMustChangePassword — it
 * is the one mutating route a flagged session may use, alongside
 * logout. Every other admin route refuses a flagged session with
 * 403 PASSWORD_CHANGE_REQUIRED (see authenticateAdmin).
 */
export async function handleAdminChangePassword(req: Request, ctx: HttpContext): Promise<Response> {
  const gate = await requireAdmin(req, ctx, 'users.changePassword', { allowMustChangePassword: true });
  if (!gate.ok) return gate.response;
  const parsed = await parseBody(req);
  if (!parsed.ok) return parsed.response;
  const currentPassword = asString(parsed.body['currentPassword']);
  const newPassword = asString(parsed.body['newPassword']);
  if (!currentPassword || !newPassword) {
    return err('currentPassword and newPassword are required.', 400);
  }
  if (!isValidAdminPassword(newPassword)) {
    return err('Pick a password with at least 12 characters.', 400);
  }
  if (!isAdminStorageConfigured(ctx.env)) return storageUnavailable();
  const rows = await sbSelect(
    ctx.env,
    'admin_users',
    `select=id,password_hash&id=eq.${encodeURIComponent(gate.user.id)}`,
  );
  if (rows === null) return storageUnavailable();
  const row = rows[0];
  if (!row) return err('Sign in to use the admin panel.', 401, undefined, 'UNAUTHORIZED');
  const stored = typeof row['password_hash'] === 'string' ? (row['password_hash'] as string) : '';
  const good = await verifyAdminPassword(currentPassword, stored);
  if (!good) {
    return err('The current password is wrong.', 401, undefined, 'INVALID_CREDENTIALS');
  }
  const newHash = await hashAdminPassword(newPassword);
  const updated = await sbPatch(ctx.env, 'admin_users', `id=eq.${encodeURIComponent(gate.user.id)}`, {
    password_hash: newHash,
    must_change_password: false,
  });
  if (updated === null) return storageUnavailable();
  // Revoke EVERY session for this user — including this one. The
  // caller re-authenticates with the new password.
  await revokeAdminSessions(ctx.env, gate.user.id);
  writeAudit(ctx, {
    actorId: gate.user.id,
    actorRole: gate.user.role,
    action: 'admin.users.changePassword',
    target: gate.user.id,
    detail: 'password changed; all sessions revoked',
  });
  return json({ ok: true, reLogin: true });
}

/**
 * POST /v1/admin/users/:id/revoke-sessions — Owner only
 * (users.manage). Deletes every admin_sessions row for that user, so
 * all of their signed-in tabs/devices are signed out at once. Used
 * directly (compromised account) and internally by password change,
 * disable and delete.
 */
export async function handleAdminRevokeSessions(req: Request, ctx: HttpContext, id: string): Promise<Response> {
  const gate = await requireAdmin(req, ctx, 'users.manage');
  if (!gate.ok) return gate.response;
  if (!isUuid(id)) return err('Invalid user id.', 400);
  if (!isAdminStorageConfigured(ctx.env)) return storageUnavailable();
  const rows = await sbSelect(ctx.env, 'admin_users', `select=id,username&id=eq.${encodeURIComponent(id)}`);
  if (rows === null) return storageUnavailable();
  if (!rows[0]) return err('That account was not found.', 404);
  const revoked = await revokeAdminSessions(ctx.env, id);
  if (!revoked) return storageUnavailable();
  writeAudit(ctx, {
    actorId: gate.user.id,
    actorRole: gate.user.role,
    action: 'admin.users.revokeSessions',
    target: id,
    detail: `all sessions revoked for ${String(rows[0]['username'])}`,
  });
  return json({ ok: true });
}

/**
 * True when this user is the SOLE enabled Owner (the last-owner
 * guard's fast path). Used when a demote/disable/delete write fails:
 * if the DB trigger fired (the race the pre-check missed), the
 * target is still the sole enabled Owner — answer 409 LAST_OWNER,
 * not 503. If the re-read itself fails, the caller answers 503.
 */
async function isSoleEnabledOwner(ctx: HttpContext, userId: string): Promise<boolean | null> {
  const owners = await sbSelect(ctx.env, 'admin_users', 'select=id&role=eq.owner&disabled=eq.false&limit=10');
  if (owners === null) return null;
  return owners.length === 1 && String(owners[0]?.['id']) === userId;
}

// ---------------------------------------------------------------------------
// Overview + rooms + players (live data: Supabase mirror + RoomDO)
// ---------------------------------------------------------------------------

/** GET /v1/admin/overview — live counts. DO usage is NOT measured (see DO_METER_NOTE). */
export async function handleAdminOverview(req: Request, ctx: HttpContext): Promise<Response> {
  const gate = await requireAdmin(req, ctx, 'view.overview');
  if (!gate.ok) return gate.response;
  if (!isAdminStorageConfigured(ctx.env)) return storageUnavailable();
  const rooms = await sbSelect(ctx.env, 'rooms', 'select=room_id,phase&limit=500');
  const players = await sbSelect(ctx.env, 'players', 'select=player_id,connection_state,left_at&limit=1000');
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const errors = await sbCount(ctx.env, 'logs', `select=id&level=eq.error&created_at=gte.${encodeURIComponent(oneHourAgo)}&limit=1000`);
  const liveGames = (rooms ?? []).filter((r) => (LIVE_PHASES as readonly string[]).includes(String(r['phase']))).length;
  const roomsOpen = (rooms ?? []).filter((r) => r['phase'] === 'LOBBY').length;
  const playersOnline = (players ?? []).filter(
    (p) => p['connection_state'] === 'connected' && p['left_at'] === null,
  ).length;
  const env = ctx.env as HttpContext['env'] & {
    ADMIN_SESSION_SECRET?: string;
    ADMIN_SETUP_TOKEN?: string;
    DO_OP_SECRET?: string;
  };
  // Bulk-read audit (fix round M4 re-review): the overview is a
  // bulk read of rooms + players, so it leaves a trail like the
  // other list reads (row counts only — no room/player data).
  writeAudit(ctx, { actorId: gate.user.id, actorRole: gate.user.role, action: 'admin.overview.listRead', target: null, detail: `bulk read: ${(rooms ?? []).length} rooms, ${(players ?? []).length} players` });
  return json({
    liveGames,
    playersOnline,
    roomsOpen,
    workerOk: true,
    errorsLastHour: errors ?? 0,
    doRequestsToday: 0,
    doMeter: DO_METER_NOTE,
    // Health signals (fix round M4 + n1/n9): audit-write failures
    // are surfaced here (never silently lost), and secret
    // configuration is visible as booleans (never the values).
    auditHealth: getAuditHealth(),
    secretsConfigured: {
      sessionSecret: Boolean(env.ADMIN_SESSION_SECRET),
      setupToken: Boolean(env.ADMIN_SETUP_TOKEN),
      doOpSecret: Boolean(env.DO_OP_SECRET),
    },
  });
}

/** GET /v1/admin/rooms — AdminRoomRow[] from the Supabase mirror (up to ~30 s stale — player upserts are throttled; the DO is live truth). */
export async function handleAdminRooms(req: Request, ctx: HttpContext): Promise<Response> {
  const gate = await requireAdmin(req, ctx, 'view.rooms');
  if (!gate.ok) return gate.response;
  if (!isAdminStorageConfigured(ctx.env)) return storageUnavailable();
  const rooms = await sbSelect(ctx.env, 'rooms', 'select=room_id,room_code,phase,started_at&order=created_at.desc&limit=100');
  const players = await sbSelect(ctx.env, 'players', 'select=room_id,left_at&limit=2000');
  if (rooms === null || players === null) return storageUnavailable();
  const counts = new Map<string, number>();
  for (const p of players) {
    if (p['left_at'] !== null) continue;
    const rid = String(p['room_id']);
    counts.set(rid, (counts.get(rid) ?? 0) + 1);
  }
  // Bulk-read audit (fix round item 10): a list read is a bulk
  // exfiltration surface, so it leaves a trail (row count only —
  // no room/player data in the audit row).
  writeAudit(ctx, { actorId: gate.user.id, actorRole: gate.user.role, action: 'admin.rooms.listRead', target: null, detail: `bulk read: ${rooms.length} rooms` });
  return json(
    rooms.map((r) => ({
      id: String(r['room_id']),
      code: String(r['room_code']),
      phase: String(r['phase']),
      players: counts.get(String(r['room_id'])) ?? 0,
      startedAt: typeof r['started_at'] === 'string' ? (r['started_at'] as string) : null,
      // The room config carries a zone BOUNDARY, not a single radius — no honest single number exists.
      zoneRadiusMetres: null,
    })),
  );
}

/** GET /v1/admin/rooms/:id — live detail from the RoomDO (admin-summary op). */
export async function handleAdminRoomDetail(req: Request, ctx: HttpContext, roomId: string): Promise<Response> {
  const gate = await requireAdmin(req, ctx, 'view.rooms');
  if (!gate.ok) return gate.response;
  if (!isUuid(roomId)) return err('Invalid room id.', 400);
  const summary = await callDo(ctx.env, roomId, 'admin-summary', {});
  if (!summary.ok) return doError(summary);
  const room = summary['room'] as Record<string, unknown>;
  const players = (summary['players'] as Record<string, unknown>[]) ?? [];
  const endsAt = typeof room['endsAt'] === 'string' ? (room['endsAt'] as string) : null;
  // M4-2 (fix round M4): a room detail read returns the full player
  // roster (up to 30 seats — bulk in substance), so it leaves an
  // audit row like the list reads: player count only, never ids or
  // codenames. Single-PLAYER detail reads stay unlogged (OPEN-3,
  // founder call) — this is the roster, not one player.
  writeAudit(ctx, { actorId: gate.user.id, actorRole: gate.user.role, action: 'admin.rooms.detailRead', target: roomId, detail: `room detail read: ${players.length} players listed` });
  return json({
    id: String(room['roomId']),
    code: String(room['roomCode']),
    phase: String(room['phase']),
    players: players.length,
    startedAt: typeof room['startedAt'] === 'string' ? (room['startedAt'] as string) : null,
    zoneRadiusMetres: null,
    mode: String(room['mode'] ?? 'classic'),
    playersList: players.map((p) => ({
      playerId: String(p['playerId']),
      codename: String(p['displayName']),
      role: typeof p['matchRole'] === 'string' ? (p['matchRole'] as string) : 'lobby',
      connected: p['connectionState'] === 'connected' && p['leftAt'] === null,
    })),
    timers: {
      endsAtMs: endsAt ? Date.parse(endsAt) : null,
      phaseEndsAtMs: null,
    },
  });
}

/**
 * POST /v1/admin/rooms/:id/{end|cancel|force-results}.
 * - end / force-results → the match COMPLETES with current standings
 *   (admin-force-results DO op → completeMatch; the room stays for
 *   results + replay). The two actions share the primitive; the
 *   audit label differs.
 * - cancel → the room is CANCELLED and DELETED (admin-end DO op →
 *   cancelMatch + the v23 host-cancel delete flow). No rejoin.
 * The game has exactly these two termination primitives; there is no
 * third "end silently" primitive, and none is invented here.
 */
export async function handleAdminRoomAction(
  req: Request,
  ctx: HttpContext,
  roomId: string,
  action: 'end' | 'cancel' | 'force-results',
): Promise<Response> {
  const permission: AdminPermission =
    action === 'end' ? 'rooms.end' : action === 'cancel' ? 'rooms.cancel' : 'rooms.forceResults';
  const gate = await requireAdmin(req, ctx, permission);
  if (!gate.ok) return gate.response;
  if (!isUuid(roomId)) return err('Invalid room id.', 400);
  const op = action === 'cancel' ? 'admin-end' : 'admin-force-results';
  const done = await callDo(ctx.env, roomId, op, { adminActor: gate.user.username });
  if (!done.ok) return doError(done);
  writeAudit(ctx, {
    actorId: gate.user.id,
    actorRole: gate.user.role,
    action: `admin.rooms.${action === 'force-results' ? 'forceResults' : action}`,
    target: roomId,
    detail: action === 'cancel' ? 'room cancelled and deleted' : 'match completed with current standings',
  });
  return json({ ok: true, ...stripOk(done) });
}

function stripOk(r: Record<string, unknown>): Record<string, unknown> {
  const { ok: _ok, ...rest } = r;
  void _ok;
  return rest;
}

/** GET /v1/admin/players — AdminPlayerRow[] from the Supabase mirror. NEVER raw coordinates. */
export async function handleAdminPlayers(req: Request, ctx: HttpContext): Promise<Response> {
  const gate = await requireAdmin(req, ctx, 'view.players');
  if (!gate.ok) return gate.response;
  if (!isAdminStorageConfigured(ctx.env)) return storageUnavailable();
  const players = await sbSelect(
    ctx.env,
    'players',
    'select=player_id,room_id,display_name,match_role,connection_state,last_fix_at,left_at&order=joined_at.desc&limit=200',
  );
  const rooms = await sbSelect(ctx.env, 'rooms', 'select=room_id,room_code&limit=500');
  const blocks = await sbSelect(ctx.env, 'blocks', 'select=player_id,expires_at&limit=500');
  if (players === null || rooms === null || blocks === null) return storageUnavailable();
  const roomCode = new Map<string, string>();
  for (const r of rooms) roomCode.set(String(r['room_id']), String(r['room_code']));
  const nowMs = Date.now();
  const blockedIds = new Set<string>();
  for (const b of blocks) {
    const exp = b['expires_at'];
    if (typeof exp === 'string' && Date.parse(exp) <= nowMs) continue;
    if (typeof b['player_id'] === 'string') blockedIds.add(b['player_id'] as string);
  }
  // Bulk-read audit (fix round item 10).
  writeAudit(ctx, { actorId: gate.user.id, actorRole: gate.user.role, action: 'admin.players.listRead', target: null, detail: `bulk read: ${players.length} players` });
  return json(
    players.map((p) => {
      const lastFixAt = typeof p['last_fix_at'] === 'string' ? (p['last_fix_at'] as string) : null;
      return {
        playerId: String(p['player_id']),
        codename: String(p['display_name']),
        roomCode: roomCode.get(String(p['room_id'])) ?? null,
        roomId: typeof p['room_id'] === 'string' ? (p['room_id'] as string) : null,
        connected: p['connection_state'] === 'connected' && p['left_at'] === null,
        // gpsOk = a fix in the last 120 s (FIX_TTL_MS). A stale/absent fix is "no fix", never a location.
        gpsOk: lastFixAt !== null && Date.now() - Date.parse(lastFixAt) <= 120_000,
        lastFixAt,
        blocked: blockedIds.has(String(p['player_id'])),
      };
    }),
  );
}

/**
 * GET /v1/admin/players/:id/location — Owner ONLY (players.viewLocation).
 * Returns the LIVE fix from DO memory, in-session only: it is never
 * stored, never logged, never exported. The audit row records THAT a
 * location was viewed, by whom, when — NEVER the coordinates (the
 * detail field carries no lat/lng, and this handler logs nothing).
 */
export async function handleAdminPlayerLocation(
  req: Request,
  ctx: HttpContext,
  playerId: string,
): Promise<Response> {
  const gate = await requireAdmin(req, ctx, 'players.viewLocation');
  if (!gate.ok) return gate.response;
  if (!isUuid(playerId)) return err('Invalid player id.', 400);
  if (!isAdminStorageConfigured(ctx.env)) return storageUnavailable();
  const rows = await sbSelect(ctx.env, 'players', `select=room_id&player_id=eq.${encodeURIComponent(playerId)}`);
  if (rows === null) return storageUnavailable();
  const row = rows[0];
  if (!row || typeof row['room_id'] !== 'string') {
    return err('That player was not found.', 404);
  }
  const live = await callDo(ctx.env, row['room_id'] as string, 'admin-live-fix', { playerId });
  if (!live.ok) return doError(live);
  const fix = live['fix'] as Record<string, unknown> | null;
  if (!fix) {
    return err('No live fix for this player right now.', 404, undefined, 'NO_LIVE_FIX');
  }
  // Audit WITHOUT coordinates: action + actor + target + time only.
  writeAudit(ctx, {
    actorId: gate.user.id,
    actorRole: gate.user.role,
    action: 'admin.players.locationView',
    target: playerId,
    detail: 'live location viewed (coordinates never stored in audit)',
  });
  return json({
    latitude: fix['lat'],
    longitude: fix['lng'],
    accuracyMetres: typeof fix['accuracyMeters'] === 'number' ? (fix['accuracyMeters'] as number) : null,
    fixedAt:
      typeof fix['timestampMs'] === 'number'
        ? new Date(fix['timestampMs'] as number).toISOString()
        : null,
  });
}

/**
 * POST /v1/admin/players/:id/{kick|block|unblock}. Block also kicks
 * the live seat. HOST GUARD (fix round item 12): the room HOST
 * cannot be kicked, blocked or erased while hosting — the DO refuses
 * a host kick with 409, and the handlers below refuse BEFORE acting
 * (no block row, no mirror deletes) instead of ignoring the 409 and
 * proceeding. The Owner ends/cancels the room first, then acts.
 * A kick result is reported honestly: 'ok' | 'room-gone' (the room
 * was already gone — the block still records) | 'failed' (the DO
 * could not be reached — the block still records, the live seat may
 * still be in the room).
 */
type LiveKickResult = 'ok' | 'room-gone' | 'failed';

async function kickLiveSeat(
  ctx: HttpContext,
  roomId: string,
  playerId: string,
  adminUsername: string,
): Promise<LiveKickResult> {
  const kicked = await callDo(ctx.env, roomId, 'admin-kick', { targetPlayerId: playerId, adminActor: adminUsername });
  if (kicked.ok) return 'ok';
  if (kicked.code === 'NOT_FOUND' || kicked.code === 'ROOM_NOT_FOUND' || kicked.status === 404) return 'room-gone';
  return 'failed';
}

export async function handleAdminPlayerAction(
  req: Request,
  ctx: HttpContext,
  playerId: string,
  action: 'kick' | 'block' | 'unblock',
): Promise<Response> {
  const permission: AdminPermission = action === 'kick' ? 'players.kick' : action === 'block' ? 'players.block' : 'players.unblock';
  const gate = await requireAdmin(req, ctx, permission);
  if (!gate.ok) return gate.response;
  if (!isUuid(playerId)) return err('Invalid player id.', 400);
  if (!isAdminStorageConfigured(ctx.env)) return storageUnavailable();
  const rows = await sbSelect(
    ctx.env,
    'players',
    `select=room_id,reconnect_token_hash,is_host&player_id=eq.${encodeURIComponent(playerId)}`,
  );
  if (rows === null) return storageUnavailable();
  const row = rows[0];
  if (!row) return err('That player was not found.', 404);
  const roomId = typeof row['room_id'] === 'string' ? (row['room_id'] as string) : null;
  const isHost = row['is_host'] === true;

  if (action === 'kick') {
    if (!roomId) return err('That player is not in a live room.', 404);
    // The DO refuses a host kick with 409; the mirror check above
    // is the fast path (the DO is the authority if the mirror is stale).
    if (isHost) {
      writeAudit(ctx, { actorId: gate.user.id, actorRole: gate.user.role, action: 'admin.players.kick', target: playerId, detail: 'refused: target is the room host — end or cancel the room first' });
      return err('The room host cannot be kicked — end or cancel the room instead.', 409, undefined, 'HOST_PROTECTED');
    }
    const kicked = await callDo(ctx.env, roomId, 'admin-kick', { targetPlayerId: playerId, adminActor: gate.user.username });
    if (!kicked.ok) return doError(kicked);
    writeAudit(ctx, { actorId: gate.user.id, actorRole: gate.user.role, action: 'admin.players.kick', target: playerId, detail: `room ${roomId}` });
    return json({ ok: true });
  }

  if (action === 'block') {
    if (isHost) {
      writeAudit(ctx, { actorId: gate.user.id, actorRole: gate.user.role, action: 'admin.players.block', target: playerId, detail: 'refused: target is the room host — end or cancel the room first' });
      return err('The room host cannot be blocked — end or cancel the room first.', 409, undefined, 'HOST_PROTECTED');
    }
    // Live-kick first; the result is reported, not swallowed.
    const liveKick: LiveKickResult = roomId
      ? await kickLiveSeat(ctx, roomId, playerId, gate.user.username)
      : 'room-gone';
    const inserted = await sbInsert(ctx.env, 'blocks', {
      device_id: playerId,
      player_id: playerId,
      reconnect_token_hash: typeof row['reconnect_token_hash'] === 'string' ? (row['reconnect_token_hash'] as string) : null,
      action: 'ban',
      reason: 'Blocked from the admin panel.',
      blocked_by: gate.user.username,
    });
    if (!inserted) return storageUnavailable();
    writeAudit(ctx, { actorId: gate.user.id, actorRole: gate.user.role, action: 'admin.players.block', target: playerId, detail: `seat credential blocked (reconnect-token hash); live kick: ${liveKick}` });
    return json({ ok: true, liveKick, enforcement: 'seat-credential' });
  }

  // unblock: remove every block row for this player.
  const removed = await sbDelete(ctx.env, 'blocks', `player_id=eq.${encodeURIComponent(playerId)}`);
  if (!removed) return storageUnavailable();
  writeAudit(ctx, { actorId: gate.user.id, actorRole: gate.user.role, action: 'admin.players.unblock', target: playerId, detail: null });
  return json({ ok: true });
}

/**
 * Marker written IN PLACE of an erased player's id inside JSONB
 * history (fix round M3 re-review). History rows and result shapes
 * are preserved — only the id itself is gone, so a redacted
 * caughtRunnerIds entry still counts as one caught runner and a
 * redacted tag still counts as one tag. The marker is not a UUID,
 * so it can never collide with a real player id.
 */
export const ERASED_PLAYER_ID = '[erased]';

/**
 * Deep-redact one player id out of a JSON value: every string
 * exactly equal to `playerId`, at any depth (arrays, nested objects,
 * MatchResult tags/caught lists), is replaced with ERASED_PLAYER_ID.
 * Returns the redacted value plus whether anything changed, so the
 * caller only writes rows that actually carried the id. Other ids
 * (catch ids, room ids, other players) are untouched.
 */
export function redactPlayerId(value: unknown, playerId: string): { value: unknown; changed: boolean } {
  if (typeof value === 'string') {
    return value === playerId ? { value: ERASED_PLAYER_ID, changed: true } : { value, changed: false };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const r = redactPlayerId(item, playerId);
      if (r.changed) changed = true;
      return r.value;
    });
    return { value: out, changed };
  }
  if (typeof value === 'object' && value !== null) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = redactPlayerId(v, playerId);
      if (r.changed) changed = true;
      out[k] = r.value;
    }
    return { value: out, changed };
  }
  return { value, changed: false };
}

/**
 * POST /v1/admin/players/:id/erase — Owner ONLY (players.erase
 * matrix permission). Deletes a player's rows by playerId.
 *
 * HONEST ERASURE (fix round M3): every delete's result is checked
 * and reported — a partial failure returns 500 with
 * {erased: false, partial: true, deleted: [...], failed: [...]}
 * and NEVER erased:true. An unknown playerId is 404 (nothing is
 * deleted, nothing is claimed). The erase list covers: players,
 * room_events (actor), catches (hunter/runner), safety_events,
 * bug_reports, logs, blocks (player_id AND device_id — the block
 * rows key device_id to the playerId), the GAME audit_log
 * (actor_id OR target_id), billing_transactions (player_id), and
 * data_requests (player_id). The ADMIN audit log is deliberately NOT
 * erased (it is the compliance record — the erase itself is
 * audit-logged).
 *
 * JSONB SCRUB (fix round M3 re-review): row deletes alone leave the
 * id behind — a PLAYER_TAGGED row logged with the hunter as actor
 * carries the runner in its payload, a MATCH_COMPLETED row (actor
 * null) carries the full MatchResult in its payload, and the
 * completed room's rooms.result carries caughtRunnerIds /
 * survivingRunnerIds / tags. Those ids are redacted IN PLACE with
 * ERASED_PLAYER_ID (history rows and result shapes preserved, only
 * the id gone); a scrub failure is reported in `failed` like any
 * other step, never silently claimed.
 *
 * HOST GUARD (fix round item 12, scoped in the M3 re-review, DRAFT
 * added in fix round M3-A): a host of a room in a LIVE phase — or in
 * DRAFT, which still has a host and no pre-LOBBY succession — is
 * refused 409 (HOST_PROTECTED): end/cancel the room first. A host of
 * a COMPLETED / CANCELLED / ABANDONED / EXPIRED room — or a room
 * whose mirror row is gone — CAN be erased, because "end or cancel
 * the room first" is impossible for a room that already ended.
 * KICK TOLERANCE (fix round M3-1): the DO kick is verified before
 * any mirror row is deleted — but only genuine DO errors abort the
 * erase (5xx / unreachable). A 409 CONFLICT / INVALID_STATE kick
 * means the seat is already gone (already left/ejected, a host the
 * DO will not kick, or a terminal-phase room the DO will not kick
 * from) — the erase proceeds, because there is no live seat left to
 * kick. The real DO failure body carries `code` but no `status`
 * (room-do-class.ts), so the tolerance keys on the code (and on a
 * 409 status, if one is ever present), never on a missing status.
 * DO REDACT (fix round M3-B): after the kick the DO is told to
 * forget the player (`admin-redact-player` — result, config
 * `selectedHunterIds`, `hostPlayerId`, host-grace host — replaced
 * with '[erased]' in DO memory, persisted via a room-upsert), so a
 * later persistRoom can never rewrite the scrubbed id back into the
 * mirror. A redact failure does NOT abort the erase — the mirror
 * scrub below is the authoritative erasure — but it is reported
 * honestly in the response (`doRedact`) and the audit row.
 * HOST COLUMN (fix round M3-2): `rooms.host_player_id` is nulled for
 * the erased player (only when the mirror row actually names them).
 * CONFIG SCRUB (fix round M3-3): `rooms.config` is redacted with the
 * same `redactPlayerId` as `rooms.result` (`selectedHunterIds` is a
 * player-id array in the same row). SCRUB PAGINATION (fix round
 * M3-4): both JSONB scrubs page through their tables
 * (`ERASE_SCRUB_PAGE_SIZE` rows at a time) instead of trusting one
 * capped select — residue past the cap can never be reported deleted.
 * Keyset since fix round 4 (`order=<id>.asc` + `<id>=gt.<last-seen>`):
 * a concurrent DELETE mid-scrub can no longer shift rows past the
 * cursor (the offset-pagination race).
 */
export async function handleAdminPlayerErase(
  req: Request,
  ctx: HttpContext,
  playerId: string,
): Promise<Response> {
  const gate = await requireAdmin(req, ctx, 'players.erase');
  if (!gate.ok) return gate.response;
  if (!isUuid(playerId)) return err('Invalid player id.', 400);
  if (!isAdminStorageConfigured(ctx.env)) return storageUnavailable();
  const rows = await sbSelect(ctx.env, 'players', `select=room_id,is_host&player_id=eq.${encodeURIComponent(playerId)}`);
  if (rows === null) return storageUnavailable();
  const row = rows[0];
  if (!row) return err('That player was not found.', 404);
  const roomId = typeof row['room_id'] === 'string' ? (row['room_id'] as string) : null;
  if (row['is_host'] === true) {
    // Live-phase check: only a host of a room still in play is
    // protected. A terminal room (or a missing mirror row) means
    // the room already ended — the host is erasable. DRAFT counts
    // as protected (M3-A): the draft still has a host and no
    // pre-LOBBY succession, so erasing its host would orphan it.
    let live = false;
    if (roomId) {
      const roomRows = await sbSelect(ctx.env, 'rooms', `select=room_id,phase&room_id=eq.${encodeURIComponent(roomId)}`);
      if (roomRows === null) return storageUnavailable();
      const phase = roomRows[0]?.['phase'];
      live = typeof phase === 'string' && (HOST_GUARD_PHASES as readonly string[]).includes(phase);
    }
    if (live) {
      writeAudit(ctx, { actorId: gate.user.id, actorRole: gate.user.role, action: 'admin.players.erase', target: playerId, detail: 'refused: target is the room host — end or cancel the room first' });
      return err('The room host cannot be erased — end or cancel the room first.', 409, undefined, 'HOST_PROTECTED');
    }
  }
  // M3-1: a 409 kick (CONFLICT — seat already left/ejected, or the
  // DO will not kick a host; INVALID_STATE — terminal-phase room)
  // means there is no live seat left to kick, so the erase proceeds.
  // Only a genuine DO error aborts it. The DO failure body carries
  // `code` but no `status`, so the tolerance keys on the code (a 409
  // status is accepted too, if one is ever present).
  let doRedact: 'ok' | 'failed' | 'skipped' = 'skipped';
  if (roomId) {
    const kicked = await callDo(ctx.env, roomId, 'admin-kick', { targetPlayerId: playerId, adminActor: gate.user.username });
    const seatAlreadyGone =
      kicked.code === 'NOT_FOUND' ||
      kicked.code === 'ROOM_NOT_FOUND' ||
      kicked.code === 'CONFLICT' ||
      kicked.code === 'INVALID_STATE' ||
      kicked.status === 404 ||
      kicked.status === 409;
    if (!kicked.ok && !seatAlreadyGone) {
      return doError(kicked);
    }
    // M3-B: tell the DO itself to forget the player, so a later
    // persistRoom cannot rewrite the scrubbed id back into the
    // mirror. Best-effort defence-in-depth: a failure here never
    // aborts the erase (the mirror scrub below is authoritative),
    // but it is reported honestly in the response + audit row.
    const redacted = await callDo(ctx.env, roomId, 'admin-redact-player', { targetPlayerId: playerId, adminActor: gate.user.username });
    doRedact = redacted.ok ? 'ok' : 'failed';
  }
  // Every delete is checked; the players row is last. A failure in
  // any table is reported honestly — never erased:true on partial.
  const deleted: string[] = [];
  const failed: string[] = [];
  const eraseSteps: [string, Promise<boolean>][] = [
    ['room_events', sbDelete(ctx.env, 'room_events', `actor_id=eq.${encodeURIComponent(playerId)}`)],
    ['catches.hunter', sbDelete(ctx.env, 'catches', `hunter_id=eq.${encodeURIComponent(playerId)}`)],
    ['catches.runner', sbDelete(ctx.env, 'catches', `runner_id=eq.${encodeURIComponent(playerId)}`)],
    ['safety_events', sbDelete(ctx.env, 'safety_events', `player_id=eq.${encodeURIComponent(playerId)}`)],
    ['bug_reports', sbDelete(ctx.env, 'bug_reports', `player_id=eq.${encodeURIComponent(playerId)}`)],
    ['logs', sbDelete(ctx.env, 'logs', `player_id=eq.${encodeURIComponent(playerId)}`)],
    ['blocks.player_id', sbDelete(ctx.env, 'blocks', `player_id=eq.${encodeURIComponent(playerId)}`)],
    ['blocks.device_id', sbDelete(ctx.env, 'blocks', `device_id=eq.${encodeURIComponent(playerId)}`)],
    ['audit_log.actor', sbDelete(ctx.env, 'audit_log', `actor_id=eq.${encodeURIComponent(playerId)}`)],
    ['audit_log.target', sbDelete(ctx.env, 'audit_log', `target_id=eq.${encodeURIComponent(playerId)}`)],
    ['billing_transactions', sbDelete(ctx.env, 'billing_transactions', `player_id=eq.${encodeURIComponent(playerId)}`)],
    ['data_requests', sbDelete(ctx.env, 'data_requests', `player_id=eq.${encodeURIComponent(playerId)}`)],
  ];
  for (const [name, p] of eraseSteps) {
    if (await p) deleted.push(name);
    else failed.push(name);
  }
  // M3-2: null the erased player's id out of rooms.host_player_id —
  // but only when the mirror row actually names them (the patch
  // filters on host_player_id, and the step is reported only when a
  // row changed, so a non-host erase never claims a host nulling).
  if (roomId) {
    const hostPatched = await sbPatch(
      ctx.env,
      'rooms',
      `room_id=eq.${encodeURIComponent(roomId)}&host_player_id=eq.${encodeURIComponent(playerId)}`,
      { host_player_id: null },
    );
    if (hostPatched === null) failed.push('rooms.host_player_id');
    else if (hostPatched.length > 0) deleted.push('rooms.host_player_id');
  }
  // JSONB scrub (see docstring): redact the id in place in
  // room_events.payload rows that survived the actor delete and in
  // rooms.result + rooms.config rows. Only rows that actually carry
  // the id are rewritten; a failed read or patch fails the step
  // honestly. M3-4 (fix round 4: KEYSET pagination): both scrubs page
  // with `order=<id>.asc` + `<id>=gt.<last-seen>` instead of
  // limit + offset. Offset pagination is NOT stable under a
  // concurrent DELETE: a row deleted ahead of the current offset
  // shifts every later row up one, and the row at the boundary is
  // skipped — residue reported as erased:true. A keyset cursor is
  // immune by construction: deleted rows are simply gone from the
  // ordered stream, and every surviving row past the cursor is still
  // visited exactly once. (Patching in place never changes a row's
  // id, so the cursor can never skip or revisit a row.)
  const eventRowsPage = async (afterId: string | null) =>
    sbSelect(
      ctx.env,
      'room_events',
      `select=event_id,payload&order=event_id.asc${afterId === null ? '' : `&event_id=gt.${encodeURIComponent(afterId)}`}&limit=${ERASE_SCRUB_PAGE_SIZE}`,
    );
  {
    let scrubOk = true;
    let afterId: string | null = null;
    for (;;) {
      const eventRows = await eventRowsPage(afterId);
      if (eventRows === null) {
        scrubOk = false;
        break;
      }
      for (const ev of eventRows) {
        const { value, changed } = redactPlayerId(ev['payload'], playerId);
        if (!changed) continue;
        const patched = await sbPatch(
          ctx.env,
          'room_events',
          `event_id=eq.${encodeURIComponent(String(ev['event_id']))}`,
          { payload: value },
        );
        if (patched === null) scrubOk = false;
      }
      if (eventRows.length < ERASE_SCRUB_PAGE_SIZE) break;
      const lastRow = eventRows[eventRows.length - 1];
      if (lastRow === undefined) break;
      afterId = String(lastRow['event_id']);
    }
    if (scrubOk) deleted.push('room_events.payload');
    else failed.push('room_events.payload');
  }
  const resultRoomsPage = async (afterId: string | null) =>
    // No result filter: a room whose result is null can still carry
    // the id in config.selectedHunterIds, and it must be scrubbed
    // too — so every room row is scanned (one row per room).
    sbSelect(
      ctx.env,
      'rooms',
      `select=room_id,result,config&order=room_id.asc${afterId === null ? '' : `&room_id=gt.${encodeURIComponent(afterId)}`}&limit=${ERASE_SCRUB_PAGE_SIZE}`,
    );
  {
    let resultOk = true;
    let configOk = true;
    let afterId: string | null = null;
    for (;;) {
      const resultRooms = await resultRoomsPage(afterId);
      if (resultRooms === null) {
        resultOk = false;
        configOk = false;
        break;
      }
      for (const r of resultRooms) {
        // M3-3: redact the id out of BOTH jsonb columns in the row —
        // rooms.result (caught/surviving lists + tags) AND
        // rooms.config (selectedHunterIds is a player-id array).
        const patch: Record<string, unknown> = {};
        let touchesResult = false;
        let touchesConfig = false;
        if (r['result'] !== null && r['result'] !== undefined) {
          const { value, changed } = redactPlayerId(r['result'], playerId);
          if (changed) {
            patch['result'] = value;
            touchesResult = true;
          }
        }
        if (r['config'] !== null && r['config'] !== undefined) {
          const { value, changed } = redactPlayerId(r['config'], playerId);
          if (changed) {
            patch['config'] = value;
            touchesConfig = true;
          }
        }
        if (!touchesResult && !touchesConfig) continue;
        const patched = await sbPatch(
          ctx.env,
          'rooms',
          `room_id=eq.${encodeURIComponent(String(r['room_id']))}`,
          patch,
        );
        if (patched === null) {
          if (touchesResult) resultOk = false;
          if (touchesConfig) configOk = false;
        }
      }
      if (resultRooms.length < ERASE_SCRUB_PAGE_SIZE) break;
      const lastRoom = resultRooms[resultRooms.length - 1];
      if (lastRoom === undefined) break;
      afterId = String(lastRoom['room_id']);
    }
    if (resultOk) deleted.push('rooms.result');
    else failed.push('rooms.result');
    if (configOk) deleted.push('rooms.config');
    else failed.push('rooms.config');
  }
  const playerDeleted = await sbDelete(ctx.env, 'players', `player_id=eq.${encodeURIComponent(playerId)}`);
  if (playerDeleted) deleted.push('players');
  else failed.push('players');
  if (failed.length > 0) {
    writeAudit(ctx, {
      actorId: gate.user.id,
      actorRole: gate.user.role,
      action: 'admin.players.erase',
      target: playerId,
      detail: `PARTIAL erasure — deleted: ${deleted.join(', ') || 'none'}; failed: ${failed.join(', ')}; DO redact: ${doRedact}`,
    });
    return json({ ok: false, erased: false, partial: true, deleted, failed, doRedact }, 500);
  }
  writeAudit(ctx, {
    actorId: gate.user.id,
    actorRole: gate.user.role,
    action: 'admin.players.erase',
    target: playerId,
    detail: `player rows erased by codename+playerId (admin audit log retained); DO redact: ${doRedact}`,
  });
  return json({ ok: true, erased: true, deleted, doRedact });
}

// ---------------------------------------------------------------------------
// Feature flags + game config (incl. public reads)
// ---------------------------------------------------------------------------

interface FlagRow {
  key: string;
  enabled: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

/** Read all flag rows as a map (null when storage fails). */
async function readFlagRows(ctx: HttpContext): Promise<Map<string, FlagRow> | null> {
  const rows = await sbSelect(ctx.env, 'feature_flags', 'select=key,enabled,updated_by,updated_at&limit=100');
  if (rows === null) return null;
  const map = new Map<string, FlagRow>();
  for (const r of rows) {
    if (typeof r['key'] !== 'string') continue;
    map.set(r['key'] as string, {
      key: r['key'] as string,
      enabled: r['enabled'] === true,
      updatedBy: typeof r['updated_by'] === 'string' ? (r['updated_by'] as string) : null,
      updatedAt: typeof r['updated_at'] === 'string' ? (r['updated_at'] as string) : null,
    });
  }
  return map;
}

/** Build the AdminFlag[] the client renders, from DB rows + shared defaults. */
function buildFlags(map: Map<string, FlagRow> | null): AdminFlag[] {
  return ADMIN_FLAG_DEFS.map((def) => {
    const row = map?.get(def.key);
    return {
      key: def.key,
      label: def.label,
      explainer: def.explainer,
      enabled: row ? row.enabled : def.key !== 'demoMode',
      updatedBy: row?.updatedBy ?? null,
      updatedAt: row?.updatedAt ?? null,
    };
  });
}

/**
 * Future flags (billing.* and accounts.*) as AdminFlag rows, same shape
 * as the game flags. Default OFF (ADMIN_FUTURE_FLAGS `enabled`).
 * Merge note (2026-11-27, Meera fix 1): GET /v1/admin/flags used to
 * return game flags ONLY, so the flags page could never list or flip
 * the future flags and the billing/accounts pages could never read
 * their live state — every section rendered NotAvailable from the
 * static defs. The public flags read stays game-only
 * (handleAdminFlagsPublic): future-flag activation state is
 * admin-internal, not game-client data.
 */
function buildFutureFlags(map: Map<string, FlagRow> | null): AdminFlag[] {
  return ADMIN_FUTURE_FLAGS.map((def) => {
    const row = map?.get(def.key);
    return {
      key: def.key,
      label: def.label,
      explainer: def.willDo,
      enabled: row ? row.enabled : def.enabled,
      updatedBy: row?.updatedBy ?? null,
      updatedAt: row?.updatedAt ?? null,
    };
  });
}

/** GET /v1/admin/flags — AdminFlag[]: game flags + future flags. */
export async function handleAdminFlags(req: Request, ctx: HttpContext): Promise<Response> {
  const gate = await requireAdmin(req, ctx, 'view.flags');
  if (!gate.ok) return gate.response;
  if (!isAdminStorageConfigured(ctx.env)) return storageUnavailable();
  const map = await readFlagRows(ctx);
  if (map === null) return storageUnavailable();
  const flags = [...buildFlags(map), ...buildFutureFlags(map)];
  // Bulk-read audit (fix round M4 re-review): the flag list is a
  // bulk read like the other lists (row count only, never flag data).
  writeAudit(ctx, { actorId: gate.user.id, actorRole: gate.user.role, action: 'admin.flags.listRead', target: null, detail: `bulk read: ${flags.length} flags` });
  return json(flags);
}

/**
 * PUT /v1/admin/flags — {flags: [{key, enabled}]}. Keys must be in
 * ADMIN_FLAG_DEFS or ADMIN_FUTURE_FLAGS; anything else is rejected
 * (no silent new flags). GAME flags use flags.edit (Admin may flip
 * them). FUTURE flags (billing.* and accounts.*) are OWNER-ONLY — they
 * are the activation mechanism for the future sections, and the
 * flag-flip story is only true if flipping one is possible at all
 * (fix round M6: they used to 400 here). Clears the runtime flag
 * cache on this isolate so the next game read sees the change
 * (other isolates refresh within 60 s).
 */
export async function handleAdminFlagsPut(req: Request, ctx: HttpContext): Promise<Response> {
  const gate = await requireAdmin(req, ctx, 'flags.edit');
  if (!gate.ok) return gate.response;
  const parsed = await parseBody(req);
  if (!parsed.ok) return parsed.response;
  const flags = parsed.body['flags'];
  if (!Array.isArray(flags) || flags.length === 0) {
    return err('flags must be a non-empty array of {key, enabled}.', 400);
  }
  const knownGame = new Set(ADMIN_FLAG_DEFS.map((d) => d.key));
  const knownFuture = new Set(ADMIN_FUTURE_FLAGS.map((f) => f.key));
  const updates: { key: AdminFlagKey | AdminFutureFlagKey; enabled: boolean; future: boolean }[] = [];
  const seenKeys = new Set<string>();
  for (const f of flags) {
    if (typeof f !== 'object' || f === null) return err('Each flag must be {key, enabled}.', 400);
    const key = (f as { key?: unknown }).key;
    const enabled = (f as { enabled?: unknown }).enabled;
    if (typeof key !== 'string' || (!knownGame.has(key as AdminFlagKey) && !knownFuture.has(key as AdminFutureFlagKey))) {
      return err(`Unknown flag key: ${String(key)}.`, 400);
    }
    // Fix round, 2026-11-27: a repeated key used to be applied twice
    // in order and logged twice (`billing.overview=on,
    // billing.overview=off`) — a misleading audit trail. Reject
    // before any write, same 400 style as unknown keys.
    if (seenKeys.has(key)) return err(`Duplicate flag key: ${key}.`, 400);
    seenKeys.add(key);
    if (typeof enabled !== 'boolean') return err(`Flag ${key} needs enabled: true/false.`, 400);
    updates.push({ key: key as AdminFlagKey | AdminFutureFlagKey, enabled, future: knownFuture.has(key as AdminFutureFlagKey) });
  }
  // Future flags are Owner-only: an Admin flipping billing.* would
  // silently activate a section the Owner has not approved.
  if (updates.some((u) => u.future) && gate.user.role !== 'owner') {
    writeAudit(ctx, { actorId: gate.user.id, actorRole: gate.user.role, action: 'admin.flags.edit', target: null, detail: 'denied: future flags (billing.*/accounts.*) are Owner-only' });
    return err('Future flags (billing / accounts) can only be changed by the Owner.', 403, undefined, 'FORBIDDEN');
  }
  if (!isAdminStorageConfigured(ctx.env)) return storageUnavailable();
  const now = new Date().toISOString();
  for (const u of updates) {
    const patched = await sbPatch(
      ctx.env,
      'feature_flags',
      `key=eq.${encodeURIComponent(u.key)}`,
      { enabled: u.enabled, updated_by: gate.user.username, updated_at: now },
    );
    if (patched === null) return storageUnavailable();
    if (patched.length === 0) {
      const inserted = await sbInsert(ctx.env, 'feature_flags', {
        key: u.key,
        enabled: u.enabled,
        updated_by: gate.user.username,
        updated_at: now,
      });
      if (!inserted) return storageUnavailable();
    }
  }
  clearRuntimeFlagCache();
  writeAudit(ctx, {
    actorId: gate.user.id,
    actorRole: gate.user.role,
    action: 'admin.flags.edit',
    target: null,
    detail: updates.map((u) => `${u.key}=${u.enabled ? 'on' : 'off'}`).join(', '),
  });
  return json({ ok: true });
}

/** GET /v1/admin/flags/public — no auth; Cache-Control max-age=60; defaults when storage is down.
 * Public shape strips updatedBy/updatedAt (fix round M1): the game
 * client needs key + enabled only, and the updater's name is not
 * public information. */
export async function handleAdminFlagsPublic(_req: Request, ctx: HttpContext): Promise<Response> {
  let map: Map<string, FlagRow> | null = null;
  if (isAdminStorageConfigured(ctx.env)) map = await readFlagRows(ctx);
  const res = json(
    buildFlags(map).map((f) => ({ key: f.key, label: f.label, explainer: f.explainer, enabled: f.enabled })),
  );
  res.headers.set('Cache-Control', 'public, max-age=60');
  return res;
}

// --- game config ---

/** The one game_config row (key 'default'), or null. Narrow column list (n7): never select=*. */
async function readGameConfigRow(ctx: HttpContext): Promise<SbRow | null | 'unavailable'> {
  const rows = await sbSelect(ctx.env, 'game_config', "select=key,duration_seconds,head_start_seconds,ping_interval_seconds,zone_radius_metres,zone_shrink_interval_seconds,zone_shrink_enabled,updated_by,updated_at&key=eq.default&limit=1");
  if (rows === null) return 'unavailable';
  return rows[0] ?? null;
}

function configRowToClient(row: SbRow | null): AdminGameConfig {
  if (!row) return { ...ADMIN_CONFIG_DEFAULTS };
  const num = (field: string, fallback: number): number =>
    typeof row[field] === 'number' ? (row[field] as number) : fallback;
  return {
    // Stored in seconds (the engine's unit); the client edits minutes.
    roundLengthMinutes: Math.round(num('duration_seconds', ADMIN_CONFIG_DEFAULTS.roundLengthMinutes * 60) / 60),
    headStartMinutes: Math.round(num('head_start_seconds', ADMIN_CONFIG_DEFAULTS.headStartMinutes * 60) / 60),
    pingIntervalMinutes: Math.round(num('ping_interval_seconds', ADMIN_CONFIG_DEFAULTS.pingIntervalMinutes * 60) / 60),
    zoneRadiusMetres: num('zone_radius_metres', ADMIN_CONFIG_DEFAULTS.zoneRadiusMetres),
    shrinkEverySeconds: num('zone_shrink_interval_seconds', ADMIN_CONFIG_DEFAULTS.shrinkEverySeconds),
    zoneShrinkEnabled: row['zone_shrink_enabled'] !== false,
  };
}

/** GET /v1/admin/config — AdminGameConfig. */
export async function handleAdminConfig(req: Request, ctx: HttpContext): Promise<Response> {
  const gate = await requireAdmin(req, ctx, 'view.config');
  if (!gate.ok) return gate.response;
  if (!isAdminStorageConfigured(ctx.env)) return storageUnavailable();
  const row = await readGameConfigRow(ctx);
  if (row === 'unavailable') return storageUnavailable();
  return json(configRowToClient(row));
}

/** PUT /v1/admin/config — full AdminGameConfig, validated against ADMIN_CONFIG_LIMITS. */
export async function handleAdminConfigPut(req: Request, ctx: HttpContext): Promise<Response> {
  const gate = await requireAdmin(req, ctx, 'config.edit');
  if (!gate.ok) return gate.response;
  const parsed = await parseBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const issues: string[] = [];
  const values: Record<string, number> = {};
  for (const key of Object.keys(ADMIN_CONFIG_LIMITS) as (keyof typeof ADMIN_CONFIG_LIMITS)[]) {
    const v = body[key];
    if (typeof v !== 'number') {
      issues.push(`${key} must be a number.`);
      continue;
    }
    const problem = adminConfigError(key, v);
    if (problem) issues.push(`${key}: ${problem}`);
    else values[key] = v;
  }
  if (typeof body['zoneShrinkEnabled'] !== 'boolean') {
    issues.push('zoneShrinkEnabled must be true/false.');
  }
  if (issues.length > 0) return err('Game settings are not valid.', 400, issues);
  if (!isAdminStorageConfigured(ctx.env)) return storageUnavailable();
  const stored = {
    duration_seconds: (values['roundLengthMinutes'] as number) * 60,
    head_start_seconds: (values['headStartMinutes'] as number) * 60,
    ping_interval_seconds: (values['pingIntervalMinutes'] as number) * 60,
    zone_radius_metres: values['zoneRadiusMetres'] as number,
    zone_shrink_interval_seconds: values['shrinkEverySeconds'] as number,
    zone_shrink_enabled: body['zoneShrinkEnabled'] as boolean,
    updated_by: gate.user.username,
    updated_at: new Date().toISOString(),
  };
  const patched = await sbPatch(ctx.env, 'game_config', "key=eq.default", stored);
  if (patched === null) return storageUnavailable();
  if (patched.length === 0) {
    const inserted = await sbInsert(ctx.env, 'game_config', { key: 'default', ...stored });
    if (!inserted) return storageUnavailable();
  }
  writeAudit(ctx, { actorId: gate.user.id, actorRole: gate.user.role, action: 'admin.config.edit', target: null, detail: JSON.stringify(values) });
  return json({ ok: true });
}

/** GET /v1/admin/config/public — no auth; defaults when storage is down. */
export async function handleAdminConfigPublic(_req: Request, ctx: HttpContext): Promise<Response> {
  let row: SbRow | null = null;
  if (isAdminStorageConfigured(ctx.env)) {
    const read = await readGameConfigRow(ctx);
    if (read !== 'unavailable') row = read;
  }
  const res = json(configRowToClient(row));
  res.headers.set('Cache-Control', 'public, max-age=60');
  return res;
}

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

/** GET /v1/admin/safety — reports (guest intake), blocked devices, abuse log. */
export async function handleAdminSafety(req: Request, ctx: HttpContext): Promise<Response> {
  const gate = await requireAdmin(req, ctx, 'view.safety');
  if (!gate.ok) return gate.response;
  if (!isAdminStorageConfigured(ctx.env)) return storageUnavailable();
  const reports = await sbSelect(ctx.env, 'audit_log', 'select=entry_id,actor_id,action,room_id,target_id,created_at&order=created_at.desc&limit=50');
  const blocks = await sbSelect(ctx.env, 'blocks', 'select=device_id,reason,blocked_by,blocked_at,expires_at&order=blocked_at.desc&limit=100');
  const safetyEvents = await sbSelect(ctx.env, 'safety_events', 'select=event_id,type,reason,created_at&order=created_at.desc&limit=50');
  const logs = await sbSelect(ctx.env, 'logs', 'select=id,level,message,operation,created_at&order=created_at.desc&limit=50');
  if (reports === null || blocks === null || safetyEvents === null || logs === null) {
    return storageUnavailable();
  }
  // Bulk-read audit (fix round M4 re-review): the Safety page is
  // one of the two most sensitive unlogged lists — reports, blocks,
  // safety events and log rows all leave a trail (counts only).
  writeAudit(ctx, { actorId: gate.user.id, actorRole: gate.user.role, action: 'admin.safety.listRead', target: null, detail: `bulk read: ${reports.length} reports, ${blocks.length} blocks, ${safetyEvents.length} safety events, ${logs.length} log rows` });
  const nowMs = Date.now();
  return json({
    reports: reports.map((r) => ({
      id: String(r['entry_id']),
      kind: String(r['action']),
      detail: `room ${String(r['room_id'] ?? '—')} → ${String(r['target_id'] ?? '—')}`,
      createdAt: String(r['created_at']),
      createdBy: typeof r['actor_id'] === 'string' ? (r['actor_id'] as string) : null,
    })),
    // Blocked "devices": deviceId here is the SEAT key (a playerId),
    // not a hardware identifier — the game has no device key (fix
    // round M5). The Safety page lists these as blocked seats.
    blockedDevices: blocks
      .filter((b) => {
        const exp = b['expires_at'];
        return typeof exp !== 'string' || Date.parse(exp) > nowMs;
      })
      .map((b) => ({
        deviceId: String(b['device_id'] ?? ''),
        reason: typeof b['reason'] === 'string' ? (b['reason'] as string) : '',
        blockedAt: String(b['blocked_at']),
        blockedBy: typeof b['blocked_by'] === 'string' ? (b['blocked_by'] as string) : null,
      })),
    // Abuse log: safety pauses/resumes + warn/error log rows (GPS flags, token reuse, spam surface here).
    abuseLog: [
      ...safetyEvents.map((e) => ({
        id: String(e['event_id']),
        kind: String(e['type']),
        detail: typeof e['reason'] === 'string' ? (e['reason'] as string) : '',
        createdAt: String(e['created_at']),
      })),
      ...logs
        .filter((l) => l['level'] === 'warn' || l['level'] === 'error')
        .map((l) => ({
          id: String(l['id']),
          kind: typeof l['operation'] === 'string' ? (l['operation'] as string) : String(l['level']),
          detail: String(l['message']),
          createdAt: String(l['created_at']),
        })),
    ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 50),
  });
}

/** POST /v1/admin/safety/flags — {kind, detail}. Any role may create (safety.createFlag). */
export async function handleAdminSafetyFlagCreate(req: Request, ctx: HttpContext): Promise<Response> {
  const gate = await requireAdmin(req, ctx, 'safety.createFlag');
  if (!gate.ok) return gate.response;
  const parsed = await parseBody(req);
  if (!parsed.ok) return parsed.response;
  const kind = asString(parsed.body['kind']);
  const detail = asString(parsed.body['detail']);
  if (!kind || kind.length > 100) return err('kind is required (max 100 characters).', 400);
  if (!detail || detail.length > 1000) return err('detail is required (max 1000 characters).', 400);
  if (!isAdminStorageConfigured(ctx.env)) return storageUnavailable();
  const inserted = await sbInsert(ctx.env, 'safety_flags', {
    kind: kind.trim(),
    detail: detail.trim(),
    created_by: gate.user.username,
    status: 'open',
  });
  if (!inserted) return storageUnavailable();
  writeAudit(ctx, { actorId: gate.user.id, actorRole: gate.user.role, action: 'admin.safety.flagCreate', target: null, detail: `${kind}: ${detail.slice(0, 200)}` });
  return json({ ok: true }, 201);
}

/**
 * POST /v1/admin/safety/blocks — {playerId, reason}. Gated by
 * players.block (the shared matrix has no separate safety-block
 * permission).
 *
 * BAN HONESTY (fix round M5/OPEN-9): the old shape took an arbitrary
 * `deviceId` string and wrote a blocks row nothing enforced — dead
 * rows, because the game has NO device key to check at join time.
 * That path is REMOVED. This endpoint now takes a real playerId
 * (must exist in the players mirror), looks up the seat's
 * reconnect-token hash, and writes the same seat-credential block
 * as POST /v1/admin/players/:id/block. The `device_id` column keeps
 * the playerId for column compatibility (the table predates this
 * change); it is a SEAT key, not a hardware identifier — the
 * response says so (enforcement: 'seat-credential'), and no copy
 * anywhere claims a device ban. A fresh join with a new seat is
 * not matched by any block; that is stated in docs, not hidden.
 */
export async function handleAdminSafetyBlockCreate(req: Request, ctx: HttpContext): Promise<Response> {
  const gate = await requireAdmin(req, ctx, 'players.block');
  if (!gate.ok) return gate.response;
  const parsed = await parseBody(req);
  if (!parsed.ok) return parsed.response;
  const playerId = asString(parsed.body['playerId']);
  const reason = asString(parsed.body['reason']);
  if (!playerId || !isUuid(playerId)) return err('playerId (a real player) is required — arbitrary device identifiers are not blocked, because the game has no device key.', 400);
  if (!reason || reason.length > 500) return err('reason is required (max 500 characters).', 400);
  if (!isAdminStorageConfigured(ctx.env)) return storageUnavailable();
  const rows = await sbSelect(
    ctx.env,
    'players',
    `select=room_id,reconnect_token_hash,is_host&player_id=eq.${encodeURIComponent(playerId)}`,
  );
  if (rows === null) return storageUnavailable();
  const row = rows[0];
  if (!row) return err('That player was not found.', 404);
  if (row['is_host'] === true) {
    writeAudit(ctx, { actorId: gate.user.id, actorRole: gate.user.role, action: 'admin.safety.blocksManage', target: playerId, detail: 'refused: target is the room host — end or cancel the room first' });
    return err('The room host cannot be blocked — end or cancel the room first.', 409, undefined, 'HOST_PROTECTED');
  }
  const roomId = typeof row['room_id'] === 'string' ? (row['room_id'] as string) : null;
  const liveKick: LiveKickResult = roomId
    ? await kickLiveSeat(ctx, roomId, playerId, gate.user.username)
    : 'room-gone';
  const inserted = await sbInsert(ctx.env, 'blocks', {
    device_id: playerId,
    player_id: playerId,
    reconnect_token_hash: typeof row['reconnect_token_hash'] === 'string' ? (row['reconnect_token_hash'] as string) : null,
    action: 'ban',
    reason: reason.trim(),
    blocked_by: gate.user.username,
  });
  if (!inserted) return storageUnavailable();
  writeAudit(ctx, { actorId: gate.user.id, actorRole: gate.user.role, action: 'admin.safety.blocksManage', target: playerId, detail: `seat credential blocked (reconnect-token hash); live kick: ${liveKick}` });
  return json({ ok: true, liveKick, enforcement: 'seat-credential' }, 201);
}

/** DELETE /v1/admin/safety/blocks/:playerId — removes block rows for the player (player_id AND legacy device_id rows). */
export async function handleAdminSafetyBlockDelete(req: Request, ctx: HttpContext, deviceId: string): Promise<Response> {
  const gate = await requireAdmin(req, ctx, 'safety.unblock');
  if (!gate.ok) return gate.response;
  if (!isAdminStorageConfigured(ctx.env)) return storageUnavailable();
  const removedByPlayer = await sbDelete(ctx.env, 'blocks', `player_id=eq.${encodeURIComponent(deviceId)}`);
  const removedByDevice = await sbDelete(ctx.env, 'blocks', `device_id=eq.${encodeURIComponent(deviceId)}`);
  if (!removedByPlayer || !removedByDevice) return storageUnavailable();
  writeAudit(ctx, { actorId: gate.user.id, actorRole: gate.user.role, action: 'admin.safety.blocksManage', target: deviceId, detail: 'block removed' });
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Metrics + audit + announcements
// ---------------------------------------------------------------------------

/** GET /v1/admin/metrics — computed from Supabase rows. Honest gaps are nulls/notes, never invented numbers.
 * Permission is view.costs (fix round item 9): this endpoint is the
 * Costs page's read (the Numbers page reads the same endpoint; both
 * permissions are all-roles today, so no access changes). */
export async function handleAdminMetrics(req: Request, ctx: HttpContext): Promise<Response> {
  const gate = await requireAdmin(req, ctx, 'view.costs');
  if (!gate.ok) return gate.response;
  if (!isAdminStorageConfigured(ctx.env)) return storageUnavailable();
  const rooms = await sbSelect(ctx.env, 'rooms', 'select=room_id,phase,started_at,ends_at&limit=1000');
  const players = await sbSelect(ctx.env, 'players', 'select=player_id,room_id,left_at&limit=2000');
  const catches = await sbSelect(ctx.env, 'catches', 'select=catch_id,state&limit=2000');
  const roomCount = await sbCountExact(ctx.env, 'rooms', 'select=room_id');
  const playerCount = await sbCountExact(ctx.env, 'players', 'select=player_id');
  const auditCount = await sbCountExact(ctx.env, 'admin_audit_log', 'select=id');
  if (rooms === null || players === null || catches === null) return storageUnavailable();
  const completed = rooms.filter((r) => r['phase'] === 'COMPLETED');
  const durations: number[] = [];
  for (const r of completed) {
    if (typeof r['started_at'] === 'string' && typeof r['ends_at'] === 'string') {
      const mins = (Date.parse(r['ends_at'] as string) - Date.parse(r['started_at'] as string)) / 60000;
      if (Number.isFinite(mins) && mins >= 0) durations.push(mins);
    }
  }
  const averageGameLengthMinutes =
    durations.length > 0
      ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10
      : null;
  const catchRate = catches.length > 0 ? catches.filter((c) => c['state'] === 'confirmed').length / catches.length : null;
  // Peak concurrency is NOT recorded as a time series anywhere — the honest proxy is the largest current room.
  const perRoom = new Map<string, number>();
  for (const p of players) {
    if (p['left_at'] !== null) continue;
    const rid = String(p['room_id']);
    perRoom.set(rid, (perRoom.get(rid) ?? 0) + 1);
  }
  const peakConcurrency = Math.max(0, ...perRoom.values());
  // Bulk-read audit (fix round M4 re-review): metrics is a bulk
  // read of rooms + players + catches (row counts only).
  writeAudit(ctx, { actorId: gate.user.id, actorRole: gate.user.role, action: 'admin.metrics.listRead', target: null, detail: `bulk read: ${rooms.length} rooms, ${players.length} players, ${catches.length} catches` });
  return json({
    doRequestsToday: 0,
    doMeter: DO_METER_NOTE,
    dailyCap: DO_DAILY_CAP,
    dbRows: { rooms: roomCount ?? rooms.length, players: playerCount ?? players.length, audit: auditCount ?? 0 },
    gamesPlayed: completed.length,
    totalPlayers: players.length,
    peakConcurrency,
    peakConcurrencyNote: 'Largest current room — true historical peak is not recorded (no time-series exists).',
    averageGameLengthMinutes,
    catchRate: catchRate === null ? null : Math.round(catchRate * 1000) / 1000,
  });
}

/** GET /v1/admin/audit — AdminAuditEntry[] (newest first). */
export async function handleAdminAudit(req: Request, ctx: HttpContext): Promise<Response> {
  const gate = await requireAdmin(req, ctx, 'view.audit');
  if (!gate.ok) return gate.response;
  if (!isAdminStorageConfigured(ctx.env)) return storageUnavailable();
  const rows = await sbSelect(ctx.env, 'admin_audit_log', 'select=id,actor_id,actor_role,action,target,detail,created_at&order=created_at.desc&limit=200');
  const users = await sbSelect(ctx.env, 'admin_users', 'select=id,username&limit=100');
  if (rows === null || users === null) return storageUnavailable();
  const names = new Map<string, string>();
  for (const u of users) names.set(String(u['id']), String(u['username']));
  // Bulk-read audit (fix round item 10): reading the audit log
  // itself is the most sensitive list read — it leaves a trail.
  writeAudit(ctx, { actorId: gate.user.id, actorRole: gate.user.role, action: 'admin.audit.listRead', target: null, detail: `bulk read: ${rows.length} audit rows` });
  return json(
    rows.map((r) => ({
      id: String(r['id']),
      actor: typeof r['actor_id'] === 'string' ? (names.get(r['actor_id'] as string) ?? (r['actor_id'] as string)) : 'system',
      action: String(r['action']),
      target: typeof r['target'] === 'string' ? (r['target'] as string) : null,
      createdAt: String(r['created_at']),
      detail: typeof r['detail'] === 'string' ? (r['detail'] as string) : null,
    })),
  );
}

/** GET /v1/admin/announcements — AdminAnnouncement[]. */
export async function handleAdminAnnouncements(req: Request, ctx: HttpContext): Promise<Response> {
  const gate = await requireAdmin(req, ctx, 'view.announcements');
  if (!gate.ok) return gate.response;
  if (!isAdminStorageConfigured(ctx.env)) return storageUnavailable();
  const rows = await sbSelect(ctx.env, 'announcements', 'select=id,text,active,created_by,created_at,updated_at&order=created_at.desc&limit=100');
  if (rows === null) return storageUnavailable();
  // Bulk-read audit (fix round M4 re-review): the announcements
  // list is a bulk read (row count only, never message text).
  writeAudit(ctx, { actorId: gate.user.id, actorRole: gate.user.role, action: 'admin.announcements.listRead', target: null, detail: `bulk read: ${rows.length} announcements` });
  return json(
    rows.map((r) => ({
      id: String(r['id']),
      message: String(r['text']),
      active: r['active'] === true,
      createdBy: typeof r['created_by'] === 'string' ? (r['created_by'] as string) : null,
      createdAt: typeof r['created_at'] === 'string' ? (r['created_at'] as string) : null,
      updatedAt: typeof r['updated_at'] === 'string' ? (r['updated_at'] as string) : null,
    })),
  );
}

/** POST /v1/admin/announcements — {message}. */
export async function handleAdminAnnouncementCreate(req: Request, ctx: HttpContext): Promise<Response> {
  const gate = await requireAdmin(req, ctx, 'announcements.edit');
  if (!gate.ok) return gate.response;
  const parsed = await parseBody(req);
  if (!parsed.ok) return parsed.response;
  const message = asString(parsed.body['message']);
  if (!message || message.trim().length === 0 || message.length > 500) {
    return err('message must be 1–500 characters.', 400);
  }
  if (!isAdminStorageConfigured(ctx.env)) return storageUnavailable();
  const inserted = await sbInsert(ctx.env, 'announcements', {
    text: message.trim(),
    active: true,
    created_by: gate.user.username,
  });
  if (!inserted) return storageUnavailable();
  const id = String((inserted[0] as SbRow)['id'] ?? '');
  writeAudit(ctx, { actorId: gate.user.id, actorRole: gate.user.role, action: 'admin.announcements.create', target: id, detail: message.trim().slice(0, 200) });
  return json({ ok: true, id }, 201);
}

/** PUT /v1/admin/announcements/:id — {message?, active?}. */
export async function handleAdminAnnouncementUpdate(req: Request, ctx: HttpContext, id: string): Promise<Response> {
  const gate = await requireAdmin(req, ctx, 'announcements.edit');
  if (!gate.ok) return gate.response;
  if (!isUuid(id)) return err('Invalid announcement id.', 400);
  const parsed = await parseBody(req);
  if (!parsed.ok) return parsed.response;
  const patch: SbRow = { updated_at: new Date().toISOString() };
  const message = parsed.body['message'];
  if (message !== undefined) {
    if (typeof message !== 'string' || message.trim().length === 0 || message.length > 500) {
      return err('message must be 1–500 characters.', 400);
    }
    patch['text'] = message.trim();
  }
  const active = parsed.body['active'];
  if (active !== undefined) {
    if (typeof active !== 'boolean') return err('active must be true/false.', 400);
    patch['active'] = active;
  }
  if (!isAdminStorageConfigured(ctx.env)) return storageUnavailable();
  const updated = await sbPatch(ctx.env, 'announcements', `id=eq.${encodeURIComponent(id)}`, patch);
  if (updated === null) return storageUnavailable();
  if (updated.length === 0) return err('That announcement was not found.', 404);
  writeAudit(ctx, { actorId: gate.user.id, actorRole: gate.user.role, action: 'admin.announcements.update', target: id, detail: null });
  return json({ ok: true });
}

/** DELETE /v1/admin/announcements/:id. */
export async function handleAdminAnnouncementDelete(req: Request, ctx: HttpContext, id: string): Promise<Response> {
  const gate = await requireAdmin(req, ctx, 'announcements.edit');
  if (!gate.ok) return gate.response;
  if (!isUuid(id)) return err('Invalid announcement id.', 400);
  if (!isAdminStorageConfigured(ctx.env)) return storageUnavailable();
  const removed = await sbDelete(ctx.env, 'announcements', `id=eq.${encodeURIComponent(id)}`);
  if (!removed) return storageUnavailable();
  writeAudit(ctx, { actorId: gate.user.id, actorRole: gate.user.role, action: 'admin.announcements.delete', target: id, detail: null });
  return json({ ok: true });
}

/** GET /v1/admin/announcements/public — no auth; the one active banner (or null).
 * Public shape strips createdBy/createdAt/updatedAt (fix round M1):
 * the home page needs id + message + active only. */
export async function handleAdminAnnouncementsPublic(_req: Request, ctx: HttpContext): Promise<Response> {
  let rows: SbRow[] | null = null;
  if (isAdminStorageConfigured(ctx.env)) {
    rows = await sbSelect(ctx.env, 'announcements', 'select=id,text,active,created_by,created_at,updated_at&active=eq.true&order=created_at.desc&limit=10');
  }
  const list: AdminAnnouncement[] = (rows ?? []).map((r) => ({
    id: String(r['id']),
    message: String(r['text']),
    active: r['active'] === true,
    createdBy: typeof r['created_by'] === 'string' ? (r['created_by'] as string) : null,
    createdAt: typeof r['created_at'] === 'string' ? (r['created_at'] as string) : null,
    updatedAt: typeof r['updated_at'] === 'string' ? (r['updated_at'] as string) : null,
  }));
  const picked = pickPublicAnnouncement(list);
  const res = json(picked ? { id: picked.id, message: picked.message, active: picked.active } : null);
  res.headers.set('Cache-Control', 'public, max-age=60');
  return res;
}

// ---------------------------------------------------------------------------
// Admin accounts (RBAC users) — Owner only. NEVER returns password_hash.
// ---------------------------------------------------------------------------

function publicAdminUser(row: SbRow): Record<string, unknown> {
  return {
    id: String(row['id']),
    username: String(row['username']),
    role: String(row['role']),
    disabled: row['disabled'] === true,
    createdAt: typeof row['created_at'] === 'string' ? (row['created_at'] as string) : null,
  };
}

/** GET /v1/admin/users — AdminUserRow[] (no password hashes — the map above is the only shape returned). */
export async function handleAdminUsers(req: Request, ctx: HttpContext): Promise<Response> {
  const gate = await requireAdmin(req, ctx, 'view.users');
  if (!gate.ok) return gate.response;
  if (!isAdminStorageConfigured(ctx.env)) return storageUnavailable();
  const rows = await sbSelect(ctx.env, 'admin_users', 'select=id,username,role,disabled,created_at&order=created_at.asc&limit=100');
  if (rows === null) return storageUnavailable();
  // Bulk-read audit (fix round M4 re-review): the user directory is
  // the other most sensitive unlogged list — it leaves a trail now
  // (row count only, never usernames).
  writeAudit(ctx, { actorId: gate.user.id, actorRole: gate.user.role, action: 'admin.users.listRead', target: null, detail: `bulk read: ${rows.length} users` });
  return json(rows.map(publicAdminUser));
}

/** POST /v1/admin/users — create an Admin or Staff account (Owner accounts are never created here).
 * New accounts start with must_change_password=true (fix round n6):
 * the Owner hands the new user a first password, and the user must
 * rotate it on first login (the login response carries
 * mustChangePassword; POST /v1/admin/auth/change-password clears it
 * — self-service for any role — and PUT /v1/admin/users/:id
 * {password} re-arms it on an Owner reset). */
export async function handleAdminUserCreate(req: Request, ctx: HttpContext): Promise<Response> {
  const gate = await requireAdmin(req, ctx, 'users.manage');
  if (!gate.ok) return gate.response;
  const parsed = await parseBody(req);
  if (!parsed.ok) return parsed.response;
  const username = asString(parsed.body['username']);
  const role = asString(parsed.body['role']);
  const password = asString(parsed.body['password']);
  if (!username || !isValidAdminUsername(username)) {
    return err('Pick a username with at least 3 characters (letters, digits, . _ -).', 400);
  }
  if (role !== 'admin' && role !== 'staff') {
    return err("role must be 'admin' or 'staff' — Owner accounts are never created here.", 400);
  }
  if (!isValidAdminPassword(password)) {
    return err('Pick a password with at least 12 characters.', 400);
  }
  if (!isAdminStorageConfigured(ctx.env)) return storageUnavailable();
  const existing = await sbSelect(ctx.env, 'admin_users', `select=id&username=eq.${encodeURIComponent(username.trim())}&limit=1`);
  if (existing === null) return storageUnavailable();
  if (existing.length > 0) return err('That username is already taken.', 409);
  const passwordHash = await hashAdminPassword(password);
  const inserted = await sbInsert(ctx.env, 'admin_users', {
    username: username.trim(),
    role,
    password_hash: passwordHash,
    disabled: false,
    must_change_password: true,
  });
  if (!inserted) return storageUnavailable();
  const id = String((inserted[0] as SbRow)['id'] ?? '');
  writeAudit(ctx, { actorId: gate.user.id, actorRole: gate.user.role, action: 'admin.users.create', target: id, detail: `${username.trim()} (${role}) — must change password on first login` });
  return json({ ok: true, id, username: username.trim(), role, mustChangePassword: true }, 201);
}

/**
 * PUT /v1/admin/users/:id — {role?, disabled?, password?}.
 * - Empty patch (nothing to change) → 400 (fix round n8).
 * - {password} resets that user's password (Owner-only, via
 *   users.manage): re-hashes, forces rotation on next login
 *   (must_change_password=true), and revokes ALL of their sessions.
 * - Demote/disable of the last Owner → 409 (pre-check). If the
 *   write itself fails AND the target is still the sole enabled
 *   Owner, the DB trigger fired (the race the pre-check missed) —
 *   answer 409 LAST_OWNER, not 503.
 * - Disabling a user revokes their sessions (fix round B3).
 */
export async function handleAdminUserUpdate(req: Request, ctx: HttpContext, id: string): Promise<Response> {
  const gate = await requireAdmin(req, ctx, 'users.manage');
  if (!gate.ok) return gate.response;
  if (!isUuid(id)) return err('Invalid user id.', 400);
  const parsed = await parseBody(req);
  if (!parsed.ok) return parsed.response;
  const role = parsed.body['role'];
  const disabled = parsed.body['disabled'];
  const passwordRaw = parsed.body['password'];
  const password = asString(passwordRaw);
  if (role !== undefined && role !== 'admin' && role !== 'staff' && role !== 'owner') {
    return err("role must be 'owner', 'admin' or 'staff'.", 400);
  }
  if (disabled !== undefined && typeof disabled !== 'boolean') {
    return err('disabled must be true/false.', 400);
  }
  if (passwordRaw !== undefined && !isValidAdminPassword(password)) {
    return err('Pick a password with at least 12 characters.', 400);
  }
  if (role === undefined && disabled === undefined && passwordRaw === undefined) {
    return err('Nothing to update — pass role, disabled or password.', 400);
  }
  if (!isAdminStorageConfigured(ctx.env)) return storageUnavailable();
  const rows = await sbSelect(ctx.env, 'admin_users', `select=id,username,role,disabled&id=eq.${encodeURIComponent(id)}`);
  if (rows === null) return storageUnavailable();
  const target = rows[0];
  if (!target) return err('That account was not found.', 404);
  const isOwner = target['role'] === 'owner';
  const demoting = role !== undefined && role !== 'owner';
  const disabling = disabled === true;
  if (isOwner && (demoting || disabling)) {
    // Never demote or disable the last Owner (fast path; the DB
    // trigger is the guarantee — see isSoleEnabledOwner below).
    const owners = await sbSelect(ctx.env, 'admin_users', 'select=id&role=eq.owner&disabled=eq.false&limit=10');
    if (owners === null) return storageUnavailable();
    if (owners.length <= 1) {
      return err('The last Owner cannot be demoted or disabled.', 409, undefined, 'LAST_OWNER');
    }
  }
  const patch: SbRow = {};
  if (role !== undefined) patch['role'] = role;
  if (disabled !== undefined) patch['disabled'] = disabled;
  if (passwordRaw !== undefined && password !== null) {
    patch['password_hash'] = await hashAdminPassword(password);
    patch['must_change_password'] = true;
  }
  const updated = await sbPatch(ctx.env, 'admin_users', `id=eq.${encodeURIComponent(id)}`, patch);
  if (updated === null) {
    // The write failed. If this was a demote/disable of an Owner and
    // the target is STILL the sole enabled Owner, the DB trigger
    // fired (the race) — 409, not 503.
    if (isOwner && (demoting || disabling)) {
      const sole = await isSoleEnabledOwner(ctx, id);
      if (sole === true) {
        return err('The last Owner cannot be demoted or disabled.', 409, undefined, 'LAST_OWNER');
      }
    }
    return storageUnavailable();
  }
  // Disabling or resetting the password revokes the account's sessions.
  if (disabling || (passwordRaw !== undefined && password !== null)) {
    await revokeAdminSessions(ctx.env, id);
  }
  // The audit row never carries a password hash (not even the new one).
  const auditPatch: SbRow = { ...patch };
  if ('password_hash' in auditPatch) auditPatch['password_hash'] = '<redacted>';
  writeAudit(ctx, { actorId: gate.user.id, actorRole: gate.user.role, action: 'admin.users.update', target: id, detail: JSON.stringify(auditPatch) });
  return json({ ok: true });
}

/**
 * DELETE /v1/admin/users/:id — a NON-last Owner CAN be deleted
 * (fix round B3: the old code refused every Owner delete). The last
 * Owner still 409s (pre-check + DB trigger backstop, same as
 * update). Sessions for the deleted account are revoked first.
 */
export async function handleAdminUserDelete(req: Request, ctx: HttpContext, id: string): Promise<Response> {
  const gate = await requireAdmin(req, ctx, 'users.manage');
  if (!gate.ok) return gate.response;
  if (!isUuid(id)) return err('Invalid user id.', 400);
  if (!isAdminStorageConfigured(ctx.env)) return storageUnavailable();
  const rows = await sbSelect(ctx.env, 'admin_users', `select=id,username,role&id=eq.${encodeURIComponent(id)}`);
  if (rows === null) return storageUnavailable();
  const target = rows[0];
  if (!target) return err('That account was not found.', 404);
  if (target['role'] === 'owner') {
    const owners = await sbSelect(ctx.env, 'admin_users', 'select=id&role=eq.owner&disabled=eq.false&limit=10');
    if (owners === null) return storageUnavailable();
    if (owners.length <= 1) {
      return err('The last Owner cannot be deleted.', 409, undefined, 'LAST_OWNER');
    }
  }
  // Revoke every session for the deleted account, then delete the account.
  await revokeAdminSessions(ctx.env, id);
  const removed = await sbDelete(ctx.env, 'admin_users', `id=eq.${encodeURIComponent(id)}`);
  if (!removed) {
    if (target['role'] === 'owner') {
      const sole = await isSoleEnabledOwner(ctx, id);
      if (sole === true) {
        return err('The last Owner cannot be deleted.', 409, undefined, 'LAST_OWNER');
      }
    }
    return storageUnavailable();
  }
  writeAudit(ctx, { actorId: gate.user.id, actorRole: gate.user.role, action: 'admin.users.delete', target: id, detail: String(target['username']) });
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Payments & Billing (INACTIVE — designed, not live)
// ---------------------------------------------------------------------------

/**
 * Billing is NOT live: no payment provider is connected, no SDKs, no
 * keys (live or test), no charges, no card data anywhere. Every
 * endpoint below returns real structure with availability info and
 * empty, honest data — never a fake transaction or fake revenue.
 *
 * Gating: one flag per capability (ADMIN_FUTURE_FLAGS in shared):
 * billing.overview / .transactions / .plans / .providers / .refunds /
 * .tax — all default OFF. When a flag is OFF the endpoint returns
 * the not-available shape. When a flag is ON the endpoint STAYS
 * inert without a provider: it still returns available:false, with
 * a reason naming the missing provider (no charge path exists in
 * this codebase at all). Activation later = flag flip + provider
 * connection, not a rebuild.
 */
function futureFlag(key: AdminFutureFlagKey): { unlocksWhen: string; willDo: string } {
  const found = ADMIN_FUTURE_FLAGS.find((f) => f.key === key);
  return {
    unlocksWhen: found?.unlocksWhen ?? 'Activates in a future upgrade.',
    willDo: found?.willDo ?? '',
  };
}

async function billingFlags(ctx: HttpContext): Promise<Record<string, boolean> | null> {
  if (!isAdminStorageConfigured(ctx.env)) return null;
  return getRuntimeFlags(ctx.env);
}

function billingUnavailable(
  flagKey: AdminFutureFlagKey,
  flagOn: boolean,
  data: Record<string, unknown>,
): Response {
  const { unlocksWhen, willDo } = futureFlag(flagKey);
  return json({
    available: false,
    reason: flagOn
      ? 'Billing is switched on but no payment provider is connected — no charges can be made.'
      : FUTURE_UPGRADE_MESSAGE,
    unlocksWhen,
    willDo,
    ...data,
  });
}

/** GET /v1/admin/billing/overview — totals are null (no sales exist), never 0-as-revenue. */
export async function handleAdminBillingOverview(req: Request, ctx: HttpContext): Promise<Response> {
  const gate = await requireAdmin(req, ctx, 'view.billing');
  if (!gate.ok) return gate.response;
  const flags = await billingFlags(ctx);
  if (flags === null) return storageUnavailable();
  return billingUnavailable('billing.overview', flags['billing.overview'] === true, {
    totals: null,
    revenueInr: null,
    transactions: [],
    refunds: [],
    note: 'No payment provider is connected. No transactions exist.',
  });
}

/** GET /v1/admin/billing/transactions — empty list, never invented rows. */
export async function handleAdminBillingTransactions(req: Request, ctx: HttpContext): Promise<Response> {
  const gate = await requireAdmin(req, ctx, 'view.billing');
  if (!gate.ok) return gate.response;
  const flags = await billingFlags(ctx);
  if (flags === null) return storageUnavailable();
  return billingUnavailable('billing.transactions', flags['billing.transactions'] === true, {
    transactions: [],
  });
}

/** GET /v1/admin/billing/plans — the ONE planned plan (Host Pass ₹299, not on sale). */
export async function handleAdminBillingPlans(req: Request, ctx: HttpContext): Promise<Response> {
  const gate = await requireAdmin(req, ctx, 'view.billing');
  if (!gate.ok) return gate.response;
  const flags = await billingFlags(ctx);
  if (flags === null) return storageUnavailable();
  return billingUnavailable('billing.plans', flags['billing.plans'] === true, {
    plans: [HOST_PASS_PLAN],
  });
}

/** GET /v1/admin/billing/providers — no provider connected; no card data is stored or processed. */
export async function handleAdminBillingProviders(req: Request, ctx: HttpContext): Promise<Response> {
  const gate = await requireAdmin(req, ctx, 'view.billing');
  if (!gate.ok) return gate.response;
  const flags = await billingFlags(ctx);
  if (flags === null) return storageUnavailable();
  return billingUnavailable('billing.providers', flags['billing.providers'] === true, {
    providers: [],
    note: 'No payment provider is connected. No card data is stored or processed on our servers.',
  });
}

/** GET /v1/admin/billing/refunds — empty list. */
export async function handleAdminBillingRefunds(req: Request, ctx: HttpContext): Promise<Response> {
  const gate = await requireAdmin(req, ctx, 'view.billing');
  if (!gate.ok) return gate.response;
  const flags = await billingFlags(ctx);
  if (flags === null) return storageUnavailable();
  return billingUnavailable('billing.refunds', flags['billing.refunds'] === true, {
    refunds: [],
  });
}

/** GET /v1/admin/billing/tax — no invoices; GST retention rule is CA-verification pending (never guessed). */
export async function handleAdminBillingTax(req: Request, ctx: HttpContext): Promise<Response> {
  const gate = await requireAdmin(req, ctx, 'view.billing');
  if (!gate.ok) return gate.response;
  const flags = await billingFlags(ctx);
  if (flags === null) return storageUnavailable();
  return billingUnavailable('billing.tax', flags['billing.tax'] === true, {
    invoices: [],
    note: 'GST invoicing starts with the first sale. The exact GST record-retention period is CA-verification pending — see docs/admin-console.md. It is not guessed here.',
  });
}

// ---------------------------------------------------------------------------
// Users & Accounts — directory (REAL today) + future account features
// ---------------------------------------------------------------------------

/**
 * The directory is REAL today: Pakdam players are guests (codename +
 * room, no login, no invented identity fields). It reads the same
 * players mirror as /v1/admin/players and is NOT flag-gated — the
 * guest data already exists. The accounts.directory flag governs the
 * FUTURE account-level views (roles, account detail); the guest
 * directory is live data, so gating it OFF would hide real safety
 * information. Ban/suspend/unban are REAL actions on the seat
 * credential (blocks table + live kick) — see handleAdminPlayerAction
 * for the enforcement boundary (no device key exists in the game
 * today; a ban binds to the reconnect-token hash).
 *
 * This is deliberately SEPARATE from /v1/admin/users (RBAC admin
 * accounts — staff). Admin accounts = who runs the panel. Player
 * directory = who plays the game. Never confuse the two.
 */

/** GET /v1/admin/users-directory — guest players (codename, room, status). */
export async function handleAdminUsersDirectory(req: Request, ctx: HttpContext): Promise<Response> {
  const gate = await requireAdmin(req, ctx, 'view.accounts');
  if (!gate.ok) return gate.response;
  if (!isAdminStorageConfigured(ctx.env)) return storageUnavailable();
  const players = await sbSelect(
    ctx.env,
    'players',
    'select=player_id,room_id,display_name,kind,match_role,team,connection_state,last_fix_at,left_at,joined_at&order=joined_at.desc&limit=200',
  );
  const rooms = await sbSelect(ctx.env, 'rooms', 'select=room_id,room_code,phase&limit=500');
  const blocks = await sbSelect(ctx.env, 'blocks', 'select=player_id,action,expires_at&limit=500');
  if (players === null || rooms === null || blocks === null) return storageUnavailable();
  const roomInfo = new Map<string, { code: string; phase: string }>();
  for (const r of rooms) {
    roomInfo.set(String(r['room_id']), { code: String(r['room_code']), phase: String(r['phase']) });
  }
  const nowMs = Date.now();
  const statusByPlayer = new Map<string, 'active' | 'blocked' | 'suspended'>();
  for (const b of blocks) {
    const exp = b['expires_at'];
    if (typeof exp === 'string' && Date.parse(exp) <= nowMs) continue;
    const pid = String(b['player_id'] ?? '');
    if (!pid) continue;
    statusByPlayer.set(pid, b['action'] === 'suspend' ? 'suspended' : 'blocked');
  }
  // Bulk-read audit (fix round item 10).
  writeAudit(ctx, { actorId: gate.user.id, actorRole: gate.user.role, action: 'admin.accounts.listRead', target: null, detail: `bulk read: ${players.length} players` });
  return json({
    available: true,
    accountsAvailable: false,
    note: 'Guest players only — player accounts do not exist yet. No identity fields are invented.',
    players: players.map((p) => {
      const pid = String(p['player_id']);
      const info = roomInfo.get(String(p['room_id']));
      return {
        playerId: pid,
        codename: String(p['display_name']),
        kind: String(p['kind'] ?? 'guest'),
        roomId: typeof p['room_id'] === 'string' ? (p['room_id'] as string) : null,
        roomCode: info?.code ?? null,
        roomPhase: info?.phase ?? null,
        matchRole: typeof p['match_role'] === 'string' ? (p['match_role'] as string) : null,
        team: typeof p['team'] === 'string' ? (p['team'] as string) : null,
        connected: p['connection_state'] === 'connected' && p['left_at'] === null,
        lastFixAt: typeof p['last_fix_at'] === 'string' ? (p['last_fix_at'] as string) : null,
        status: statusByPlayer.get(pid) ?? 'active',
      };
    }),
  });
}

/** GET /v1/admin/users-directory/:id — profile, games, purchases (empty/future), status. */
export async function handleAdminUsersDirectoryDetail(
  req: Request,
  ctx: HttpContext,
  playerId: string,
): Promise<Response> {
  const gate = await requireAdmin(req, ctx, 'view.accounts');
  if (!gate.ok) return gate.response;
  if (!isUuid(playerId)) return err('Invalid player id.', 400);
  if (!isAdminStorageConfigured(ctx.env)) return storageUnavailable();
  const rows = await sbSelect(
    ctx.env,
    'players',
    `select=player_id,room_id,display_name,kind,match_role,team,connection_state,last_fix_at,left_at,joined_at&player_id=eq.${encodeURIComponent(playerId)}`,
  );
  if (rows === null) return storageUnavailable();
  const row = rows[0];
  if (!row) return err('That player was not found.', 404);
  const roomId = typeof row['room_id'] === 'string' ? (row['room_id'] as string) : null;
  const roomRows = roomId
    ? await sbSelect(ctx.env, 'rooms', `select=room_id,room_code,phase,started_at,ends_at&room_id=eq.${encodeURIComponent(roomId)}`)
    : [];
  if (roomRows === null) return storageUnavailable();
  const blocks = await activeBlocksForPlayer(ctx.env, playerId);
  const status = blocks.some((b) => b.action === 'ban') ? 'blocked' : blocks.length > 0 ? 'suspended' : 'active';
  return json({
    available: true,
    accountsAvailable: false,
    player: {
      playerId,
      codename: String(row['display_name']),
      kind: String(row['kind'] ?? 'guest'),
      matchRole: typeof row['match_role'] === 'string' ? (row['match_role'] as string) : null,
      team: typeof row['team'] === 'string' ? (row['team'] as string) : null,
      connected: row['connection_state'] === 'connected' && row['left_at'] === null,
      joinedAt: typeof row['joined_at'] === 'string' ? (row['joined_at'] as string) : null,
      lastFixAt: typeof row['last_fix_at'] === 'string' ? (row['last_fix_at'] as string) : null,
      status,
    },
    games: (roomRows ?? []).map((r) => ({
      roomId: String(r['room_id']),
      roomCode: String(r['room_code']),
      phase: String(r['phase']),
      startedAt: typeof r['started_at'] === 'string' ? (r['started_at'] as string) : null,
      endsAt: typeof r['ends_at'] === 'string' ? (r['ends_at'] as string) : null,
    })),
    // No purchases exist — no billing provider, no sales. Empty by fact, not by omission.
    purchases: [],
    blocks: blocks.map((b) => ({
      id: b.id,
      action: b.action,
      reason: b.reason,
      expiresAt: b.expiresAt,
    })),
  });
}

/**
 * POST /v1/admin/users-directory/:id/{ban|suspend|unban} — REAL.
 * Ban = indefinite block; suspend = time-boxed block (default 7
 * days, body {reason, suspendDays?}). Both kick the live seat first
 * (best-effort) and record a blocks row keyed by playerId + the
 * seat's reconnect-token hash, so a rejoin with the stored token is
 * refused at the join gate (see isReconnectHashBlocked). Unban
 * removes the rows. All three are audit-logged.
 */
export async function handleAdminDirectoryBan(
  req: Request,
  ctx: HttpContext,
  playerId: string,
  action: 'ban' | 'suspend' | 'unban',
): Promise<Response> {
  // Unban uses players.unblock (fix round item 9 — it used to reuse
  // players.block, so the matrix's unblock permission was dead).
  const permission: AdminPermission = action === 'unban' ? 'players.unblock' : 'players.block';
  const gate = await requireAdmin(req, ctx, permission);
  if (!gate.ok) return gate.response;
  if (!isUuid(playerId)) return err('Invalid player id.', 400);
  if (!isAdminStorageConfigured(ctx.env)) return storageUnavailable();
  const parsed = await parseBody(req);
  if (!parsed.ok) return parsed.response;
  const reason = asString(parsed.body['reason']);
  const suspendDays = parsed.body['suspendDays'];
  if (action !== 'unban' && (!reason || reason.length > 500)) {
    return err('reason is required (max 500 characters).', 400);
  }
  if (action === 'suspend' && suspendDays !== undefined && (typeof suspendDays !== 'number' || !Number.isInteger(suspendDays) || suspendDays < 1 || suspendDays > 365)) {
    return err('suspendDays must be an integer between 1 and 365.', 400);
  }
  const rows = await sbSelect(
    ctx.env,
    'players',
    `select=room_id,reconnect_token_hash,is_host&player_id=eq.${encodeURIComponent(playerId)}`,
  );
  if (rows === null) return storageUnavailable();
  const row = rows[0];
  if (!row) return err('That player was not found.', 404);
  const roomId = typeof row['room_id'] === 'string' ? (row['room_id'] as string) : null;

  if (action === 'unban') {
    const removed = await sbDelete(ctx.env, 'blocks', `player_id=eq.${encodeURIComponent(playerId)}`);
    if (!removed) return storageUnavailable();
    writeAudit(ctx, { actorId: gate.user.id, actorRole: gate.user.role, action: 'admin.players.unban', target: playerId, detail: 'directory unban' });
    return json({ ok: true });
  }

  // HOST GUARD (fix round item 12): a live room host is refused
  // 409 — no kick attempt, no block row.
  if (row['is_host'] === true) {
    writeAudit(ctx, { actorId: gate.user.id, actorRole: gate.user.role, action: action === 'ban' ? 'admin.players.ban' : 'admin.players.suspend', target: playerId, detail: 'refused: target is the room host — end or cancel the room first' });
    return err('The room host cannot be banned or suspended — end or cancel the room first.', 409, undefined, 'HOST_PROTECTED');
  }

  const liveKick: LiveKickResult = roomId
    ? await kickLiveSeat(ctx, roomId, playerId, gate.user.username)
    : 'room-gone';
  const days = action === 'suspend' ? (typeof suspendDays === 'number' ? suspendDays : 7) : null;
  const inserted = await sbInsert(ctx.env, 'blocks', {
    device_id: playerId,
    player_id: playerId,
    reconnect_token_hash: typeof row['reconnect_token_hash'] === 'string' ? (row['reconnect_token_hash'] as string) : null,
    action,
    reason: reason as string,
    expires_at: days !== null ? new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString() : null,
    blocked_by: gate.user.username,
  });
  if (!inserted) return storageUnavailable();
  writeAudit(ctx, {
    actorId: gate.user.id,
    actorRole: gate.user.role,
    action: action === 'ban' ? 'admin.players.ban' : 'admin.players.suspend',
    target: playerId,
    detail: `${action}: ${(reason as string).slice(0, 200)}; live kick: ${liveKick}`,
  });
  return json({ ok: true, liveKick, enforcement: 'seat-credential' });
}

/**
 * GET /v1/admin/data-requests — DPDP access/correction/erasure
 * request flow. FUTURE: flag accounts.dataRequests is OFF, so this
 * returns the not-available shape and the (empty) design table is
 * never written by any live intake. When the flag flips, the rows
 * come from data_requests (migration 0010).
 */
export async function handleAdminDataRequests(req: Request, ctx: HttpContext): Promise<Response> {
  const gate = await requireAdmin(req, ctx, 'view.accounts');
  if (!gate.ok) return gate.response;
  const flags = await billingFlags(ctx);
  if (flags === null) return storageUnavailable();
  const { unlocksWhen, willDo } = futureFlag('accounts.dataRequests');
  if (flags['accounts.dataRequests'] !== true) {
    return json({
      available: false,
      reason: FUTURE_UPGRADE_MESSAGE,
      unlocksWhen,
      willDo,
      requests: [],
      note: 'No live request intake yet. Erasure today is the Owner-only POST /v1/admin/players/:id/erase endpoint.',
    });
  }
  const rows = await sbSelect(ctx.env, 'data_requests', 'select=id,player_id,kind,contact_ref,status,created_at,resolved_at&order=created_at.desc&limit=100');
  if (rows === null) return storageUnavailable();
  // M4-1 (fix round M4): this list read exposes player ids + contact
  // refs, so it leaves an audit row — count only, never row data.
  writeAudit(ctx, { actorId: gate.user.id, actorRole: gate.user.role, action: 'admin.dataRequests.listRead', target: null, detail: `bulk read: ${rows.length} data requests` });
  return json({ available: true, requests: rows });
}

/**
 * GET /v1/admin/login-methods — Google / email magic link per the v2
 * login feature. FUTURE: flag accounts.loginMethods is OFF, and the
 * login feature itself is not built — even with the flag ON this
 * stays available:false until the v2 login lands. No phone OTP, ever
 * (decided in the v2 spec).
 */
export async function handleAdminLoginMethods(req: Request, ctx: HttpContext): Promise<Response> {
  const gate = await requireAdmin(req, ctx, 'view.accounts');
  if (!gate.ok) return gate.response;
  const flags = await billingFlags(ctx);
  if (flags === null) return storageUnavailable();
  const { unlocksWhen, willDo } = futureFlag('accounts.loginMethods');
  const flagOn = flags['accounts.loginMethods'] === true;
  return json({
    available: false,
    reason: flagOn
      ? 'Login methods are switched on but the login feature is not built yet.'
      : FUTURE_UPGRADE_MESSAGE,
    unlocksWhen,
    willDo,
    methods: [
      { method: 'google', status: 'future', note: 'Sign in with Google (v2 login feature).' },
      { method: 'email', status: 'future', note: 'Email magic link. No phone OTP.' },
    ],
  });
}
