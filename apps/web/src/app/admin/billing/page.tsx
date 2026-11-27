'use client';

/**
 * Payments & Billing — /admin/billing.
 *
 * Founder scope addition, 2026-11-25: "add the payments/billing…
 * the features not active will just say not available at the moment
 * / future upgrades."
 *
 * Pakdam TODAY has no payments: free to play, no billing, no
 * payment provider connected, no transactions. This page is wired
 * to the LIVE state (merge, 2026-11-27 — Meera fix 1): each section
 * reads its flag from GET /v1/admin/flags AND its endpoint, and
 * branches on both. Flag OFF → the shared NotAvailable state with
 * the fetched flag value. Flag ON → the section's real (empty)
 * content from the endpoint — and the endpoint still answers
 * `available: false` with no provider connected, so nothing here
 * can ever look live or take money. No fake numbers, no fake
 * transactions, no demo revenue. Activation later is a flag flip +
 * a provider connection, not a rebuild.
 *
 * Host Pass ₹299 one-time is shown as PLANNED — not on sale, legal
 * gate pending (v2 track scaffolding only). No sale happens before
 * the legal gate.
 *
 * Compliance, designed in now: payments go through a provider
 * (RBI token-only — no card numbers ever touch our servers;
 * PCI-DSS via the provider), GST invoices are issued per payment,
 * and billing records are kept per the GST retention rule (exact
 * rule to be confirmed by the CA — never guessed here).
 */
import {
  HOST_PASS_PLAN,
  adminFutureFlag,
  adminFutureFlagEnabled,
  type AdminFlag,
  type AdminFutureFlagKey,
} from '@pakdam/shared';
import {
  getAdminBillingOverview,
  getAdminBillingPlans,
  getAdminBillingProviders,
  getAdminBillingRefunds,
  getAdminBillingTax,
  getAdminBillingTransactions,
  listAdminFlags,
  type AdminBillingOverview,
  type AdminBillingPlans,
  type AdminBillingProviders,
  type AdminBillingRefunds,
  type AdminBillingTax,
  type AdminBillingTransactions,
} from '../../../lib/admin/admin-client';
import { useAdminData } from '../../../lib/admin/use-admin';
import {
  AdminCard,
  AdminError,
  AdminLoading,
  AdminSectionTitle,
  NotAvailable,
} from '../../../components/admin/AdminUi';

interface BillingData {
  flags: AdminFlag[];
  /** Fetched only when its flag is ON (the endpoints are inert otherwise). */
  overview: AdminBillingOverview | null;
  transactions: AdminBillingTransactions | null;
  plans: AdminBillingPlans | null;
  providers: AdminBillingProviders | null;
  refunds: AdminBillingRefunds | null;
  tax: AdminBillingTax | null;
}

/**
 * Two-stage load (fix round, 2026-11-27 — same pattern as
 * loadAccountDetail): resolve the flags FIRST, then fetch only the
 * endpoints whose flag is ON. A flag-OFF section never triggers its
 * endpoint's read — the old single Promise.all fired every billing
 * fetch before the flags resolved.
 */
async function loadBilling(): Promise<BillingData> {
  const flags = await listAdminFlags();
  const [overview, transactions, plans, providers, refunds, tax] = await Promise.all([
    adminFutureFlagEnabled(flags, 'billing.overview') ? getAdminBillingOverview() : Promise.resolve(null),
    adminFutureFlagEnabled(flags, 'billing.transactions') ? getAdminBillingTransactions() : Promise.resolve(null),
    adminFutureFlagEnabled(flags, 'billing.plans') ? getAdminBillingPlans() : Promise.resolve(null),
    adminFutureFlagEnabled(flags, 'billing.providers') ? getAdminBillingProviders() : Promise.resolve(null),
    adminFutureFlagEnabled(flags, 'billing.refunds') ? getAdminBillingRefunds() : Promise.resolve(null),
    adminFutureFlagEnabled(flags, 'billing.tax') ? getAdminBillingTax() : Promise.resolve(null),
  ]);
  return { flags, overview, transactions, plans, providers, refunds, tax };
}

/** One billing section: flag OFF → NotAvailable; flag ON → the endpoint's real content.
 * The endpoint's `available` field is the second half of the truth: ON + not-available
 * (no provider yet) renders the honest empty state + the reason; ON + available
 * renders the endpoint's real rows. Nothing is ever faked. */
function BillingSection({
  flagKey,
  title,
  blurb,
  enabled,
  available,
  reason,
  children,
}: {
  flagKey: AdminFutureFlagKey;
  title: string;
  blurb?: string;
  enabled: boolean;
  available: boolean;
  reason?: string;
  children: React.ReactNode;
}) {
  const flag = adminFutureFlag(flagKey);
  return (
    <AdminCard>
      <AdminSectionTitle title={title} blurb={blurb} />
      {enabled ? (
        <>
          {children}
          {!available && reason ? <p className="mt-2 text-[13px] leading-snug text-[#A1A1AA]">{reason}</p> : null}
        </>
      ) : (
        <NotAvailable flagKey={flag.key} willDo={flag.willDo} unlocksWhen={flag.unlocksWhen} enabled={enabled} />
      )}
    </AdminCard>
  );
}

export default function AdminBillingPage() {
  const { data, loading, error, retry } = useAdminData(() => loadBilling(), []);
  const plans = adminFutureFlag('billing.plans');
  const plansOn = data ? adminFutureFlagEnabled(data.flags, 'billing.plans') : false;

  return (
    <>
      <div>
        <h1 className="text-[22px] font-bold text-white">Payments &amp; billing</h1>
        <p className="mt-1 text-[14px] text-[#A1A1AA]">
          Pakdam is free to play today. Billing is built as a future upgrade — nothing here takes money yet.
        </p>
      </div>

      {loading ? <AdminLoading what="billing" /> : null}
      {error ? <AdminError message={error} onRetry={retry} /> : null}

      {data ? (
        <>
          <BillingSection
            flagKey="billing.overview"
            title="Overview"
            enabled={adminFutureFlagEnabled(data.flags, 'billing.overview')}
            available={data.overview?.available ?? false}
            reason={data.overview?.reason}
          >
            <p className="text-[14px] text-[#A1A1AA]">No revenue yet — no payments have been taken.</p>
            {data.overview?.note ? (
              <p className="mt-1 text-[13px] text-[#A1A1AA]">{data.overview.note}</p>
            ) : null}
          </BillingSection>

          <BillingSection
            flagKey="billing.transactions"
            title="Transactions"
            enabled={adminFutureFlagEnabled(data.flags, 'billing.transactions')}
            available={data.transactions?.available ?? false}
            reason={data.transactions?.reason}
          >
            <p className="text-[14px] text-[#A1A1AA]">No transactions yet — none exist.</p>
          </BillingSection>

          <AdminCard>
            <AdminSectionTitle title="Plans & passes" blurb="What players will be able to buy, when billing goes live." />
            <div className="rounded-[14px] border border-[#26262B] bg-[#1E1E22] p-4">
              <p className="text-[17px] font-bold text-white">{HOST_PASS_PLAN.name}</p>
              <p className="mt-1 text-[15px] text-white">
                {HOST_PASS_PLAN.priceLabel} · {HOST_PASS_PLAN.billing}
              </p>
              <p className="mt-1 text-[14px] font-semibold text-[#F59E0B]">{HOST_PASS_PLAN.statusCopy}</p>
              <p className="mt-1 text-[13px] leading-snug text-[#A1A1AA]">
                Host Pass lets one player host unlimited games. It is planned only — it is not on sale, and no money is
                taken until the legal gate passes.
              </p>
            </div>
            <div className="mt-3">
              {plansOn ? (
                <p className="text-[13px] leading-snug text-[#A1A1AA]">
                  {data.plans?.reason ?? 'One plan is planned. It is not on sale.'}
                </p>
              ) : (
                <NotAvailable flagKey={plans.key} willDo={plans.willDo} unlocksWhen={plans.unlocksWhen} enabled={plansOn} />
              )}
            </div>
          </AdminCard>

          <BillingSection
            flagKey="billing.providers"
            title="Payment providers & methods"
            enabled={adminFutureFlagEnabled(data.flags, 'billing.providers')}
            available={data.providers?.available ?? false}
            reason={data.providers?.reason}
          >
            <p className="text-[14px] text-[#A1A1AA]">No payment provider is connected.</p>
            {data.providers?.note ? (
              <p className="mt-1 text-[13px] text-[#A1A1AA]">{data.providers.note}</p>
            ) : null}
          </BillingSection>

          <BillingSection
            flagKey="billing.refunds"
            title="Refunds"
            enabled={adminFutureFlagEnabled(data.flags, 'billing.refunds')}
            available={data.refunds?.available ?? false}
            reason={data.refunds?.reason}
          >
            <p className="text-[14px] text-[#A1A1AA]">No refunds — none exist.</p>
          </BillingSection>

          <BillingSection
            flagKey="billing.tax"
            title="Tax & payouts"
            enabled={adminFutureFlagEnabled(data.flags, 'billing.tax')}
            available={data.tax?.available ?? false}
            reason={data.tax?.reason}
          >
            <p className="text-[14px] text-[#A1A1AA]">No invoices yet — GST invoicing starts with the first sale.</p>
            {data.tax?.note ? <p className="mt-1 text-[13px] text-[#A1A1AA]">{data.tax.note}</p> : null}
          </BillingSection>
        </>
      ) : null}

      <AdminCard>
        <AdminSectionTitle title="How billing will stay compliant" blurb="Designed in now, verified before any sale." />
        <p className="text-[14px] leading-snug text-[#A1A1AA]">
          Payments go through a payment provider — card numbers never touch Pakdam&apos;s servers (RBI token-only, PCI-DSS
          via the provider). Every payment gets a GST invoice. Billing records are kept per the GST retention rule —
          the exact rule is confirmed by the CA before the first sale, never guessed.
        </p>
      </AdminCard>
    </>
  );
}
