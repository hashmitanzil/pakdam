'use client';

/**
 * Users & Accounts — /admin/accounts — PLAYER accounts.
 *
 * Labelled clearly apart from "Users" (/admin/users), which is the
 * CONSOLE accounts page (Owner/Admin/Staff who sign in to this
 * panel). This page is about the people who PLAY.
 *
 * What is REAL today: guest players — codename + device key, no
 * login, no account. The directory below lists real guest players
 * from GET /v1/admin/players (live/recent games), with no invented
 * identity fields: no phone, no email, no real names — guests have
 * none of those. Account features (profiles, purchases, roles,
 * data requests, login methods) are future and show the shared
 * NotAvailable state behind their flags.
 *
 * Bans/suspensions of a DEVICE key are real today (Safety blocks)
 * and are offered on the account detail page with the two-tap
 * confirm. Bans of a player ACCOUNT are future.
 */
import Link from 'next/link';
import { listAdminPlayers } from '../../../lib/admin/admin-client';
import { useAdminData } from '../../../lib/admin/use-admin';
import { AdminCard, AdminEmpty, AdminError, AdminLoading } from '../../../components/admin/AdminUi';

export default function AdminAccountsPage() {
  const { data, loading, error, retry } = useAdminData(() => listAdminPlayers());

  return (
    <>
      <div>
        <h1 className="text-[22px] font-bold text-white">Users &amp; accounts — players</h1>
        <p className="mt-1 text-[14px] text-[#A1A1AA]">
          Guest players today — codename and device only, no login yet. Player accounts are a future upgrade. (Console
          accounts are under “Users”.)
        </p>
      </div>

      {loading ? <AdminLoading what="players" /> : null}
      {error ? <AdminError message={error} onRetry={retry} /> : null}
      {data && data.length === 0 ? <AdminEmpty message="No players online right now." /> : null}

      {data
        ? data.map((player) => (
            <Link key={player.playerId} href={`/admin/accounts/${player.playerId}`}>
              <AdminCard>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[17px] font-bold text-white">
                      {player.codename}
                      {player.blocked ? ' · Blocked' : ''}
                    </p>
                    <p className="mt-0.5 text-[13px] text-[#A1A1AA]">
                      Guest · Room: {player.roomCode ?? '—'} · {player.connected ? 'Online now' : 'Away'}
                    </p>
                    <p className="mt-0.5 text-[13px] text-[#A1A1AA]">
                      Last seen: {player.lastFixAt ? new Date(player.lastFixAt).toLocaleTimeString('en-IN') : 'Never'}
                    </p>
                  </div>
                  <span aria-hidden className="text-[18px] text-[#EF4444]">
                    →
                  </span>
                </div>
              </AdminCard>
            </Link>
          ))
        : null}

      <p className="text-[13px] leading-snug text-[#A1A1AA]">
        No phone numbers, emails or real names are shown here — guest players have none. Only what the game itself
        knows (codename, room, connection) is listed.
      </p>
    </>
  );
}
