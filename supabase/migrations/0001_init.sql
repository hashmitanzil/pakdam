-- Pakdam — 0001_init
-- Fresh schema for the Pakdam rebuild (written from PROTOCOL-MAP §7.1).
-- 10 tables. Deploy order: 0001 + 0003 + 0004 on the same project (Mumbai).
-- There is deliberately NO 0002 migration: RLS is HELD until the auth-method
-- decision (OD-022) lands — guest seats have no profile, so the held policies
-- could never satisfy them. Never edit this file in place on a live project;
-- schema changes go in a new numbered migration.
--
-- Privacy hard rules (never break these):
--   * No raw coordinates are ever persisted (LocationFix lives only in DO
--     memory; see the trigger in 0004_postgis as a backstop).
--   * No raw tokens of any kind are ever persisted — hashes only.
--   * WS tickets are never persisted at all.

-- Host accounts (future; guest seats have no profile).
CREATE TABLE IF NOT EXISTS profiles (
    profile_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name          text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 30),
    locale                text NOT NULL DEFAULT 'en',
    age_assurance_status  text NOT NULL DEFAULT 'pending',
    created_at            timestamptz NOT NULL DEFAULT now(),
    deleted_at            timestamptz
);

-- One row per room: code, host, phase, version, full config (jsonb), result.
CREATE TABLE IF NOT EXISTS rooms (
    room_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    room_code       text NOT NULL UNIQUE CHECK (room_code ~ '^[A-Z0-9]{6}$'),
    host_player_id  uuid,
    phase           text NOT NULL DEFAULT 'LOBBY' CHECK (phase IN (
                        'DRAFT', 'LOBBY', 'READY_CHECK', 'COUNTDOWN', 'HEAD_START',
                        'ACTIVE', 'SAFETY_PAUSED', 'RESOLVING', 'COMPLETED',
                        'CANCELLED', 'ABANDONED', 'EXPIRED')),
    version         integer NOT NULL DEFAULT 1,
    config          jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    started_at      timestamptz,
    ends_at         timestamptz,
    result          jsonb
);

-- One row per seat: name, host flag, role/team, reconnect-token hash,
-- suspension count. No host-token hash is stored (host tokens live only in
-- DO state). reconnect_token_hash is NOT NULL — hash only, never the raw token.
CREATE TABLE IF NOT EXISTS players (
    player_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id              uuid NOT NULL REFERENCES rooms (room_id) ON DELETE CASCADE,
    profile_id           uuid REFERENCES profiles (profile_id) ON DELETE SET NULL,
    kind                 text NOT NULL DEFAULT 'guest' CHECK (kind IN ('host-account', 'guest')),
    display_name         text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 30),
    is_host              boolean NOT NULL DEFAULT false,
    match_role           text CHECK (match_role IS NULL OR match_role IN ('hunter', 'runner')),
    team                 text CHECK (team IS NULL OR team IN ('hunters', 'runners')),
    reconnect_token_hash text NOT NULL,
    joined_at            timestamptz NOT NULL DEFAULT now(),
    left_at              timestamptz,
    ejected_at           timestamptz,
    connection_state     text NOT NULL DEFAULT 'connected'
                         CHECK (connection_state IN ('connected', 'stale', 'suspended', 'disconnected')),
    last_fix_at          timestamptz,
    location_quality     text CHECK (location_quality IS NULL OR location_quality IN ('good', 'fair', 'poor')),
    is_ready             boolean NOT NULL DEFAULT false,
    briefing_confirmed   boolean NOT NULL DEFAULT false,
    age_gate_passed      boolean NOT NULL DEFAULT false,
    suspension_count     integer NOT NULL DEFAULT 0
);

-- The one event log (validated GameEvents, redacted — see the trigger in
-- 0004_postgis, which rejects any payload carrying raw coordinates).
CREATE TABLE IF NOT EXISTS room_events (
    event_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id    uuid NOT NULL REFERENCES rooms (room_id) ON DELETE CASCADE,
    seq        bigint NOT NULL,
    type       text NOT NULL,
    actor_id   uuid,
    payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (room_id, seq)
);

-- One row per catch at request; patched on state change.
CREATE TABLE IF NOT EXISTS catches (
    catch_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id        uuid NOT NULL REFERENCES rooms (room_id) ON DELETE CASCADE,
    hunter_id      uuid NOT NULL,
    runner_id      uuid NOT NULL,
    state          text NOT NULL DEFAULT 'awaiting-confirmation' CHECK (state IN (
                       'requested', 'awaiting-confirmation', 'confirmed',
                       'disputed', 'rejected', 'expired')),
    qr_token_hash  text,
    requested_at   timestamptz NOT NULL DEFAULT now(),
    confirmed_at   timestamptz,
    resolution     text
);

-- SOS / pause / resume audit. Values used for type: sos / safety-pause /
-- safety-resume.
CREATE TABLE IF NOT EXISTS safety_events (
    event_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id    uuid NOT NULL REFERENCES rooms (room_id) ON DELETE CASCADE,
    player_id  uuid,
    type       text NOT NULL,
    reason     text,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Bug intake. No location is ever attached.
CREATE TABLE IF NOT EXISTS bug_reports (
    report_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id      uuid REFERENCES rooms (room_id) ON DELETE SET NULL,
    player_id    uuid,
    device_info  text,
    app_version  text,
    description  text NOT NULL,
    status       text NOT NULL DEFAULT 'open',
    created_at   timestamptz NOT NULL DEFAULT now()
);

-- Grievance intake, distinct from bugs.
CREATE TABLE IF NOT EXISTS grievances (
    grievance_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    complainant_ref  text NOT NULL,
    channel          text NOT NULL DEFAULT 'in-app' CHECK (channel IN ('in-app', 'email')),
    summary          text NOT NULL,
    status           text NOT NULL DEFAULT 'acknowledged',
    acknowledged_at  timestamptz NOT NULL DEFAULT now(),
    resolved_at      timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now()
);

-- Report / block audit records.
CREATE TABLE IF NOT EXISTS audit_log (
    entry_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id    uuid,
    actor_role  text,
    action      text NOT NULL,
    room_id     uuid,
    target_id   uuid,
    result      text NOT NULL DEFAULT 'allowed' CHECK (result IN ('allowed', 'denied')),
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Daily counts only — no payloads, no identifiers.
CREATE TABLE IF NOT EXISTS telemetry_daily (
    date                   date PRIMARY KEY,
    matches_completed      integer NOT NULL DEFAULT 0,
    player_games           integer NOT NULL DEFAULT 0,
    messages               integer NOT NULL DEFAULT 0,
    location_updates_count integer NOT NULL DEFAULT 0,
    tile_requests          integer NOT NULL DEFAULT 0,
    storage_bytes          bigint NOT NULL DEFAULT 0,
    errors                 integer NOT NULL DEFAULT 0
);
