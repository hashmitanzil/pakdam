import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const {
  ADMIN_FLAG_DEFS,
  ADMIN_FUTURE_FLAGS,
  ADMIN_WIRED_FLAGS,
  ADMIN_CONFIG_DEFAULTS,
  ADMIN_CONFIG_LIMITS,
  ADMIN_NAV,
  ADMIN_PERMISSIONS,
  FUTURE_UPGRADE_MESSAGE,
  HOST_PASS_PLAN,
  adminCan,
  adminConfigError,
  adminFlagWired,
  adminFutureFlagEnabled,
  adminNavFor,
} = await import('../src/admin.ts');

// Mission Control RBAC matrix (packages/shared/src/admin.ts) — the
// server enforces this table on every /v1/admin/* route; the client
// only mirrors it for display. This test pins the matrix: every
// role × every permission, allowed AND denied.

test('owner holds every permission in the matrix', () => {
  for (const permission of Object.keys(ADMIN_PERMISSIONS)) {
    assert.equal(adminCan('owner', permission), true, `owner must hold ${permission}`);
  }
});

test('admin holds everything except live locations and user management', () => {
  assert.equal(adminCan('admin', 'players.viewLocation'), false);
  assert.equal(adminCan('admin', 'view.users'), false);
  assert.equal(adminCan('admin', 'users.manage'), false);
  for (const permission of [
    'view.overview',
    'view.rooms',
    'view.players',
    'view.flags',
    'view.config',
    'view.safety',
    'view.costs',
    'view.numbers',
    'view.audit',
    'view.announcements',
    'view.billing',
    'view.accounts',
    'rooms.end',
    'rooms.cancel',
    'rooms.forceResults',
    'players.kick',
    'players.block',
    'players.unblock',
    'flags.edit',
    'config.edit',
    'safety.createFlag',
    'safety.unblock',
    'announcements.edit',
  ]) {
    assert.equal(adminCan('admin', permission), true, `admin must hold ${permission}`);
  }
});

test('staff is view-only plus creating safety flags — no mutations, no live location', () => {
  for (const permission of [
    'view.overview',
    'view.rooms',
    'view.players',
    'view.flags',
    'view.config',
    'view.safety',
    'view.costs',
    'view.numbers',
    'view.audit',
    'view.announcements',
    'view.accounts',
    'safety.createFlag',
  ]) {
    assert.equal(adminCan('staff', permission), true, `staff must hold ${permission}`);
  }
  for (const permission of [
    'rooms.end',
    'rooms.cancel',
    'rooms.forceResults',
    'players.kick',
    'players.block',
    'players.unblock',
    'players.viewLocation',
    'flags.edit',
    'config.edit',
    'safety.unblock',
    'announcements.edit',
    'users.manage',
    'view.users',
    'view.billing',
  ]) {
    assert.equal(adminCan('staff', permission), false, `staff must NOT hold ${permission}`);
  }
});

test('erasure is Owner-only; password change is self-service for every role — own password only (fix round B3 re-review)', () => {
  assert.equal(adminCan('owner', 'players.erase'), true);
  assert.equal(adminCan('owner', 'users.changePassword'), true);
  assert.equal(adminCan('admin', 'players.erase'), false);
  assert.equal(adminCan('admin', 'users.changePassword'), true, 'an Admin rotates their own password — the endpoint takes no target user');
  assert.equal(adminCan('staff', 'players.erase'), false);
  assert.equal(adminCan('staff', 'users.changePassword'), true, 'a Staff member rotates their own password');
});

test('unknown roles and unknown permissions deny', () => {
  assert.equal(adminCan(null, 'view.rooms'), false);
  assert.equal(adminCan('superuser', 'view.rooms'), false);
  assert.equal(adminCan('owner', 'no.such.permission'), false);
});

test('billing/accounts nav is gated per role', () => {
  const ownerHrefs = adminNavFor('owner').map((n) => n.href);
  assert.ok(ownerHrefs.includes('/admin/billing'));
  assert.ok(ownerHrefs.includes('/admin/accounts'));
  assert.ok(ownerHrefs.includes('/admin/users'));
  const adminHrefs = adminNavFor('admin').map((n) => n.href);
  assert.ok(adminHrefs.includes('/admin/billing'));
  assert.ok(adminHrefs.includes('/admin/accounts'));
  assert.ok(!adminHrefs.includes('/admin/users'), 'admin must not see the Users page');
  const staffHrefs = adminNavFor('staff').map((n) => n.href);
  assert.ok(!staffHrefs.includes('/admin/billing'), 'staff must not see Billing');
  assert.ok(staffHrefs.includes('/admin/accounts'));
  assert.ok(!staffHrefs.includes('/admin/users'));
  assert.equal(ADMIN_NAV.length, 14); // +1 fix round 2: Change password, visible to every role
});

test('future flags are all OFF by default, with unlock copy', () => {
  assert.equal(FUTURE_UPGRADE_MESSAGE, 'Not available at the moment — future upgrade.');
  for (const flag of ADMIN_FUTURE_FLAGS) {
    assert.equal(flag.enabled, false, `${flag.key} must default OFF`);
    assert.ok(flag.unlocksWhen.length > 0, `${flag.key} needs unlock copy`);
    assert.ok(flag.willDo.length > 0, `${flag.key} needs will-do copy`);
  }
  const keys = ADMIN_FUTURE_FLAGS.map((f) => f.key);
  for (const key of [
    'billing.overview',
    'billing.transactions',
    'billing.plans',
    'billing.providers',
    'billing.refunds',
    'billing.tax',
    'accounts.directory',
    'accounts.dataRequests',
    'accounts.loginMethods',
  ]) {
    assert.ok(keys.includes(key), `missing future flag ${key}`);
  }
});

test('gameStart kill-switch flag exists in the flag defs', () => {
  const def = ADMIN_FLAG_DEFS.find((d) => d.key === 'gameStart');
  assert.ok(def, 'gameStart must be a switchable flag');
  assert.match(def.explainer, /no new match can start/);
});

test('Host Pass is planned, never on sale', () => {
  assert.equal(HOST_PASS_PLAN.priceLabel, '₹299');
  assert.equal(HOST_PASS_PLAN.pricePaise, 29900);
  assert.equal(HOST_PASS_PLAN.status, 'planned');
  assert.match(HOST_PASS_PLAN.statusCopy, /not on sale/);
  assert.match(HOST_PASS_PLAN.statusCopy, /Legal gate/);
});

test('game-config defaults match the live calibration values', () => {
  assert.deepEqual(ADMIN_CONFIG_DEFAULTS, {
    roundLengthMinutes: 30,
    headStartMinutes: 3,
    pingIntervalMinutes: 3,
    zoneRadiusMetres: 500,
    shrinkEverySeconds: 600,
    zoneShrinkEnabled: true,
  });
  assert.deepEqual(ADMIN_CONFIG_LIMITS.roundLengthMinutes, { min: 5, max: 180 });
  assert.equal(adminConfigError('roundLengthMinutes', 30), null);
  assert.equal(adminConfigError('roundLengthMinutes', 4), 'Too small — the smallest allowed is 5.');
  assert.equal(adminConfigError('zoneRadiusMetres', 6000), 'Too big — the largest allowed is 5000.');
  assert.equal(adminConfigError('pingIntervalMinutes', 31), 'Too big — the largest allowed is 30.');
});

test('gameStart is wired, not a placebo (merge, Meera fix 2)', () => {
  assert.ok(ADMIN_WIRED_FLAGS.includes('radio'), 'radio stays wired');
  assert.ok(ADMIN_WIRED_FLAGS.includes('gameStart'), 'gameStart is wired: handleStart refuses new matches when OFF');
  assert.equal(adminFlagWired('gameStart'), true);
  for (const key of ['pings', 'zone', 'demoMode', 'voiceText', 'qrInvite']) {
    assert.equal(adminFlagWired(key), false, `${key} is not consumed by the game`);
  }
});

test('future flags carry labels for the flags page', () => {
  for (const f of ADMIN_FUTURE_FLAGS) {
    assert.ok(typeof f.label === 'string' && f.label.length > 0, `${f.key} needs a label`);
    assert.equal(f.enabled, false, `${f.key} defaults OFF`);
  }
  assert.equal(ADMIN_FUTURE_FLAGS.find((f) => f.key === 'billing.overview').label, 'Billing — overview');
});

test('adminFutureFlagEnabled reads the fetched flag list (missing = OFF)', () => {
  const rows = [
    { key: 'billing.overview', enabled: true },
    { key: 'billing.tax', enabled: false },
  ];
  assert.equal(adminFutureFlagEnabled(rows, 'billing.overview'), true);
  assert.equal(adminFutureFlagEnabled(rows, 'billing.tax'), false);
  assert.equal(adminFutureFlagEnabled(rows, 'billing.plans'), false, 'absent row means OFF, never ON');
  assert.equal(adminFutureFlagEnabled(null, 'billing.overview'), false);
  assert.equal(adminFutureFlagEnabled(undefined, 'billing.overview'), false);
});
