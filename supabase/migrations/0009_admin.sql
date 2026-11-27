-- Pakdam — 0009_admin (Admin Console / Mission Control)
--
-- WRITTEN, NOT APPLIED. The founder applies it (Supabase SQL editor
-- or `supabase db push`) before the admin Worker is deployed; until it
-- lands, every admin endpoint answers 503 (storage unavailable) and
-- the game is unaffected — admin storage is load-bearing for the
-- console only, never for live play.
--
-- Privacy hard rules (same as 0001 — never break these):
--   * No raw coordinates in ANY admin table (no lat/lng column exists
--     below; live fixes live only in DO memory and are served
--     in-session to the Owner, never stored).
--   * No raw tokens of any kind — session token_hashes only, never
--     the token value. No raw passwords — PBKDF2 hashes only.
--   * No card data anywhere (billing is future — see 0010).
--
-- Retention (deliberate difference — see docs/admin-console.md):
--   * admin_audit_log: 180 DAYS (compliance record — CERT-In / DPDP
--     evidence). Deleted by the Worker scheduled handler
--     (deleteOldAdminAudit in workers/src/admin-db.ts).
--   * Game logs table: 7 days (deleteOldLogs). The two retentions
--     are different on purpose: game logs are high-volume telemetry,
--     the admin audit log is a compliance record.

-- Separate admin accounts (NOT the game guest flow, NOT Supabase Auth
-- — see workers/src/admin-auth.ts for the decision on evidence).
create table if not exists public.admin_users (
  id              uuid primary key default gen_random_uuid(),
  username        text not null unique check (char_length(username) between 3 and 30),
  role            text not null check (role in ('owner', 'admin', 'staff')),
  -- PBKDF2-SHA256, format pbkdf2-sha256$<iterations>$<salt>$<hash>.
  password_hash   text not null,
  created_at      timestamptz not null default now(),
  last_login_at   timestamptz,
  failed_attempts integer not null default 0,
  locked_until    timestamptz,
  disabled        boolean not null default false
);

create index if not exists admin_users_username_idx
  on public.admin_users (username);

-- Server-side admin sessions: 12 h absolute expiry. token_hash is the
-- SHA-256 of the whole bearer token; the raw token is never stored.
create table if not exists public.admin_sessions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.admin_users (id) on delete cascade,
  token_hash text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists admin_sessions_token_hash_idx
  on public.admin_sessions (token_hash);

create index if not exists admin_sessions_expires_at_idx
  on public.admin_sessions (expires_at);

-- Feature flags: one row per capability. The game flags are the live
-- switches (radio / pings / zone / gameStart default ON, demoMode
-- OFF); the billing.* / accounts.* flags are the activation
-- mechanism for the future sections (default OFF — flipping one
-- activates its section with no code change). Keys match
-- ADMIN_FLAG_DEFS + ADMIN_FUTURE_FLAGS in packages/shared/src/admin.ts.
create table if not exists public.feature_flags (
  key        text primary key,
  enabled    boolean not null default false,
  updated_by text,
  updated_at timestamptz not null default now()
);

-- Game config: one row (key 'default'). Values are the CURRENT live
-- defaults from packages/shared/src/calibration.ts — NOT invented:
-- duration 1800 s, head start 180 s, ping interval 180 s, zone
-- radius 500 m, shrink every 600 s, shrink on.
insert into public.feature_flags (key, enabled) values
  ('radio', true),
  ('pings', true),
  ('zone', true),
  ('gameStart', true),
  ('demoMode', false),
  ('voiceText', true),
  ('qrInvite', true),
  ('billing.overview', false),
  ('billing.transactions', false),
  ('billing.plans', false),
  ('billing.providers', false),
  ('billing.refunds', false),
  ('billing.tax', false),
  ('accounts.directory', false),
  ('accounts.roles', false),
  ('accounts.bans', false),
  ('accounts.dataRequests', false),
  ('accounts.loginMethods', false)
on conflict (key) do nothing;

create table if not exists public.game_config (
  key                          text primary key,
  duration_seconds             integer not null default 1800,
  head_start_seconds           integer not null default 180,
  ping_interval_seconds        integer not null default 180,
  zone_radius_metres           integer not null default 500,
  zone_shrink_interval_seconds integer not null default 600,
  zone_shrink_enabled          boolean not null default true,
  updated_by                   text,
  updated_at                   timestamptz not null default now()
);

insert into public.game_config (key) values ('default')
on conflict (key) do nothing;

-- Announcements shown on the game home screen (active, newest first).
create table if not exists public.announcements (
  id         uuid primary key default gen_random_uuid(),
  text       text not null check (char_length(text) between 1 and 500),
  active     boolean not null default true,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Blocks: bans/suspensions. device_id is an admin-supplied opaque
-- identifier (today: a playerId); player_id + reconnect_token_hash
-- bind the block to the SEAT CREDENTIAL, which is what the join gate
-- enforces (there is no device key in the game today — see
-- docs/admin-console.md). action 'ban' = indefinite, 'suspend' =
-- time-boxed via expires_at.
create table if not exists public.blocks (
  id                   uuid primary key default gen_random_uuid(),
  device_id            text,
  player_id            uuid,
  reconnect_token_hash text,
  action               text not null check (action in ('ban', 'suspend')),
  reason               text,
  expires_at           timestamptz,
  blocked_by           text,
  blocked_at           timestamptz not null default now()
);

create index if not exists blocks_player_id_idx
  on public.blocks (player_id);

create index if not exists blocks_token_hash_idx
  on public.blocks (reconnect_token_hash);

-- Safety flags raised from the console (kind + detail, audit-only).
create table if not exists public.safety_flags (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null,
  detail     text not null,
  created_by text,
  status     text not null default 'open' check (status in ('open', 'reviewed', 'closed')),
  created_at timestamptz not null default now()
);

-- Admin audit log: EVERY mutating admin action + RBAC denials +
-- auth events + Owner live-location views (WITHOUT coordinates —
-- the detail field must never carry a lat/lng). 180-day retention.
create table if not exists public.admin_audit_log (
  id         uuid primary key default gen_random_uuid(),
  actor_id   uuid,
  actor_role text,
  action     text not null,
  target     text,
  detail     text,
  created_at timestamptz not null default now()
);

create index if not exists admin_audit_log_created_at_idx
  on public.admin_audit_log (created_at desc);

create index if not exists admin_audit_log_actor_idx
  on public.admin_audit_log (actor_id, created_at desc);
