-- 0001_init.sql — ONE canonical schema (v2.1 Issue 6 fix).
-- Chosen base: Pack v2 file 25 tables (players, rooms, room_events, catches,
-- safety_events, bug_reports, grievances, audit_log, telemetry_daily),
-- PLUS profiles (host accounts, from file 03). Folded in / NOT created:
--  room_participants -> players (players ARE participants; is_host + match_role separate)
--  match_events      -> room_events (one event log)
--  match_results     -> rooms.result (jsonb, no routes/coordinate trails)
--  catch_attempts    -> catches
--  support_tickets   -> bug_reports + grievances (Rule 20 grievance is distinct from HNT-117 bugs)
--  saved_arenas      -> DEFERRED (P1, not Phase 0)
-- NO table stores raw coordinates. LocationFix lives ONLY in the Durable
-- Object active-room state and is purged at match end/TTL (HNT-068).
create extension if not exists pgcrypto;
create table if not exists profiles (
  profile_id uuid primary key default gen_random_uuid(),
  display_name text not null check (char_length(display_name) between 1 and 30),
  locale text not null default 'en',
  age_assurance_status text not null default 'pending',
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create table if not exists rooms (
  room_id uuid primary key default gen_random_uuid(),
  room_code text not null unique,
  host_player_id uuid,
  phase text not null check (phase in ('DRAFT','LOBBY','READY_CHECK','COUNTDOWN','HEAD_START','ACTIVE','SAFETY_PAUSED','RESOLVING','COMPLETED','CANCELLED','ABANDONED','EXPIRED')),
  version int not null default 0,
  config jsonb not null,
  created_at timestamptz not null default now(),
  started_at timestamptz, ends_at timestamptz,
  result jsonb
);
create table if not exists players (
  player_id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(room_id) on delete cascade,
  profile_id uuid references profiles(profile_id),
  kind text not null check (kind in ('host-account','guest')),
  display_name text not null check (char_length(display_name) between 1 and 30),
  is_host boolean not null default false,
  match_role text check (match_role in ('hunter','runner')),
  team text check (team in ('hunters','runners')),
  reconnect_token_hash text not null,
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  age_gate_passed boolean not null default false,
  suspension_count int not null default 0
);
create table if not exists room_events (
  event_id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(room_id) on delete cascade,
  seq bigint not null,
  type text not null, actor_id uuid, payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (room_id, seq)
);
create table if not exists catches (
  catch_id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(room_id) on delete cascade,
  hunter_id uuid not null, runner_id uuid not null,
  state text not null check (state in ('requested','awaiting-confirmation','confirmed','disputed','rejected','expired')),
  qr_token_hash text, requested_at timestamptz not null default now(),
  confirmed_at timestamptz, resolution text
);
create table if not exists safety_events (
  event_id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(room_id) on delete cascade,
  player_id uuid, type text not null, reason text,
  created_at timestamptz not null default now()
);
create table if not exists bug_reports (
  report_id uuid primary key default gen_random_uuid(),
  room_id uuid references rooms(room_id), player_id uuid,
  device_info text not null, app_version text not null,
  description text not null, status text not null default 'open',
  created_at timestamptz not null default now()
);
create table if not exists grievances (
  grievance_id uuid primary key default gen_random_uuid(),
  complainant_ref text not null, channel text not null check (channel in ('in-app','email')),
  summary text not null, status text not null default 'acknowledged',
  acknowledged_at timestamptz, resolved_at timestamptz
);
create table if not exists audit_log (
  entry_id uuid primary key default gen_random_uuid(),
  actor_id uuid, actor_role text, action text not null,
  room_id uuid, target_id uuid, created_at timestamptz not null default now(),
  result text not null check (result in ('allowed','denied'))
);
create table if not exists telemetry_daily (
  date date primary key,
  matches_completed int not null default 0, player_games int not null default 0,
  messages int not null default 0, location_updates_count int not null default 0,
  tile_requests int not null default 0, storage_bytes bigint not null default 0, errors int not null default 0
);
