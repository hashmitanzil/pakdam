'use client';

/**
 * Admin sign-in — /admin/login.
 *
 * Username + password. Errors are plain words and never say whether
 * the username or the password was wrong (see `loginErrorCopy` in
 * admin-client.ts). After too many wrong tries the server locks the
 * account and the page says so plainly. A signed-in admin is sent
 * straight to the overview.
 *
 * `?relogin=1` — shown after a password rotation: the server revoked
 * every session on rotation, so the user lands here and is told to
 * sign in again with the new password. A flagged user with a stored
 * session is NOT redirected to the change page from here directly:
 * the stored session sends them to /admin, where the shell guard
 * (which re-checks /me) bounces them to the change page.
 */
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { Suspense } from 'react';
import { ADMIN_RELOGIN_NOTICE, AdminApiError, adminLogin } from '../../../lib/admin/admin-client';
import { readAdminSession, saveAdminSession } from '../../../lib/admin/admin-session';

function AdminLoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const relogin = searchParams.get('relogin') === '1';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (readAdminSession()) router.replace('/admin');
  }, [router]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!username.trim() || !password) {
      setError('Enter your username and password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await adminLogin(username.trim(), password);
      saveAdminSession({ token: result.token, username: result.username, role: result.role });
      // Forced password change (fix round, Zara n6): Owner-created
      // accounts must change their password on first sign-in. The
      // server reports it on the login response; the change page
      // itself is /admin/change-password.
      router.replace(result.mustChangePassword ? '/admin/change-password?forced=1' : '/admin');
    } catch (err) {
      if (err instanceof AdminApiError) setError(err.message);
      else setError('Could not reach the server — check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="mt-4">
        <p className="pakdam-display text-[28px] leading-none text-white">
          PAKDAM <span className="text-[#EF4444]">CONTROL</span>
        </p>
        <p className="mt-2 text-[15px] text-[#A1A1AA]">Sign in to manage Pakdam.</p>
      </header>

      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-3" noValidate>
        <label className="block">
          <span className="pakdam-label">Username</span>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="off"
            autoCorrect="off"
            className="mt-1 w-full rounded-[14px] border border-[#26262B] bg-[#141416] px-4 text-[15px] text-white placeholder:text-[#A1A1AA]"
            placeholder="Your admin username"
          />
        </label>
        <label className="block">
          <span className="pakdam-label">Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            className="mt-1 w-full rounded-[14px] border border-[#26262B] bg-[#141416] px-4 text-[15px] text-white placeholder:text-[#A1A1AA]"
            placeholder="Your password"
          />
        </label>

        {error ? (
          <p role="alert" className="rounded-[14px] border border-[#EF4444]/50 bg-[#141416] px-4 py-3 text-[15px] text-white">
            {error}
          </p>
        ) : null}
        {relogin && !error ? (
          <p role="status" className="rounded-[14px] border border-[#22C55E]/50 bg-[#141416] px-4 py-3 text-[15px] text-white">
            {ADMIN_RELOGIN_NOTICE}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={busy}
          className="h-14 w-full rounded-[14px] bg-[#EF4444] text-[17px] font-bold text-white active:bg-[#DC2626] disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <p className="mt-4 text-center text-[14px] text-[#A1A1AA]">
        First time here?{' '}
        <Link href="/admin/setup" className="font-semibold text-[#EF4444]">
          Set up the Owner account
        </Link>
      </p>
      <p className="mt-2 text-center text-[13px] text-[#A1A1AA]">
        Only signed-in admins can open this panel. Wrong tries lock the account for a while.
      </p>
    </>
  );
}

export default function AdminLoginPage() {
  return (
    <Suspense>
      <AdminLoginForm />
    </Suspense>
  );
}
