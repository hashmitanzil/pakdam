-- v29 (Gap 5) — structured-log table for the DO log buffer.
--
-- WRITTEN, NOT APPLIED. The founder applies it (Supabase SQL editor
-- or `supabase db push`) before the v29 Worker is deployed; until it
-- lands, PostgREST 404s on `logs` and `persistLogBatch` returns false
-- silently — logging is best-effort, like every other persist helper,
-- so a missing table never breaks a game.
--
-- Retention: 7 days, enforced by the Worker `scheduled` handler
-- (`deleteOldLogs` in workers/src/supabase.ts, cron "0 3 * * *").
-- pg_cron (nightly `DELETE FROM logs WHERE created_at < now() -
-- interval '7 days'`) is the alternative the founder can switch to.
--
-- NEVER a coordinate: the DO strips lat/lng/latitude/longitude/fix/
-- centre keys (deep) before insert, and callers pass audit data only
-- (codes, counts, durations). A log row must never carry a fix.

create table if not exists public.logs (
  id bigserial primary key,
  level text not null check (level in ('debug', 'info', 'warn', 'error')),
  message text not null,
  room_id uuid,
  player_id uuid,
  operation text,
  duration_ms integer,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists logs_created_at_idx
  on public.logs (created_at desc);

create index if not exists logs_room_created_at_idx
  on public.logs (room_id, created_at desc);
