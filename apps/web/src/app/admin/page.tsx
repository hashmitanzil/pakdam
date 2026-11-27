'use client';

/**
 * Overview — /admin.
 *
 * Live games now, players online, rooms open, platform health
 * (Worker status, errors in the last hour, in-app counters). Every
 * number comes from GET /v1/admin/overview; nothing is invented.
 * Billing and accounts counts are shown as "—" — those sections are
 * not live yet, so no number is shown for them at all.
 */
import { getAdminOverview } from '../../lib/admin/admin-client';
import { useAdminData, useAdminNotice } from '../../lib/admin/use-admin';
import { AdminCard, AdminEmpty, AdminError, AdminLoading, AdminSectionTitle } from '../../components/admin/AdminUi';

export default function AdminOverviewPage() {
  const notice = useAdminNotice();
  const { data, loading, error, retry } = useAdminData(() => getAdminOverview());

  return (
    <>
      <div>
        <h1 className="text-[22px] font-bold text-white">Overview</h1>
        <p className="mt-1 text-[14px] text-[#A1A1AA]">What is happening on Pakdam right now.</p>
      </div>

      {notice ? (
        <p role="status" className="rounded-[14px] border border-[#26262B] bg-[#141416] px-4 py-3 text-[15px] text-white">
          {notice}
        </p>
      ) : null}

      {loading ? <AdminLoading what="the overview" /> : null}
      {error ? <AdminError message={error} onRetry={retry} /> : null}

      {data ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            <AdminCard>
              <p className="pakdam-label">Live games</p>
              <p className="pakdam-numeric mt-1 text-[28px] font-bold text-white">{data.liveGames}</p>
              <p className="text-[13px] text-[#A1A1AA]">{data.liveGames === 0 ? 'No live games' : 'Games in play now'}</p>
            </AdminCard>
            <AdminCard>
              <p className="pakdam-label">Players online</p>
              <p className="pakdam-numeric mt-1 text-[28px] font-bold text-white">{data.playersOnline}</p>
              <p className="text-[13px] text-[#A1A1AA]">Connected right now</p>
            </AdminCard>
            <AdminCard>
              <p className="pakdam-label">Rooms open</p>
              <p className="pakdam-numeric mt-1 text-[28px] font-bold text-white">{data.roomsOpen}</p>
              <p className="text-[13px] text-[#A1A1AA]">Lobbies waiting to start</p>
            </AdminCard>
            <AdminCard>
              <p className="pakdam-label">Worker status</p>
              <p className={`mt-1 text-[20px] font-bold ${data.workerOk ? 'text-[#22C55E]' : 'text-[#EF4444]'}`}>
                {data.workerOk ? 'Healthy' : 'Down'}
              </p>
              <p className="text-[13px] text-[#A1A1AA]">The game server answering now</p>
            </AdminCard>
          </div>

          <AdminCard>
            <AdminSectionTitle title="Platform health" blurb="Errors and usage, counted in the app." />
            <p className="text-[15px] text-white">
              <span className="pakdam-numeric font-bold">{data.errorsLastHour}</span> errors in the last hour
            </p>
            <p className="mt-1 text-[15px] text-white">
              {data.doMeter ? (
                <>
                  <span className="pakdam-numeric font-bold">—</span> {data.doMeter}
                </>
              ) : (
                <>
                  <span className="pakdam-numeric font-bold">{data.doRequestsToday.toLocaleString('en-IN')}</span>{' '}
                  server requests used today
                </>
              )}
            </p>
            <p className="mt-2 text-[13px] text-[#A1A1AA]">
              The Cloudflare daily cap is checked on the Cloudflare dashboard, not here — see Costs &amp; limits.
            </p>
          </AdminCard>

          <AdminCard>
            <AdminSectionTitle title="Payments & accounts" blurb="Not live yet — no numbers to show." />
            <p className="text-[15px] text-white">Revenue today: —</p>
            <p className="mt-1 text-[15px] text-white">Player accounts: —</p>
            <p className="mt-2 text-[13px] text-[#A1A1AA]">
              Billing and player accounts are future upgrades. Nothing is counted until they go live.
            </p>
          </AdminCard>

          {data.liveGames === 0 ? <AdminEmpty message="No live games" /> : null}
        </>
      ) : null}
    </>
  );
}
