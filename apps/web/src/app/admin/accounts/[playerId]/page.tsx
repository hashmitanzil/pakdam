'use client';

/**
 * Player account detail — /admin/accounts/[playerId].
 *
 * What is REAL today is shown from the players list: codename,
 * room, connection, GPS status, last fix, blocked or not. Purchases,
 * account roles, data requests and login methods are future and show
 * the shared NotAvailable state. Banning/suspending the DEVICE is
 * real today (Safety blocks) — two-tap confirm, plain-words
 * consequence. No invented identity fields, no raw coordinates.
 */
import Link from 'next/link';
import { use, useState } from 'react';
import { ADMIN_BAN_HONEST_COPY, adminFutureFlag, adminFutureFlagEnabled, type AdminFlag } from '@pakdam/shared';
import {
  AdminApiError,
  adminPlayerAction,
  getAdminBillingTransactions,
  getAdminDataRequests,
  getAdminLoginMethods,
  listAdminFlags,
  listAdminPlayers,
  type AdminBillingTransactions,
  type AdminDataRequests,
  type AdminLoginMethods,
  type AdminPlayerRow,
} from '../../../../lib/admin/admin-client';
import { useAdminData } from '../../../../lib/admin/use-admin';
import {
  AdminCard,
  AdminError,
  AdminLoading,
  AdminRow,
  AdminSectionTitle,
  ConfirmAction,
  NotAvailable,
} from '../../../../components/admin/AdminUi';

interface AccountDetailData {
  players: AdminPlayerRow[];
  flags: AdminFlag[];
  /** Fetched only when its flag is ON (the endpoints are inert otherwise). */
  transactions: AdminBillingTransactions | null;
  dataRequests: AdminDataRequests | null;
  loginMethods: AdminLoginMethods | null;
}

/**
 * Merge, 2026-11-27 — Meera fix 1: the future sections used to render
 * NotAvailable unconditionally from the static defs. Now each section
 * reads its LIVE flag from GET /v1/admin/flags: flag OFF → NotAvailable
 * with the fetched value; flag ON → the section's real content from
 * its endpoint (still honestly empty today — no provider, no accounts).
 * The gated fetches run only after the flags resolve, so a flag-OFF
 * section never triggers its endpoint's audit-logged list read.
 */
async function loadAccountDetail(): Promise<AccountDetailData> {
  const [players, flags] = await Promise.all([listAdminPlayers(), listAdminFlags()]);
  const [transactions, dataRequests, loginMethods] = await Promise.all([
    adminFutureFlagEnabled(flags, 'billing.transactions') ? getAdminBillingTransactions() : Promise.resolve(null),
    adminFutureFlagEnabled(flags, 'accounts.dataRequests') ? getAdminDataRequests() : Promise.resolve(null),
    adminFutureFlagEnabled(flags, 'accounts.loginMethods') ? getAdminLoginMethods() : Promise.resolve(null),
  ]);
  return { players, flags, transactions, dataRequests, loginMethods };
}

export default function AdminAccountDetailPage({ params }: { params: Promise<{ playerId: string }> }) {
  const { playerId } = use(params);
  const { data, loading, error, retry } = useAdminData(() => loadAccountDetail(), [playerId]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionDone, setActionDone] = useState<string | null>(null);

  const player = data?.players.find((p) => p.playerId === playerId) ?? null;
  const flags = data?.flags ?? null;
  const purchasesOn = adminFutureFlagEnabled(flags, 'billing.transactions');
  const bansOn = adminFutureFlagEnabled(flags, 'accounts.bans');
  const rolesOn = adminFutureFlagEnabled(flags, 'accounts.roles');
  const dataRequestsOn = adminFutureFlagEnabled(flags, 'accounts.dataRequests');
  const loginMethodsOn = adminFutureFlagEnabled(flags, 'accounts.loginMethods');
  // Narrowed copies for the JSX below: `data` is nullable and the
  // `{player ? ...}` guard does not narrow it for the compiler.
  const transactionsRes = data?.transactions ?? null;
  const dataRequestsRes = data?.dataRequests ?? null;
  const loginMethodsRes = data?.loginMethods ?? null;

  const runAction = async (action: 'block' | 'unblock', doneCopy: string) => {
    setActionError(null);
    setActionDone(null);
    try {
      await adminPlayerAction(playerId, action);
      setActionDone(doneCopy);
      retry();
    } catch (err) {
      setActionError(err instanceof AdminApiError ? err.message : 'Something went wrong — try again.');
    }
  };

  const roles = adminFutureFlag('accounts.roles');
  const bans = adminFutureFlag('accounts.bans');
  const dataRequests = adminFutureFlag('accounts.dataRequests');
  const loginMethods = adminFutureFlag('accounts.loginMethods');

  return (
    <>
      <div>
        <Link href="/admin/accounts" className="text-[14px] font-semibold text-[#EF4444]">
          ← All players
        </Link>
        <h1 className="mt-2 text-[22px] font-bold text-white">Player account</h1>
        <p className="mt-1 text-[14px] text-[#A1A1AA]">Guest player today — a full account is a future upgrade.</p>
      </div>

      {loading ? <AdminLoading what="this player" /> : null}
      {error ? <AdminError message={error} onRetry={retry} /> : null}
      {!loading && !error && !player ? (
        <p role="status" className="py-4 text-center text-[15px] text-[#A1A1AA]">
          Player not found — they may have left the game.
        </p>
      ) : null}
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

      {player ? (
        <>
          <AdminCard>
            <AdminSectionTitle title="Profile — what the game knows" blurb="Guest: codename and device only." />
            <AdminRow label="Codename" value={player.codename} />
            <AdminRow label="Account type" value="Guest (no login yet)" />
            <AdminRow label="Room" value={player.roomCode ?? '—'} />
            <AdminRow label="Connection" value={player.connected ? 'Online now' : 'Away'} />
            <AdminRow label="GPS" value={player.gpsOk ? 'Fix ok' : 'No fix'} />
            <AdminRow
              label="Last seen"
              value={player.lastFixAt ? new Date(player.lastFixAt).toLocaleString('en-IN') : 'Never'}
            />
            <AdminRow label="Status" value={player.blocked ? 'Blocked' : 'Active'} />
          </AdminCard>

          <AdminCard>
            <AdminSectionTitle title="Games" blurb="Live and recent games for this player." />
            <p className="text-[14px] text-[#A1A1AA]">
              {player.roomCode ? `Playing in room ${player.roomCode} now.` : 'Not in a game right now.'}
            </p>
            <p className="mt-1 text-[13px] text-[#A1A1AA]">Full game history arrives with player accounts.</p>
          </AdminCard>

          <AdminCard>
            <AdminSectionTitle title="Purchases" blurb="Empty — billing is not live." />
            {purchasesOn ? (
              <>
                <p className="text-[14px] text-[#A1A1AA]">No payments yet — none exist for this player.</p>
                {transactionsRes && !transactionsRes.available && transactionsRes.reason ? (
                  <p className="mt-1 text-[13px] leading-snug text-[#A1A1AA]">{transactionsRes.reason}</p>
                ) : null}
              </>
            ) : (
              <NotAvailable
                flagKey="billing.transactions"
                willDo="Lists every payment this player made."
                unlocksWhen="Activates when the first payment goes live."
                enabled={purchasesOn}
              />
            )}
          </AdminCard>

          <AdminCard>
            <AdminSectionTitle title="Bans & suspensions" blurb="Seat blocks are real today; account bans are future." />
            {player.blocked ? (
              <ConfirmAction
                label="Unblock seat"
                confirmLabel="Tap again to unblock"
                consequence="Lets this seat's stored sign-in join games again."
                onConfirm={() => runAction('unblock', `${player.codename}'s seat was unblocked.`)}
                danger={false}
              />
            ) : (
              <ConfirmAction
                label="Ban this seat"
                confirmLabel="Tap again to ban"
                consequence={ADMIN_BAN_HONEST_COPY}
                onConfirm={() => runAction('block', `${player.codename}'s seat was blocked.`)}
              />
            )}
            <div className="mt-3">
              {bansOn ? (
                <p className="text-[13px] leading-snug text-[#A1A1AA]">
                  Account bans arrive with player accounts. Seat blocks are live now — use &ldquo;Ban this seat&rdquo;
                  above.
                </p>
              ) : (
                <NotAvailable flagKey={bans.key} willDo={bans.willDo} unlocksWhen={bans.unlocksWhen} enabled={bansOn} />
              )}
            </div>
          </AdminCard>

          <AdminCard>
            <AdminSectionTitle title="Roles" />
            {rolesOn ? (
              <p className="text-[14px] text-[#A1A1AA]">
                Player accounts are not live yet — there are no account roles to show.
              </p>
            ) : (
              <NotAvailable flagKey={roles.key} willDo={roles.willDo} unlocksWhen={roles.unlocksWhen} enabled={rolesOn} />
            )}
          </AdminCard>

          <AdminCard>
            <AdminSectionTitle title="Data requests (DPDP Act)" blurb="Access, correction and erasure — designed now, live with accounts." />
            {dataRequestsOn ? (
              <>
                {dataRequestsRes?.available && dataRequestsRes.requests.length > 0 ? (
                  <div>
                    {dataRequestsRes.requests.map((r) => (
                      <AdminRow
                        key={r.id}
                        label={`${r.kind} · ${r.status}`}
                        value={new Date(r.created_at).toLocaleDateString('en-IN')}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="text-[14px] text-[#A1A1AA]">No data requests yet — none have been made.</p>
                )}
                {dataRequestsRes && !dataRequestsRes.available && dataRequestsRes.reason ? (
                  <p className="mt-1 text-[13px] leading-snug text-[#A1A1AA]">{dataRequestsRes.reason}</p>
                ) : null}
                {dataRequestsRes?.note ? (
                  <p className="mt-1 text-[13px] leading-snug text-[#A1A1AA]">{dataRequestsRes.note}</p>
                ) : null}
              </>
            ) : (
              <NotAvailable
                flagKey={dataRequests.key}
                willDo={dataRequests.willDo}
                unlocksWhen={dataRequests.unlocksWhen}
                enabled={dataRequestsOn}
              />
            )}
            <p className="mt-2 text-[13px] leading-snug text-[#A1A1AA]">
              When live, a player can ask for their data, ask for a correction, or ask for erasure — and every request
              is answered and logged here.
            </p>
          </AdminCard>

          <AdminCard>
            <AdminSectionTitle title="Login methods" blurb="How this player signs in, when accounts go live." />
            {loginMethodsOn ? (
              <>
                {loginMethodsRes?.methods.map((m) => (
                  <AdminRow key={m.method} label={m.method} value={`${m.status} — ${m.note}`} />
                ))}
                {loginMethodsRes && !loginMethodsRes.available && loginMethodsRes.reason ? (
                  <p className="mt-2 text-[13px] leading-snug text-[#A1A1AA]">{loginMethodsRes.reason}</p>
                ) : null}
              </>
            ) : (
              <NotAvailable
                flagKey={loginMethods.key}
                willDo={loginMethods.willDo}
                unlocksWhen={loginMethods.unlocksWhen}
                enabled={loginMethodsOn}
              />
            )}
            <p className="mt-2 text-[13px] leading-snug text-[#A1A1AA]">
              Planned: Google or an email link. No phone OTP. Signing in stays optional — guests keep playing without
              an account.
            </p>
          </AdminCard>
        </>
      ) : null}
    </>
  );
}
