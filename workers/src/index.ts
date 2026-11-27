/**
 * @pakdam/workers — Worker fetch entry.
 *
 * Routing (frozen contract v2.1, PROTOCOL-MAP §1 + §7 route table), CORS,
 * security headers (CSP + HSTS — the old build had none), JSON error
 * envelopes, per-route HTTP rate limiting (every route, including the 9 the
 * old build left un-limited), and the /ws upgrade path.
 *
 * The Worker is a thin front door. All game authority lives in the room's
 * DO (`RoomDO`); invite-code -> roomId mappings live in the single
 * `CodeRegistryDO`. The Worker never validates a WS ticket against its own
 * store and never stores a ticket, token, or fix.
 */
import { HttpRateLimiter, clientIp } from './rate-limit.js';
import {
  err,
  handleBugReport,
  handleCatchToken,
  handleCreateRoom,
  handleGetState,
  handleGrievance,
  handleHostToken,
  handleHostTransfer,
  handleJoin,
  handleJoinByCode,
  handleLifecycle,
  handleLookupByCode,
  handleRegenerateCode,
  handleRemovePlayer,
  handleReplay,
  handleReports,
  handleResolveCatch,
  handleResults,
  handleRevokeTicket,
  handleStart,
  handleUpdateConfig,
  handleWsTicket,
  handleWsUpgrade,
  isUuid,
  type HttpContext,
} from './http.js';
import {
  handleAdminAnnouncementCreate,
  handleAdminAnnouncementDelete,
  handleAdminAnnouncementUpdate,
  handleAdminAnnouncements,
  handleAdminAnnouncementsPublic,
  handleAdminAudit,
  handleAdminBillingOverview,
  handleAdminBillingPlans,
  handleAdminBillingProviders,
  handleAdminBillingRefunds,
  handleAdminBillingTax,
  handleAdminBillingTransactions,
  handleAdminChangePassword,
  handleAdminConfig,
  handleAdminConfigPublic,
  handleAdminConfigPut,
  handleAdminDataRequests,
  handleAdminDirectoryBan,
  handleAdminFlags,
  handleAdminFlagsPublic,
  handleAdminFlagsPut,
  handleAdminLogin,
  handleAdminLoginMethods,
  handleAdminLogout,
  handleAdminMe,
  handleAdminMetrics,
  handleAdminOverview,
  handleAdminPlayerAction,
  handleAdminPlayerErase,
  handleAdminPlayerLocation,
  handleAdminPlayers,
  handleAdminRevokeSessions,
  handleAdminRoomAction,
  handleAdminRoomDetail,
  handleAdminRooms,
  handleAdminSafety,
  handleAdminSafetyBlockCreate,
  handleAdminSafetyBlockDelete,
  handleAdminSafetyFlagCreate,
  handleAdminSetup,
  handleAdminUserCreate,
  handleAdminUserDelete,
  handleAdminUserUpdate,
  handleAdminUsers,
  handleAdminUsersDirectory,
  handleAdminUsersDirectoryDetail,
} from './admin.js';
import { deleteExpiredAdminSessions, deleteOldAdminAudit, deleteOldLoginAttempts } from './admin-db.js';
import { deleteOldLogs } from './supabase.js';
import { flushTelemetry } from './telemetry.js';

export { CodeRegistryDO, RoomDO } from './room-do-class.js';

export interface Env {
  ROOM_DO: DurableObjectNamespace;
  CODE_REGISTRY_DO: DurableObjectNamespace;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  /** Optional comma-separated allowlist; defaults below when unset. */
  ALLOWED_ORIGINS?: string;
  /**
   * Worker<->DO shared secret for internal /op calls (P2). When set,
   * the DO rejects /op calls without it; when unset the check is skipped
   * (dev). Set in production via `wrangler secret put DO_OP_SECRET`.
   */
  DO_OP_SECRET?: string;
  /**
   * Admin Console (Mission Control) — fail-closed secrets (fix round
   * B1/n1/n9). A console.warn is not a control, so these are refusals:
   * - ADMIN_SETUP_TOKEN: REQUIRED for first-Owner setup. When unset,
   *   POST /v1/admin/auth/setup answers 503 — there is no setup
   *   without it. Set via `wrangler secret put ADMIN_SETUP_TOKEN`.
   *   The setup page sends the token (it has a token field).
   * - ADMIN_SESSION_SECRET: HMAC key for admin session tokens. When
   *   unset, login/setup REFUSE to mint a session (503) — unless the
   *   deployment explicitly opts into dev mode (ADMIN_DEV_MODE=true),
   *   in which case `nosecret` tokens are minted with a console.error.
   *   Set via `wrangler secret put ADMIN_SESSION_SECRET`.
   * - ADMIN_DEV_MODE: 'true' ONLY for local/dev deploys. Never set
   *   it in production — it is the only thing that permits
   *   secret-less admin sessions.
   */
  ADMIN_SETUP_TOKEN?: string;
  ADMIN_SESSION_SECRET?: string;
  ADMIN_DEV_MODE?: string;
}

const limiter = new HttpRateLimiter();

// ---------------------------------------------------------------------------
// CORS + security headers
// ---------------------------------------------------------------------------

const DEFAULT_ALLOWED_ORIGINS = [
  'https://pakdam.vercel.app',
  'http://localhost:3000',
];

function allowedOrigins(env: Env): string[] {
  if (env.ALLOWED_ORIGINS) {
    return env.ALLOWED_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter((o) => o.length > 0);
  }
  return DEFAULT_ALLOWED_ORIGINS;
}

function corsHeaders(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('Origin');
  if (!origin) return {};
  if (!allowedOrigins(env).includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    // v29 (Gap 4) — `Idempotency-Key` is a custom request header, so
    // the browser preflight must allow it or join/start/replay retries
    // can never carry a key.
    // Admin console (2026-11-25): PUT + DELETE are in the methods
    // list because the admin client edits flags/config/announcements
    // with PUT and removes blocks/announcements/users with DELETE —
    // without them the preflight fails and the panel cannot save.
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/** Security headers on every response (the old build had none). */
const SECURITY_HEADERS: Record<string, string> = {
  // API worker: no content of its own to load, no framing, no forms.
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function withHeaders(res: Response, extra: Record<string, string>): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  // A 101 WebSocket upgrade must keep its own headers untouched except for
  // the security set above; constructing a new Response would drop the
  // socket, so callers pass upgrades through unchanged.
  if (res.status === 101) return res;
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

type Handler = (
  req: Request,
  ctx: HttpContext,
  params: Record<string, string>,
  body: Record<string, unknown> | null,
) => Promise<Response>;

interface Route {
  method: string;
  /** e.g. 'POST /v1/rooms/:id/ws-ticket' — must be a key of HTTP_RATE_LIMITS. */
  rateKey: string;
  match: (segments: string[]) => Record<string, string> | null;
  handler: Handler;
}

function seg(pattern: string): (segments: string[]) => Record<string, string> | null {
  const parts = pattern.split('/').filter((p) => p.length > 0);
  return (segments: string[]) => {
    if (segments.length !== parts.length) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < parts.length; i += 1) {
      const want = parts[i] as string;
      const got = segments[i] as string;
      if (want.startsWith(':')) {
        params[want.slice(1)] = decodeURIComponent(got);
      } else if (want !== got) {
        return null;
      }
    }
    return params;
  };
}

const ROUTES: Route[] = [
  {
    method: 'POST',
    rateKey: 'POST /v1/rooms',
    match: seg('/v1/rooms'),
    handler: (req, ctx) => handleCreateRoom(req, ctx),
  },
  {
    method: 'GET',
    rateKey: 'GET /v1/rooms/by-code/:code',
    match: seg('/v1/rooms/by-code/:code'),
    handler: (_req, ctx, p) => handleLookupByCode(_req, ctx, p['code'] as string),
  },
  {
    method: 'POST',
    rateKey: 'POST /v1/rooms/:id/join',
    match: seg('/v1/rooms/:id/join'),
    handler: (req, ctx, p) => handleJoin(req, ctx, p['id'] as string),
  },
  {
    method: 'POST',
    rateKey: 'POST /v1/rooms/join-by-code',
    match: seg('/v1/rooms/join-by-code'),
    handler: (req, ctx) => handleJoinByCode(req, ctx),
  },
  {
    method: 'POST',
    rateKey: 'POST /v1/rooms/:id/ws-ticket/revoke',
    match: seg('/v1/rooms/:id/ws-ticket/revoke'),
    handler: (req, ctx, p) => handleRevokeTicket(req, ctx, p['id'] as string),
  },
  {
    method: 'POST',
    rateKey: 'POST /v1/rooms/:id/ws-ticket',
    match: seg('/v1/rooms/:id/ws-ticket'),
    handler: (req, ctx, p) => handleWsTicket(req, ctx, p['id'] as string),
  },
  {
    method: 'GET',
    rateKey: 'WS /v1/rooms/:id/ws',
    match: seg('/v1/rooms/:id/ws'),
    handler: (req, ctx, p) => handleWsUpgrade(req, ctx, p['id'] as string),
  },
  {
    method: 'GET',
    rateKey: 'GET /v1/rooms/:id/results',
    match: seg('/v1/rooms/:id/results'),
    handler: (req, ctx, p) => handleResults(req, ctx, p['id'] as string),
  },
  {
    method: 'GET',
    rateKey: 'GET /v1/rooms/:id',
    match: seg('/v1/rooms/:id'),
    handler: (req, ctx, p) => handleGetState(req, ctx, p['id'] as string),
  },
  {
    method: 'POST',
    rateKey: 'POST /v1/rooms/:id/replay',
    match: seg('/v1/rooms/:id/replay'),
    handler: (req, ctx, p) => handleReplay(req, ctx, p['id'] as string),
  },
  {
    method: 'POST',
    rateKey: 'POST /v1/rooms/:id/start',
    match: seg('/v1/rooms/:id/start'),
    handler: (req, ctx, p) => handleStart(req, ctx, p['id'] as string),
  },
  {
    method: 'POST',
    rateKey: 'POST /v1/rooms/:id/config',
    match: seg('/v1/rooms/:id/config'),
    handler: (req, ctx, p) => handleUpdateConfig(req, ctx, p['id'] as string),
  },
  {
    method: 'POST',
    rateKey: 'POST /v1/rooms/:id/remove-player',
    match: seg('/v1/rooms/:id/remove-player'),
    handler: (req, ctx, p) => handleRemovePlayer(req, ctx, p['id'] as string),
  },
  {
    method: 'POST',
    rateKey: 'POST /v1/rooms/:id/regenerate-code',
    match: seg('/v1/rooms/:id/regenerate-code'),
    handler: (req, ctx, p) => handleRegenerateCode(req, ctx, p['id'] as string),
  },
  {
    method: 'POST',
    rateKey: 'POST /v1/rooms/:id/host/token',
    match: seg('/v1/rooms/:id/host/token'),
    handler: (req, ctx, p) => handleHostToken(req, ctx, p['id'] as string),
  },
  {
    method: 'POST',
    rateKey: 'POST /v1/rooms/:id/host/transfer',
    match: seg('/v1/rooms/:id/host/transfer'),
    handler: (req, ctx, p) => handleHostTransfer(req, ctx, p['id'] as string),
  },
  {
    method: 'POST',
    rateKey: 'POST /v1/rooms/:id/catch-token',
    match: seg('/v1/rooms/:id/catch-token'),
    handler: (req, ctx, p) => handleCatchToken(req, ctx, p['id'] as string),
  },
  {
    method: 'POST',
    rateKey: 'POST /v1/rooms/:id/catches/:cid/resolve',
    match: seg('/v1/rooms/:id/catches/:cid/resolve'),
    handler: (req, ctx, p) => handleResolveCatch(req, ctx, p['id'] as string, p['cid'] as string),
  },
  {
    method: 'POST',
    rateKey: 'POST /v1/rooms/:id/lifecycle',
    match: seg('/v1/rooms/:id/lifecycle'),
    handler: (req, ctx, p) => handleLifecycle(req, ctx, p['id'] as string),
  },
  {
    method: 'POST',
    rateKey: 'POST /v1/reports',
    match: seg('/v1/reports'),
    handler: (req, ctx) => handleReports(req, ctx),
  },
  {
    method: 'POST',
    rateKey: 'POST /v1/support/bugs',
    match: seg('/v1/support/bugs'),
    handler: (req, ctx) => handleBugReport(req, ctx),
  },
  {
    method: 'POST',
    rateKey: 'POST /v1/support/grievances',
    match: seg('/v1/support/grievances'),
    handler: (req, ctx) => handleGrievance(req, ctx),
  },
  // -- Admin Console (Mission Control) ---------------------------------------
  // Grouped rate keys (see HTTP_RATE_LIMITS in @pakdam/shared): login /
  // setup are 5 per 15 min per IP (+ per-(account, IP) DB lockout);
  // authed reads share 'GET /v1/admin/read', writes share 'POST|PUT|DELETE
  // /v1/admin/write', public reads share 'GET /v1/admin/public'.
  // Auth + RBAC live in the handlers (workers/src/admin.ts); the
  // router only rate-limits here.
  {
    method: 'POST',
    rateKey: 'POST /v1/admin/auth/login',
    match: seg('/v1/admin/auth/login'),
    handler: (req, ctx) => handleAdminLogin(req, ctx),
  },
  {
    method: 'POST',
    rateKey: 'POST /v1/admin/auth/setup',
    match: seg('/v1/admin/auth/setup'),
    handler: (req, ctx) => handleAdminSetup(req, ctx),
  },
  {
    method: 'POST',
    rateKey: 'POST /v1/admin/write',
    match: seg('/v1/admin/auth/change-password'),
    handler: (req, ctx) => handleAdminChangePassword(req, ctx),
  },
  {
    method: 'POST',
    rateKey: 'POST /v1/admin/write',
    match: seg('/v1/admin/auth/logout'),
    handler: (req, ctx) => handleAdminLogout(req, ctx),
  },
  {
    method: 'GET',
    rateKey: 'GET /v1/admin/read',
    match: seg('/v1/admin/auth/me'),
    handler: (req, ctx) => handleAdminMe(req, ctx),
  },
  {
    method: 'GET',
    rateKey: 'GET /v1/admin/read',
    match: seg('/v1/admin/overview'),
    handler: (req, ctx) => handleAdminOverview(req, ctx),
  },
  {
    method: 'GET',
    rateKey: 'GET /v1/admin/read',
    match: seg('/v1/admin/rooms'),
    handler: (req, ctx) => handleAdminRooms(req, ctx),
  },
  {
    method: 'GET',
    rateKey: 'GET /v1/admin/read',
    match: seg('/v1/admin/rooms/:id'),
    handler: (req, ctx, p) => handleAdminRoomDetail(req, ctx, p['id'] as string),
  },
  {
    method: 'POST',
    rateKey: 'POST /v1/admin/write',
    match: seg('/v1/admin/rooms/:id/end'),
    handler: (req, ctx, p) => handleAdminRoomAction(req, ctx, p['id'] as string, 'end'),
  },
  {
    method: 'POST',
    rateKey: 'POST /v1/admin/write',
    match: seg('/v1/admin/rooms/:id/cancel'),
    handler: (req, ctx, p) => handleAdminRoomAction(req, ctx, p['id'] as string, 'cancel'),
  },
  {
    method: 'POST',
    rateKey: 'POST /v1/admin/write',
    match: seg('/v1/admin/rooms/:id/force-results'),
    handler: (req, ctx, p) => handleAdminRoomAction(req, ctx, p['id'] as string, 'force-results'),
  },
  {
    method: 'GET',
    rateKey: 'GET /v1/admin/read',
    match: seg('/v1/admin/players'),
    handler: (req, ctx) => handleAdminPlayers(req, ctx),
  },
  {
    method: 'GET',
    rateKey: 'GET /v1/admin/read',
    match: seg('/v1/admin/players/:id/location'),
    handler: (req, ctx, p) => handleAdminPlayerLocation(req, ctx, p['id'] as string),
  },
  {
    method: 'POST',
    rateKey: 'POST /v1/admin/write',
    match: seg('/v1/admin/players/:id/kick'),
    handler: (req, ctx, p) => handleAdminPlayerAction(req, ctx, p['id'] as string, 'kick'),
  },
  {
    method: 'POST',
    rateKey: 'POST /v1/admin/write',
    match: seg('/v1/admin/players/:id/block'),
    handler: (req, ctx, p) => handleAdminPlayerAction(req, ctx, p['id'] as string, 'block'),
  },
  {
    method: 'POST',
    rateKey: 'POST /v1/admin/write',
    match: seg('/v1/admin/players/:id/unblock'),
    handler: (req, ctx, p) => handleAdminPlayerAction(req, ctx, p['id'] as string, 'unblock'),
  },
  {
    method: 'POST',
    rateKey: 'POST /v1/admin/write',
    match: seg('/v1/admin/players/:id/erase'),
    handler: (req, ctx, p) => handleAdminPlayerErase(req, ctx, p['id'] as string),
  },
  {
    method: 'GET',
    rateKey: 'GET /v1/admin/read',
    match: seg('/v1/admin/flags'),
    handler: (req, ctx) => handleAdminFlags(req, ctx),
  },
  {
    method: 'PUT',
    rateKey: 'PUT /v1/admin/write',
    match: seg('/v1/admin/flags'),
    handler: (req, ctx) => handleAdminFlagsPut(req, ctx),
  },
  {
    method: 'GET',
    rateKey: 'GET /v1/admin/public',
    match: seg('/v1/admin/flags/public'),
    handler: (req, ctx) => handleAdminFlagsPublic(req, ctx),
  },
  {
    method: 'GET',
    rateKey: 'GET /v1/admin/read',
    match: seg('/v1/admin/config'),
    handler: (req, ctx) => handleAdminConfig(req, ctx),
  },
  {
    method: 'PUT',
    rateKey: 'PUT /v1/admin/write',
    match: seg('/v1/admin/config'),
    handler: (req, ctx) => handleAdminConfigPut(req, ctx),
  },
  {
    method: 'GET',
    rateKey: 'GET /v1/admin/public',
    match: seg('/v1/admin/config/public'),
    handler: (req, ctx) => handleAdminConfigPublic(req, ctx),
  },
  {
    method: 'GET',
    rateKey: 'GET /v1/admin/read',
    match: seg('/v1/admin/safety'),
    handler: (req, ctx) => handleAdminSafety(req, ctx),
  },
  {
    method: 'POST',
    rateKey: 'POST /v1/admin/write',
    match: seg('/v1/admin/safety/flags'),
    handler: (req, ctx) => handleAdminSafetyFlagCreate(req, ctx),
  },
  {
    method: 'POST',
    rateKey: 'POST /v1/admin/write',
    match: seg('/v1/admin/safety/blocks'),
    handler: (req, ctx) => handleAdminSafetyBlockCreate(req, ctx),
  },
  {
    method: 'DELETE',
    rateKey: 'DELETE /v1/admin/write',
    match: seg('/v1/admin/safety/blocks/:deviceId'),
    handler: (req, ctx, p) => handleAdminSafetyBlockDelete(req, ctx, p['deviceId'] as string),
  },
  {
    method: 'GET',
    rateKey: 'GET /v1/admin/read',
    match: seg('/v1/admin/metrics'),
    handler: (req, ctx) => handleAdminMetrics(req, ctx),
  },
  {
    method: 'GET',
    rateKey: 'GET /v1/admin/read',
    match: seg('/v1/admin/audit'),
    handler: (req, ctx) => handleAdminAudit(req, ctx),
  },
  {
    method: 'GET',
    rateKey: 'GET /v1/admin/read',
    match: seg('/v1/admin/announcements'),
    handler: (req, ctx) => handleAdminAnnouncements(req, ctx),
  },
  {
    method: 'POST',
    rateKey: 'POST /v1/admin/write',
    match: seg('/v1/admin/announcements'),
    handler: (req, ctx) => handleAdminAnnouncementCreate(req, ctx),
  },
  {
    method: 'PUT',
    rateKey: 'PUT /v1/admin/write',
    match: seg('/v1/admin/announcements/:id'),
    handler: (req, ctx, p) => handleAdminAnnouncementUpdate(req, ctx, p['id'] as string),
  },
  {
    method: 'DELETE',
    rateKey: 'DELETE /v1/admin/write',
    match: seg('/v1/admin/announcements/:id'),
    handler: (req, ctx, p) => handleAdminAnnouncementDelete(req, ctx, p['id'] as string),
  },
  {
    method: 'GET',
    rateKey: 'GET /v1/admin/public',
    match: seg('/v1/admin/announcements/public'),
    handler: (req, ctx) => handleAdminAnnouncementsPublic(req, ctx),
  },
  {
    method: 'GET',
    rateKey: 'GET /v1/admin/read',
    match: seg('/v1/admin/users'),
    handler: (req, ctx) => handleAdminUsers(req, ctx),
  },
  {
    method: 'POST',
    rateKey: 'POST /v1/admin/write',
    match: seg('/v1/admin/users'),
    handler: (req, ctx) => handleAdminUserCreate(req, ctx),
  },
  {
    method: 'PUT',
    rateKey: 'PUT /v1/admin/write',
    match: seg('/v1/admin/users/:id'),
    handler: (req, ctx, p) => handleAdminUserUpdate(req, ctx, p['id'] as string),
  },
  {
    method: 'DELETE',
    rateKey: 'DELETE /v1/admin/write',
    match: seg('/v1/admin/users/:id'),
    handler: (req, ctx, p) => handleAdminUserDelete(req, ctx, p['id'] as string),
  },
  {
    method: 'POST',
    rateKey: 'POST /v1/admin/write',
    match: seg('/v1/admin/users/:id/revoke-sessions'),
    handler: (req, ctx, p) => handleAdminRevokeSessions(req, ctx, p['id'] as string),
  },
  // -- Payments & Billing (inactive — flag-gated, no provider) --------------
  {
    method: 'GET',
    rateKey: 'GET /v1/admin/read',
    match: seg('/v1/admin/billing/overview'),
    handler: (req, ctx) => handleAdminBillingOverview(req, ctx),
  },
  {
    method: 'GET',
    rateKey: 'GET /v1/admin/read',
    match: seg('/v1/admin/billing/transactions'),
    handler: (req, ctx) => handleAdminBillingTransactions(req, ctx),
  },
  {
    method: 'GET',
    rateKey: 'GET /v1/admin/read',
    match: seg('/v1/admin/billing/plans'),
    handler: (req, ctx) => handleAdminBillingPlans(req, ctx),
  },
  {
    method: 'GET',
    rateKey: 'GET /v1/admin/read',
    match: seg('/v1/admin/billing/providers'),
    handler: (req, ctx) => handleAdminBillingProviders(req, ctx),
  },
  {
    method: 'GET',
    rateKey: 'GET /v1/admin/read',
    match: seg('/v1/admin/billing/refunds'),
    handler: (req, ctx) => handleAdminBillingRefunds(req, ctx),
  },
  {
    method: 'GET',
    rateKey: 'GET /v1/admin/read',
    match: seg('/v1/admin/billing/tax'),
    handler: (req, ctx) => handleAdminBillingTax(req, ctx),
  },
  // -- Users & Accounts directory (real guest data) + future features --------
  {
    method: 'GET',
    rateKey: 'GET /v1/admin/read',
    match: seg('/v1/admin/users-directory'),
    handler: (req, ctx) => handleAdminUsersDirectory(req, ctx),
  },
  {
    method: 'GET',
    rateKey: 'GET /v1/admin/read',
    match: seg('/v1/admin/users-directory/:id'),
    handler: (req, ctx, p) => handleAdminUsersDirectoryDetail(req, ctx, p['id'] as string),
  },
  {
    method: 'POST',
    rateKey: 'POST /v1/admin/write',
    match: seg('/v1/admin/users-directory/:id/ban'),
    handler: (req, ctx, p) => handleAdminDirectoryBan(req, ctx, p['id'] as string, 'ban'),
  },
  {
    method: 'POST',
    rateKey: 'POST /v1/admin/write',
    match: seg('/v1/admin/users-directory/:id/suspend'),
    handler: (req, ctx, p) => handleAdminDirectoryBan(req, ctx, p['id'] as string, 'suspend'),
  },
  {
    method: 'POST',
    rateKey: 'POST /v1/admin/write',
    match: seg('/v1/admin/users-directory/:id/unban'),
    handler: (req, ctx, p) => handleAdminDirectoryBan(req, ctx, p['id'] as string, 'unban'),
  },
  {
    method: 'GET',
    rateKey: 'GET /v1/admin/read',
    match: seg('/v1/admin/data-requests'),
    handler: (req, ctx) => handleAdminDataRequests(req, ctx),
  },
  {
    method: 'GET',
    rateKey: 'GET /v1/admin/read',
    match: seg('/v1/admin/login-methods'),
    handler: (req, ctx) => handleAdminLoginMethods(req, ctx),
  },
];

// ---------------------------------------------------------------------------
// Fetch entry
// ---------------------------------------------------------------------------

export default {
  /**
   * v29 (Gap 5) — 7-day log retention, Worker scheduled handler.
   * Runs on the cron trigger (wrangler.toml `[triggers] crons =
   * ["0 3 * * *"]` — 03:00 UTC daily, configured in this repo, not
   * added at deploy time). Deletes `logs` rows older than 7 days.
   * Best-effort: failures are logged to the Worker console only,
   * never retried here (the next day's run picks them up). pg_cron
   * (nightly `DELETE FROM logs WHERE created_at < now() - interval
   * '7 days'`) is the alternative the founder can switch to — pg_cron
   * availability cannot be checked from this VM, so the Worker
   * handler is the implementation, not the fallback.
   */
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      deleteOldLogs(env).then((ok) => {
        if (!ok) console.error('Scheduled log retention failed.');
      }),
    );
    // Admin console (Mission Control): expired sessions are revoked
    // and admin audit rows older than 180 days are deleted (the
    // audit log is a compliance record — 180 days, NOT the 7-day
    // game-log retention above). Best-effort, same as the log job.
    ctx.waitUntil(
      deleteExpiredAdminSessions(env).then((ok) => {
        if (!ok) console.error('Scheduled admin session cleanup failed.');
      }),
    );
    ctx.waitUntil(
      deleteOldAdminAudit(env).then((ok) => {
        if (!ok) console.error('Scheduled admin audit retention failed.');
      }),
    );
    // Admin console (fix round B2): login-attempt rows older than
    // 24 h are deleted (a lockout lasts 15 min, so this never
    // deletes a live lock — it only stops the table growing by one
    // row per (username, IP) pair that ever failed).
    ctx.waitUntil(
      deleteOldLoginAttempts(env).then((ok) => {
        if (!ok) console.error('Scheduled admin login-attempt cleanup failed.');
      }),
    );
  },
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const cors = corsHeaders(req, env);
    const url = new URL(req.url);
    const segments = url.pathname.split('/').filter((s) => s.length > 0);

    // CORS preflight, answered before routing.
    if (req.method === 'OPTIONS') {
      return withHeaders(new Response(null, { status: 204, headers: cors }), cors);
    }

    const httpCtx: HttpContext = { env, ctx };
    try {
      for (const route of ROUTES) {
        if (route.method !== req.method) continue;
        const params = route.match(segments);
        if (params === null) continue;

        // Unvalidated ids (P2): malformed room/catch ids are rejected
        // here, before any DO is instantiated.
        if (params['id'] !== undefined && !isUuid(params['id'])) {
          return withHeaders(err('Invalid room id.', 400), cors);
        }
        if (params['cid'] !== undefined && !isUuid(params['cid'])) {
          return withHeaders(err('Invalid catch id.', 400), cors);
        }

        // Per-route rate limit, before the handler runs. Seat-scoped
        // routes are NOT limited here: the handler limits them AFTER
        // parsing the credential, keyed by the token hash (P1-14) — a
        // pre-handler key would have to trust the unauthenticated
        // client-supplied playerId. Unauthenticated routes and the WS
        // upgrade are limited here. Join + by-code key on the room/code,
        // not the IP (NAT-JOIN: 30 players on one venue WiFi share one
        // IP — per-IP join would 429 the 6th player). The WS upgrade keys
        // on the ROOM (P1-12, 60/min/room in the calibration table), not
        // the client IP — a venue NAT must not throttle a whole roster's
        // reconnects.
        const isSeatRoute =
          route.rateKey.includes('/ws-ticket') ||
          route.rateKey.includes('/start') ||
          route.rateKey.includes('/replay') ||
          route.rateKey.includes('/config') ||
          route.rateKey.includes('/remove-player') ||
          route.rateKey.includes('/regenerate-code') ||
          route.rateKey.includes('/catch-token') ||
          route.rateKey.includes('/lifecycle') ||
          route.rateKey.includes('/host/') ||
          route.rateKey.includes('/resolve') ||
          route.rateKey.includes('/results') ||
          route.rateKey === 'GET /v1/rooms/:id';
        const isWsRoute = route.rateKey === 'WS /v1/rooms/:id/ws';
        const isJoinRoute = route.rateKey === 'POST /v1/rooms/:id/join';
        const isJoinByCodeRoute = route.rateKey === 'POST /v1/rooms/join-by-code';
        const isByCodeRoute = route.rateKey === 'GET /v1/rooms/by-code/:code';
        if (!isSeatRoute) {
          let key = clientIp(req);
          if (isWsRoute) {
            key = `ws:${params['id'] ?? 'unknown'}`;
          } else if (isJoinRoute || isJoinByCodeRoute) {
            let roomCode: string | null = null;
            if (req.method === 'POST') {
              // Peek at the body once for the rate-limit key; the handler
              // parses it again (a Request body can only be read once per
              // clone, so clone here).
              try {
                const peek = (await req.clone().json()) as Record<string, unknown>;
                if (typeof peek['roomCode'] === 'string') roomCode = peek['roomCode'] as string;
              } catch {
                // Unparseable body: the handler will 400; still rate-limit below.
              }
            }
            // Room + code bucket (35/min in the table): a full roster on
            // one NAT IP joins inside a minute without a 429.
            key = isJoinByCodeRoute
              ? `join-by-code:${roomCode ?? ''}`
              : `join:${params['id'] ?? 'unknown'}:${roomCode ?? ''}`;
          } else if (isByCodeRoute) {
            // The code itself is the bucket (35/min in the table).
            key = `by-code:${params['code'] ?? ''}`;
          }
          const check = limiter.check(route.rateKey, key);
          if (!check.allowed) {
            const res = err('Too many tries — slow down.', 429);
            const headers = new Headers(res.headers);
            headers.set('Retry-After', String(check.retryAfterSeconds));
            return withHeaders(
              new Response(res.body, { status: 429, headers }),
              cors,
            );
          }
        }

        const res = await route.handler(req, httpCtx, params, null);
        // Best-effort telemetry flush on a completed match response path.
        if (route.rateKey === 'GET /v1/rooms/:id/results') {
          ctx.waitUntil(flushTelemetry(env));
        }
        // Admin console (fix round n3): every AUTHENTICATED admin
        // response carries Cache-Control: no-store — admin JSON
        // (sessions, locations, audit rows) must never sit in a
        // browser or proxy cache. The three PUBLIC reads are the
        // exception: they set their own `public, max-age=60` and are
        // skipped here (their rateKey is 'GET /v1/admin/public').
        // Applied here, at the router, so it covers every admin
        // handler — json() and err() alike — with no per-handler
        // churn. The game routes are untouched.
        if (route.rateKey.includes('/admin/') && route.rateKey !== 'GET /v1/admin/public') {
          const headers = new Headers(res.headers);
          headers.set('Cache-Control', 'no-store');
          return withHeaders(new Response(res.body, { status: res.status, headers }), cors);
        }
        return withHeaders(res, cors);
      }
      return withHeaders(err('Not found.', 404), cors);
    } catch (e) {
      console.error('Worker error:', e instanceof Error ? e.message : String(e));
      return withHeaders(err('Server error.', 500), cors);
    }
  },
};
