-- 0002_rls.sql — Row Level Security policies (fail-closed).
--
-- STATUS: WRITTEN, NOT YET ACTIVE. Do NOT apply to a live database until
-- the auth method decision lands (14 OD-022).
--
-- What these policies assume (grounded, not invented): the architecture
-- (02 §2) names Supabase Auth as the pilot auth candidate, and the
-- canonical schema links a seat to an account via players.profile_id.
-- The policies below key every read to auth.uid() = profiles.profile_id —
-- i.e. they assume Supabase Auth issues JWTs and a seat's profile_id is
-- the JWT subject. That mechanism is the architecture's candidate; the
-- METHOD by which a host or guest obtains that JWT (magic link, OTP,
-- password, or something else) is still OPEN (OD-022), and no JWT can be
-- issued until it is decided.
--
-- EXACT BLOCKER: guest seats have players.profile_id NULL (guests have no
-- account in P0) and therefore can NEVER satisfy any policy below. Until
-- the auth mission defines an identity path for guests (e.g. a guest
-- profile created at join, or a signed seat claim), guests have no
-- working participant read path through RLS at all. That is why this
-- file must not be applied live yet: applying it now would deny every
-- guest read, which is fail-closed and safe, but it is not a working
-- participant read path. The API/auth mission must close OD-022 first,
-- then apply this file and verify it against a live database.
--
-- Design (fail-closed throughout):
-- * No INSERT / UPDATE / DELETE policy exists for anon or authenticated.
--   All writes go through the service role (Worker / Durable Object),
--   which bypasses RLS. Clients never write these tables directly.
-- * No table stores raw coordinates, so RLS cannot leak them (HNT-068).
-- * audit_log, telemetry_daily, grievances: no participant read at all.
--   grievances carry only a pseudonymised complainant_ref with no player
--   link, so no authenticated caller can ever be matched to a row.
-- * This file was NOT syntax-checked against a live Postgres (no psql in
--   this environment). Validate with `supabase db push --dry-run` or psql
--   before applying; do not apply on the basis of this file alone.

alter table rooms enable row level security;
alter table players enable row level security;
alter table room_events enable row level security;
alter table catches enable row level security;
alter table safety_events enable row level security;
alter table bug_reports enable row level security;
alter table grievances enable row level security;
alter table audit_log enable row level security;
alter table profiles enable row level security;
alter table telemetry_daily enable row level security;

-- profiles: a caller reads/updates only their own profile row.
create policy profiles_own_row_select on profiles
  for select to authenticated
  using (auth.uid() = profile_id);
create policy profiles_own_row_update on profiles
  for update to authenticated
  using (auth.uid() = profile_id)
  with check (auth.uid() = profile_id);

-- rooms: readable only by a participant of that room (linked profile).
create policy rooms_participant_select on rooms
  for select to authenticated
  using (exists (
    select 1 from players
    where players.room_id = rooms.room_id
      and players.profile_id = auth.uid()
  ));

-- players: a seat reads its own row; a host reads every seat in their room.
create policy players_self_or_host_select on players
  for select to authenticated
  using (
    players.profile_id = auth.uid()
    or exists (
      select 1 from players h
      where h.room_id = players.room_id
        and h.profile_id = auth.uid()
        and h.is_host
    )
  );

-- room_events: readable only by a participant of that room. Payloads must
-- never contain coordinates (enforced upstream in the engine/DO, HNT-120).
create policy room_events_participant_select on room_events
  for select to authenticated
  using (exists (
    select 1 from players
    where players.room_id = room_events.room_id
      and players.profile_id = auth.uid()
  ));

-- catches: readable by the Hunter, the Runner, or the host of the room.
-- qr_token_hash is never in a client payload (17 §3.3); the column is
-- readable here only because the Worker reads it via service role.
create policy catches_party_or_host_select on catches
  for select to authenticated
  using (
    exists (
      select 1 from players
      where players.player_id in (catches.hunter_id, catches.runner_id)
        and players.profile_id = auth.uid()
    )
    or exists (
      select 1 from players h
      where h.room_id = catches.room_id
        and h.profile_id = auth.uid()
        and h.is_host
    )
  );

-- safety_events: readable by the player it concerns, or the host.
create policy safety_events_self_or_host_select on safety_events
  for select to authenticated
  using (
    exists (
      select 1 from players
      where players.player_id = safety_events.player_id
        and players.profile_id = auth.uid()
    )
    or exists (
      select 1 from players h
      where h.room_id = safety_events.room_id
        and h.profile_id = auth.uid()
        and h.is_host
    )
  );

-- bug_reports: readable by the reporter, or the host of the room.
create policy bug_reports_reporter_or_host_select on bug_reports
  for select to authenticated
  using (
    exists (
      select 1 from players
      where players.player_id = bug_reports.player_id
        and players.profile_id = auth.uid()
    )
    or (bug_reports.room_id is not null and exists (
      select 1 from players h
      where h.room_id = bug_reports.room_id
        and h.profile_id = auth.uid()
        and h.is_host
    ))
  );

-- grievances: NO participant policy (see header). Deliberate fail-closed:
-- complainant_ref cannot be matched to an authenticated caller.
create policy grievances_no_participant_select on grievances
  for select to authenticated
  using (false);

-- audit_log: NO participant policy. Service role only, with audit logging
-- at the application layer. Explicit deny so the intent is readable.
create policy audit_log_no_participant_select on audit_log
  for select to authenticated
  using (false);

-- telemetry_daily: NO participant policy. Aggregates only, service role.
create policy telemetry_daily_no_participant_select on telemetry_daily
  for select to authenticated
  using (false);
