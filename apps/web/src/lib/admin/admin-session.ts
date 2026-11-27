/**
 * Admin session — Mission Control sign-in storage.
 *
 * Follows the game's existing token pattern exactly
 * (apps/web/src/lib/session-credentials.ts): the bearer token lives in
 * sessionStorage ONLY — never localStorage (survives tab close, shared
 * across tabs), never in a URL, never logged. One tab = one admin
 * session; closing the tab signs the admin out. The token is held in
 * memory by the layout after sign-in and re-read from sessionStorage
 * on navigation, so a reload in the same tab stays signed in.
 *
 * No new storage pattern was invented: this mirrors the game seat
 * token on purpose, so the same trade-offs and the same audit rules
 * apply.
 */
import type { AdminMe, AdminRole } from '@pakdam/shared';

/** One sessionStorage key for the whole admin session. */
export const ADMIN_SESSION_KEY = 'pakdam.admin.session.v1';
/** Notice shown once after a redirect (e.g. a non-Owner opening /admin/users). */
export const ADMIN_NOTICE_KEY = 'pakdam.admin.notice.v1';

export interface AdminSession {
  token: string;
  username: string;
  role: AdminRole;
}

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined';
}

export function saveAdminSession(session: AdminSession): void {
  if (!isBrowser()) return;
  try {
    window.sessionStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(session));
  } catch {
    // Storage unavailable — the session lives only in memory for this tab.
  }
}

export function readAdminSession(): AdminSession | null {
  if (!isBrowser()) return null;
  try {
    const raw = window.sessionStorage.getItem(ADMIN_SESSION_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as AdminSession).token !== 'string' ||
      !(parsed as AdminSession).token ||
      typeof (parsed as AdminSession).username !== 'string' ||
      ((parsed as AdminSession).role !== 'owner' &&
        (parsed as AdminSession).role !== 'admin' &&
        (parsed as AdminSession).role !== 'staff')
    ) {
      return null;
    }
    return parsed as AdminSession;
  } catch {
    return null;
  }
}

export function clearAdminSession(): void {
  if (!isBrowser()) return;
  try {
    window.sessionStorage.removeItem(ADMIN_SESSION_KEY);
  } catch {
    // Already gone.
  }
}

export function saveAdminNotice(message: string): void {
  if (!isBrowser()) return;
  try {
    window.sessionStorage.setItem(ADMIN_NOTICE_KEY, message);
  } catch {
    // Notice lost; the page still works.
  }
}

/** Reads the one-shot notice and clears it, so a reload does not re-show it. */
export function takeAdminNotice(): string | null {
  if (!isBrowser()) return null;
  try {
    const raw = window.sessionStorage.getItem(ADMIN_NOTICE_KEY);
    if (raw) window.sessionStorage.removeItem(ADMIN_NOTICE_KEY);
    return raw;
  } catch {
    return null;
  }
}

export function adminSessionToMe(session: AdminSession | null): AdminMe | null {
  if (!session) return null;
  return { username: session.username, role: session.role };
}
