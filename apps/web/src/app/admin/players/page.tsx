'use client';

/**
 * Players — /admin/players.
 *
 * Live players by codename + room, connection/GPS status, last fix
 * time. Owner/Admin actions: Kick, Block device — each behind the
 * two-tap confirm. Staff sees the list only.
 *
 * LIVE LOCATION — Owner only, behind an explicit "View live
 * location" action, with the visible notice that it is shown
 * in-session only and never stored, logged or exported. The view
 * itself is recorded in the audit log (not the coordinates).
 * Admin and Staff never see a location button, a map, or coordinates.
 *
 * UI gating only: the server enforces kick/block/location.
 */
import { useState } from 'react';
import { ADMIN_BAN_HONEST_COPY, ADMIN_DENIED_MESSAGE, ADMIN_LOCATION_NOTICE, adminCan } from '@pakdam/shared';
import {
  AdminApiError,
  adminPlayerAction,
  getAdminPlayerLocation,
  listAdminPlayers,
  type AdminPlayerRow,
} from '../../../lib/admin/admin-client';
import { readAdminSession } from '../../../lib/admin/admin-session';
import { useAdminData } from '../../../lib/admin/use-admin';
import {
  AdminCard,
  AdminDenied,
  AdminEmpty,
  AdminError,
  AdminLoading,
  ConfirmAction,
} from '../../../components/admin/AdminUi';

export default function AdminPlayersPage() {
  const session = readAdminSession();
  const role = session?.role ?? null;
  const canKick = adminCan(role, 'players.kick');
  const canBlock = adminCan(role, 'players.block');
  const canViewLocation = adminCan(role, 'players.viewLocation');
  const { data, loading, error, retry } = useAdminData(() => listAdminPlayers());
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionDone, setActionDone] = useState<string | null>(null);
  const [locationFor, setLocationFor] = useState<string | null>(null);
  const [locationText, setLocationText] = useState<string | null>(null);
  const [locationBusy, setLocationBusy] = useState(false);

  const runAction = async (player: AdminPlayerRow, action: 'kick' | 'block' | 'unblock', doneCopy: string) => {
    setActionError(null);
    setActionDone(null);
    try {
      await adminPlayerAction(player.playerId, action);
      setActionDone(doneCopy);
      retry();
    } catch (err) {
      setActionError(err instanceof AdminApiError ? err.message : 'Something went wrong — try again.');
    }
  };

  const viewLocation = async (player: AdminPlayerRow) => {
    setLocationBusy(true);
    setLocationText(null);
    try {
      const loc = await getAdminPlayerLocation(player.playerId);
      // The coordinates are rendered as text on this screen only.
      // They are never written to storage, never logged, and never
      // sent anywhere else. The view itself is recorded in the audit
      // log by the server (never the coordinates). Data minimisation:
      // the coordinates are fetched only on this explicit tap, and
      // never fetched just to be thrown away.
      setLocationFor(player.codename);
      setLocationText(
        `Lat ${loc.latitude.toFixed(5)}, Lng ${loc.longitude.toFixed(5)} — ` +
          `last fix ${loc.fixedAt ? new Date(loc.fixedAt).toLocaleTimeString('en-IN') : 'unknown time'}, ` +
          `about ${loc.accuracyMetres !== null ? `±${loc.accuracyMetres} m` : 'unknown accuracy'}.`,
      );
    } catch (err) {
      setActionError(err instanceof AdminApiError ? err.message : 'Something went wrong — try again.');
    } finally {
      setLocationBusy(false);
    }
  };

  return (
    <>
      <div>
        <h1 className="text-[22px] font-bold text-white">Players</h1>
        <p className="mt-1 text-[14px] text-[#A1A1AA]">Who is playing now. Codenames only — no real names in the game.</p>
      </div>

      {loading ? <AdminLoading what="players" /> : null}
      {error ? <AdminError message={error} onRetry={retry} /> : null}
      {data && data.length === 0 ? <AdminEmpty message="No players online right now." /> : null}
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

      {locationFor && locationText ? (
        <AdminCard>
          <p className="text-[15px] font-bold text-white">
            <span aria-hidden className="text-[#EF4444]">◎ </span>Live location — {locationFor}
          </p>
          <p className="pakdam-numeric mt-1 text-[15px] font-semibold text-white">{locationText}</p>
          <p className="mt-2 text-[13px] text-[#A1A1AA]">{ADMIN_LOCATION_NOTICE}</p>
          <button
            type="button"
            onClick={() => {
              setLocationFor(null);
              setLocationText(null);
            }}
            className="mt-3 min-h-[48px] text-[14px] font-semibold text-[#EF4444]"
          >
            Hide location
          </button>
        </AdminCard>
      ) : null}

      {data
        ? data.map((player) => (
            <AdminCard key={player.playerId}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[17px] font-bold text-white">
                    {player.codename}
                    {player.blocked ? ' · Blocked' : ''}
                  </p>
                  <p className="mt-0.5 text-[13px] text-[#A1A1AA]">
                    Room: {player.roomCode ?? '—'} · {player.connected ? 'Connected' : 'Away'} · GPS{' '}
                    {player.gpsOk ? 'ok' : 'no fix'}
                  </p>
                  <p className="mt-0.5 text-[13px] text-[#A1A1AA]">
                    Last fix: {player.lastFixAt ? new Date(player.lastFixAt).toLocaleTimeString('en-IN') : 'Never'}
                  </p>
                </div>
              </div>

              <div className="mt-3 flex flex-col gap-2">
                {canViewLocation ? (
                  <button
                    type="button"
                    disabled={locationBusy}
                    onClick={() => viewLocation(player)}
                    className="h-12 w-full rounded-[14px] border border-[#EF4444] bg-transparent text-[15px] font-bold text-[#EF4444] disabled:opacity-50"
                  >
                    {locationBusy ? 'Loading…' : 'View live location'}
                  </button>
                ) : null}
                {canKick ? (
                  <ConfirmAction
                    label="Kick from game"
                    confirmLabel="Tap again to kick"
                    consequence="Removes this player from the game now. They see that they were removed."
                    onConfirm={() => runAction(player, 'kick', `${player.codename} was kicked from the game.`)}
                  />
                ) : null}
                {canBlock ? (
                  player.blocked ? (
                    <ConfirmAction
                      label="Unblock seat"
                      confirmLabel="Tap again to unblock"
                      consequence="Lets this seat's stored sign-in join games again."
                      onConfirm={() => runAction(player, 'unblock', `${player.codename}'s seat was unblocked.`)}
                      danger={false}
                    />
                  ) : (
                    <ConfirmAction
                      label="Block this seat"
                      confirmLabel="Tap again to block"
                      consequence={ADMIN_BAN_HONEST_COPY}
                      onConfirm={() => runAction(player, 'block', `${player.codename}'s seat was blocked.`)}
                    />
                  )
                ) : null}
                {!canKick && !canBlock && !canViewLocation ? (
                  <AdminDenied message={ADMIN_DENIED_MESSAGE} />
                ) : null}
              </div>
            </AdminCard>
          ))
        : null}
    </>
  );
}
