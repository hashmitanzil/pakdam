'use client';

/**
 * Room detail — /admin/rooms/[id].
 *
 * Players, roles, phase, zone, timers. Owner/Admin actions — End
 * game, Cancel, Force to results — each behind the two-tap confirm
 * with a plain-words consequence line. Staff sees the room but no
 * action buttons, and a plain-words note instead.
 *
 * UI gating only: the server enforces who may end/cancel a room.
 */
import Link from 'next/link';
import { use, useState } from 'react';
import { adminCan } from '@pakdam/shared';
import {
  AdminApiError,
  adminRoomAction,
  getAdminRoom,
} from '../../../../lib/admin/admin-client';
import { readAdminSession } from '../../../../lib/admin/admin-session';
import { useAdminData } from '../../../../lib/admin/use-admin';
import {
  AdminCard,
  AdminDenied,
  AdminError,
  AdminLoading,
  AdminRow,
  AdminSectionTitle,
  ConfirmAction,
} from '../../../../components/admin/AdminUi';
import { ADMIN_DENIED_MESSAGE } from '@pakdam/shared';

export default function AdminRoomDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const session = readAdminSession();
  const role = session?.role ?? null;
  const canAct = adminCan(role, 'rooms.end');
  const { data, loading, error, retry } = useAdminData(() => getAdminRoom(id), [id]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionDone, setActionDone] = useState<string | null>(null);

  const runAction = async (action: 'end' | 'cancel' | 'force-results', doneCopy: string) => {
    setActionError(null);
    setActionDone(null);
    try {
      await adminRoomAction(id, action);
      setActionDone(doneCopy);
      retry();
    } catch (err) {
      setActionError(err instanceof AdminApiError ? err.message : 'Something went wrong — try again.');
    }
  };

  return (
    <>
      <div>
        <Link href="/admin/rooms" className="text-[14px] font-semibold text-[#EF4444]">
          ← All rooms
        </Link>
        <h1 className="mt-2 text-[22px] font-bold text-white">Room</h1>
      </div>

      {loading ? <AdminLoading what="this room" /> : null}
      {error ? <AdminError message={error} onRetry={retry} /> : null}
      {actionError ? (
        <p role="alert" className="rounded-[14px] border border-[#EF4444]/50 bg-[#141416] px-4 py-3 text-[15px] text-white">
          {actionError}
        </p>
      ) : null}
      {actionDone ? (
        <p role="status" className="rounded-[14px] border border-[#22C55E]/50 bg-[#141416] px-4 py-3 text-[15px] text-white">
          {actionDone}
        </p>
      ) : null}

      {data ? (
        <>
          <AdminCard>
            <AdminSectionTitle title={`${data.code} · ${data.phase}`} blurb={`${data.mode} · ${data.players} players`} />
            <AdminRow label="Phase" value={data.phase} />
            <AdminRow label="Players" value={String(data.players)} />
            <AdminRow
              label="Started"
              value={data.startedAt ? new Date(data.startedAt).toLocaleString('en-IN') : 'Not started'}
            />
            <AdminRow
              label="Zone size"
              value={data.zoneRadiusMetres !== null ? `${data.zoneRadiusMetres} m` : '—'}
            />
            <AdminRow
              label="Ends at"
              value={data.timers.endsAtMs ? new Date(data.timers.endsAtMs).toLocaleTimeString('en-IN') : '—'}
            />
          </AdminCard>

          <AdminCard>
            <AdminSectionTitle title="Players" blurb="Codenames only — no real names in the game." />
            {data.playersList.length === 0 ? (
              <p className="text-[14px] text-[#A1A1AA]">Nobody is in this room.</p>
            ) : (
              data.playersList.map((p) => (
                <AdminRow
                  key={p.playerId}
                  label={p.codename}
                  value={`${p.role}${p.connected ? '' : ' · away'}`}
                />
              ))
            )}
          </AdminCard>

          {canAct ? (
            <AdminCard>
              <AdminSectionTitle title="Room actions" blurb="Each one needs two taps — the first shows what happens." />
              <div className="flex flex-col gap-3">
                <ConfirmAction
                  label="End game"
                  confirmLabel="Tap again to end the game"
                  consequence="Ends the game now. Players see the results page."
                  onConfirm={() => runAction('end', 'Game ended. Players see the results page.')}
                />
                <ConfirmAction
                  label="Force to results"
                  confirmLabel="Tap again to force results"
                  consequence="Skips the rest of the game. Players see the results page now."
                  onConfirm={() => runAction('force-results', 'Game moved to results.')}
                />
                <ConfirmAction
                  label="Cancel room"
                  confirmLabel="Tap again to cancel the room"
                  consequence="Cancels the room. Players go back to the home screen and the game is gone."
                  onConfirm={() => runAction('cancel', 'Room cancelled.')}
                />
              </div>
            </AdminCard>
          ) : (
            <AdminDenied message={ADMIN_DENIED_MESSAGE} />
          )}
        </>
      ) : null}
    </>
  );
}
