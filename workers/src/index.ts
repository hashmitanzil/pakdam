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
import { HttpRateLimiter, clientIp, seatKey } from './rate-limit.js';
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
  handleLifecycle,
  handleLookupByCode,
  handleRegenerateCode,
  handleRemovePlayer,
  handleReports,
  handleResolveCatch,
  handleResults,
  handleRevokeTicket,
  handleStart,
  handleUpdateConfig,
  handleWsTicket,
  handleWsUpgrade,
  type HttpContext,
} from './http.js';
import { flushTelemetry } from './telemetry.js';

export { CodeRegistryDO, RoomDO } from './room-do-class.js';

export interface Env {
  ROOM_DO: DurableObjectNamespace;
  CODE_REGISTRY_DO: DurableObjectNamespace;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  /** Optional comma-separated allowlist; defaults below when unset. */
  ALLOWED_ORIGINS?: string;
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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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
];

// ---------------------------------------------------------------------------
// Fetch entry
// ---------------------------------------------------------------------------

export default {
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

        // Per-route rate limit, before the handler runs. Seat-scoped
        // routes key on room + playerId (body for POST, query for GET);
        // unauthenticated routes and the WS upgrade key on client IP.
        // NOTE: the WS upgrade keys on IP at the HTTP layer because the
        // seat is unknown before ticket validation; per-seat WS limits
        // apply after attach, inside the DO. Join + by-code key on the
        // room/code, not the IP (NAT-JOIN: 30 players on one venue WiFi
        // share one IP — per-IP join would 429 the 6th player).
        let key = clientIp(req);
        const isSeatRoute =
          route.rateKey.includes('/ws-ticket') ||
          route.rateKey.includes('/start') ||
          route.rateKey.includes('/config') ||
          route.rateKey.includes('/remove-player') ||
          route.rateKey.includes('/regenerate-code') ||
          route.rateKey.includes('/catch-token') ||
          route.rateKey.includes('/lifecycle') ||
          route.rateKey.includes('/host/') ||
          route.rateKey.includes('/resolve') ||
          route.rateKey.includes('/results') ||
          route.rateKey === 'GET /v1/rooms/:id';
        const isJoinRoute = route.rateKey === 'POST /v1/rooms/:id/join';
        const isByCodeRoute = route.rateKey === 'GET /v1/rooms/by-code/:code';
        if (isSeatRoute || isJoinRoute) {
          let playerId: string | null = url.searchParams.get('playerId');
          let roomCode: string | null = null;
          if (req.method === 'POST') {
            // Peek at the body once for the rate-limit key; the handler
            // parses it again (a Request body can only be read once per
            // clone, so clone here).
            try {
              const peek = (await req.clone().json()) as Record<string, unknown>;
              if (typeof peek['playerId'] === 'string') playerId = peek['playerId'] as string;
              if (typeof peek['roomCode'] === 'string') roomCode = peek['roomCode'] as string;
            } catch {
              // Unparseable body: the handler will 400; still rate-limit below.
            }
          }
          if (isJoinRoute) {
            // Room + code bucket (35/min in the table): a full roster on
            // one NAT IP joins inside a minute without a 429.
            key = `join:${params['id'] ?? 'unknown'}:${roomCode ?? ''}`;
          } else if (playerId) {
            key = seatKey(params['id'] ?? 'unknown', playerId);
          } else {
            // No seat yet: scope to this IP within this room, never to a
            // single shared `roomId:anonymous` window for all strangers.
            key = `anon:${params['id'] ?? 'unknown'}:${clientIp(req)}`;
          }
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

        const res = await route.handler(req, httpCtx, params, null);
        // Best-effort telemetry flush on a completed match response path.
        if (route.rateKey === 'GET /v1/rooms/:id/results') {
          ctx.waitUntil(flushTelemetry(env));
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
