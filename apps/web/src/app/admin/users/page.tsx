'use client';

/**
 * Users — /admin/users — CONSOLE accounts (Owner only).
 *
 * This page is about the accounts that sign in to THIS panel
 * (Owner / Admin / Staff). It is NOT player accounts — those live
 * under "Users & accounts" (/admin/accounts). The two are labelled
 * apart on purpose so nobody confuses them.
 *
 * Non-Owners never see this page at all: they are sent back to the
 * overview with a plain-words note. The last Owner can never be
 * demoted or deleted — the server enforces it, and this page
 * refuses too, in plain words.
 */
import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ADMIN_DENIED_USERS_MESSAGE, ADMIN_PASSWORD_POLICY_COPY, adminCan, adminPasswordError, type AdminRole } from '@pakdam/shared';
import {
  AdminApiError,
  adminRevokeUserSessions,
  createAdminUser,
  deleteAdminUser,
  listAdminUsers,
  updateAdminUser,
  type AdminUserRow,
} from '../../../lib/admin/admin-client';
import { readAdminSession, saveAdminNotice } from '../../../lib/admin/admin-session';
import { useAdminData } from '../../../lib/admin/use-admin';
import {
  AdminCard,
  AdminEmpty,
  AdminError,
  AdminLoading,
  AdminSectionTitle,
  ConfirmAction,
} from '../../../components/admin/AdminUi';

export default function AdminUsersPage() {
  const router = useRouter();
  const session = readAdminSession();
  const role = session?.role ?? null;
  const isOwner = adminCan(role, 'users.manage');

  // Non-Owners must not render this page at all: back to the
  // overview with a plain-words note (shown once, then cleared).
  useEffect(() => {
    if (role !== null && !isOwner) {
      saveAdminNotice(ADMIN_DENIED_USERS_MESSAGE);
      router.replace('/admin');
    }
  }, [role, isOwner, router]);

  const { data, loading, error, retry } = useAdminData(() => listAdminUsers(), [isOwner]);
  const [username, setUsername] = useState('');
  // The server never creates Owner accounts here (POST /v1/admin/users
  // accepts 'admin' | 'staff' only) — Owners are created by /admin/setup.
  const [newRole, setNewRole] = useState<'admin' | 'staff'>('admin');
  const [password, setPassword] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [formDone, setFormDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!isOwner) {
    return (
      <p role="status" className="py-6 text-center text-[15px] text-[#A1A1AA]">
        Only the Owner can manage accounts. Taking you back…
      </p>
    );
  }

  const ownerCount = data ? data.filter((u) => u.role === 'owner' && !u.disabled).length : 0;

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (username.trim().length < 3) {
      setFormError('Pick a username with at least 3 characters.');
      return;
    }
    if (password.length < 12) {
      setFormError(adminPasswordError(password) ?? 'Pick a longer password.');
      return;
    }
    setBusy(true);
    setFormError(null);
    setFormDone(null);
    try {
      await createAdminUser(username.trim(), newRole, password);
      setFormDone(`Account ${username.trim()} created as ${newRole}.`);
      setUsername('');
      setPassword('');
      retry();
    } catch (err) {
      setFormError(err instanceof AdminApiError ? err.message : 'Something went wrong — try again.');
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (user: AdminUserRow, nextRole: AdminRole) => {
    if (user.role === 'owner' && ownerCount <= 1) {
      setFormError('You cannot demote the last Owner. Create another Owner first.');
      return;
    }
    try {
      await updateAdminUser(user.id, { role: nextRole });
      setFormDone(`${user.username} is now ${nextRole}.`);
      retry();
    } catch (err) {
      setFormError(err instanceof AdminApiError ? err.message : 'Something went wrong — try again.');
    }
  };

  const toggleDisabled = async (user: AdminUserRow) => {
    if (user.role === 'owner' && !user.disabled && ownerCount <= 1) {
      setFormError('You cannot disable the last Owner. Create another Owner first.');
      return;
    }
    try {
      await updateAdminUser(user.id, { disabled: !user.disabled });
      setFormDone(user.disabled ? `${user.username} is active again.` : `${user.username} is disabled.`);
      retry();
    } catch (err) {
      setFormError(err instanceof AdminApiError ? err.message : 'Something went wrong — try again.');
    }
  };

  const revokeSessions = async (user: AdminUserRow) => {
    setFormError(null);
    setFormDone(null);
    try {
      await adminRevokeUserSessions(user.id);
      setFormDone(`${user.username} was signed out everywhere. They will need to sign in again.`);
    } catch (err) {
      setFormError(err instanceof AdminApiError ? err.message : 'Something went wrong — try again.');
    }
  };

  const remove = async (user: AdminUserRow) => {
    if (user.role === 'owner' && ownerCount <= 1) {
      setFormError('You cannot delete the last Owner. Create another Owner first.');
      return;
    }
    try {
      await deleteAdminUser(user.id);
      setFormDone(`${user.username} deleted.`);
      retry();
    } catch (err) {
      setFormError(err instanceof AdminApiError ? err.message : 'Something went wrong — try again.');
    }
  };

  return (
    <>
      <div>
        <h1 className="text-[22px] font-bold text-white">Users — console accounts</h1>
        <p className="mt-1 text-[14px] text-[#A1A1AA]">
          Who can sign in to this panel. Player accounts are separate — see “Users &amp; accounts”.
        </p>
        <p className="mt-2 text-[14px] text-[#A1A1AA]">
          <Link href="/admin/change-password" className="font-semibold text-[#EF4444]">
            Change my own password →
          </Link>
        </p>
      </div>

      {loading ? <AdminLoading what="console accounts" /> : null}
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

      <AdminCard>
        <AdminSectionTitle title="Create an account" blurb="Owner only. The new account signs in with its own password." />
        <form onSubmit={create} className="flex flex-col gap-3" noValidate>
          <label className="block">
            <span className="pakdam-label">Username</span>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              className="mt-1 w-full rounded-[14px] border border-[#26262B] bg-[#141416] px-4 text-[15px] text-white placeholder:text-[#A1A1AA]"
              placeholder="e.g. priya-admin"
            />
          </label>
          <label className="block">
            <span className="pakdam-label">Role</span>
            <select
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as 'admin' | 'staff')}
              className="mt-1 w-full rounded-[14px] border border-[#26262B] bg-[#141416] px-4 text-[15px] text-white"
            >
              <option value="admin">Admin — end games, switches, settings</option>
              <option value="staff">Staff — view only, can report</option>
            </select>
            <p className="mt-1 text-[13px] text-[#A1A1AA]">
              Owner accounts are created only by the first-time setup — this form creates Admin or Staff.
            </p>
          </label>
          <label className="block">
            <span className="pakdam-label">Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              className="mt-1 w-full rounded-[14px] border border-[#26262B] bg-[#141416] px-4 text-[15px] text-white placeholder:text-[#A1A1AA]"
              placeholder={ADMIN_PASSWORD_POLICY_COPY}
            />
            <span className="mt-1 block text-[13px] text-[#A1A1AA]">
              {ADMIN_PASSWORD_POLICY_COPY} They must change it when they first sign in.
            </span>
          </label>
          <button
            type="submit"
            disabled={busy}
            className="h-12 w-full rounded-[14px] bg-[#EF4444] text-[15px] font-bold text-white active:bg-[#DC2626] disabled:opacity-50"
          >
            {busy ? 'Creating…' : 'Create account'}
          </button>
        </form>
      </AdminCard>

      {data && data.length === 0 ? <AdminEmpty message="No console accounts yet." /> : null}
      {data
        ? data.map((user) => {
            const isLastOwner = user.role === 'owner' && ownerCount <= 1;
            return (
              <AdminCard key={user.id}>
                <p className="text-[17px] font-bold text-white">
                  {user.username} · {user.role}
                  {user.disabled ? ' · Disabled' : ''}
                  {user.mustChangePassword ? ' · Must change password' : ''}
                </p>
                <p className="mt-0.5 text-[13px] text-[#A1A1AA]">
                  Created {user.createdAt ? new Date(user.createdAt).toLocaleDateString('en-IN') : '—'}
                  {user.mustChangePassword ? ' · Has not changed the Owner-set password yet.' : ''}
                  {isLastOwner ? ' · Last Owner — cannot be demoted, disabled or deleted.' : ''}
                </p>
                <div className="mt-3 flex flex-col gap-2">
                  <label className="block">
                    <span className="pakdam-label">Change role</span>
                    <select
                      value={user.role}
                      disabled={isLastOwner}
                      onChange={(e) => changeRole(user, e.target.value as AdminRole)}
                      className="mt-1 w-full rounded-[14px] border border-[#26262B] bg-[#141416] px-4 text-[15px] text-white disabled:opacity-50"
                    >
                      <option value="owner">Owner</option>
                      <option value="admin">Admin</option>
                      <option value="staff">Staff</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    disabled={isLastOwner}
                    onClick={() => toggleDisabled(user)}
                    className="h-12 w-full rounded-[14px] border border-[#EF4444] bg-transparent text-[15px] font-bold text-[#EF4444] disabled:opacity-50"
                  >
                    {user.disabled ? 'Enable account' : 'Disable account'}
                  </button>
                  <ConfirmAction
                    label="Revoke all sessions"
                    confirmLabel="Tap again to sign them out everywhere"
                    consequence="Signs this account out on every device and browser. They will need to sign in again."
                    onConfirm={() => revokeSessions(user)}
                  />
                  <ConfirmAction
                    label="Delete account"
                    confirmLabel="Tap again to delete"
                    consequence={`Deletes ${user.username}'s account. They will no longer be able to sign in.`}
                    onConfirm={() => remove(user)}
                  />
                  {isLastOwner ? (
                    <p className="text-[13px] text-[#A1A1AA]">
                      This is the last Owner. Create another Owner before changing this one.
                    </p>
                  ) : null}
                </div>
              </AdminCard>
            );
          })
        : null}
    </>
  );
}
