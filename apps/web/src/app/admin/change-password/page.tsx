'use client';

/**
 * Change password — /admin/change-password.
 *
 * Change the signed-in account's own password (current + new, with
 * confirm). Reached from the Users page, and forced after sign-in
 * when the server reports `mustChangePassword` on the login response
 * (`?forced=1` — Owner-created accounts must change their password
 * on first sign-in). New passwords must be 12+ characters; the
 * server enforces that too.
 *
 * Submits to POST /v1/admin/auth/change-password (self-service
 * for any signed-in admin — it changes the caller's OWN password
 * only; the server verifies the current password and revokes ALL
 * sessions for the account on success, so the caller returns
 * `reLogin: true` and this page clears the stored session and sends
 * the user to /admin/login?relogin=1, where the notice is shown —
 * never back to /admin, where the revoked session would bounce
 * them to login with no explanation. The forced copy ("created by
 * the Owner") is shown only when the session really is flagged
 * (`me.mustChangePassword`, via the shell guard); ?forced=1 alone
 * is not proof — anyone can type it in the URL.
 */
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { ADMIN_PASSWORD_POLICY_COPY, adminPasswordError } from '@pakdam/shared';
import { AdminApiError, adminChangePassword } from '../../../lib/admin/admin-client';
import { clearAdminSession } from '../../../lib/admin/admin-session';
import { useAdminSessionGuard } from '../../../lib/admin/use-admin';

function ChangePasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const forced = searchParams.get('forced') === '1';
  // The shell guard already called /me; this second read gives this
  // page the real flag for its copy (a 403 here means flagged — the
  // guard sets mustChangePassword: true from the error itself).
  // While it loads, trust ?forced=1 so a flagged user never sees
  // the copy flip; once it resolves, the flag decides.
  const { me } = useAdminSessionGuard();
  const showForcedCopy = forced && (me === null || me.mustChangePassword === true);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!currentPassword) {
      setError('Enter your current password.');
      return;
    }
    const passwordProblem = adminPasswordError(newPassword);
    if (passwordProblem) {
      setError(passwordProblem);
      return;
    }
    if (newPassword !== confirm) {
      setError('The two new passwords do not match.');
      return;
    }
    if (newPassword === currentPassword) {
      setError('Pick a new password — different from the current one.');
      return;
    }
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const result = await adminChangePassword(currentPassword, newPassword);
      if (result.reLogin) {
        // The server revoked every session, including this one.
        // Clear the stored session and send the user to sign in
        // again — with the notice on the login page, where it is
        // actually seen. Never route to /admin here: the revoked
        // session would bounce straight to /admin/login with no
        // explanation, and the success message would never be read.
        clearAdminSession();
        router.replace('/admin/login?relogin=1');
        return;
      }
      setDone('Password changed. Use the new password next time you sign in.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirm('');
    } catch (err) {
      if (err instanceof AdminApiError) setError(err.message);
      else setError('Could not reach the server — check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div>
        <h1 className="text-[22px] font-bold text-white">Change password</h1>
        <p className="mt-1 text-[14px] text-[#A1A1AA]">
          {showForcedCopy
            ? 'Your account was created by the Owner — change your password before you go on.'
            : 'Change your own password.'}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-3" noValidate>
        <label className="block">
          <span className="pakdam-label">Current password</span>
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
            className="mt-1 w-full rounded-[14px] border border-[#26262B] bg-[#141416] px-4 text-[15px] text-white placeholder:text-[#A1A1AA]"
            placeholder="Your current password"
          />
        </label>
        <label className="block">
          <span className="pakdam-label">New password</span>
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
            className="mt-1 w-full rounded-[14px] border border-[#26262B] bg-[#141416] px-4 text-[15px] text-white placeholder:text-[#A1A1AA]"
            placeholder={ADMIN_PASSWORD_POLICY_COPY}
          />
          <span className="mt-1 block text-[13px] text-[#A1A1AA]">
            {ADMIN_PASSWORD_POLICY_COPY} The server checks this too.
          </span>
        </label>
        <label className="block">
          <span className="pakdam-label">Repeat new password</span>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            className="mt-1 w-full rounded-[14px] border border-[#26262B] bg-[#141416] px-4 text-[15px] text-white placeholder:text-[#A1A1AA]"
            placeholder="Type it again"
          />
        </label>

        {error ? (
          <p role="alert" className="rounded-[14px] border border-[#EF4444]/50 bg-[#141416] px-4 py-3 text-[15px] text-white">
            {error}
          </p>
        ) : null}
        {done ? (
          <p role="status" className="rounded-[14px] border border-[#22C55E]/50 bg-[#141416] px-4 py-3 text-[15px] text-white">
            {done}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={busy}
          className="h-14 w-full rounded-[14px] bg-[#EF4444] text-[17px] font-bold text-white active:bg-[#DC2626] disabled:opacity-50"
        >
          {busy ? 'Changing…' : 'Change password'}
        </button>
      </form>
    </>
  );
}

export default function AdminChangePasswordPage() {
  return (
    <Suspense>
      <ChangePasswordForm />
    </Suspense>
  );
}
