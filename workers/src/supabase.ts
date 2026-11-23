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

/** Coordinate keys — stripped at ANY depth from log/event payloads.
 * One list, shared by `redactPayload`, `stripCoordinatesDeep` and
 * `RoomStore.logGameEvent`: a nested `fix` / `centre` / `coordinates`
 * / `position` / `lngLat` object must never reach a log through a
 * nested payload. v29 fix round (F9) extends the list with `center`,
 * `coordinates`, `position`, `lngLat` (in addition to
 * lat/lng/latitude/longitude/fix/centre). All current payloads are
 * scalar by construction — this is hardening, not a live leak. */
export const COORDINATE_KEYS: readonly string[] = [
  'lat',
  'lng',
  'latitude',
  'longitude',
  'fix',
  'centre',
  'center',
  'coordinates',
  'position',
  'lngLat',
];

/** Strip any coordinate keys from a payload (room_events trigger backstop).
 * Deep: nested objects and arrays are stripped too — see
 * `stripCoordinatesDeep`. Same key list as RoomStore.logGameEvent. */
export function redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return stripCoordinatesDeep(payload) as Record<string, unknown>;
}

/**
 * v29 (Gap 5) — one structured-log entry, buffered in DO memory (cap
 * 100) and flushed as a `log-batch` intent. `metadata` is audit data
 * only: codes, counts, durations — NEVER coordinates, NEVER a fix.
 * `persistLogBatch` strips coordinate keys as a backstop, so a
 * caller mistake cannot smuggle a position into the `logs` table.
 */
export interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  roomId?: string;
  playerId?: string;
  operation?: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

/** Deep-strip coordinate keys from a value (objects AND arrays). */
export function stripCoordinatesDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCoordinatesDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (COORDINATE_KEYS.includes(k)) continue;
      out[k] = stripCoordinatesDeep(v);
    }
    return out;
  }
  return value;
}

/**
 * v29 (Gap 5) — write a batch of structured-log rows (plain PostgREST
 * POST to `logs`). Boolean return, never throws: a failed insert never
 * fails a game request. One row per entry; `metadata` is deep-stripped
 * of coordinate keys first, so a log row can never carry a fix.
 * Migration 0008 creates the table (written, NOT applied — the
 * founder applies it); before it lands, PostgREST 404s and this
 * returns false, silently — logging is best-effort, like everything
 * else in this file.
 */
export async function persistLogBatch(
  env: SupabaseEnv,
  entries: readonly LogEntry[],
): Promise<boolean> {
  if (entries.length === 0) return true;
  const rows = entries.map((e) => ({
    level: e.level,
    message: e.message,
    room_id: e.roomId ?? null,
    player_id: e.playerId ?? null,
    operation: e.operation ?? null,
    duration_ms: e.durationMs ?? null,
    metadata: stripCoordinatesDeep(e.metadata ?? {}),
  }));
  return postgrest(env, 'logs', 'POST', rows, 'return=minimal');
}

/**
 * v29 (Gap 5) — 7-day log retention: delete `logs` rows older than 7
 * days. Called from the Worker `scheduled` handler (see index.ts).
 * pg_cron (nightly `DELETE FROM logs WHERE created_at < now() -
 * interval '7 days'`) is the alternative the founder can switch to —
 * pg_cron availability cannot be checked from this VM, so the Worker
 * handler is the implementation, not the fallback. Boolean return,
 * never throws.
 */
export async function deleteOldLogs(env: SupabaseEnv): Promise<boolean> {
  if (!isSupabaseConfigured(env)) return false;
  try {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const res = await fetch(
      `${env.SUPABASE_URL as string}/rest/v1/logs?created_at=lt.${encodeURIComponent(cutoff)}`,
      {
        method: 'DELETE',
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY as string,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY as string}`,
        },
      },
    );
    return res.ok;
  } catch {
    return false;
  }
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

/** Pause / resume audit row (v18: SOS removed — no 'sos' type is ever sent). */
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

/**
 * v29 (R12) — per-game rows-written budget: ~2,500 rows for a
 * 30-player 30-min game. The budget is a guardrail, not a quota:
 * intents are the audit trail — a game that needs more rows writes
 * more rows. Honest composition (v29 fix round, F8): the MEASURED
 * slice is 1,800 rows (30 players × ~1 player-upsert/30 s × 30 min);
 * the honest total is ≈ 2,200 — slice 1,800 + pings ~240 + catches
 * ~100–150 + start/match ~35 + log-batches — against the 2,500
 * assert budget. "~2,500" is the assert budget, NOT the measurement:
 * the start batch is NOT counted in the measured slice (if it were,
 * the extrapolated slice would be 2,760 and the test would fail).
 * Note the 30 s player-upsert throttle is memory-only and resets on
 * wake — after an eviction every seat's next fix re-upserts at once,
 * so a wake costs up to one extra upsert per seat.
 * The number to watch is the per-game total in tests
 * (`v29-rows-written.test.mjs`): if it grows past ~3,000, the
 * player-upsert throttle or the log buffer is the first suspect.
 */
export type PersistIntent =
  | { kind: 'room-upsert'; room: Room }
  | { kind: 'player-upsert'; roomId: string; player: Player }
  | { kind: 'room-event'; roomId: string; seq: number; type: string; actorId: string | null; payload: Record<string, unknown> }
  | { kind: 'catch-insert'; roomId: string; catch: CatchEvent }
  | { kind: 'catch-update'; catch: CatchEvent }
  | { kind: 'safety-event'; roomId: string; playerId: string; type: string; reason: string | null }
  | { kind: 'match-result'; room: Room }
  | { kind: 'log-batch'; entries: LogEntry[] };

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
    case 'log-batch':
      return persistLogBatch(env, intent.entries);
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
 *
 * v23 fix round 1 (S7): returns one boolean per intent, in order —
 * `true` when that intent's write landed, `false` when it did not
 * (helper returned false, or the call threw). Callers that merely
 * audit (the normal `waitUntil` paths) still ignore the result; the
 * host-cancel delete path MUST check it — a Supabase outage used to
 * be swallowed here while the room was wiped, silently losing the
 * CANCELLED audit record. This function never throws.
 */
export async function executePersistIntents(
  env: SupabaseEnv,
  intents: readonly PersistIntent[],
): Promise<boolean[]> {
  const results = await Promise.allSettled(
    intents.map(async (intent) => {
      try {
        return await executePersistIntent(env, intent);
      } catch {
        // Best-effort by design — the DO is the authority.
        return false;
      }
    }),
  );
  return results.map((r) => (r.status === 'fulfilled' ? r.value : false));
}
