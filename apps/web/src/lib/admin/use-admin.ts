'use client';

/**
 * Admin page hooks — session guard + data loading, shared by every
 * /admin page so each page stays small and behaves the same way.
 *
 * - `useAdminSessionGuard`: reads the session (sessionStorage, same
 *   pattern as the game tokens). No session → /admin/login. A 401
 *   from GET /me → session cleared, /admin/login. A 403
 *   PASSWORD_CHANGE_REQUIRED from /me, or `me.mustChangePassword`
 *   true, → /admin/change-password?forced=1 — EXCEPT on the change
 *   page itself, where a flagged user belongs (see
 *   `passwordChangeRedirectFor` in admin-client.ts: one decision,
 *   shared by the guard and every data fetch, so no page needs its
 *   own patch). The server is the authority; this only decides what
 *   the UI shows. The guard re-runs on navigation (pathname is a
 *   dep) so a session flagged mid-visit is caught on the next page,
 *   not only on reload.
 * - `useAdminData`: loading / error / retry around one loader. The
 *   loading state is a real signal (a fetch is in flight); the error
 *   state always carries a working Retry — except a 403
 *   PASSWORD_CHANGE_REQUIRED, which redirects to the change page
 *   instead of showing an error + a Retry that would keep failing.
 */
import { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import type { AdminMe } from '@pakdam/shared';
import {
  AdminApiError,
  adminMe,
  isPasswordChangeRequiredError,
  passwordChangeRedirectFor,
} from './admin-client';
import { clearAdminSession, readAdminSession, takeAdminNotice } from './admin-session';

export interface AdminSessionState {
  me: AdminMe | null;
  /** True once the guard has decided (signed in, or redirected). */
  ready: boolean;
}

export function useAdminSessionGuard(): AdminSessionState {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<AdminMe | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const session = readAdminSession();
    if (!session) {
      router.replace('/admin/login');
      return;
    }
    let cancelled = false;
    adminMe()
      .then((confirmed) => {
        if (cancelled) return;
        // /me returns mustChangePassword when the server sets it
        // (defence in depth — today /me 403s for a flagged session
        // instead, handled in the catch below, so this branch fires
        // only if the server ever starts returning the flag here).
        const redirect = passwordChangeRedirectFor(pathname, confirmed.mustChangePassword === true);
        if (redirect) {
          router.replace(redirect);
          return;
        }
        setMe(confirmed);
        setReady(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof AdminApiError && err.kind === 'unauthorized') {
          clearAdminSession();
          router.replace('/admin/login');
          return;
        }
        if (isPasswordChangeRequiredError(err)) {
          const redirect = passwordChangeRedirectFor(pathname, true);
          if (redirect) {
            router.replace(redirect);
            return;
          }
          // Already on the change page (or a public page): the user
          // is where they need to be. Render the shell from the
          // stored session, WITH the flag set — the change page
          // reads it for its copy — and let the change form run.
          setMe({ username: session.username, role: session.role, mustChangePassword: true });
          setReady(true);
          return;
        }
        // /me failed for another reason (network, server down) — trust
        // the stored session for the shell, show the role it carries,
        // and let each page's own fetch surface its error + Retry.
        // The server still enforces every action.
        setMe({ username: session.username, role: session.role });
        setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [router, pathname]);

  return { me, ready };
}

/** One-shot notice left by a redirect (e.g. non-Owner opening /admin/users). */
export function useAdminNotice(): string | null {
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    setNotice(takeAdminNotice());
  }, []);
  return notice;
}

export interface AdminDataState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  retry: () => void;
}

export function useAdminData<T>(loader: () => Promise<T>, deps: readonly unknown[] = []): AdminDataState<T> {
  const router = useRouter();
  const pathname = usePathname();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const retry = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loader()
      .then((value) => {
        if (cancelled) return;
        setData(value);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Mid-session flagging: the server now refuses this fetch
        // with 403 PASSWORD_CHANGE_REQUIRED. Redirect to the change
        // page — showing the error + Retry here would keep failing,
        // and the guard only re-checks /me on navigation/mount.
        // (On the change page itself this never fires: that page
        // uses no useAdminData loader.)
        if (isPasswordChangeRequiredError(err)) {
          const redirect = passwordChangeRedirectFor(pathname, true);
          if (redirect) {
            router.replace(redirect);
            return;
          }
        }
        setError(err instanceof Error ? err.message : 'Something went wrong — try again.');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, ...deps]);

  return { data, loading, error, retry };
}
