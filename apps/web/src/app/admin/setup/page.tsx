'use client';

/**
 * First Owner setup — /admin/setup.
 *
 * Only works before any admin account exists (the server answers 409
 * once an Owner exists, and the page then points at Sign in). The
 * account created here is the Owner — the main account that can
 * never be demoted or deleted.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ADMIN_PASSWORD_POLICY_COPY, adminPasswordError } from '@pakdam/shared';
import { AdminApiError, adminSetup } from '../../../lib/admin/admin-client';
import { saveAdminSession } from '../../../lib/admin/admin-session';

export default function AdminSetupPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  // Setup token (fix round, Zara B1 + Diya BLOCKING): required,
  // password-masked. The server fails closed without it — the first
  // Owner cannot be created by anyone who does not hold the token
  // the founder set with `wrangler secret put ADMIN_SETUP_TOKEN`.
  const [setupToken, setSetupToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (username.trim().length < 3) {
      setError('Pick a username with at least 3 characters.');
      return;
    }
    const passwordProblem = adminPasswordError(password);
    if (passwordProblem) {
      setError(passwordProblem);
      return;
    }
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    if (!setupToken) {
      setError('Enter the setup token.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await adminSetup(username.trim(), password, setupToken);
      saveAdminSession({ token: result.token, username: result.username, role: result.role });
      router.replace('/admin');
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
        <p className="mt-2 text-[15px] text-[#A1A1AA]">
          Set up the Owner account — the main account for this panel. This only works once.
        </p>
      </header>

      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-3" noValidate>
        <label className="block">
          <span className="pakdam-label">Owner username</span>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="off"
            autoCorrect="off"
            className="mt-1 w-full rounded-[14px] border border-[#26262B] bg-[#141416] px-4 text-[15px] text-white placeholder:text-[#A1A1AA]"
            placeholder="e.g. owner"
          />
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
            {ADMIN_PASSWORD_POLICY_COPY} The server checks this too.
          </span>
        </label>
        <label className="block">
          <span className="pakdam-label">Repeat password</span>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            className="mt-1 w-full rounded-[14px] border border-[#26262B] bg-[#141416] px-4 text-[15px] text-white placeholder:text-[#A1A1AA]"
            placeholder="Type it again"
          />
        </label>

        <label className="block">
          <span className="pakdam-label">Setup token</span>
          <input
            type="password"
            value={setupToken}
            onChange={(e) => setSetupToken(e.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            required
            className="mt-1 w-full rounded-[14px] border border-[#26262B] bg-[#141416] px-4 text-[15px] text-white placeholder:text-[#A1A1AA]"
            placeholder="The setup token from the founder"
          />
          <span className="mt-1 block text-[13px] text-[#A1A1AA]">
            Required. Without the right token, setup fails — this stops anyone else creating the first Owner.
          </span>
        </label>

        {error ? (
          <p role="alert" className="rounded-[14px] border border-[#EF4444]/50 bg-[#141416] px-4 py-3 text-[15px] text-white">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={busy}
          className="h-14 w-full rounded-[14px] bg-[#EF4444] text-[17px] font-bold text-white active:bg-[#DC2626] disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create Owner account'}
        </button>
      </form>

      <p className="mt-4 text-center text-[14px] text-[#A1A1AA]">
        Already have an account?{' '}
        <Link href="/admin/login" className="font-semibold text-[#EF4444]">
          Sign in
        </Link>
      </p>
    </>
  );
}
