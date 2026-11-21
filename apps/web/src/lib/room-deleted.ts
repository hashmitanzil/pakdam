/**
 * Room-deleted handling (founder decisions, 2026-11-21): when the host
 * cancels, the room is deleted — every player still in it goes back
 * home with ONE plain message, identical on every page.
 *
 * The message travels in `sessionStorage` (per tab, consumed once by
 * Home), never in the URL — a room id or a "deleted" flag in the URL
 * would survive a reload and re-show the notice on a later visit.
 * `goHomeAfterRoomDeleted` also drops the dead seat, so reopening the
 * room URL does not resurrect a stale session.
 */
import type { AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { clearSession } from './session-credentials';

/** The one plain message, shown identically everywhere. */
export const ROOM_DELETED_MESSAGE = 'The host cancelled — this lobby is gone.';

const ROOM_DELETED_FLAG = 'pakdam:room-deleted';

/** Arm the one-shot home notice for this tab. */
export function markRoomDeleted(): void {
  try {
    window.sessionStorage.setItem(ROOM_DELETED_FLAG, '1');
  } catch {
    // Storage unavailable — the redirect still happens, just silent.
  }
}

/** Read + clear the one-shot flag. True only on the first home render after a deletion. */
export function takeRoomDeletedNotice(): boolean {
  try {
    if (window.sessionStorage.getItem(ROOM_DELETED_FLAG) !== '1') return false;
    window.sessionStorage.removeItem(ROOM_DELETED_FLAG);
    return true;
  } catch {
    return false;
  }
}

/**
 * Leave a deleted room: drop the dead seat, arm the home notice, and
 * replace the URL (no back-button return into a dead room). Safe to
 * call more than once — the second call is a no-op navigation.
 */
export function goHomeAfterRoomDeleted(router: AppRouterInstance, roomId: string): void {
  clearSession(roomId);
  markRoomDeleted();
  router.replace('/');
}
