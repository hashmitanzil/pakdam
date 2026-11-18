# Canonical schema (v2.1 Issue 6 — one schema, decided here)

Base: Pack v2 file 25. Added: `profiles` (host accounts, from file 03).
Folded: `room_participants`→`players`, `match_events`→`room_events`,
`match_results`→`rooms.result`, `catch_attempts`→`catches`,
`support_tickets`→`bug_reports` + `grievances`. Deferred: `saved_arenas` (P1).
Tables: profiles, players, rooms, room_events, catches, safety_events,
bug_reports, grievances, audit_log, telemetry_daily.
No table stores raw coordinates — ever (HNT-068).
Host/role (Issue 7): `players.is_host` (permission) is separate from
`players.match_role` ('hunter'|'runner'|NULL). A host can be a Hunter/Runner.
