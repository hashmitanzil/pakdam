/**
 * @pakdam/workers — Supabase durable-record writes (plain fetch to PostgREST).
 *
 * No @supabase/supabase-js dependency. Credentials ONLY from Worker
 * bindings: SUPABASE_URL is a plain [vars] value in wrangler.toml, the
 * service-role key is a SECRET (wrangler secret put). When either binding
 * is missing/empty, every helper returns false and does nothing.
 *
 * PERSISTENCE IS BEST-EFFORT BY DESIGN: a failed insert never fails a game
 * request. Callers use ctx.waitUntil() and never await on the hot path. The
 * DO stays the authority when Supabase is absent.
 *
 * NEVER PERSISTED: raw coordinates (fixes live only in DO memory), raw
 * tokens of any kind (hashes only), WS tickets.
 */
import type { CatchEvent, Player, Room } from '@pakdam/shared';

export interface SupabaseEnv {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}

export function isSupabaseConfigured(env: SupabaseEnv): boolean {
  return Boolean(env.SUPABASE_URL) && Boolean(env.SUPABASE_SERVICE_ROLE_KEY);
}

async function postgrest(
  env: SupabaseEnv,
  path: string,
  method: 'POST' | 'PATCH',
  body: unknown,
  prefer?: string,
): Promise<boolean> {
  if (!isSupabaseConfigured(env)) return false;
  try {
    const res = await fetch(
      `${env.SUPABASE_URL as string}/rest/v1/${path}`,
      {
        method,
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY as string,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY as string}`,
          'Content-Type': 'application/json',
          ...(prefer ? { Prefer: prefer } : {}),
        },
        body: JSON.stringify(body),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

/** Strip any coordinate keys from a payload (room_events trigger backstop).
 * Same key list as RoomStore.logGameEvent — a nested `fix` / `centre`
 * object must never reach the log through this backstop either. */
export function redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (['lat', 'lng', 'latitude', 'longitude', 'fix', 'centre'].includes(k)) continue;
    out[k] = v;
  }
  return out;
}

function roomRow(room: Room): Record<string, unknown> {
  return {
    room_id: room.roomId,
    room_code: room.roomCode,
    host_player_id: room.hostPlayerId,
    phase: room.phase,
    version: room.version,
    config: room.config,
    created_at: room.createdAt,
    started_at: room.startedAt,
    ends_at: room.endsAt,
    result: room.result,
  };
}

function playerRow(roomId: string, p: Player): Record<string, unknown> {
  return {
    player_id: p.playerId,
    room_id: roomId,
    profile_id: null,
    kind: p.kind,
    display_name: p.displayName,
    is_host: p.isHost,
    match_role: p.matchRole,
    team: p.team,
    reconnect_token_hash: p.reconnectTokenHash,
    joined_at: p.joinedAt,
    left_at: p.leftAt,
    age_gate_passed: p.ageGatePassed,
    suspension_count: p.suspensionCount,
  };
}

/** One row per room (upsert by room_id). */
export async function persistRoom(env: SupabaseEnv, room: Room): Promise<boolean> {
  return postgrest(env, 'rooms?on_conflict=room_id', 'POST', roomRow(room), 'resolution=merge-duplicates,return=minimal');
}

/** One row per seat (upsert by player_id). */
export async function persistPlayer(
  env: SupabaseEnv,
  roomId: string,
  player: Player,
): Promise<boolean> {
  return postgrest(env, 'players?on_conflict=player_id', 'POST', playerRow(roomId, player), 'resolution=merge-duplicates,return=minimal');
}

/** Redacted game event into room_events (UNIQUE (room_id, seq)). */
export async function persistRoomEvent(
  env: SupabaseEnv,
  roomId: string,
  seq: number,
  type: string,
  actorId: string | null,
  payload: Record<string, unknown>,
): Promise<boolean> {
  return postgrest(env, 'room_events', 'POST', {
    room_id: roomId,
    seq,
    type,
    actor_id: actorId,
    payload: redactPayload(payload),
  });
}

/** One row per catch at request time. */
export async function persistCatchInsert(
  env: SupabaseEnv,
  roomId: string,
  c: CatchEvent,
): Promise<boolean> {
  return postgrest(env, 'catches', 'POST', {
    catch_id: c.catchId,
    room_id: roomId,
    hunter_id: c.hunterPlayerId,
    runner_id: c.runnerPlayerId,
    state: c.state,
    qr_token_hash: c.qrTokenHash,
    requested_at: c.requestedAt,
    confirmed_at: c.confirmedAt,
    resolution: c.resolution,
  });
}

/** Patch a catch row on state change. */
export async function persistCatchUpdate(
  env: SupabaseEnv,
  c: CatchEvent,
): Promise<boolean> {
  return postgrest(env, `catches?catch_id=eq.${c.catchId}`, 'PATCH', {
    state: c.state,
    qr_token_hash: c.qrTokenHash,
    confirmed_at: c.confirmedAt,
    resolution: c.resolution,
  });
}

/** SOS / pause / resume audit row. */
export async function persistSafetyEvent(
  env: SupabaseEnv,
  roomId: string,
  playerId: string,
  type: string,
  reason: string | null,
): Promise<boolean> {
  return postgrest(env, 'safety_events', 'POST', {
    room_id: roomId,
    player_id: playerId,
    type,
    reason,
  });
}

/** Final phase + result for a completed/cancelled match. */
export async function persistMatchResult(
  env: SupabaseEnv,
  room: Room,
): Promise<boolean> {
  return postgrest(env, `rooms?room_id=eq.${room.roomId}`, 'PATCH', {
    phase: room.phase,
    version: room.version,
    result: room.result,
  });
}

/** Report / block audit record (a 'block' here does NOT remove or silence anyone). */
export async function persistReportAudit(
  env: SupabaseEnv,
  input: { roomId: string; playerId: string; targetPlayerId?: string | null; kind: 'report' | 'block' },
): Promise<boolean> {
  return postgrest(env, 'audit_log', 'POST', {
    actor_id: input.playerId,
    actor_role: 'guest',
    action: `player.${input.kind}`,
    room_id: input.roomId,
    target_id: input.targetPlayerId ?? null,
    result: 'allowed',
  });
}

/** Bug intake — no location ever attached. */
export async function persistBugReport(
  env: SupabaseEnv,
  input: { roomId?: string | null; playerId?: string | null; deviceInfo?: string | null; appVersion?: string | null; description: string },
): Promise<boolean> {
  return postgrest(env, 'bug_reports', 'POST', {
    room_id: input.roomId ?? null,
    player_id: input.playerId ?? null,
    device_info: input.deviceInfo ?? null,
    app_version: input.appVersion ?? null,
    description: input.description,
    status: 'open',
  });
}

/** Grievance intake, distinct from bugs. */
export async function persistGrievance(
  env: SupabaseEnv,
  input: { complainantRef?: string | null; channel: string; summary: string },
): Promise<boolean> {
  return postgrest(env, 'grievances', 'POST', {
    complainant_ref: input.complainantRef ?? null,
    channel: input.channel,
    summary: input.summary,
    status: 'acknowledged',
  });
}

/** Daily counts only — no payloads, no identifiers. */
export async function upsertTelemetryDaily(
  env: SupabaseEnv,
  date: string,
  counts: Record<string, number>,
): Promise<boolean> {
  return postgrest(
    env,
    'telemetry_daily?on_conflict=date',
    'POST',
    { date, ...counts },
    'resolution=merge-duplicates,return=minimal',
  );
}

// ---------------------------------------------------------------------------
// Persist intents — the DO returns these (JSON-safe) with every mutating op;
// the Worker (HTTP path) or the DO class (WS path) executes them via
// ctx.waitUntil(). The DO itself never touches Supabase.
//
// NOTE: there is deliberately no fetchRoomResult read helper here — live
// results are read from DO state (RoomStore.resultsFor), never from
// Supabase; a Supabase read path would go stale on every DO-only update.
// ---------------------------------------------------------------------------

export type PersistIntent =
  | { kind: 'room-upsert'; room: Room }
  | { kind: 'player-upsert'; roomId: string; player: Player }
  | { kind: 'room-event'; roomId: string; seq: number; type: string; actorId: string | null; payload: Record<string, unknown> }
  | { kind: 'catch-insert'; roomId: string; catch: CatchEvent }
  | { kind: 'catch-update'; catch: CatchEvent }
  | { kind: 'safety-event'; roomId: string; playerId: string; type: string; reason: string | null }
  | { kind: 'match-result'; room: Room };

export async function executePersistIntent(
  env: SupabaseEnv,
  intent: PersistIntent,
): Promise<boolean> {
  switch (intent.kind) {
    case 'room-upsert':
      return persistRoom(env, intent.room);
    case 'player-upsert':
      return persistPlayer(env, intent.roomId, intent.player);
    case 'room-event':
      return persistRoomEvent(env, intent.roomId, intent.seq, intent.type, intent.actorId, intent.payload);
    case 'catch-insert':
      return persistCatchInsert(env, intent.roomId, intent.catch);
    case 'catch-update':
      return persistCatchUpdate(env, intent.catch);
    case 'safety-event':
      return persistSafetyEvent(env, intent.roomId, intent.playerId, intent.type, intent.reason);
    case 'match-result':
      return persistMatchResult(env, intent.room);
    default:
      return false;
  }
}

/**
 * Best-effort, CONCURRENT (Phase 3 #8): every intent is an independent
 * PostgREST call on a different row/table (or the same room row carrying
 * the same snapshot values), so they run via Promise.allSettled instead
 * of sequentially — a catch confirm's catch-update + player-upsert +
 * room-event (+ match-result + room-upsert on a win) and a start's N+1
 * player-upserts no longer pay N round trips in series. A failure in
 * one intent never fails the others, as before. Hashes are untouched
 * (SHA-256 is sub-ms; caching them would save nothing and risk reuse).
 */
export async function executePersistIntents(
  env: SupabaseEnv,
  intents: readonly PersistIntent[],
): Promise<void> {
  await Promise.allSettled(
    intents.map(async (intent) => {
      try {
        await executePersistIntent(env, intent);
      } catch {
        // Best-effort by design — the DO is the authority.
      }
    }),
  );
}
