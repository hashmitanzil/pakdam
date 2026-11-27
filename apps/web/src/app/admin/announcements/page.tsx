'use client';

/**
 * Announcements — /admin/announcements.
 *
 * Create / edit / deactivate a home-screen message. The preview
 * shows exactly how it reads on the game home page (the same
 * banner component the home page uses). Owner/Admin only for
 * edits; Staff sees the list.
 */
import { useState, type FormEvent } from 'react';
import { adminCan } from '@pakdam/shared';
import { ADMIN_DENIED_MESSAGE } from '@pakdam/shared';
import {
  AdminApiError,
  createAdminAnnouncement,
  deleteAdminAnnouncement,
  listAdminAnnouncements,
  updateAdminAnnouncement,
} from '../../../lib/admin/admin-client';
import { readAdminSession } from '../../../lib/admin/admin-session';
import { useAdminData } from '../../../lib/admin/use-admin';
import { AnnouncementBanner } from '../../../components/admin/AnnouncementBanner';
import {
  AdminCard,
  AdminDenied,
  AdminEmpty,
  AdminError,
  AdminLoading,
  AdminSectionTitle,
  ConfirmAction,
} from '../../../components/admin/AdminUi';

export default function AdminAnnouncementsPage() {
  const session = readAdminSession();
  const role = session?.role ?? null;
  const canEdit = adminCan(role, 'announcements.edit');
  const { data, loading, error, retry } = useAdminData(() => listAdminAnnouncements());
  const [message, setMessage] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [formDone, setFormDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (message.trim().length === 0) {
      setFormError('Write the message first — it cannot be empty.');
      return;
    }
    if (message.trim().length > 200) {
      setFormError('Too long — keep it under 200 characters so it fits one banner.');
      return;
    }
    setBusy(true);
    setFormError(null);
    setFormDone(null);
    try {
      await createAdminAnnouncement(message.trim());
      setFormDone('Announcement created and live on the home screen.');
      setMessage('');
      retry();
    } catch (err) {
      setFormError(err instanceof AdminApiError ? err.message : 'Something went wrong — try again.');
    } finally {
      setBusy(false);
    }
  };

  const setActive = async (id: string, active: boolean) => {
    try {
      await updateAdminAnnouncement(id, { active });
      setFormDone(active ? 'Announcement is live on the home screen.' : 'Announcement hidden from the home screen.');
      retry();
    } catch (err) {
      setFormError(err instanceof AdminApiError ? err.message : 'Something went wrong — try again.');
    }
  };

  const remove = async (id: string) => {
    try {
      await deleteAdminAnnouncement(id);
      setFormDone('Announcement deleted.');
      retry();
    } catch (err) {
      setFormError(err instanceof AdminApiError ? err.message : 'Something went wrong — try again.');
    }
  };

  return (
    <>
      <div>
        <h1 className="text-[22px] font-bold text-white">Announcements</h1>
        <p className="mt-1 text-[14px] text-[#A1A1AA]">Messages shown on the game home screen. Only one can be live at a time.</p>
      </div>

      {loading ? <AdminLoading what="announcements" /> : null}
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

      {canEdit ? (
        <AdminCard>
          <AdminSectionTitle title="New announcement" blurb="Shown as a banner players can dismiss." />
          <form onSubmit={create} className="flex flex-col gap-3" noValidate>
            <label className="block">
              <span className="pakdam-label">Message</span>
              <input
                type="text"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                maxLength={200}
                placeholder="e.g. New: play with 30 players this weekend"
                className="mt-1 w-full rounded-[14px] border border-[#26262B] bg-[#141416] px-4 text-[15px] text-white placeholder:text-[#A1A1AA]"
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="h-12 w-full rounded-[14px] bg-[#EF4444] text-[15px] font-bold text-white active:bg-[#DC2626] disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Publish announcement'}
            </button>
          </form>
          {message.trim() ? (
            <div className="mt-4">
              <p className="pakdam-label mb-2">Preview — how it reads on the home page</p>
              <AnnouncementBanner
                announcement={{ id: 'preview', message: message.trim(), active: true }}
                onDismiss={() => undefined}
              />
            </div>
          ) : null}
        </AdminCard>
      ) : (
        <AdminDenied message={ADMIN_DENIED_MESSAGE} />
      )}

      {data && data.length === 0 ? <AdminEmpty message="No announcements yet." /> : null}
      {data
        ? data.map((a) => (
            <AdminCard key={a.id}>
              <p className="text-[15px] font-semibold text-white">{a.message}</p>
              <p className="mt-0.5 text-[13px] text-[#A1A1AA]">
                {a.active ? 'Live on the home screen' : 'Hidden'}
                {a.createdBy ? ` · by ${a.createdBy}` : ''}
                {a.updatedAt ? ` · ${new Date(a.updatedAt).toLocaleString('en-IN')}` : ''}
              </p>
              {canEdit ? (
                <div className="mt-3 flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={() => setActive(a.id, !a.active)}
                    className="h-12 w-full rounded-[14px] border border-[#EF4444] bg-transparent text-[15px] font-bold text-[#EF4444]"
                  >
                    {a.active ? 'Hide from home screen' : 'Show on home screen'}
                  </button>
                  <ConfirmAction
                    label="Delete announcement"
                    confirmLabel="Tap again to delete"
                    consequence="Deletes this announcement. Players will no longer see it."
                    onConfirm={() => remove(a.id)}
                  />
                </div>
              ) : null}
            </AdminCard>
          ))
        : null}
    </>
  );
}
