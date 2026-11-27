'use client';

/**
 * Admin shell — Mission Control layout.
 *
 * Every /admin page except /admin/login and /admin/setup renders
 * inside this shell: the session guard (no session → login), the
 * role-filtered nav (from the shared matrix — never a second copy),
 * and Sign out. The nav hides what the role may not open; the
 * server still enforces every route and action — the UI gating is
 * usability only.
 */
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { adminNavFor, adminRoleLabel } from '@pakdam/shared';
import { adminLogout } from '../../lib/admin/admin-client';
import { clearAdminSession } from '../../lib/admin/admin-session';
import { useAdminSessionGuard } from '../../lib/admin/use-admin';

const PUBLIC_ADMIN_PATHS = ['/admin/login', '/admin/setup'];

export default function AdminLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { me, ready } = useAdminSessionGuard();

  if (PUBLIC_ADMIN_PATHS.includes(pathname ?? '')) {
    return <main className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col px-4 pb-6 pt-6">{children}</main>;
  }

  const handleSignOut = async () => {
    await adminLogout();
    clearAdminSession();
    router.replace('/admin/login');
  };

  if (!ready || !me) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col px-4 pb-6 pt-6">
        <p role="status" className="py-6 text-center text-[15px] text-[#A1A1AA]">
          Checking your session…
        </p>
      </main>
    );
  }

  const nav = adminNavFor(me.role);
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col px-4 pb-6 pt-6">
      <header className="flex items-center justify-between gap-3">
        <div>
          <p className="pakdam-display text-[24px] leading-none text-white">
            PAKDAM <span className="text-[#EF4444]">CONTROL</span>
          </p>
          <p className="mt-1 text-[13px] text-[#A1A1AA]">
            {me.username} · {adminRoleLabel(me.role)}
          </p>
        </div>
        <button
          type="button"
          onClick={handleSignOut}
          className="min-h-[48px] rounded-[14px] border border-[#26262B] bg-[#141416] px-4 text-[14px] font-semibold text-white"
        >
          Sign out
        </button>
      </header>

      <nav aria-label="Admin sections" className="mt-4 flex flex-col gap-2">
        {nav.map((item) => {
          const active = pathname === item.href || (item.href !== '/admin' && pathname?.startsWith(`${item.href}/`));
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={`flex items-center justify-between rounded-[14px] border px-4 py-3 ${
                active ? 'border-[#EF4444]/50 bg-[#141416]' : 'border-[#26262B] bg-[#141416]'
              }`}
            >
              <span>
                <span className="block text-[15px] font-bold text-white">{item.label}</span>
                <span className="mt-0.5 block text-[13px] text-[#A1A1AA]">{item.blurb}</span>
              </span>
              <span aria-hidden className="text-[18px] text-[#EF4444]">
                →
              </span>
            </Link>
          );
        })}
      </nav>

      <main className="mt-6 flex flex-col gap-4">{children}</main>

      <p className="mt-8 text-center text-[13px] text-[#A1A1AA]">
        Mission Control — the server checks every action. What you see here is for ease of use only.
      </p>
    </div>
  );
}
