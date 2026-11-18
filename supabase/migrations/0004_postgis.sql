-- 0004_postgis.sql — PostGIS, the authoritative spatial layer
-- (founder-approved final stack, 2026-11-17).
--
-- What this does:
--   1. Enables PostGIS.
--   2. `restricted_areas`: host-defined no-go areas as geography
--      polygons (one row per drawn no-go circle). No names — the app
--      lists them as "No-go area N", never a typed place name.
--   3. `zone_polygon(room_id)`: the room's play-zone boundary as a
--      geography polygon, built from rooms.config (the boundary the
--      host drew). The boundary is a HOST-DEFINED play area, not a
--      player's location.
--   4. `point_in_zone(room_id, lat, lng)` / `point_in_restricted_area`
--      (room_id, lat, lng): authoritative point-in-polygon checks.
--      The point is passed as ARGUMENTS and never stored — PostGIS
--      judges the BOUNDARY, never a player's trail.
--   5. A trigger that rejects any room_events payload carrying raw
--      coordinates at the top level (HNT-068: raw coordinates live
--      ONLY in Durable Object active-room state, purged at match end;
--      snapshots/logs must work without them).
--
-- What PostGIS does NOT do (founder rule — do not claim otherwise):
-- PostGIS can test whether a point is inside a boundary. It CANNOT
-- judge whether a place is DANGEROUS. OSM data cannot judge danger
-- either. The real safety layer is the host's venue choice +
-- the pre-match warning (see the host-setup screens). A restricted
-- area is a host-drawn polygon, not a safety verdict.
--
-- STATUS: WRITTEN, NOT YET APPLIED. No live database exists in this
-- environment to apply or syntax-check it against — the founder
-- applies it himself on Supabase (Mumbai) with `supabase db push`
-- after 0001 + 0003, and verifies the functions there. The deploy
-- migration set is 0001 + 0003 + 0004 (0002 RLS is deferred until
-- auth closes — see supabase/migrations-deferred/README.md).

create extension if not exists postgis;

-- Host-defined no-go areas (drawn on the map in host setup).
-- One row per no-go circle. No label column: the app lists them as
-- "No-go area N" — never a typed place name.
create table if not exists restricted_areas (
  area_id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(room_id) on delete cascade,
  area geography(Polygon, 4326) not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_restricted_areas_room on restricted_areas(room_id);
create index if not exists idx_restricted_areas_gix on restricted_areas using gist (area);

-- The room's play-zone boundary as a geography polygon, built from
-- rooms.config (config.zone.boundary is an array of {lat, lng}).
-- Returns NULL when the room has no boundary (play zone off, or a
-- room created before Draw mode existed). The boundary is closed
-- explicitly (first point repeated at the end) — a GeoJSON polygon
-- ring must close.
create or replace function zone_polygon(p_room_id uuid)
returns geography(Polygon, 4326)
language sql stable as $$
  select
    case
      when (config->'zone'->'boundary') is null
        or jsonb_array_length(config->'zone'->'boundary') < 3
      then null
      else ST_SetSRID(ST_GeomFromGeoJSON(
        jsonb_build_object(
          'type', 'Polygon',
          'coordinates', jsonb_build_array(
            (select jsonb_agg(jsonb_build_array((pt->>'lng')::float, (pt->>'lat')::float) order by ord)
             from jsonb_array_elements(config->'zone'->'boundary') with ordinality as e(pt, ord))
            || jsonb_build_array(
              jsonb_build_array(
                ((config->'zone'->'boundary'->0->>'lng')::float),
                ((config->'zone'->'boundary'->0->>'lat')::float)))
          )
        )::text
      ), 4326)::geography
    end
  from rooms
  where room_id = p_room_id;
$$;

-- Authoritative point-in-zone check. The point is an argument, never
-- stored. Returns NULL when the room has no zone boundary (play zone
-- off) — the caller treats NULL as "no zone to be outside of", not
-- as "inside".
create or replace function point_in_zone(p_room_id uuid, p_lat double precision, p_lng double precision)
returns boolean
language sql stable as $$
  select
    case when zone_polygon(p_room_id) is null then null
    else ST_Contains(
      zone_polygon(p_room_id),
      ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography)
    end;
$$;

-- Authoritative restricted-area check. True when the point falls
-- inside ANY no-go area of the room. The point is an argument, never
-- stored.
create or replace function point_in_restricted_area(p_room_id uuid, p_lat double precision, p_lng double precision)
returns boolean
language sql stable as $$
  select exists (
    select 1 from restricted_areas
    where room_id = p_room_id
      and ST_Contains(area, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography)
  );
$$;

-- HNT-068 enforcement at the database layer: a room_events payload
-- must never carry raw coordinates. The validated game events
-- (packages/shared/src/events.ts) are already redacted before they
-- reach storage — this trigger is the backstop that fails loudly if
-- an unredacted payload ever arrives. Only the top level is checked:
-- nested coordinate fields inside a legit payload are the API
-- mission's problem, not this trigger's.
create or replace function reject_coordinate_payload()
returns trigger
language plpgsql as $$
begin
  if (NEW.payload ? 'lat' or NEW.payload ? 'lng'
      or NEW.payload ? 'latitude' or NEW.payload ? 'longitude') then
    raise exception 'room_events payload must not contain raw coordinates (HNT-068)';
  end if;
  return NEW;
end;
$$;
drop trigger if exists trg_reject_coordinate_payload on room_events;
create trigger trg_reject_coordinate_payload
  before insert on room_events
  for each row execute function reject_coordinate_payload();
