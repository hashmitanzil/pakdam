/**
 * Admin fix round 2 (client) — forced password change, post-rotation
 * re-login, and the shell /me flag (Meera NO-GO gaps 1–3 + nits).
 *
 * These tests pin BEHAVIOUR through the real client functions with a
 * mocked fetch — not source strings (the round-1 test that only
 * asserted source strings is exactly how these gaps shipped green):
 *
 * - a 403 PASSWORD_CHANGE_REQUIRED from /me (or any data fetch)
 *   is recognised as such, and the server's message is kept instead
 *   of the generic "You don't have permission for this."
 * - the redirect decision (`passwordChangeRedirectFor`) sends a
 *   flagged session to /admin/change-password?forced=1 on every
 *   panel page, and NEVER on the change page itself (no loop) or
 *   the public login/setup pages (the shell covers login via /admin).
 * - `adminChangePassword` returns the server's `reLogin` flag.
 * - the Change password nav entry is visible to Owner, Admin AND
 *   Staff (the flagged user's in-panel escape route).
 *
 * Deliberately NOT pinned here (stated, not fudged): the React
 * wiring itself — `useAdminSessionGuard` / `useAdminData` calling
 * `router.replace()` with the helper's result, the change-password
 * page clearing the session + routing to /admin/login?relogin=1 on
 * `reLogin`, and the login page rendering the notice for
 * `?relogin=1` — cannot run in this node unit harness (no React /
 * next/navigation renderer; Playwright is excluded in this VM).
 * Those three wirings are thin calls to the pinned helpers above
 * and are covered by typecheck + review, not by a test.
 */
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('./resolve-hooks.mjs', import.meta.url);

const { ADMIN_NAV, adminNavFor } = await import('@pakdam/shared');

const client = await import('../src/lib/admin/admin-client.ts');
const {
  ADMIN_CHANGE_PASSWORD_URL,
  ADMIN_PASSWORD_CHANGE_REQUIRED_MESSAGE,
  ADMIN_RELOGIN_NOTICE,
  AdminApiError,
  PASSWORD_CHANGE_REQUIRED_CODE,
  adminChangePassword,
  adminErrorMessage,
  adminMe,
  isPasswordChangeRequiredError,
  passwordChangeRedirectFor,
} = client;

/* A stub fetch that answers from a queue (same pattern as admin-fixround). */
let lastCall = null;
const responses = [];
globalThis.fetch = async (url, init) => {
  lastCall = { url, init };
  const next = responses.shift() ?? { status: 200, body: {} };
  return {
    ok: next.status >= 200 && next.status < 300,
    status: next.status,
    headers: { get: () => null },
    json: async () => next.body,
  };
};
process.env.NEXT_PUBLIC_WORKER_URL = 'https://worker.example.test';

/* --- Gap 1: the 403 is recognised, the server message is kept ------ */
test('403 PASSWORD_CHANGE_REQUIRED from /me is recognised and keeps the server message', async () => {
  responses.push({
    status: 403,
    body: { error: 'You must change your password before using the admin panel.', code: 'PASSWORD_CHANGE_REQUIRED' },
  });
  await assert.rejects(adminMe(), (err) => {
    assert.ok(err instanceof AdminApiError);
    assert.equal(err.status, 403);
    assert.equal(err.kind, 'forbidden');
    assert.equal(err.code, PASSWORD_CHANGE_REQUIRED_CODE);
    assert.equal(err.code, 'PASSWORD_CHANGE_REQUIRED');
    // The server's message survives — NOT the generic forbidden line.
    assert.equal(err.message, 'You must change your password before using the admin panel.');
    assert.ok(!err.message.includes("You don't have permission"));
    assert.equal(isPasswordChangeRequiredError(err), true);
    return true;
  });
  assert.ok(String(lastCall.url).endsWith('/v1/admin/auth/me'));
});

test('a plain 403 (no PASSWORD_CHANGE_REQUIRED code) still gets the generic line', async () => {
  responses.push({ status: 403, body: { error: 'Forbidden.', code: 'FORBIDDEN' } });
  await assert.rejects(adminMe(), (err) => {
    assert.equal(err.message, "You don't have permission for this.");
    assert.equal(isPasswordChangeRequiredError(err), false);
    return true;
  });
});

test('isPasswordChangeRequiredError only fires for that exact code', () => {
  assert.equal(
    isPasswordChangeRequiredError(new AdminApiError(403, 'x', 'forbidden', 'PASSWORD_CHANGE_REQUIRED')),
    true,
  );
  assert.equal(isPasswordChangeRequiredError(new AdminApiError(403, 'x', 'forbidden', 'FORBIDDEN')), false);
  assert.equal(isPasswordChangeRequiredError(new AdminApiError(401, 'x', 'unauthorized')), false);
  assert.equal(isPasswordChangeRequiredError(new Error('boom')), false);
  assert.equal(isPasswordChangeRequiredError(null), false);
});

test('adminErrorMessage keeps the server message for the flag code, falls back plainly without one', () => {
  assert.equal(
    adminErrorMessage(403, 'You must change your password before using the admin panel.', 'PASSWORD_CHANGE_REQUIRED'),
    'You must change your password before using the admin panel.',
  );
  assert.equal(
    adminErrorMessage(403, undefined, 'PASSWORD_CHANGE_REQUIRED'),
    ADMIN_PASSWORD_CHANGE_REQUIRED_MESSAGE,
  );
  assert.equal(adminErrorMessage(403, 'anything', 'FORBIDDEN'), "You don't have permission for this.");
  assert.equal(adminErrorMessage(403, 'anything'), "You don't have permission for this.");
});

/* --- Gaps 1 + 3: the redirect decision ------------------------------ */
test('flagged session redirects to the change page from every panel page', () => {
  assert.equal(passwordChangeRedirectFor('/admin', true), '/admin/change-password?forced=1');
  assert.equal(passwordChangeRedirectFor('/admin', true), ADMIN_CHANGE_PASSWORD_URL);
  assert.equal(passwordChangeRedirectFor('/admin/rooms', true), '/admin/change-password?forced=1');
  assert.equal(passwordChangeRedirectFor('/admin/users', true), '/admin/change-password?forced=1');
  assert.equal(passwordChangeRedirectFor('/admin/audit', true), '/admin/change-password?forced=1');
  assert.equal(passwordChangeRedirectFor(null, true), '/admin/change-password?forced=1');
});

test('flagged session does NOT redirect on the change page itself (no loop)', () => {
  assert.equal(passwordChangeRedirectFor('/admin/change-password', true), null);
});

test('flagged session does NOT redirect from the public login/setup pages (shell covers login via /admin)', () => {
  assert.equal(passwordChangeRedirectFor('/admin/login', true), null);
  assert.equal(passwordChangeRedirectFor('/admin/setup', true), null);
});

test('unflagged session never redirects, on any page', () => {
  assert.equal(passwordChangeRedirectFor('/admin', false), null);
  assert.equal(passwordChangeRedirectFor('/admin/rooms', false), null);
  assert.equal(passwordChangeRedirectFor('/admin/change-password', false), null);
});

/* --- Gap 2: post-rotation re-login ---------------------------------- */
test('adminChangePassword returns reLogin:true when the server revokes all sessions', async () => {
  responses.push({ status: 200, body: { ok: true, reLogin: true } });
  const result = await adminChangePassword('old-password-123', 'new-password-456');
  assert.deepEqual(result, { reLogin: true });
  assert.ok(String(lastCall.url).endsWith('/v1/admin/auth/change-password'));
});

test('adminChangePassword returns reLogin:false when the server sends no flag', async () => {
  responses.push({ status: 200, body: { ok: true } });
  const result = await adminChangePassword('old-password-123', 'new-password-456');
  assert.deepEqual(result, { reLogin: false });
});

test('the re-login notice tells the user to sign in again with the new password', () => {
  assert.equal(ADMIN_RELOGIN_NOTICE, 'Password changed. Sign in again with your new password.');
  assert.ok(ADMIN_RELOGIN_NOTICE.includes('new password'));
});

/* --- Gap 1 escape route: Change password in the nav for all roles --- */
test('Change password is in ADMIN_NAV and visible to owner, admin and staff', () => {
  const entry = ADMIN_NAV.find((n) => n.href === '/admin/change-password');
  assert.ok(entry, 'nav has a change-password entry');
  assert.equal(entry.label, 'Change password');
  for (const role of ['owner', 'admin', 'staff']) {
    assert.ok(
      adminNavFor(role).some((n) => n.href === '/admin/change-password'),
      `${role} sees Change password in the nav`,
    );
  }
});
