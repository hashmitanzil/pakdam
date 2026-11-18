import type { CatchEvent, Player, Room } from '@pakdam/shared';
/**
 * Supabase PostgREST client (Worker 5, 2026-11-17) — the Worker's
 * durable store for rooms, results, catches, safety events, bug
 * reports, grievances and audit entries (canonical schema:
 * supabase/migrations/0001_init.sql).
 *
 * HOW IT IS WIRED — read this before assuming Supabase is live:
 * - Credentials come ONLY from Worker bindings: `SUPABASE_URL` (a
 *   plain `[vars]` value in wrangler.toml — the project URL is
 *   public, same value as the web app's NEXT_PUBLIC_SUPABASE_URL)
 *   and `SUPABASE_SERVICE_ROLE_KEY` (a SECRET, set with
 *   `npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY` — see
 *   docs/CLOUDFLARE-SETUP.md §9). No credential is hardcoded here,
 *   no .env value is read, nothing is invented.
 * - When either binding is missing or empty, every helper below
 *   returns `false` and does NOTHING — the Durable Object stays the
 *   authority and the game never fails because Supabase is absent.
 *   Persistence is best-effort by design: a failed insert never
 *   fails a game request (callers use `ctx.waitUntil`, never await
 *   on the hot path).
 * - The client is plain `fetch` against PostgREST (`/rest/v1/`),
 *   no @supabase/supabase-js dependency (the Workers bundle stays
 *   small and the client stays unit-testable under plain Node).
 * - NEVER persisted here: raw coordinates (LocationFix lives ONLY
 *   in DO memory, HNT-068), raw tokens of any kind (only hashes —
 *   reconnect_token_hash / qr_token_hash — as the schema already
 *   stores them), or WS tickets (Worker-in-memory per isolate only,
 *   see auth.ts).
 */
export interface SupabaseEnv {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}

/** True only when BOTH bindings are present and non-empty. */
export function supabaseConfigured(env: SupabaseEnv): boolean {
  return typeof env.SUPABASE_URL === 'string' && env.SUPABASE_URL.length > 0
    && typeof env.SUPABASE_SERVICE_ROLE_KEY === 'string' && env.SUPABASE_SERVICE_ROLE_KEY.length > 0;
}

async function sbRequest(env: SupabaseEnv, method: string, path: string, body?: unknown): Promise<boolean> {
  if (!supabaseConfigured(env)) return false;
  try {
    const res = await fetch(`${env.SUPABASE_URL!.replace(/\/$/, '')}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY!,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY!}`,
        'content-type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Insert one row. Returns false (never throws) when Supabase is
 *  unconfigured, unreachable, or rejects the row. */
export function sbInsert(env: SupabaseEnv, table: string, row: Record<string, unknown>): Promise<boolean> {
  return sbRequest(env, 'POST', table, row);
}

/** Update rows matching `?key=eq.value`. Returns false (never
 *  throws) when Supabase is unconfigured, unreachable, or rejects. */
export function sbUpdate(
  env: SupabaseEnv, table: string,
  match: Record<string, string>, patch: Record<string, unknown>,
): Promise<boolean> {
  const qs = Object.entries(match)
    .map(([k, v]) => `${k}=eq.${encodeURIComponent(v)}`)
    .join('&');
  return sbRequest(env, 'PATCH', `${table}?${qs}`, patch);
}

/** Room creation (Worker create route): one rooms row + the host's
 *  players row. Called with ctx.waitUntil — a Supabase failure never
 *  fails the 201. No host-token hash is stored: host tokens live
 *  only in DO state (room-do.ts hostTokens). */
export async function persistRoomCreated(env: SupabaseEnv, room: Room, host: Player): Promise<boolean> {
  const roomOk = await sbInsert(env, 'rooms', {
    room_id: room.roomId, room_code: room.roomCode, host_player_id: room.hostPlayerId,
    phase: room.phase, version: room.version, config: room.config,
    created_at: room.createdAt, started_at: room.startedAt, ends_at: room.endsAt,
    result: room.result,
  });
  if (!roomOk) return false;
  return sbInsert(env, 'players', {
    player_id: host.playerId, room_id: host.roomId, kind: host.kind,
    display_name: host.displayName, is_host: host.isHost,
    match_role: host.matchRole, team: host.team,
    reconnect_token_hash: host.reconnectTokenHash,
    joined_at: host.joinedAt, left_at: host.leftAt,
    age_gate_passed: host.ageGatePassed, suspension_count: host.suspensionCount,
  });
}

/** Match end (COMPLETED or CANCELLED with a result): the rooms row
 *  carries the final phase + result jsonb. Called from the DO when
 *  the phase flips to a terminal phase with room.result set. */
export function persistMatchResult(env: SupabaseEnv, room: Room): Promise<boolean> {
  return sbUpdate(env, 'rooms', { room_id: room.roomId }, {
    phase: room.phase, version: room.version,
    started_at: room.startedAt, ends_at: room.endsAt, result: room.result,
  });
}

/** A catch as it is first requested: one catches row. Only the QR
 *  token HASH is stored (never the raw token — the raw token lives
 *  in DO memory only, for the Runner's QR). */
export function persistCatchInsert(env: SupabaseEnv, c: CatchEvent): Promise<boolean> {
  return sbInsert(env, 'catches', {
    catch_id: c.catchId, room_id: c.roomId, hunter_id: c.hunterPlayerId,
    runner_id: c.runnerPlayerId, state: c.state, qr_token_hash: c.qrTokenHash,
    requested_at: c.requestedAt, confirmed_at: c.confirmedAt, resolution: c.resolution,
  });
}

/** A catch changing state after the request (confirmed / disputed /
 *  rejected / expired / host-resolved): patch the row in place. */
export function persistCatchUpdate(env: SupabaseEnv, c: CatchEvent): Promise<boolean> {
  return sbUpdate(env, 'catches', { catch_id: c.catchId }, {
    state: c.state, confirmed_at: c.confirmedAt, resolution: c.resolution,
  });
}

/** One safety_events row: SOS raised, safety pause, safety resume.
 *  `type` is the table's free-text type column (the SafetyEventType
 *  union in shared/types.ts is the client-side vocabulary; the
 *  values used here are 'sos' | 'safety-pause' | 'safety-resume'). */
export function persistSafetyEvent(
  env: SupabaseEnv, roomId: string, playerId: string,
  type: 'sos' | 'safety-pause' | 'safety-resume', reason: string | null,
): Promise<boolean> {
  return sbInsert(env, 'safety_events', {
    room_id: roomId, player_id: playerId, type, reason,
  });
}

export interface BugReportRow {
  roomId: string | null; playerId: string | null;
  deviceInfo: string; appVersion: string; description: string;
}

/** POST /v1/support/bugs (HNT-117): no location is ever attached. */
export function persistBugReport(env: SupabaseEnv, row: BugReportRow): Promise<boolean> {
  return sbInsert(env, 'bug_reports', {
    room_id: row.roomId, player_id: row.playerId,
    device_info: row.deviceInfo, app_version: row.appVersion,
    description: row.description, status: 'open',
  });
}

export interface GrievanceRow {
  complainantRef: string; channel: 'in-app' | 'email'; summary: string;
}

/** POST /v1/support/grievances (Rule 20 — distinct from bugs). */
export function persistGrievance(env: SupabaseEnv, row: GrievanceRow): Promise<boolean> {
  return sbInsert(env, 'grievances', {
    complainant_ref: row.complainantRef, channel: row.channel,
    summary: row.summary, status: 'acknowledged',
  });
}

/** POST /v1/reports (HNT-064 report/block): an audit record ONLY.
 *  There is no block list in the DO yet, so a 'block' here is
 *  recorded for the host / a later moderation pass — it does NOT
 *  itself remove or silence anyone. Enforcement is a follow-up, not
 *  silently claimed by this route. */
export function persistReportAudit(
  env: SupabaseEnv, roomId: string, actorId: string, targetId: string | null, kind: 'report' | 'block',
): Promise<boolean> {
  return sbInsert(env, 'audit_log', {
    actor_id: actorId, actor_role: 'player',
    action: kind === 'block' ? 'player.block' : 'player.report',
    room_id: roomId, target_id: targetId, result: 'allowed',
  });
}
