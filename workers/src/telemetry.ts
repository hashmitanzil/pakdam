/**
 * @pakdam/workers — telemetry_daily aggregation.
 *
 * Daily counts ONLY — no payloads, no identifiers. Best-effort: a failed
 * flush never blocks game flow, and counters are in-memory per isolate, so
 * a flush simply upserts whatever this isolate saw. The DO is the authority;
 * telemetry is a counter, not a record.
 */
import { upsertTelemetryDaily, type SupabaseEnv } from './supabase.js';

export type TelemetryKind =
  | 'matches_completed'
  | 'player_games'
  | 'messages'
  | 'location_updates_count'
  | 'tile_requests'
  | 'storage_bytes'
  | 'errors';

const counters = new Map<string, number>();
let countersDate = '';

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Increment a daily counter (in-memory, per isolate). */
export function recordTelemetry(kind: TelemetryKind, n: number = 1): void {
  const today = todayUtc();
  if (countersDate !== today) {
    counters.clear();
    countersDate = today;
  }
  counters.set(kind, (counters.get(kind) ?? 0) + n);
}

/**
 * Flush this isolate's counters to telemetry_daily (upsert by date) and
 * reset them. Best-effort: returns false when Supabase is unconfigured or
 * the upsert fails; counters are kept on failure so a later flush retries.
 */
export async function flushTelemetry(env: SupabaseEnv): Promise<boolean> {
  if (counters.size === 0) return true;
  const date = countersDate || todayUtc();
  const counts: Record<string, number> = {};
  for (const [k, v] of counters) counts[k] = v;
  const ok = await upsertTelemetryDaily(env, date, counts);
  if (ok) counters.clear();
  return ok;
}
