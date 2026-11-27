/**
 * Admin fix-round tests (Meera) — Zara B1/B3/n2/n6/n10/M1/M5, Diya
 * BLOCKING/§4/§5.
 *
 * Pins:
 * 1. Setup sends the setup token; a 403 surfaces the one generic
 *    line, never whether the token or the account was the problem.
 * 2. Costs with an unknown DO meter shows "Usage unknown — check
 *    the Cloudflare dashboard" with no green badge and no
 *    "within limits" copy.
 * 3. Live location renders coordinates as text (Owner only).
 * 4. Ban copy is honest everywhere (seat's stored sign-in only).
 * 5. Unwired flags + game config carry the placebo label; radio
 *    (wired) does not.
 * 6. The admin client rejects non-https Worker URLs (localhost
 *    excepted) — tokens never travel over plaintext.
 * 7. Password policy is 12+ characters.
 * 8. Public reads strip admin usernames (updatedBy/createdBy).
 * 9. Change-password + revoke-sessions hit the specified endpoints
 *    and surface a plain line when the server has no such route yet.
 */
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

register('./resolve-hooks.mjs', import.meta.url);

const {
  ADMIN_BAN_HONEST_COPY,
  ADMIN_CONFIG_PLACEBO_LABEL,
  ADMIN_PLACEBO_LABEL,
  ADMIN_SETUP_FAILED_MESSAGE,
  ADMIN_UNKNOWN_METER_COPY,
  adminFlagWired,
  adminPasswordError,
} = await import('@pakdam/shared');

const client = await import('../src/lib/admin/admin-client.ts');
const {
  ADMIN_NOT_ON_SERVER_YET_MESSAGE,
  adminChangePassword,
  adminRevokeUserSessions,
  adminSetup,
  adminWorkerUrlError,
  getPublicAnnouncement,
  getPublicFlags,
  stripPublicAnnouncement,
  stripPublicFlag,
} = client;

function read(rel) {
  return readFileSync(new URL(rel, import.meta.url), 'utf8');
}

/* A stub fetch that records the last call and answers from a queue. */
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

/* --- 1. Setup token ------------------------------------------------ */
test('setup sends the setup token in the body', async () => {
  responses.push({ status: 201, body: { token: 'tok', username: 'owner', role: 'owner' } });
  await adminSetup('owner', 'a-very-long-password', 'secret-token-1');
  assert.ok(String(lastCall.url).endsWith('/v1/admin/auth/setup'));
  const body = JSON.parse(lastCall.init.body);
  assert.equal(body.setupToken, 'secret-token-1');
  assert.equal(body.username, 'owner');
});

test('setup 403 surfaces the one generic line, never the cause', async () => {
  responses.push({ status: 403, body: { error: 'Setup token is wrong.', code: 'FORBIDDEN' } });
  await assert.rejects(
    adminSetup('owner', 'a-very-long-password', 'wrong-token'),
    (err) => {
      assert.equal(err.message, ADMIN_SETUP_FAILED_MESSAGE);
      assert.equal(err.message, 'Setup failed — check the setup token and try again.');
      assert.ok(!err.message.toLowerCase().includes('token is wrong'));
      return true;
    },
  );
});

test('setup page: token field is required and password-masked', () => {
  const src = read('../src/app/admin/setup/page.tsx');
  assert.ok(src.includes('setupToken'), 'setup page has a setupToken field');
  assert.ok(src.includes('type="password"'), 'token field is password-masked');
  assert.ok(src.includes('required'), 'token field is required');
  assert.ok(src.includes('if (!setupToken)'), 'empty token is refused client-side');
  assert.ok(src.includes('adminSetup(username.trim(), password, setupToken)'), 'token is sent');
});

/* --- 2. Costs unknown meter ---------------------------------------- */
test('costs page: unknown meter shows the unknown copy, no green badge, no "within limits"', () => {
  const src = read('../src/app/admin/costs/page.tsx');
  assert.ok(src.includes('ADMIN_UNKNOWN_METER_COPY'), 'costs uses the shared unknown-meter copy');
  assert.equal(ADMIN_UNKNOWN_METER_COPY, 'Usage unknown — check the Cloudflare dashboard');
  // The green "Within limits." badge lives ONLY inside the measured
  // branch (data.doMeter absent). The unknown branch renders no
  // badge and no "within limits" copy.
  const unknownBranch = src.split('data.doMeter ?')[1] ?? '';
  const unknownBlock = unknownBranch.split(': (')[0] ?? '';
  assert.ok(!unknownBlock.includes('Within limits.'), 'unknown branch must not say "Within limits."');
  assert.ok(!unknownBlock.includes('text-[#22C55E]'), 'unknown branch must not render a green badge');
  assert.ok(src.includes('never shows a green'), 'the page states the rule in plain words');
});

/* --- 3. Live location renders coordinates (Owner only) ------------- */
test('players page renders coordinates as text, Owner-only, with the notice', () => {
  const src = read('../src/app/admin/players/page.tsx');
  assert.ok(src.includes("adminCan(role, 'players.viewLocation')"), 'location gated on the shared matrix');
  assert.ok(src.includes('loc.latitude.toFixed(5)'), 'latitude is rendered');
  assert.ok(src.includes('loc.longitude.toFixed(5)'), 'longitude is rendered');
  assert.ok(src.includes('ADMIN_LOCATION_NOTICE'), 'in-session-only notice shown with the coordinates');
});

/* --- 4. Ban honesty ------------------------------------------------- */
test('ban copy is honest on safety, accounts detail and players pages', () => {
  assert.equal(
    ADMIN_BAN_HONEST_COPY,
    "Blocks this seat's stored sign-in. A player on a fresh device can rejoin.",
  );
  for (const page of [
    '../src/app/admin/safety/page.tsx',
    '../src/app/admin/accounts/[playerId]/page.tsx',
    '../src/app/admin/players/page.tsx',
  ]) {
    const src = read(page);
    assert.ok(src.includes('ADMIN_BAN_HONEST_COPY'), `${page} uses the honest ban copy`);
    assert.ok(!src.includes('Block this device'), `${page} must not say "Block this device"`);
    assert.ok(!src.includes('Ban device'), `${page} must not say "Ban device"`);
    assert.ok(!src.includes('Blocks this device from joining any game'), `${page} must not imply a full device block`);
  }
});

/* --- 5. Placebo labels ---------------------------------------------- */
test('radio and gameStart are wired; every other game flag is a placebo', () => {
  assert.equal(adminFlagWired('radio'), true, 'radio is wired (DO reads it)');
  // Merge, 2026-11-27 (Meera fix 2): gameStart IS wired — handleStart
  // refuses new matches when it is OFF — so the flags page must never
  // call it a placebo. An Owner toggling it off blocks all new games.
  assert.equal(adminFlagWired('gameStart'), true, 'gameStart is wired (handleStart consults it)');
  for (const key of ['pings', 'zone', 'demoMode', 'voiceText', 'qrInvite']) {
    assert.equal(adminFlagWired(key), false, `${key} is not consumed by the game`);
  }
  assert.equal(ADMIN_PLACEBO_LABEL, 'Not connected yet — changing this does nothing in the game today.');
  const flagsSrc = read('../src/app/admin/flags/page.tsx');
  assert.ok(flagsSrc.includes('adminFlagWired(def.key)'), 'flags page labels per flag');
  assert.ok(flagsSrc.includes('ADMIN_PLACEBO_LABEL'), 'flags page renders the placebo label');
  const configSrc = read('../src/app/admin/config/page.tsx');
  assert.ok(configSrc.includes('ADMIN_CONFIG_PLACEBO_LABEL'), 'config page carries the placebo banner');
  assert.equal(
    ADMIN_CONFIG_PLACEBO_LABEL,
    'Not connected yet — changing these settings does nothing in the game today.',
  );
});

test('future flags are listed and flippable on the flags page (Owner-only), never placebo-labelled', () => {
  const flagsSrc = read('../src/app/admin/flags/page.tsx');
  assert.ok(flagsSrc.includes('ADMIN_FUTURE_FLAGS'), 'flags page renders the future-capability section');
  assert.ok(flagsSrc.includes('Future capabilities'), 'future section is headed as future capabilities');
  assert.ok(flagsSrc.includes('isOwner'), 'future toggles are Owner-only in the UI');
  assert.ok(flagsSrc.includes('Only the Owner can switch this on'), 'non-Owners are told why the toggle is off');
  // Single-flag saves: the old whole-list save re-sent the future
  // flags on every game-flag toggle, and the server 403s any request
  // carrying a future flag from a non-Owner.
  assert.ok(flagsSrc.includes('saveAdminFlags([{ key, enabled }])'), 'each toggle saves one flag only');
  assert.ok(!flagsSrc.includes('data.map((f) => ({ key: f.key'), 'no whole-list re-send on toggle');
});

/* --- 6. HTTPS assertion --------------------------------------------- */
test('admin client rejects non-https Worker URLs except localhost', () => {
  assert.equal(adminWorkerUrlError('https://worker.example.test'), null);
  assert.equal(adminWorkerUrlError('http://localhost:8787'), null);
  assert.equal(adminWorkerUrlError('http://127.0.0.1:8787'), null);
  assert.equal(
    adminWorkerUrlError('http://worker.example.test'),
    'The game server address must use https — sign-in is blocked over an insecure connection.',
  );
  assert.equal(adminWorkerUrlError(''), 'The game server address is not set up yet.');
  // The guard is wired into every admin call path.
  const clientSrc = read('../src/lib/admin/admin-client.ts');
  assert.ok(clientSrc.includes('checkedWorkerUrl()'), 'all admin calls go through the checked URL');
  assert.ok((clientSrc.match(/checkedWorkerUrl\(\)/g) ?? []).length >= 4, 'login, setup, adminFetch and public reads all check');
});

/* --- 7. Password policy is 12+ -------------------------------------- */
test('admin passwords must be 12+ characters, in plain words', () => {
  assert.equal(adminPasswordError('short'), 'Too short — use at least 12 characters.');
  assert.equal(adminPasswordError('eleven-char'), 'Too short — use at least 12 characters.');
  assert.equal(adminPasswordError('twelve-chars!'), null);
  for (const page of ['../src/app/admin/setup/page.tsx', '../src/app/admin/users/page.tsx']) {
    const src = read(page);
    assert.ok(!src.includes('At least 8 characters'), `${page} must not say 8 characters any more`);
    assert.ok(src.includes('ADMIN_PASSWORD_POLICY_COPY'), `${page} shows the 12+ policy`);
  }
  const changeSrc = read('../src/app/admin/change-password/page.tsx');
  assert.ok(changeSrc.includes('adminPasswordError(newPassword)'), 'change-password enforces 12+ too');
});

/* --- 8. Public reads strip admin usernames -------------------------- */
test('public flag strip drops updatedBy/updatedAt', () => {
  const stripped = stripPublicFlag({
    key: 'radio',
    label: 'Radio (voice)',
    explainer: 'Lets players talk.',
    enabled: true,
    updatedBy: 'owner',
    updatedAt: '2026-11-25T00:00:00Z',
  });
  assert.deepEqual(stripped, { key: 'radio', label: 'Radio (voice)', explainer: 'Lets players talk.', enabled: true });
  assert.ok(!('updatedBy' in stripped));
});

test('public announcement strip drops createdBy/createdAt/updatedAt', () => {
  const stripped = stripPublicAnnouncement({
    id: 'a1',
    message: 'Hello',
    active: true,
    createdBy: 'owner',
    createdAt: '2026-11-25T00:00:00Z',
    updatedAt: '2026-11-25T00:00:00Z',
  });
  assert.deepEqual(stripped, { id: 'a1', message: 'Hello', active: true });
  assert.equal(stripPublicAnnouncement(null), null);
});

test('getPublicFlags/getPublicAnnouncement never return admin usernames even if the server sends them', async () => {
  responses.push({
    status: 200,
    body: [
      { key: 'radio', label: 'Radio', explainer: 'x', enabled: true, updatedBy: 'owner', updatedAt: 't' },
    ],
  });
  const flags = await getPublicFlags();
  assert.equal(flags.length, 1);
  assert.ok(!('updatedBy' in flags[0]), 'leaked updatedBy must be stripped client-side');
  responses.push({
    status: 200,
    body: { id: 'a1', message: 'Hi', active: true, createdBy: 'owner', createdAt: 't', updatedAt: 't' },
  });
  const announcement = await getPublicAnnouncement();
  assert.ok(announcement && !('createdBy' in announcement), 'leaked createdBy must be stripped client-side');
});

/* --- 9. Change-password + revoke-sessions ---------------------------- */
test('change-password posts current + new to the specified endpoint', async () => {
  responses.push({ status: 200, body: { ok: true } });
  await adminChangePassword('old-password-123', 'new-password-456');
  assert.ok(String(lastCall.url).endsWith('/v1/admin/auth/change-password'));
  assert.equal(lastCall.init.method, 'POST');
  const body = JSON.parse(lastCall.init.body);
  assert.equal(body.currentPassword, 'old-password-123');
  assert.equal(body.newPassword, 'new-password-456');
});

test('revoke-sessions posts to the user endpoint with confirm copy in the UI', async () => {
  responses.push({ status: 200, body: { ok: true } });
  await adminRevokeUserSessions('user-1');
  assert.ok(String(lastCall.url).endsWith('/v1/admin/users/user-1/revoke-sessions'));
  const usersSrc = read('../src/app/admin/users/page.tsx');
  assert.ok(usersSrc.includes('Revoke all sessions'), 'users page has the revoke control');
  assert.ok(
    usersSrc.includes('Signs this account out on every device and browser. They will need to sign in again.'),
    'revoke carries a plain-words consequence line',
  );
});

test('missing server endpoints surface a plain "not available yet" line, never a crash', async () => {
  responses.push({ status: 404, body: { error: 'Not found' } });
  await assert.rejects(adminChangePassword('old-password-123', 'new-password-456'), (err) => {
    assert.equal(err.message, ADMIN_NOT_ON_SERVER_YET_MESSAGE);
    return true;
  });
  responses.push({ status: 404, body: { error: 'Not found' } });
  await assert.rejects(adminRevokeUserSessions('user-1'), (err) => {
    assert.equal(err.message, ADMIN_NOT_ON_SERVER_YET_MESSAGE);
    return true;
  });
});

test('forced-change state is surfaced: login routes to change-password, users list shows the badge', () => {
  const loginSrc = read('../src/app/admin/login/page.tsx');
  assert.ok(loginSrc.includes('mustChangePassword'), 'login reads the forced-change flag');
  assert.ok(loginSrc.includes('/admin/change-password?forced=1'), 'forced change routes to the change page');
  const usersSrc = read('../src/app/admin/users/page.tsx');
  assert.ok(usersSrc.includes('Must change password'), 'users list shows the forced-change badge');
  const changeSrc = read('../src/app/admin/change-password/page.tsx');
  assert.ok(changeSrc.includes("forced=1") || changeSrc.includes("forced') === '1'"), 'change page names the forced case');
});
