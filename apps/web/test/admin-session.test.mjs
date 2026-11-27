/**
 * Admin session + client-copy tests (Meera).
 *
 * Pins: the admin bearer token follows the game's token pattern —
 * sessionStorage ONLY (never localStorage, never a URL, never
 * logged); login errors never say whether the username or the
 * password was wrong; lockout copy names the wait; 401 means the
 * session ended, 403 means no permission.
 */
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

register('./resolve-hooks.mjs', import.meta.url);

const sessionStore = new Map();
const localStore = new Map();
globalThis.window = {
  sessionStorage: {
    getItem: (key) => sessionStore.get(key) ?? null,
    setItem: (key, value) => {
      sessionStore.set(key, value);
    },
    removeItem: (key) => {
      sessionStore.delete(key);
    },
  },
  localStorage: {
    getItem: (key) => localStore.get(key) ?? null,
    setItem: (key, value) => {
      localStore.set(key, value);
    },
    removeItem: (key) => {
      localStore.delete(key);
    },
  },
};

const {
  ADMIN_SESSION_KEY,
  ADMIN_NOTICE_KEY,
  saveAdminSession,
  readAdminSession,
  clearAdminSession,
  saveAdminNotice,
  takeAdminNotice,
} = await import('../src/lib/admin/admin-session.ts');

const { loginErrorCopy, adminErrorMessage, publicCacheTtlMs } = await import(
  '../src/lib/admin/admin-client.ts'
);

function reset() {
  sessionStore.clear();
  localStore.clear();
}

test('token lives in sessionStorage only — never localStorage', () => {
  reset();
  saveAdminSession({ token: 'tok-1', username: 'owner', role: 'owner' });
  assert.equal(sessionStore.get(ADMIN_SESSION_KEY) !== undefined, true);
  assert.equal(localStore.size, 0, 'nothing may be written to localStorage');
  assert.deepEqual(readAdminSession(), { token: 'tok-1', username: 'owner', role: 'owner' });
  clearAdminSession();
  assert.equal(readAdminSession(), null);
  assert.equal(sessionStore.size, 0);
});

test('a stored session with a bad role or empty token reads as signed out', () => {
  reset();
  sessionStore.set(ADMIN_SESSION_KEY, JSON.stringify({ token: '', username: 'x', role: 'owner' }));
  assert.equal(readAdminSession(), null);
  sessionStore.set(ADMIN_SESSION_KEY, JSON.stringify({ token: 't', username: 'x', role: 'superuser' }));
  assert.equal(readAdminSession(), null);
  sessionStore.set(ADMIN_SESSION_KEY, 'not-json{');
  assert.equal(readAdminSession(), null);
});

test('one-shot notice is read once then cleared', () => {
  reset();
  saveAdminNotice('Only the Owner can manage accounts.');
  assert.equal(takeAdminNotice(), 'Only the Owner can manage accounts.');
  assert.equal(takeAdminNotice(), null);
  assert.equal(sessionStore.has(ADMIN_NOTICE_KEY), false);
});

test('login errors never say whether the username or the password was wrong', () => {
  const wrong = 'Wrong username or password. Check both and try again.';
  assert.equal(loginErrorCopy(401), wrong);
  assert.equal(loginErrorCopy(400), wrong);
  assert.equal(loginErrorCopy(404), wrong);
  assert.ok(!loginErrorCopy(401).toLowerCase().includes('username is wrong'));
  assert.ok(!loginErrorCopy(401).toLowerCase().includes('password is wrong'));
});

test('lockout copy names the wait; too-many-tries is plain words', () => {
  assert.equal(
    loginErrorCopy(423),
    'Too many wrong tries — this account is locked for a while. Wait 15 minutes and try again.',
  );
  assert.equal(loginErrorCopy(429, 'ACCOUNT_LOCKED'), loginErrorCopy(423));
  assert.equal(loginErrorCopy(429), 'Too many tries — wait a moment and try again.');
});

test('401 = session ended, 403 = no permission, 404/409 plain words', () => {
  assert.equal(adminErrorMessage(401), 'Your session ended. Sign in again.');
  assert.equal(adminErrorMessage(403), "You don't have permission for this.");
  assert.equal(adminErrorMessage(404), 'That was not found — it may have been removed.');
  assert.equal(adminErrorMessage(409), 'That conflicts with something that already exists.');
  assert.equal(adminErrorMessage(500), 'Something went wrong — try again.');
  assert.equal(adminErrorMessage(500, 'Custom server message'), 'Custom server message');
});

test('public reads cache for 60 s', () => {
  assert.equal(publicCacheTtlMs(), 60_000);
});

test('source pins: no token in a URL, no token logging, sessionStorage only', () => {
  const sessionSrc = readFileSync(new URL('../src/lib/admin/admin-session.ts', import.meta.url), 'utf8');
  assert.ok(!/window\.localStorage|localStorage\.(getItem|setItem|removeItem)/.test(sessionSrc), 'admin session must never use localStorage');
  assert.ok(sessionSrc.includes('sessionStorage'), 'admin session uses sessionStorage like the game tokens');
  const clientSrc = readFileSync(new URL('../src/lib/admin/admin-client.ts', import.meta.url), 'utf8');
  assert.ok(clientSrc.includes("Authorization', `Bearer"), 'bearer token sent as a header');
  assert.ok(!/console\.(log|info|debug)\([^)]*token/i.test(clientSrc), 'token must never be logged');
  assert.ok(!clientSrc.includes('?token='), 'token must never be put in a URL');
});
