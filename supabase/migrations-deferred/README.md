# Deferred migrations — DO NOT apply

Files in this directory are WRITTEN but HELD: they must NOT be applied
to any database until the blocker named in each file's header closes.

## 0002_rls.sql — HELD until the auth method decision lands (OD-022)

Founder decision (2026-11-17): the deploy migration set is 0001 +
0003 (+0004 PostGIS). 0002 RLS is SKIPPED until auth closes.

Why it is here, not in `supabase/migrations/`: the file used to sit
in `migrations/` with a "DO NOT APPLY LIVE" header — but `supabase
db push` applies everything in that directory in filename order, so a
blind push would have applied it anyway. Moving it here makes the skip
structural: the deploy set is exactly what is in `migrations/`.

Why it is held (from the file header): the policies assume Supabase
Auth issues JWTs and a seat's `profile_id` is the JWT subject, but the
method is OPEN (OD-022), and guest seats have `players.profile_id`
NULL, so guests "can NEVER satisfy any policy below" and "have no
working participant read path through RLS at all." Applying it now is
fail-closed and safe, but it is not a working participant read path.

Re-apply order when OD-022 closes: move this file back to
`supabase/migrations/0002_rls.sql`, then apply in filename order
(0001, 0002, 0003, 0004) on a fresh project — or apply it alone on a
project that already has 0001 + 0003 + 0004, then verify it against
the live database (the file was never syntax-checked against a live
Postgres). The API/auth mission must close OD-022 first (define a
guest identity path — e.g. a guest profile created at join, or a
signed seat claim).
