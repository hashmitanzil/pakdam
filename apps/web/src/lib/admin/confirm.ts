/**
 * Two-step confirm state machine for destructive admin actions.
 *
 * A destructive action (End game, Cancel, Force to results, Kick,
 * Block, Delete) must be impossible to trigger by an accidental tap:
 * the first tap only ARMS the button (showing the consequence line),
 * the second tap — on the armed button — CONFIRMS. Any other tap,
 * a cancel, or a completed action DISARMS. The pure machine is
 * tested in apps/web/test/admin-confirm.test.mjs; the React wrapper
 * in components/admin/AdminUi.tsx renders it.
 */
export type ConfirmState = 'idle' | 'armed';

export type ConfirmEvent =
  | { type: 'tap' }
  | { type: 'cancel' }
  | { type: 'done' };

/**
 * Next state + whether the tap is the confirming one.
 * - idle + tap → armed, not confirmed (shows the consequence).
 * - armed + tap → idle, confirmed (the action runs now).
 * - cancel / done → idle, never confirmed.
 */
export function confirmNext(
  state: ConfirmState,
  event: ConfirmEvent,
): { state: ConfirmState; confirmed: boolean } {
  if (event.type === 'cancel' || event.type === 'done') {
    return { state: 'idle', confirmed: false };
  }
  if (state === 'idle') return { state: 'armed', confirmed: false };
  return { state: 'idle', confirmed: true };
}
