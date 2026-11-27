'use client';

/**
 * Audit log — /admin/audit.
 *
 * Every panel action: who, what, when, target. Readable list,
 * newest first. Audit entries are kept for 180 days — that
 * retention is stated on the page (game logs are 7 days; admin
 * audit is 180 days).
 */
import { listAdminAudit } from '../../../lib/admin/admin-client';
import { useAdminData } from '../../../lib/admin/use-admin';
import { AdminCard, AdminEmpty, AdminError, AdminLoading } from '../../../components/admin/AdminUi';

export default function AdminAuditPage() {
  const { data, loading, error, retry } = useAdminData(() => listAdminAudit());

  return (
    <>
      <div>
        <h1 className="text-[22px] font-bold text-white">Audit log</h1>
        <p className="mt-1 text-[14px] text-[#A1A1AA]">
          Every action in this panel — who did what, when, and to what. Kept for 180 days.
        </p>
      </div>

      {loading ? <AdminLoading what="the audit log" /> : null}
      {error ? <AdminError message={error} onRetry={retry} /> : null}
      {data && data.length === 0 ? <AdminEmpty message="No actions recorded yet." /> : null}

      {data ? (
        <AdminCard>
          {data.map((entry) => (
            <div key={entry.id} className="border-b border-[#26262B] py-2 last:border-b-0">
              <p className="text-[15px] font-semibold text-white">{entry.action}</p>
              {entry.detail ? <p className="text-[14px] text-[#A1A1AA]">{entry.detail}</p> : null}
              <p className="text-[14px] text-[#A1A1AA]">
                by {entry.actor}
                {entry.target ? ` · ${entry.target}` : ''}
              </p>
              <p className="mt-0.5 text-[13px] text-[#A1A1AA]">{new Date(entry.createdAt).toLocaleString('en-IN')}</p>
            </div>
          ))}
        </AdminCard>
      ) : null}

      <p className="text-[13px] leading-snug text-[#A1A1AA]">
        Retention: audit entries are kept for 180 days, then deleted. Game logs are kept for 7 days. Live locations are
        never written to this log — only that a location was viewed, never the coordinates.
      </p>
    </>
  );
}
