'use client';

/**
 * Safety — /admin/safety.
 *
 * Reports/flags list, blocked seats (with Unblock), abuse log
 * (fake-GPS flags, token reuse, spam). Staff can create a
 * flag/report from here; Staff cannot kick, end or configure
 * (those live on their own pages). Unblocking a seat is
 * Owner/Admin only, behind the two-tap confirm.
 *
 * HONESTY (fix round, Zara M5 + Diya §4): a block binds to the
 * seat's stored sign-in (reconnect-token hash) only — it is not a
 * device or person ban. A player on a fresh device can rejoin.
 * The copy on this page says so; nothing here implies a device
 * or a person is fully blocked.
 */
import { useState, type FormEvent } from 'react';
import { ADMIN_BAN_HONEST_COPY, ADMIN_DENIED_MESSAGE, adminCan } from '@pakdam/shared';
import {
  AdminApiError,
  createSafetyBlock,
  createSafetyFlag,
  deleteSafetyBlock,
  getAdminSafety,
} from '../../../lib/admin/admin-client';
import { readAdminSession } from '../../../lib/admin/admin-session';
import { useAdminData } from '../../../lib/admin/use-admin';
import {
  AdminCard,
  AdminDenied,
  AdminEmpty,
  AdminError,
  AdminLoading,
  AdminSectionTitle,
  ConfirmAction,
} from '../../../components/admin/AdminUi';

export default function AdminSafetyPage() {
  const session = readAdminSession();
  const role = session?.role ?? null;
  const canCreateFlag = adminCan(role, 'safety.createFlag');
  const canUnblock = adminCan(role, 'safety.unblock');
  const { data, loading, error, retry } = useAdminData(() => getAdminSafety());
  const [kind, setKind] = useState('');
  const [detail, setDetail] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [formDone, setFormDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submitFlag = async (event: FormEvent) => {
    event.preventDefault();
    if (!kind.trim() || !detail.trim()) {
      setFormError('Say what happened — a short kind and a line of detail.');
      return;
    }
    setBusy(true);
    setFormError(null);
    setFormDone(null);
    try {
      await createSafetyFlag(kind.trim(), detail.trim());
      setFormDone('Report saved. It is in the list below.');
      setKind('');
      setDetail('');
      retry();
    } catch (err) {
      setFormError(err instanceof AdminApiError ? err.message : 'Something went wrong — try again.');
    } finally {
      setBusy(false);
    }
  };

  const unblock = async (deviceId: string) => {
    try {
      await deleteSafetyBlock(deviceId);
      setFormDone('Seat unblocked. Its stored sign-in can join games again.');
      retry();
    } catch (err) {
      setFormError(err instanceof AdminApiError ? err.message : 'Something went wrong — try again.');
    }
  };

  const block = async (deviceId: string, reason: string) => {
    try {
      await createSafetyBlock(deviceId, reason);
      setFormDone('Seat blocked.');
      retry();
    } catch (err) {
      setFormError(err instanceof AdminApiError ? err.message : 'Something went wrong — try again.');
    }
  };

  return (
    <>
      <div>
        <h1 className="text-[22px] font-bold text-white">Safety</h1>
        <p className="mt-1 text-[14px] text-[#A1A1AA]">Reports, blocked seats and abuse flags. Staff can report; only Owner and Admin can unblock.</p>
      </div>

      {loading ? <AdminLoading what="safety" /> : null}
      {error ? <AdminError message={error} onRetry={retry} /> : null}
      {formError ? (
        <p role="alert" className="rounded-[14px] border border-[#EF4444]/50 bg-[#141416] px-4 py-3 text-[15px] text-white">
          {formError}
        </p>
      ) : null}
      {formDone ? (
        <p role="status" className="rounded-[14px] border border-[#22C55E]/50 bg-[#141416] px-4 py-3 text-[15px] text-white">
          {formDone}
        </p>
      ) : null}

      {canCreateFlag ? (
        <AdminCard>
          <AdminSectionTitle title="Report something" blurb="A flag or a report goes to the list below." />
          <form onSubmit={submitFlag} className="flex flex-col gap-3" noValidate>
            <label className="block">
              <span className="pakdam-label">Kind</span>
              <input
                type="text"
                value={kind}
                onChange={(e) => setKind(e.target.value)}
                placeholder="e.g. fake GPS, spam, abuse"
                className="mt-1 w-full rounded-[14px] border border-[#26262B] bg-[#141416] px-4 text-[15px] text-white placeholder:text-[#A1A1AA]"
              />
            </label>
            <label className="block">
              <span className="pakdam-label">What happened</span>
              <input
                type="text"
                value={detail}
                onChange={(e) => setDetail(e.target.value)}
                placeholder="One line — room code and codename help"
                className="mt-1 w-full rounded-[14px] border border-[#26262B] bg-[#141416] px-4 text-[15px] text-white placeholder:text-[#A1A1AA]"
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="h-12 w-full rounded-[14px] bg-[#EF4444] text-[15px] font-bold text-white active:bg-[#DC2626] disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save report'}
            </button>
          </form>
        </AdminCard>
      ) : (
        <AdminDenied message={ADMIN_DENIED_MESSAGE} />
      )}

      {data ? (
        <>
          <AdminCard>
            <AdminSectionTitle title="Reports & flags" blurb="Newest first." />
            {data.reports.length === 0 ? (
              <AdminEmpty message="No reports yet." />
            ) : (
              data.reports.map((r) => (
                <div key={r.id} className="border-b border-[#26262B] py-2 last:border-b-0">
                  <p className="text-[15px] font-semibold text-white">{r.kind}</p>
                  <p className="text-[14px] text-[#A1A1AA]">{r.detail}</p>
                  <p className="mt-0.5 text-[13px] text-[#A1A1AA]">
                    {new Date(r.createdAt).toLocaleString('en-IN')}
                    {r.createdBy ? ` · by ${r.createdBy}` : ''}
                  </p>
                </div>
              ))
            )}
          </AdminCard>

          <AdminCard>
            <AdminSectionTitle title="Blocked seats" blurb="A block binds to a seat's stored sign-in only — a fresh device can rejoin." />
            {data.blockedDevices.length === 0 ? (
              <AdminEmpty message="No seats blocked." />
            ) : (
              data.blockedDevices.map((d) => (
                <div key={d.deviceId} className="border-b border-[#26262B] py-3 last:border-b-0">
                  <p className="text-[15px] font-semibold text-white">{d.deviceId}</p>
                  <p className="text-[14px] text-[#A1A1AA]">{d.reason}</p>
                  <p className="mt-0.5 text-[13px] text-[#A1A1AA]">
                    Blocked {new Date(d.blockedAt).toLocaleString('en-IN')}
                    {d.blockedBy ? ` · by ${d.blockedBy}` : ''}
                  </p>
                  {canUnblock ? (
                    <div className="mt-2">
                      <ConfirmAction
                        label="Unblock seat"
                        confirmLabel="Tap again to unblock"
                        consequence="Lets this seat's stored sign-in join games again."
                        onConfirm={() => unblock(d.deviceId)}
                        danger={false}
                      />
                    </div>
                  ) : (
                    <AdminDenied message={ADMIN_DENIED_MESSAGE} />
                  )}
                </div>
              ))
            )}
          </AdminCard>

          <AdminCard>
            <AdminSectionTitle title="Abuse log" blurb="Fake-GPS flags, token reuse, spam — automatic entries." />
            {data.abuseLog.length === 0 ? (
              <AdminEmpty message="No abuse flags yet." />
            ) : (
              data.abuseLog.map((a) => (
                <div key={a.id} className="border-b border-[#26262B] py-2 last:border-b-0">
                  <p className="text-[15px] font-semibold text-white">{a.kind}</p>
                  <p className="text-[14px] text-[#A1A1AA]">{a.detail}</p>
                  <p className="mt-0.5 text-[13px] text-[#A1A1AA]">{new Date(a.createdAt).toLocaleString('en-IN')}</p>
                  {canUnblock ? (
                    <div className="mt-2">
                      <ConfirmAction
                        label="Block this seat"
                        confirmLabel="Tap again to block"
                        consequence={ADMIN_BAN_HONEST_COPY}
                        onConfirm={() => block(a.id, `Abuse log: ${a.kind}`)}
                      />
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </AdminCard>
        </>
      ) : null}
    </>
  );
}
