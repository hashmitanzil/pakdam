/**
 * @pakdam/workers — runtime feature-flag reads.
 *
 * The admin console's feature_flags table is the activation mechanism:
 * flipping a flag activates a section / game switch with no code change
 * and no deploy. This module is the ONE place the game path consults
 * flags at runtime (imported by workers/src/http.ts for the start
 * kill-switch and by workers/src/room-do-class.ts for radio).
 *
 * Rules:
 * - Flags are cached in-memory per isolate for 60 s (one PostgREST
 *   round-trip per minute per isolate, not per request).
 * - ANY failure (Supabase unconfigured, fetch throws, non-OK, bad
 *   JSON) fails OPEN to the shared defaults — a Supabase outage must
 *   never mute a live game or block a match start. The admin console
 *   itself (workers/src/admin.ts) does the opposite: it fails CLOSED
 *   with 503 when Supabase is down, because admin data lives there.
 * - Keys are Meera's shared contract (packages/shared/src/admin.ts
 *   ADMIN_FLAG_DEFS + ADMIN_FUTURE_FLAGS): 'radio', 'pings', 'zone',
 *   'demoMode', 'voiceText', 'qrInvite', 'gameStart', 'billing.*',
 *   'accounts.*'. Unknown keys default to false.
 * - No coordinates, no tokens, no secrets pass through here — key +
 *   boolean only.
 */
import { ADMIN_FLAG_DEFS, ADMIN_FUTURE_FLAGS } from '@pakdam/shared';
import type { SupabaseEnv } from './supabase.js';

/** Cache TTL: 60 s, matching the web client's public-read cache. */
export const RUNTIME_FLAGS_CACHE_MS = 60_000;

/** The shared defaults, as one map: game flags ON, future flags OFF. */
export function defaultRuntimeFlags(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const def of ADMIN_FLAG_DEFS) {
    // Game switches default ON (the live game predates the console);
    // demoMode is the exception — no demo mode exists in the game.
    out[def.key] = def.key === 'demoMode' ? false : true;
  }
  // gameStart is a server-side kill-switch, not a web UI flag yet —
  // default ON (matches: a missing flag must never block a start).
  out['gameStart'] = true;
  for (const def of ADMIN_FUTURE_FLAGS) out[def.key] = def.enabled;
  return out;
}

let cachedAtMs = 0;
let cachedFlags: Record<string, boolean> = defaultRuntimeFlags();

/** Test helper: drop the cache so the next read re-fetches. */
export function clearRuntimeFlagCache(): void {
  cachedAtMs = 0;
  cachedFlags = defaultRuntimeFlags();
}

/**
 * Read the live flag map (cached 60 s). Never throws, never returns
 * null — on any failure the shared defaults come back.
 */
export async function getRuntimeFlags(
  env: SupabaseEnv,
  nowMs: number = Date.now(),
): Promise<Record<string, boolean>> {
  if (nowMs - cachedAtMs < RUNTIME_FLAGS_CACHE_MS) return { ...cachedFlags };
  const fresh = await fetchRuntimeFlags(env);
  cachedFlags = fresh;
  cachedAtMs = nowMs;
  return { ...fresh };
}

async function fetchRuntimeFlags(env: SupabaseEnv): Promise<Record<string, boolean>> {
  const defaults = defaultRuntimeFlags();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return defaults;
  try {
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/feature_flags?select=key,enabled`,
      {
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      },
    );
    if (!res.ok) return defaults;
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows)) return defaults;
    const out: Record<string, boolean> = { ...defaults };
    for (const row of rows) {
      if (
        typeof row === 'object' &&
        row !== null &&
        typeof (row as { key?: unknown }).key === 'string' &&
        typeof (row as { enabled?: unknown }).enabled === 'boolean'
      ) {
        out[(row as { key: string }).key] = (row as { enabled: boolean }).enabled;
      }
    }
    return out;
  } catch {
    return defaults;
  }
}

/** One-flag read: is `key` ON right now (default from the table)? */
export async function isRuntimeFlagEnabled(
  env: SupabaseEnv,
  key: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const flags = await getRuntimeFlags(env, nowMs);
  return flags[key] ?? defaultRuntimeFlags()[key] ?? false;
}
