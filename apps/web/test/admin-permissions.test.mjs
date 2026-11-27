/**
 * Admin permissions tests (Meera) — the shared matrix in
 * packages/shared/src/admin.ts.
 *
 * Pins: Owner can do everything (incl. live locations + user
 * management); Admin can end/kick/switch/configure/announce but
 * NEVER sees exact live locations and NEVER manages users; Staff is
 * view-only + creating flags/reports, and cannot kick, end or
 * configure. Unknown roles deny. The Users page is Owner-only; the
 * live-location permission is Owner-only. Future flags default OFF;
 * Host Pass is planned, never on sale.
 */
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('./resolve-hooks.mjs', import.meta.url);

const {
  ADMIN_PERMISSIONS,
  ADMIN_FUTURE_FLAGS,
  HOST_PASS_PLAN,
  adminCan,
  adminNavFor,
  adminConfigError,
  adminCapAlertState,
  pickPublicAnnouncement,
  shouldShowAnnouncement,
  FUTURE_UPGRADE_MESSAGE,
} = await import('@pakdam/shared');

test('owner can do everything', () => {
  for (const perm of Object.keys(ADMIN_PERMISSIONS)) {
    assert.equal(adminCan('owner', perm), true, `owner should have ${perm}`);
  }
});

test('admin: end/kick/switch/config/announce yes; locations and users no', () => {
  assert.equal(adminCan('admin', 'rooms.end'), true);
  assert.equal(adminCan('admin', 'rooms.cancel'), true);
  assert.equal(adminCan('admin', 'rooms.forceResults'), true);
  assert.equal(adminCan('admin', 'players.kick'), true);
  assert.equal(adminCan('admin', 'players.block'), true);
  assert.equal(adminCan('admin', 'flags.edit'), true);
  assert.equal(adminCan('admin', 'config.edit'), true);
  assert.equal(adminCan('admin', 'announcements.edit'), true);
  assert.equal(adminCan('admin', 'players.viewLocation'), false, 'admin must never see exact live locations');
  assert.equal(adminCan('admin', 'view.users'), false, 'admin must never manage console accounts');
  assert.equal(adminCan('admin', 'users.manage'), false);
});

test('staff: view-only + create flags; cannot kick, end or configure', () => {
  assert.equal(adminCan('staff', 'view.overview'), true);
  assert.equal(adminCan('staff', 'view.rooms'), true);
  assert.equal(adminCan('staff', 'view.players'), true);
  assert.equal(adminCan('staff', 'safety.createFlag'), true, 'staff can create a flag/report');
  assert.equal(adminCan('staff', 'players.kick'), false);
  assert.equal(adminCan('staff', 'players.block'), false);
  assert.equal(adminCan('staff', 'rooms.end'), false);
  assert.equal(adminCan('staff', 'rooms.cancel'), false);
  assert.equal(adminCan('staff', 'rooms.forceResults'), false);
  assert.equal(adminCan('staff', 'flags.edit'), false);
  assert.equal(adminCan('staff', 'config.edit'), false);
  assert.equal(adminCan('staff', 'announcements.edit'), false);
  assert.equal(adminCan('staff', 'players.viewLocation'), false);
  assert.equal(adminCan('staff', 'users.manage'), false);
});

test('unknown / missing roles deny everything', () => {
  assert.equal(adminCan(null, 'view.overview'), false);
  assert.equal(adminCan(undefined, 'view.overview'), false);
  assert.equal(adminCan('superuser', 'view.overview'), false);
  assert.equal(adminCan('', 'rooms.end'), false);
});

test('nav: owner sees all 14 sections, admin 13 (no Users), staff 12 (no Users, no Billing)', () => {
  assert.equal(adminNavFor('owner').length, 14);
  assert.equal(adminNavFor('admin').length, 13);
  assert.equal(adminNavFor('admin').some((n) => n.href === '/admin/users'), false);
  assert.equal(adminNavFor('staff').length, 12);
  assert.equal(adminNavFor('staff').some((n) => n.href === '/admin/users'), false);
  assert.equal(adminNavFor('staff').some((n) => n.href === '/admin/billing'), false);
  assert.equal(adminNavFor('owner').some((n) => n.href === '/admin/billing'), true);
  assert.equal(adminNavFor('owner').some((n) => n.href === '/admin/accounts'), true);
});

test('config validation refuses bad values in plain words', () => {
  assert.equal(adminConfigError('roundLengthMinutes', 30), null);
  assert.equal(adminConfigError('roundLengthMinutes', 4), 'Too small — the smallest allowed is 5.');
  assert.equal(adminConfigError('roundLengthMinutes', 181), 'Too big — the largest allowed is 180.');
  assert.equal(adminConfigError('pingIntervalMinutes', 0), null, '0 = no pings is valid');
  assert.equal(adminConfigError('zoneRadiusMetres', 2.5), 'Enter a whole number, not a decimal.');
  assert.equal(adminConfigError('headStartMinutes', Number.NaN), 'Enter a whole number.');
});

test('cap alert state: ok < 75%, watch 75–90%, near-cap at 90%', () => {
  assert.equal(adminCapAlertState(100, 1000), 'ok');
  assert.equal(adminCapAlertState(750, 1000), 'watch');
  assert.equal(adminCapAlertState(900, 1000), 'near-cap');
  assert.equal(adminCapAlertState(100, 0), 'ok', 'no cap figure never alarms');
});

test('public announcement: only the newest active one shows; dismissed hides it', () => {
  const list = [
    { id: 'a1', message: 'Old', active: true, createdBy: null, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
    { id: 'a2', message: 'New', active: true, createdBy: null, createdAt: '2026-01-02', updatedAt: '2026-01-02' },
    { id: 'a3', message: 'Hidden', active: false, createdBy: null, createdAt: '2026-01-03', updatedAt: '2026-01-03' },
  ];
  assert.equal(pickPublicAnnouncement(list)?.id, 'a2');
  assert.equal(pickPublicAnnouncement([]), null);
  assert.equal(shouldShowAnnouncement(list[1], null), true);
  assert.equal(shouldShowAnnouncement(list[1], 'a2'), false, 'dismissed this session hides it');
  assert.equal(shouldShowAnnouncement(list[2], null), false, 'inactive never shows');
  assert.equal(shouldShowAnnouncement({ ...list[1], message: '   ' }, null), false, 'blank never shows');
  assert.equal(shouldShowAnnouncement(null, null), false);
});

test('future flags: every capability defaults OFF; Host Pass is planned, not on sale', () => {
  assert.equal(FUTURE_UPGRADE_MESSAGE, 'Not available at the moment — future upgrade.');
  for (const flag of ADMIN_FUTURE_FLAGS) {
    assert.equal(flag.enabled, false, `${flag.key} must default OFF`);
    assert.ok(flag.unlocksWhen.length > 0, `${flag.key} needs an unlock line`);
    assert.ok(flag.willDo.length > 0, `${flag.key} needs a will-do line`);
  }
  const keys = ADMIN_FUTURE_FLAGS.map((f) => f.key);
  for (const expected of [
    'billing.overview',
    'billing.transactions',
    'billing.plans',
    'billing.providers',
    'billing.refunds',
    'billing.tax',
    'accounts.directory',
    'accounts.roles',
    'accounts.bans',
    'accounts.dataRequests',
    'accounts.loginMethods',
  ]) {
    assert.ok(keys.includes(expected), `missing future flag ${expected}`);
  }
  assert.equal(HOST_PASS_PLAN.status, 'planned');
  assert.equal(HOST_PASS_PLAN.priceLabel, '₹299');
  assert.equal(HOST_PASS_PLAN.statusCopy, 'Planned — not on sale. Legal gate pending.');
});
