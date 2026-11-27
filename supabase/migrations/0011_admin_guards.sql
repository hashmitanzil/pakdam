-- Pakdam — 0011_admin_guards (Admin Console fix round, 2026-11-25)
--
-- WRITTEN, NOT APPLIED. The founder applies it (Supabase SQL editor
-- or `supabase db push`) after 0009 + 0010. Until it lands, the
-- Worker code that depends on it degrades HONESTLY, never silently:
--   * admin_setup_owner RPC missing → setup answers 503 (not a
--     silent second Owner).
--   * admin_login_attempts missing → logins still work (the pair
--     lockout reads return no rows) but per-pair lockout cannot arm;
--     the HTTP per-IP login limiter is the backstop until then.
--   * must_change_password missing → Owner-created accounts simply
--     carry no rotation flag (the column defaults to false).
--
-- What this migration is FOR (Zara B1/B2/B3, fix round):
--   1. TOCTOU on first setup: two concurrent POST /v1/admin/auth/setup
--      calls used to both read "zero admins" and both insert an Owner.
--      The fix is DB-level, not check-then-act: admin_setup_owner()
--      takes a transaction-scoped advisory lock, checks, and inserts
--      inside one function call. Concurrent callers serialize; the
--      loser gets {"ok": false, "error": "already_setup"}.
--   2. TOCTOU on the last Owner: two concurrent demotes/disables/
--      deletes of the last two Owners used to both read "two owners"
--      and both proceed. The fix is DB-level: the
--      admin_users_last_owner_guard trigger raises before ANY
--      UPDATE/DELETE that would leave zero ENABLED Owners. The
--      trigger itself takes an advisory lock first, so two concurrent
--      guard checks serialize (plain READ COMMITTED would let both
--      see two owners and both pass). The Worker's pre-check gives
--      the friendly 409; the trigger is the guarantee.
--   3. Per-(account + IP) login lockout (B2): admin_login_attempts
--      keyed by (username, ip_hash). There is NO account-level lock
--      any more — an attacker from arbitrary IPs can never lock the
--      Owner out of their own IP. The old admin_users.failed_attempts
--      / locked_until columns are dropped (they were the vulnerable
--      mechanism). IPs are stored as SHA-256 hashes only, never raw.
--   4. First-login rotation (n6): admin_users.must_change_password.
--      Owner-created accounts start true; a password change clears it.

-- 4. First-login rotation flag.
alter table if exists public.admin_users
  add column if not exists must_change_password boolean not null default false;

-- 3. Drop the account-level lockout columns (replaced by the
-- per-(account + IP) table below). If 0009 was never applied these
-- are no-ops (if exists).
alter table if exists public.admin_users
  drop column if exists failed_attempts,
  drop column if exists locked_until;

-- 3. Per-(account + IP) login attempts. username is the login key
-- (usernames are unique; there is no rename path). ip_hash is the
-- SHA-256 of CF-Connecting-IP — never a raw IP. A row is created on
-- the first failure for a pair and deleted on a successful login
-- from that pair. locked_until arms after 5 failures (15 min).
create table if not exists public.admin_login_attempts (
  id              uuid primary key default gen_random_uuid(),
  username        text not null,
  ip_hash         text not null,
  failed_attempts integer not null default 0,
  locked_until    timestamptz,
  updated_at      timestamptz not null default now(),
  unique (username, ip_hash)
);

create index if not exists admin_login_attempts_ip_hash_idx
  on public.admin_login_attempts (ip_hash);

-- 1. Atomic first-Owner setup. Called via PostgREST
-- POST /rest/v1/rpc/admin_setup_owner with {p_username,
-- p_password_hash}. Returns {"ok": true, "id": "<uuid>"} or
-- {"ok": false, "error": "already_setup"} — never raises, so the
-- Worker can tell "already set up" (409) from "storage down" (503).
-- Advisory key 727271 is arbitrary and fixed; it only has to be
-- unique among the advisory locks this project uses (727272 is the
-- last-Owner guard below).
create or replace function public.admin_setup_owner(
  p_username text,
  p_password_hash text
) returns jsonb
language plpgsql
as $$
declare
  new_id uuid;
begin
  -- Transaction-scoped: held until this call commits/rolls back,
  -- so concurrent setup calls serialize on it.
  perform pg_advisory_xact_lock(727271);
  if exists (select 1 from public.admin_users) then
    return jsonb_build_object('ok', false, 'error', 'already_setup');
  end if;
  insert into public.admin_users
    (username, role, password_hash, disabled, must_change_password)
    values (p_username, 'owner', p_password_hash, false, false)
    returning id into new_id;
  return jsonb_build_object('ok', true, 'id', new_id);
end;
$$;

-- 2. Last-Enabled-Owner guard. Fires on every UPDATE/DELETE of an
-- admin_users row, but only blocks when the operation would leave
-- ZERO enabled Owners: deleting an enabled Owner, demoting one
-- (role away from 'owner'), or disabling one. Ordinary updates
-- (last_login_at, password change, role changes among non-owners)
-- pass straight through. The advisory lock (key 727272) serializes
-- concurrent guard checks — without it, two concurrent demotes of
-- the last two Owners would both read "two owners" and both pass.
create or replace function public.admin_guard_last_owner()
returns trigger
language plpgsql
as $$
declare
  remaining integer;
begin
  -- Only rows that stop being an enabled Owner can violate the rule.
  if tg_op = 'DELETE' then
    if old.role <> 'owner' or old.disabled = true then
      return old;
    end if;
  elsif old.role <> 'owner' or old.disabled = true
        or (new.role = 'owner' and new.disabled = false) then
    return new;
  end if;
  perform pg_advisory_xact_lock(727272);
  select count(*) into remaining
    from public.admin_users
    where role = 'owner' and disabled = false and id <> old.id;
  if remaining = 0 then
    raise exception 'last_owner: the last enabled Owner cannot be demoted, disabled or deleted'
      using errcode = 'check_violation';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists admin_users_last_owner_guard on public.admin_users;
create trigger admin_users_last_owner_guard
  before update or delete on public.admin_users
  for each row execute function public.admin_guard_last_owner();
