'use client';

/**
 * Costs & limits — /admin/costs.
 *
 * DO requests used today (in-app counters), DB rows, alert state
 * before the 90% cap. Said honestly on the page: the Cloudflare
 * daily cap itself is checked on the Cloudflare dashboard — this
 * panel does NOT invent a meter for it. The in-app counter is
 * compared against the cap the server reports; if the server has
 * no cap figure, the page says so instead of guessing.
 */
import { adminCapAlertState, ADMIN_UNKNOWN_METER_COPY } from '@pakdam/shared';
import { getAdminMetrics } from '../../../lib/admin/admin-client';
import { useAdminData } from '../../../lib/admin/use-admin';
import { AdminCard, AdminError, AdminLoading, AdminRow, AdminSectionTitle } from '../../../components/admin/AdminUi';

export default function AdminCostsPage() {
  const { data, loading, error, retry } = useAdminData(() => getAdminMetrics());

  const alert = data ? adminCapAlertState(data.doRequestsToday, data.dailyCap) : 'ok';

  return (
    <>
      <div>
        <h1 className="text-[22px] font-bold text-white">Costs &amp; limits</h1>
        <p className="mt-1 text-[14px] text-[#A1A1AA]">Usage against the daily limits. Counts come from the app itself.</p>
      </div>

      {loading ? <AdminLoading what="costs" /> : null}
      {error ? <AdminError message={error} onRetry={retry} /> : null}

      {data ? (
        <>
          <AdminCard>
            <AdminSectionTitle title="Server requests today" blurb="The Worker cannot measure this — see below." />
            {data.doMeter ? (
              <>
                <p className="pakdam-numeric text-[28px] font-bold text-white">—</p>
                <p role="status" className="mt-1 text-[15px] font-semibold text-white">
                  {ADMIN_UNKNOWN_METER_COPY}.
                </p>
                <p className="mt-1 text-[14px] text-[#A1A1AA]">{data.doMeter}</p>
              </>
            ) : (
              <>
                <p className="pakdam-numeric text-[28px] font-bold text-white">
                  {data.doRequestsToday.toLocaleString('en-IN')}
                </p>
                <p className="mt-1 text-[14px] text-[#A1A1AA]">
                  {data.dailyCap > 0
                    ? `Daily cap: ${data.dailyCap.toLocaleString('en-IN')} requests`
                    : 'No daily cap figure reported by the server.'}
                </p>
                {data.dailyCap > 0 ? (
                  <p
                    role="status"
                    className={`mt-2 text-[15px] font-semibold ${
                      alert === 'near-cap' ? 'text-[#EF4444]' : alert === 'watch' ? 'text-[#F59E0B]' : 'text-[#22C55E]'
                    }`}
                  >
                    {alert === 'near-cap'
                      ? 'Near the cap — over 90% used. Check the Cloudflare dashboard now.'
                      : alert === 'watch'
                        ? 'Getting close — over 75% used.'
                        : 'Within limits.'}
                  </p>
                ) : null}
              </>
            )}
            <p className="mt-2 text-[13px] leading-snug text-[#A1A1AA]">
              The Cloudflare daily cap is checked on the Cloudflare dashboard. This panel never shows a green
              “within limits” state from a meter it cannot measure.
            </p>
          </AdminCard>

          <AdminCard>
            <AdminSectionTitle title="Database" blurb="Rows stored, by table." />
            <AdminRow label="Rooms" value={String(data.dbRows.rooms)} />
            <AdminRow label="Players" value={String(data.dbRows.players)} />
            <AdminRow label="Audit entries" value={String(data.dbRows.audit)} />
          </AdminCard>
        </>
      ) : null}
    </>
  );
}
