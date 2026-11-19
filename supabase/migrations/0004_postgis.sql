-- Pakdam — 0004_postgis
-- Fresh PostGIS layer for the Pakdam rebuild (written from PROTOCOL-MAP §7.2).
-- Apply after 0001_init + 0003_indexes.
--
-- Uses ST_Covers, NOT ST_Contains: ST_Contains is geometry-only and the first
-- live run failed with ERROR 42883; ST_Covers works on geography and also
-- counts a point exactly ON the boundary as inside, which is the right call
-- for a game zone.
--
-- What PostGIS does NOT do: it can test whether a point is inside a boundary.
-- It CANNOT judge whether a place is DANGEROUS. The real safety layer is the
-- host's venue choice + the pre-match warning. A restricted area is a
-- host-drawn polygon, not a safety verdict.
--
-- Points are passed as ARGUMENTS and never stored.

CREATE EXTENSION IF NOT EXISTS postgis;

-- Host-drawn no-go polygons, one row per area. No label column — the app
-- lists them as "No-go area N".
CREATE TABLE IF NOT EXISTS restricted_areas (
    area_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id    uuid NOT NULL REFERENCES rooms (room_id) ON DELETE CASCADE,
    area       geography(Polygon, 4326) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- The room's play-zone boundary as a geography polygon, built from
-- rooms.config (config.zone.boundary is a GeoJSON Polygon: the drawn shape
-- verbatim, or the 32-point circle approximation). The boundary is stored
-- closed by the server; NULL when the room has no boundary (play zone off
-- or no centre yet).
CREATE OR REPLACE FUNCTION zone_polygon(p_room_id uuid)
RETURNS geography(Polygon, 4326)
LANGUAGE sql
STABLE
AS $$
    SELECT CASE
        WHEN r.config -> 'zone' -> 'boundary' IS NULL THEN NULL
        ELSE ST_GeogFromGeoJSON((r.config -> 'zone' -> 'boundary')::text)::geography(Polygon, 4326)
    END
    FROM rooms r
    WHERE r.room_id = p_room_id;
$$;

-- Authoritative point-in-zone check. Returns NULL when the room has no zone.
CREATE OR REPLACE FUNCTION point_in_zone(p_room_id uuid, p_lat double precision, p_lng double precision)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT CASE
        WHEN z IS NULL THEN NULL
        ELSE ST_Covers(z, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography)
    END
    FROM zone_polygon(p_room_id) AS z;
$$;

-- Authoritative point-in-restricted-area check. True when the point lies
-- inside ANY no-go polygon of the room; false when the room has none.
CREATE OR REPLACE FUNCTION point_in_restricted_area(p_room_id uuid, p_lat double precision, p_lng double precision)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM restricted_areas a
        WHERE a.room_id = p_room_id
          AND ST_Covers(a.area, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography)
    );
$$;

-- Backstop (HNT-068): the event log must never carry raw coordinates.
-- Rejects any insert whose payload carries a top-level lat / lng /
-- latitude / longitude key.
CREATE OR REPLACE FUNCTION reject_coordinate_payload()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.payload ?| ARRAY['lat', 'lng', 'latitude', 'longitude'] THEN
        RAISE EXCEPTION 'room_events payload must not contain raw coordinates';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reject_coordinate_payload ON room_events;
CREATE TRIGGER trg_reject_coordinate_payload
    BEFORE INSERT ON room_events
    FOR EACH ROW EXECUTE FUNCTION reject_coordinate_payload();
