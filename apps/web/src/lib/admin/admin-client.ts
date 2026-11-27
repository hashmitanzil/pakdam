/**
 * Admin API client — Mission Control HTTP calls.
 *
 * Base URL is `NEXT_PUBLIC_WORKER_URL`, the same base the game uses
 * (apps/web/src/lib/websocket.ts `getWorkerUrl`). Every admin call
 * sends the session bearer token; the token is never logged and never
 * put in a URL. Public reads (announcement / flags / config) need no
 * token and are cached in memory for 60 s — the game reads them at
 * startup and never more often than that.
 *
 * Error mapping (plain words, no leak):
 * - 401 → the session is gone; the caller sends the admin back to
 *   /admin/login. `AdminApiError.kind === 'unauthorized'`.
 * - 403 → "You don't have permission for this."
 *   (`kind === 'forbidden'`), EXCEPT 403 with code
 *   PASSWORD_CHANGE_REQUIRED: the server's own message ("You must
 *   change your password…") is kept, and the guard / data hooks
 *   redirect to /admin/change-password?forced=1 instead of showing
 *   an error (see `isPasswordChangeRequiredError`,
 *   `passwordChangeRedirectFor`). The server is the authority; the UI
 *   gating only hides buttons, it never decides.
 * - 423 (locked) / 429 on login → lockout copy, see `loginErrorCopy`.
 * - Anything else → the server's plain message when it has one,
 *   else "Something went wrong — try again."
 *
 * If a route in the FIXED contract is missing server-side (Kabir's
 * half), these calls fail with a plain error — the client never
 * invents its own endpoints.
 */
import {
  ADMIN_SETUP_FAILED_MESSAGE,
  type AdminAnnouncement,
  type AdminFlag,
  type AdminFlagKey,
  type AdminFutureFlagKey,
  type AdminGameConfig,
  type AdminMe,
  type AdminRole,
} from '@pakdam/shared';
import { getWorkerUrl } from '../websocket';
import { fetchWithRetry } from '../api-client';
import { readAdminSession } from './admin-session';

export class AdminApiError extends Error {
  readonly status: number;
  readonly kind: 'unauthorized' | 'forbidden' | 'locked' | 'plain';
  readonly code?: string;
  constructor(status: number, message: string, kind: AdminApiError['kind'], code?: string) {
    super(message);
    this.status = status;
    this.kind = kind;
    this.code = code;
  }
}

export const ADMIN_FORBIDDEN_MESSAGE = "You don't have permission for this.";
export const ADMIN_SESSION_EXPIRED_MESSAGE = 'Your session ended. Sign in again.';
export const ADMIN_GENERIC_ERROR = 'Something went wrong — try again.';
/**
 * Forced password change (fix round 2, 2026-11-26). The server
 * refuses a flagged session on every admin route except
 * change-password/logout with 403 + this code, and GET /me refuses
 * it too — so the flag is only ever visible to the client as this
 * error (or on the login response). `code` is carried on
 * AdminApiError so the guard and the data hooks can branch on it
 * instead of treating it as a generic 403.
 */
export const PASSWORD_CHANGE_REQUIRED_CODE = 'PASSWORD_CHANGE_REQUIRED';
/** Where a flagged session is sent (from the guard or a data fetch). */
export const ADMIN_CHANGE_PASSWORD_URL = '/admin/change-password?forced=1';
/** Fallback copy when the server sends no message with the 403. */
export const ADMIN_PASSWORD_CHANGE_REQUIRED_MESSAGE =
  'You must change your password before using the admin panel.';
/**
 * Shown on /admin/login after a password rotation (query
 * `?relogin=1`). The server revokes ALL sessions on rotation, so
 * the user must sign in again — with the new password — and the
 * notice must say so plainly, on the page they land on.
 */
export const ADMIN_RELOGIN_NOTICE = 'Password changed. Sign in again with your new password.';

/** True when `err` is the server's forced-password-change refusal. */
export function isPasswordChangeRequiredError(err: unknown): boolean {
  return err instanceof AdminApiError && err.code === PASSWORD_CHANGE_REQUIRED_CODE;
}

/**
 * The change-password redirect for a flagged session on `pathname`,
 * or null when no redirect applies. Pure, so unit tests can pin the
 * decision without React/Next. Never redirects on the change page
 * itself (that would loop: the flagged user IS where they need to
 * be, and /me 403s for them there too), and never from the public
 * pages — /admin/login sends a stored session to /admin, where the
 * shell then bounces it to the change page, so the login redirect
 * is deliberately left alone.
 */
export function passwordChangeRedirectFor(pathname: string | null | undefined, flagged: boolean): string | null {
  if (!flagged) return null;
  if (pathname === '/admin/change-password' || pathname === '/admin/login' || pathname === '/admin/setup') {
    return null;
  }
  return ADMIN_CHANGE_PASSWORD_URL;
}
/** Shown when a password/session endpoint does not exist server-side yet. */
export const ADMIN_NOT_ON_SERVER_YET_MESSAGE = 'This is not available on the server yet — ask the coordinator.';

/**
 * HTTPS assertion (Zara n10) — credentials and bearer tokens must
 * never travel over plaintext. Rejects a non-https Worker URL
 * except localhost (local dev only). Returns the plain-words error,
 * or null when the URL is fine. Pure, so tests can pin it directly.
 */
export function adminWorkerUrlError(base: string): string | null {
  if (!base) return 'The game server address is not set up yet.';
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    return 'The game server address is not set up correctly.';
  }
  if (parsed.protocol === 'https:') return null;
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return null;
  return 'The game server address must use https — sign-in is blocked over an insecure connection.';
}

/** The checked Worker base URL, or throws a plain-words AdminApiError. */
function checkedWorkerUrl(): string {
  const base = getWorkerUrl();
  const problem = adminWorkerUrlError(base);
  if (problem) throw new AdminApiError(0, problem, 'plain');
  return base;
}

/**
 * Login error copy. Never says whether the username or the password
 * was wrong — one message covers both. A lockout (423, or 429 with a
 * lockout code) names the wait in plain words.
 */
export function loginErrorCopy(status: number, code?: string): string {
  if (status === 423 || code === 'ACCOUNT_LOCKED' || code === 'LOCKED_OUT') {
    return 'Too many wrong tries — this account is locked for a while. Wait 15 minutes and try again.';
  }
  if (status === 429) {
    return 'Too many tries — wait a moment and try again.';
  }
  if (status === 400 || status === 401 || status === 404) {
    return 'Wrong username or password. Check both and try again.';
  }
  return ADMIN_GENERIC_ERROR;
}

export function adminErrorMessage(status: number, serverMessage?: string, code?: string): string {
  if (status === 401) return ADMIN_SESSION_EXPIRED_MESSAGE;
  // A forced password change is not a permission problem — keep the
  // server's message so the user is told what to do, never the
  // generic "You don't have permission for this."
  if (status === 403 && code === PASSWORD_CHANGE_REQUIRED_CODE) {
    if (serverMessage && serverMessage.trim().length > 0 && serverMessage.length < 200) {
      return serverMessage;
    }
    return ADMIN_PASSWORD_CHANGE_REQUIRED_MESSAGE;
  }
  if (status === 403) return ADMIN_FORBIDDEN_MESSAGE;
  if (status === 404) return 'That was not found — it may have been removed.';
  if (status === 409) return 'That conflicts with something that already exists.';
  if (status === 429) return 'Too many tries — wait a moment and try again.';
  if (serverMessage && serverMessage.trim().length > 0 && serverMessage.length < 200) {
    return serverMessage;
  }
  return ADMIN_GENERIC_ERROR;
}

interface ErrorBody {
  error?: unknown;
  code?: unknown;
  message?: unknown;
}

async function readErrorBody(response: Response): Promise<ErrorBody> {
  try {
    const parsed: unknown = await response.json();
    if (typeof parsed === 'object' && parsed !== null) return parsed as ErrorBody;
    return {};
  } catch {
    return {};
  }
}

function errorKind(status: number, code?: string): AdminApiError['kind'] {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 423 || code === 'ACCOUNT_LOCKED' || code === 'LOCKED_OUT') return 'locked';
  return 'plain';
}

export async function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const base = checkedWorkerUrl();
  const session = readAdminSession();
  const headers = new Headers(init.headers ?? {});
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  if (session?.token) headers.set('Authorization', `Bearer ${session.token}`);
  const response = await fetchWithRetry(`${base}${path}`, { ...init, headers });
  if (!response.ok) {
    const body = await readErrorBody(response);
    const code = typeof body.code === 'string' ? body.code : undefined;
    const serverMessage =
      typeof body.error === 'string'
        ? body.error
        : typeof body.message === 'string'
          ? body.message
          : undefined;
    throw new AdminApiError(
      response.status,
      adminErrorMessage(response.status, serverMessage, code),
      errorKind(response.status, code),
      code,
    );
  }
  return response;
}

async function adminJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await adminFetch(path, init);
  return (await response.json()) as T;
}

/** POST /v1/admin/auth/login — returns the bearer token + identity. */
export async function adminLogin(
  username: string,
  password: string,
): Promise<{ token: string; username: string; role: AdminRole; mustChangePassword: boolean }> {
  const base = checkedWorkerUrl();
  let response: Response;
  try {
    response = await fetch(`${base}/v1/admin/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
  } catch {
    throw new AdminApiError(0, 'Could not reach the server — check your connection and try again.', 'plain');
  }
  if (!response.ok) {
    const body = await readErrorBody(response);
    const code = typeof body.code === 'string' ? body.code : undefined;
    throw new AdminApiError(
      response.status,
      loginErrorCopy(response.status, code),
      errorKind(response.status, code),
      code,
    );
  }
  const parsed = (await response.json()) as {
    token?: unknown;
    username?: unknown;
    role?: unknown;
    mustChangePassword?: unknown;
  };
  if (typeof parsed.token !== 'string' || !parsed.token) {
    throw new AdminApiError(0, ADMIN_GENERIC_ERROR, 'plain');
  }
  return {
    token: parsed.token,
    username: typeof parsed.username === 'string' ? parsed.username : username,
    role: parsed.role === 'owner' || parsed.role === 'admin' || parsed.role === 'staff' ? parsed.role : 'staff',
    // The server sets this for accounts that must change their
    // password on first sign-in (Owner-created accounts). Absent =
    // no forced change.
    mustChangePassword: parsed.mustChangePassword === true,
  };
}

/**
 * POST /v1/admin/auth/setup — first Owner account (only works before
 * any admin exists). The setup token is REQUIRED and password-masked
 * in the form; the server fails closed without it. A 403 never says
 * whether the token or the account was the problem — one generic
 * line covers both.
 */
export async function adminSetup(
  username: string,
  password: string,
  setupToken: string,
): Promise<{ token: string; username: string; role: AdminRole }> {
  const base = checkedWorkerUrl();
  const response = await fetch(`${base}/v1/admin/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, setupToken }),
  });
  if (!response.ok) {
    const body = await readErrorBody(response);
    const code = typeof body.code === 'string' ? body.code : undefined;
    throw new AdminApiError(
      response.status,
      response.status === 409
        ? 'An Owner account already exists — sign in instead.'
        : response.status === 403
          ? ADMIN_SETUP_FAILED_MESSAGE
          : adminErrorMessage(response.status),
      errorKind(response.status, code),
      code,
    );
  }
  const parsed = (await response.json()) as { token?: unknown; username?: unknown; role?: unknown };
  return {
    token: typeof parsed.token === 'string' ? parsed.token : '',
    username: typeof parsed.username === 'string' ? parsed.username : username,
    role: 'owner',
  };
}

/** POST /v1/admin/auth/logout — best-effort; the client clears the session either way. */
export async function adminLogout(): Promise<void> {
  try {
    await adminFetch('/v1/admin/auth/logout', { method: 'POST' });
  } catch {
    // Logout is best-effort — a dead network must never trap the admin signed in.
  }
}

/** GET /v1/admin/auth/me — confirms the session and the role. */
export function adminMe(): Promise<AdminMe> {
  return adminJson<AdminMe>('/v1/admin/auth/me');
}

/**
 * POST /v1/admin/auth/change-password — change the signed-in
 * account's own password (current + new). Self-service for any
 * role: the server operates on the caller's session identity only
 * and takes no target user, so nobody can change anyone else's
 * password through it. The server enforces the 12+ policy too.
 * A 404 surfaces the plain "not available on the server yet" line
 * instead of a crash (defensive fallback — the endpoint exists).
 *
 * Returns the server's `reLogin` flag: on success the server has
 * revoked ALL sessions for the account (including this one), so
 * `reLogin === true` means the caller must clear the stored session
 * and send the user to /admin/login with the re-login notice —
 * never back to /admin, where the revoked session would bounce
 * them to login with no explanation.
 */
export async function adminChangePassword(
  currentPassword: string,
  newPassword: string,
): Promise<{ reLogin: boolean }> {
  try {
    const response = await adminFetch('/v1/admin/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    let parsed: unknown = {};
    try {
      parsed = await response.json();
    } catch {
      parsed = {};
    }
    return {
      reLogin:
        typeof parsed === 'object' && parsed !== null && (parsed as { reLogin?: unknown }).reLogin === true,
    };
  } catch (err) {
    if (err instanceof AdminApiError && err.status === 404) {
      throw new AdminApiError(404, ADMIN_NOT_ON_SERVER_YET_MESSAGE, 'plain');
    }
    throw err;
  }
}

/**
 * POST /v1/admin/users/:id/revoke-sessions — sign one account out
 * everywhere (all sessions revoked). The endpoint IS routed
 * (workers/src/index.ts, POST /v1/admin/users/:id/revoke-sessions);
 * a 404 still surfaces the plain "not available yet" line as a
 * defensive fallback, never a crash.
 */
export async function adminRevokeUserSessions(userId: string): Promise<void> {
  try {
    await adminFetch(`/v1/admin/users/${encodeURIComponent(userId)}/revoke-sessions`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  } catch (err) {
    if (err instanceof AdminApiError && err.status === 404) {
      throw new AdminApiError(404, ADMIN_NOT_ON_SERVER_YET_MESSAGE, 'plain');
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Typed payloads (the FIXED contract shapes; extra fields are ignored) */
/* ------------------------------------------------------------------ */

export interface AdminOverview {
  liveGames: number;
  playersOnline: number;
  roomsOpen: number;
  workerOk: boolean;
  errorsLastHour: number;
  /**
   * DO requests used today — the Worker CANNOT query Cloudflare DO
   * usage (no API token binding), so the server reports 0 plus
   * `doMeter` (see DO_METER_NOTE in workers/src/admin.ts). When
   * `doMeter` is present, the UI must show "—" and the note, never
   * the 0 as if it were a real count.
   */
  doRequestsToday: number;
  doMeter?: string | null;
}

export interface AdminRoomRow {
  id: string;
  code: string;
  phase: string;
  players: number;
  startedAt: string | null;
  zoneRadiusMetres: number | null;
}

export interface AdminRoomDetail extends AdminRoomRow {
  mode: string;
  playersList: { playerId: string; codename: string; role: string; connected: boolean }[];
  timers: { endsAtMs: number | null; phaseEndsAtMs: number | null };
}

export interface AdminPlayerRow {
  playerId: string;
  codename: string;
  roomCode: string | null;
  roomId: string | null;
  connected: boolean;
  gpsOk: boolean;
  lastFixAt: string | null;
  blocked: boolean;
}

export interface AdminSafety {
  reports: { id: string; kind: string; detail: string; createdAt: string; createdBy: string | null }[];
  blockedDevices: { deviceId: string; reason: string; blockedAt: string; blockedBy: string | null }[];
  abuseLog: { id: string; kind: string; detail: string; createdAt: string }[];
}

export interface AdminMetrics {
  /** See AdminOverview.doMeter — 0 + a note means "not measurable", never a real count. */
  doRequestsToday: number;
  doMeter?: string | null;
  dailyCap: number;
  dbRows: { rooms: number; players: number; audit: number };
  gamesPlayed: number;
  totalPlayers: number;
  peakConcurrency: number;
  /** The server's honesty note: the peak is the largest current room, not a recorded historical peak. */
  peakConcurrencyNote?: string | null;
  averageGameLengthMinutes: number | null;
  catchRate: number | null;
}

export interface AdminAuditEntry {
  id: string;
  actor: string;
  action: string;
  target: string | null;
  createdAt: string;
  detail?: string | null;
}

export interface AdminUserRow {
  id: string;
  username: string;
  role: AdminRole;
  disabled: boolean;
  createdAt: string | null;
  /** Set by the server for accounts that must change password on first sign-in. Absent = no forced change. */
  mustChangePassword?: boolean;
}

export function getAdminOverview(): Promise<AdminOverview> {
  return adminJson<AdminOverview>('/v1/admin/overview');
}

export function listAdminRooms(): Promise<AdminRoomRow[]> {
  return adminJson<AdminRoomRow[]>('/v1/admin/rooms');
}

export function getAdminRoom(id: string): Promise<AdminRoomDetail> {
  return adminJson<AdminRoomDetail>(`/v1/admin/rooms/${encodeURIComponent(id)}`);
}

export function adminRoomAction(id: string, action: 'end' | 'cancel' | 'force-results'): Promise<void> {
  return adminFetch(`/v1/admin/rooms/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
    body: JSON.stringify({}),
  }).then(() => undefined);
}

export function listAdminPlayers(): Promise<AdminPlayerRow[]> {
  return adminJson<AdminPlayerRow[]>('/v1/admin/players');
}

export function adminPlayerAction(
  playerId: string,
  action: 'kick' | 'block' | 'unblock',
): Promise<void> {
  return adminFetch(`/v1/admin/players/${encodeURIComponent(playerId)}/${action}`, {
    method: 'POST',
    body: JSON.stringify({}),
  }).then(() => undefined);
}

export interface AdminPlayerLocation {
  latitude: number;
  longitude: number;
  accuracyMetres: number | null;
  fixedAt: string | null;
}

/** GET /v1/admin/players/:id/location — Owner only, in-session only. */
export function getAdminPlayerLocation(playerId: string): Promise<AdminPlayerLocation> {
  return adminJson<AdminPlayerLocation>(`/v1/admin/players/${encodeURIComponent(playerId)}/location`);
}

export function listAdminFlags(): Promise<AdminFlag[]> {
  return adminJson<AdminFlag[]>('/v1/admin/flags');
}

export function saveAdminFlags(
  flags: { key: AdminFlagKey | AdminFutureFlagKey; enabled: boolean }[],
): Promise<void> {
  return adminFetch('/v1/admin/flags', {
    method: 'PUT',
    body: JSON.stringify({ flags }),
  }).then(() => undefined);
}

/**
 * Billing / accounts availability reads (merge, 2026-11-27 — Meera
 * fix 1). Every billing endpoint returns `available: false` until a
 * payment provider is connected, even with its flag ON — the pages
 * branch on BOTH the flag (from listAdminFlags) and this field, so
 * the UI reflects the real state instead of the static defs. No
 * fake numbers: totals are null, lists are empty, never invented.
 */
export interface AdminBillingAvailability {
  available: boolean;
  /** Present on the not-available shape; absent when the list is live (data-requests flag-ON). */
  reason?: string;
  unlocksWhen?: string;
  willDo?: string;
  note?: string;
}

export interface AdminBillingOverview extends AdminBillingAvailability {
  totals: null;
  revenueInr: null;
  transactions: unknown[];
  refunds: unknown[];
}

export interface AdminBillingTransactions extends AdminBillingAvailability {
  transactions: unknown[];
}

export interface AdminBillingPlans extends AdminBillingAvailability {
  plans: { name: string; priceLabel: string; billing: string; status: string; statusCopy: string }[];
}

export interface AdminBillingProviders extends AdminBillingAvailability {
  providers: unknown[];
}

export interface AdminBillingRefunds extends AdminBillingAvailability {
  refunds: unknown[];
}

export interface AdminBillingTax extends AdminBillingAvailability {
  invoices: unknown[];
}

export function getAdminBillingOverview(): Promise<AdminBillingOverview> {
  return adminJson<AdminBillingOverview>('/v1/admin/billing/overview');
}

export function getAdminBillingTransactions(): Promise<AdminBillingTransactions> {
  return adminJson<AdminBillingTransactions>('/v1/admin/billing/transactions');
}

export function getAdminBillingPlans(): Promise<AdminBillingPlans> {
  return adminJson<AdminBillingPlans>('/v1/admin/billing/plans');
}

export function getAdminBillingProviders(): Promise<AdminBillingProviders> {
  return adminJson<AdminBillingProviders>('/v1/admin/billing/providers');
}

export function getAdminBillingRefunds(): Promise<AdminBillingRefunds> {
  return adminJson<AdminBillingRefunds>('/v1/admin/billing/refunds');
}

export function getAdminBillingTax(): Promise<AdminBillingTax> {
  return adminJson<AdminBillingTax>('/v1/admin/billing/tax');
}

/** GET /v1/admin/data-requests — available:true only with the flag ON. */
export interface AdminDataRequestRow {
  id: string;
  player_id: string | null;
  kind: string;
  contact_ref: string | null;
  status: string;
  created_at: string;
  resolved_at: string | null;
}

export interface AdminDataRequests extends AdminBillingAvailability {
  requests: AdminDataRequestRow[];
}

export function getAdminDataRequests(): Promise<AdminDataRequests> {
  return adminJson<AdminDataRequests>('/v1/admin/data-requests');
}

/** GET /v1/admin/login-methods — available:false until the v2 login feature lands. */
export interface AdminLoginMethod {
  method: string;
  status: string;
  note: string;
}

export interface AdminLoginMethods extends AdminBillingAvailability {
  methods: AdminLoginMethod[];
}

export function getAdminLoginMethods(): Promise<AdminLoginMethods> {
  return adminJson<AdminLoginMethods>('/v1/admin/login-methods');
}

export function getAdminConfig(): Promise<AdminGameConfig> {
  return adminJson<AdminGameConfig>('/v1/admin/config');
}

export function saveAdminConfig(config: AdminGameConfig): Promise<void> {
  return adminFetch('/v1/admin/config', {
    method: 'PUT',
    body: JSON.stringify(config),
  }).then(() => undefined);
}

export function getAdminSafety(): Promise<AdminSafety> {
  return adminJson<AdminSafety>('/v1/admin/safety');
}

export function createSafetyFlag(kind: string, detail: string): Promise<void> {
  return adminFetch('/v1/admin/safety/flags', {
    method: 'POST',
    body: JSON.stringify({ kind, detail }),
  }).then(() => undefined);
}

export function createSafetyBlock(deviceId: string, reason: string): Promise<void> {
  return adminFetch('/v1/admin/safety/blocks', {
    method: 'POST',
    body: JSON.stringify({ deviceId, reason }),
  }).then(() => undefined);
}

export function deleteSafetyBlock(deviceId: string): Promise<void> {
  return adminFetch(`/v1/admin/safety/blocks/${encodeURIComponent(deviceId)}`, {
    method: 'DELETE',
  }).then(() => undefined);
}

export function getAdminMetrics(): Promise<AdminMetrics> {
  return adminJson<AdminMetrics>('/v1/admin/metrics');
}

export function listAdminAudit(): Promise<AdminAuditEntry[]> {
  return adminJson<AdminAuditEntry[]>('/v1/admin/audit');
}

export function listAdminAnnouncements(): Promise<AdminAnnouncement[]> {
  return adminJson<AdminAnnouncement[]>('/v1/admin/announcements');
}

export function createAdminAnnouncement(message: string): Promise<void> {
  return adminFetch('/v1/admin/announcements', {
    method: 'POST',
    body: JSON.stringify({ message }),
  }).then(() => undefined);
}

export function updateAdminAnnouncement(id: string, patch: { message?: string; active?: boolean }): Promise<void> {
  return adminFetch(`/v1/admin/announcements/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  }).then(() => undefined);
}

export function deleteAdminAnnouncement(id: string): Promise<void> {
  return adminFetch(`/v1/admin/announcements/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  }).then(() => undefined);
}

export function listAdminUsers(): Promise<AdminUserRow[]> {
  return adminJson<AdminUserRow[]>('/v1/admin/users');
}

export function createAdminUser(username: string, role: 'admin' | 'staff', password: string): Promise<void> {
  return adminFetch('/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({ username, role, password }),
  }).then(() => undefined);
}

export function updateAdminUser(
  id: string,
  patch: { role?: AdminRole; disabled?: boolean },
): Promise<void> {
  return adminFetch(`/v1/admin/users/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  }).then(() => undefined);
}

export function deleteAdminUser(id: string): Promise<void> {
  return adminFetch(`/v1/admin/users/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  }).then(() => undefined);
}

/* ------------------------------------------------------------------ */
/* Public reads — no token. The game home page uses these at startup. */
/* Cached in memory for 60 s so a reload never hammers the Worker.     */
/*                                                                     */
/* USERNAME LEAK (Zara M1): the authed flags/announcements endpoints   */
/* carry updatedBy/createdBy, and the public endpoints used to echo   */
/* them too — a public read must never name an admin. The client      */
/* strips those fields here, whatever the server sends, so the game   */
/* never holds an admin username. The server is being fixed to stop   */
/* sending them; this strip is defence in depth, not the fix.         */
/* ------------------------------------------------------------------ */

/** A public flag: key, label, explainer, on/off — no who/when.
 * The key is widened like AdminFlag: the public endpoint is
 * game-only by server contract, but the fetched rows share the
 * AdminFlag shape, so the type must accept what the shape can
 * carry. The game only ever looks up game keys. */
export interface PublicAdminFlag {
  key: AdminFlagKey | AdminFutureFlagKey;
  label: string;
  explainer: string;
  enabled: boolean;
}

/** A public announcement: id, message, active — no who/when. */
export type PublicAdminAnnouncement = Pick<AdminAnnouncement, 'id' | 'message' | 'active'>;

/** Strip identity fields from one public flag (defence in depth). */
export function stripPublicFlag(flag: AdminFlag): PublicAdminFlag {
  return { key: flag.key, label: flag.label, explainer: flag.explainer, enabled: flag.enabled };
}

/** Strip identity fields from one public announcement (defence in depth). */
export function stripPublicAnnouncement(
  announcement: AdminAnnouncement | null,
): PublicAdminAnnouncement | null {
  if (!announcement) return null;
  return { id: announcement.id, message: announcement.message, active: announcement.active };
}

const PUBLIC_CACHE_MS = 60_000;
const publicCache = new Map<string, { atMs: number; value: unknown }>();

function publicCached<T>(key: string): T | null {
  const entry = publicCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.atMs > PUBLIC_CACHE_MS) {
    publicCache.delete(key);
    return null;
  }
  return entry.value as T;
}

async function fetchPublic<T>(path: string, cacheKey: string): Promise<T> {
  const cached = publicCached<T>(cacheKey);
  if (cached !== null) return cached;
  const base = checkedWorkerUrl();
  const response = await fetch(`${base}${path}`);
  if (!response.ok) throw new Error(`Public read failed (${response.status}).`);
  const value = (await response.json()) as T;
  publicCache.set(cacheKey, { atMs: Date.now(), value });
  return value;
}

export async function getPublicAnnouncement(): Promise<PublicAdminAnnouncement | null> {
  const raw = await fetchPublic<AdminAnnouncement | null>('/v1/admin/announcements/public', 'announcement');
  return stripPublicAnnouncement(raw);
}

export async function getPublicFlags(): Promise<PublicAdminFlag[]> {
  const raw = await fetchPublic<AdminFlag[]>('/v1/admin/flags/public', 'flags');
  return raw.map(stripPublicFlag);
}

export function getPublicConfig(): Promise<AdminGameConfig> {
  return fetchPublic<AdminGameConfig>('/v1/admin/config/public', 'config');
}

/** Test helper: the public cache TTL (60 s). */
export function publicCacheTtlMs(): number {
  return PUBLIC_CACHE_MS;
}
