'use client';

/**
 * Numbers — /admin/numbers.
 *
 * Games played, players, peak concurrency, average game length,
 * catch rate. Simple counts only — no vanity charts, no invented
 * figures. Billing and account numbers are not shown: those
 * sections are not live yet.
 */
import { getAdminMetrics } from '../../../lib/admin/admin-client';
import { useAdminData } from '../../../lib/admin/use-admin';
import { AdminCard, AdminError, AdminLoading, AdminRow } from '../../../components/admin/AdminUi';

export default function AdminNumbersPage() {
  const { data, loading, error, retry } = useAdminData(() => getAdminMetrics());

  return (
    <>
      <div>
        <h1 className="text-[22px] font-bold text-white">Numbers</h1>
        <p className="mt-1 text-[14px] text-[#A1A1AA]">Simple counts. Nothing here is a guess.</p>
      </div>

      {loading ? <AdminLoading what="numbers" /> : null}
      {error ? <AdminError message={error} onRetry={retry} /> : null}

      {data ? (
        <AdminCard>
          <AdminRow label="Games played" value={String(data.gamesPlayed)} />
          <AdminRow label="Players (all time)" value={String(data.totalPlayers)} />
          <AdminRow label="Peak players at once" value={String(data.peakConcurrency)} />
          {data.peakConcurrencyNote ? (
            <p className="mt-1 text-[13px] text-[#A1A1AA]">{data.peakConcurrencyNote}</p>
          ) : null}
          <AdminRow
            label="Average game length"
            value={data.averageGameLengthMinutes !== null ? `${Math.round(data.averageGameLengthMinutes)} min` : '—'}
          />
          <AdminRow
            label="Catch rate"
            value={data.catchRate !== null ? `${Math.round(data.catchRate * 100)}%` : '—'}
          />
          <AdminRow label="Revenue" value="—" />
          <AdminRow label="Player accounts" value="—" />
          <p className="mt-2 text-[13px] text-[#A1A1AA]">
            Revenue and player accounts show “—” until billing and accounts go live. No number is shown before it exists.
          </p>
        </AdminCard>
      ) : null}
    </>
  );
}
