-- Pakdam — 0003_indexes
-- Fresh indexes for the Pakdam rebuild (written from PROTOCOL-MAP §7.1).
-- Apply after 0001_init, before 0004_postgis. There is deliberately NO 0002
-- migration: RLS is HELD until the auth-method decision (OD-022) lands.

-- Room lookup by invite code (GET /v1/rooms/by-code/:code, join verification).
CREATE INDEX IF NOT EXISTS idx_rooms_room_code
    ON rooms (room_code);

-- The one event log, read in sequence order per room.
CREATE INDEX IF NOT EXISTS idx_room_events_room_seq
    ON room_events (room_id, seq);

-- Roster lookups per room.
CREATE INDEX IF NOT EXISTS idx_players_room_id
    ON players (room_id);

-- Catch lookups per room + state (pending catches for a room).
CREATE INDEX IF NOT EXISTS idx_catches_room_state
    ON catches (room_id, state);

-- Audit log, newest first.
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at
    ON audit_log (created_at DESC);

-- Grievance queue by status.
CREATE INDEX IF NOT EXISTS idx_grievances_status
    ON grievances (status);
