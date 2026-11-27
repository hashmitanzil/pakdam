-- Pakdam — 0010_admin_billing (Payments & Billing + Accounts design)
--
-- WRITTEN, NOT APPLIED. Schema as DESIGN, not as a live feature.
-- Pakdam TODAY has no payments (free, no provider connected) and no
-- user accounts (guest-only). These tables are created EMPTY and
-- stay empty until a billing flag flips AND a payment provider is
-- connected AND the legal gate clears. No provider SDK, no keys, no
-- charges exist in this codebase; nothing in the Worker writes to
-- these tables today (the billing endpoints return the not-available
-- shape). Do NOT backfill fake rows into them.
--
-- Design notes (for the merge with the v2 track):
-- - plans.price_paise is the money unit (paise, integer — never
--   float). The one planned plan is Host Pass, ₹299 one-time
--   (HOST_PASS_PLAN in packages/shared/src/admin.ts; the v2 constant
--   HOST_PASS_PRICE_INR = 299 is the source of truth at merge).
-- - transactions store a PROVIDER reference + status, never card
--   data: no card number, no CVV, no expiry, no cardholder name —
--   card handling is the provider's job (PCI-DSS via the provider;
--   RBI card token-only: our servers never see a card number).
--   provider_payment_id is the provider's id, not ours.
-- - amounts are integer paise; currency is always 'INR' for now.
-- - refunds reference a transaction; payouts/invoices are the
--   settlement + GST paperwork tables. GST record-retention: the
--   exact period is CA-VERIFICATION PENDING — it is NOT stated here
--   (see docs/admin-console.md); do not guess a year count.
-- - data_requests is the DPDP data-principal request flow
--   (access / correction / erasure). No live intake exists yet —
--   the accounts.dataRequests flag is OFF and no endpoint writes
--   here. When intake lands, requests carry a contact reference
--   only (no password, no raw identity documents).
-- - There is deliberately NO player_accounts table: player accounts
--   do not exist yet. The users-directory reads the guest `players`
--   table. When the v2 login feature lands, accounts plug in here
--   as a new migration — not by repurposing these tables.

-- Planned / future plans (Host Pass lives here when it goes on sale).
create table if not exists public.billing_plans (
  id           text primary key,
  name         text not null,
  price_paise  integer not null check (price_paise >= 0),
  currency     text not null default 'INR',
  billing      text not null default 'one-time' check (billing in ('one-time', 'subscription')),
  status       text not null default 'planned' check (status in ('planned', 'on-sale', 'retired')),
  created_at   timestamptz not null default now()
);

-- Payment transactions (empty until the first real sale).
create table if not exists public.billing_transactions (
  id                  uuid primary key default gen_random_uuid(),
  plan_id             text references public.billing_plans (id),
  player_id           uuid,
  amount_paise        integer not null check (amount_paise >= 0),
  currency            text not null default 'INR',
  status              text not null default 'pending' check (status in ('pending', 'succeeded', 'failed', 'refunded')),
  provider            text,
  provider_payment_id text,
  created_at          timestamptz not null default now()
);

create index if not exists billing_transactions_player_idx
  on public.billing_transactions (player_id);

-- Refunds (empty until the first real refund).
create table if not exists public.billing_refunds (
  id             uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.billing_transactions (id),
  amount_paise   integer not null check (amount_paise >= 0),
  reason         text,
  status         text not null default 'requested' check (status in ('requested', 'approved', 'rejected', 'completed')),
  created_at     timestamptz not null default now()
);

-- Settlement payouts to the platform owner (empty until payouts exist).
create table if not exists public.billing_payouts (
  id           uuid primary key default gen_random_uuid(),
  amount_paise integer not null check (amount_paise >= 0),
  currency     text not null default 'INR',
  status       text not null default 'pending' check (status in ('pending', 'paid', 'failed')),
  created_at   timestamptz not null default now()
);

-- GST invoices (empty until the first sale; retention CA-pending).
create table if not exists public.billing_invoices (
  id             uuid primary key default gen_random_uuid(),
  transaction_id uuid references public.billing_transactions (id),
  invoice_number text,
  amount_paise   integer not null check (amount_paise >= 0),
  gst_paise      integer not null default 0 check (gst_paise >= 0),
  created_at     timestamptz not null default now()
);

-- DPDP data-principal requests (access / correction / erasure).
-- No live intake yet — flag accounts.dataRequests is OFF.
create table if not exists public.data_requests (
  id           uuid primary key default gen_random_uuid(),
  player_id    uuid,
  kind         text not null check (kind in ('access', 'correction', 'erasure')),
  contact_ref  text,
  status       text not null default 'received' check (status in ('received', 'in-progress', 'completed', 'rejected')),
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz
);

create index if not exists data_requests_player_idx
  on public.data_requests (player_id);
