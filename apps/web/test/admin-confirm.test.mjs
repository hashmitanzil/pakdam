/**
 * Admin confirm-flow + role-gating source tests (Meera).
 *
 * Pins: the two-tap confirm machine (first tap arms, second
 * confirms, cancel/done disarms — a single accidental tap can never
 * run a destructive action); every destructive button in the
 * console goes through ConfirmAction; every page gates its actions
 * on the shared matrix (adminCan) instead of a second copy; the
 * Users page redirects non-Owners; the live-location button renders
 * only for the Owner; the billing/accounts pages render
 * NotAvailable and invent no identity fields or fake numbers.
 */
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

register('./resolve-hooks.mjs', import.meta.url);

const { confirmNext } = await import('../src/lib/admin/confirm.ts');

function read(rel) {
  return readFileSync(new URL(rel, import.meta.url), 'utf8');
}

test('confirm machine: first tap arms only, second tap confirms', () => {
  assert.deepEqual(confirmNext('idle', { type: 'tap' }), { state: 'armed', confirmed: false });
  assert.deepEqual(confirmNext('armed', { type: 'tap' }), { state: 'idle', confirmed: true });
});

test('confirm machine: cancel and done always disarm without confirming', () => {
  assert.deepEqual(confirmNext('armed', { type: 'cancel' }), { state: 'idle', confirmed: false });
  assert.deepEqual(confirmNext('idle', { type: 'cancel' }), { state: 'idle', confirmed: false });
  assert.deepEqual(confirmNext('armed', { type: 'done' }), { state: 'idle', confirmed: false });
});

test('ConfirmAction renders the consequence line only when armed', () => {
  const src = read('../src/components/admin/AdminUi.tsx');
  assert.ok(src.includes('consequence'), 'the consequence line is part of the component');
  assert.ok(src.includes('Tap again to'), 'the armed button names the confirming tap');
  assert.ok(src.includes('Cancel — keep things as they are'), 'arming can be cancelled');
  assert.ok(src.includes('NotAvailable'), 'the shared not-available state lives here');
  assert.ok(
    src.includes('Not available at the moment — future upgrade.'),
    'NotAvailable carries the one shared line',
  );
  assert.ok(src.includes('data-future-flag'), 'NotAvailable names its flag for tests');
});

const DESTRUCTIVE_PAGES = [
  '../src/app/admin/rooms/[id]/page.tsx',
  '../src/app/admin/players/page.tsx',
  '../src/app/admin/safety/page.tsx',
  '../src/app/admin/announcements/page.tsx',
  '../src/app/admin/users/page.tsx',
  '../src/app/admin/accounts/[playerId]/page.tsx',
];

for (const page of DESTRUCTIVE_PAGES) {
  test(`${page}: destructive actions go through ConfirmAction`, () => {
    const src = read(page);
    assert.ok(src.includes('ConfirmAction'), `${page} must use the two-tap ConfirmAction`);
    assert.ok(!src.includes('window.confirm'), `${page} must not use the native confirm dialog`);
  });
}

test('room detail: End/Cancel/Force-to-results each carry a plain-words consequence', () => {
  const src = read('../src/app/admin/rooms/[id]/page.tsx');
  assert.ok(src.includes('Ends the game now. Players see the results page.'));
  assert.ok(src.includes('Cancels the room. Players go back to the home screen'));
  assert.ok(src.includes('Skips the rest of the game. Players see the results page now.'));
});

test('players: location is Owner-only behind an explicit action + the in-session notice', () => {
  const src = read('../src/app/admin/players/page.tsx');
  assert.ok(src.includes("adminCan(role, 'players.viewLocation')"), 'location gated on the shared matrix');
  assert.ok(src.includes('View live location'), 'explicit action, not an always-on map');
  assert.ok(
    src.includes('ADMIN_LOCATION_NOTICE') || src.includes('Live location is shown in-session only. It is never stored, logged or exported.'),
    'the notice is visible where the location is shown',
  );
  assert.ok(!src.includes('latitude') || src.includes('never written to storage'), 'coordinates are never stored');
});

test('users page: non-Owners are redirected, last Owner cannot be demoted/deleted/disabled', () => {
  const src = read('../src/app/admin/users/page.tsx');
  assert.ok(src.includes("adminCan(role, 'users.manage')"));
  assert.ok(src.includes("router.replace('/admin')"), 'non-Owner is sent back to the overview');
  assert.ok(src.includes('ADMIN_DENIED_USERS_MESSAGE'), 'the redirect carries a plain-words note');
  assert.ok(src.includes('last Owner'), 'last-Owner refusal is in plain words');
  assert.ok(src.includes('Create another Owner first'), 'the refusal says what to do instead');
});

test('billing page: sections branch on the live flag + the endpoint available field; Host Pass is planned, never priced as live', () => {
  const src = read('../src/app/admin/billing/page.tsx');
  for (const flag of ['billing.overview', 'billing.transactions', 'billing.plans', 'billing.providers', 'billing.refunds', 'billing.tax']) {
    assert.ok(src.includes(flag), `billing page must cover ${flag}`);
  }
  // Merge, 2026-11-27 (Meera fix 1): sections no longer render
  // NotAvailable unconditionally from the static defs — they fetch
  // the live flag state and the endpoint, and branch on both.
  assert.ok(src.includes('listAdminFlags'), 'billing page reads the live flag state');
  assert.ok(src.includes('adminFutureFlagEnabled'), 'billing page branches on the fetched flag value');
  assert.ok(src.includes('getAdminBillingOverview'), 'billing page calls the overview endpoint');
  assert.ok(src.includes('.available'), 'billing page branches on the endpoint available field');
  // Fix round, 2026-11-27: two-stage load — the flags resolve FIRST
  // and each billing fetch runs only when its flag is ON (same
  // pattern as loadAccountDetail). The old single Promise.all fired
  // every billing endpoint before the flags resolved.
  assert.ok(src.includes('const flags = await listAdminFlags();'), 'flags resolve before any billing fetch');
  for (const [flag, fn] of [
    ['billing.overview', 'getAdminBillingOverview'],
    ['billing.transactions', 'getAdminBillingTransactions'],
    ['billing.plans', 'getAdminBillingPlans'],
    ['billing.providers', 'getAdminBillingProviders'],
    ['billing.refunds', 'getAdminBillingRefunds'],
    ['billing.tax', 'getAdminBillingTax'],
  ]) {
    assert.ok(
      src.includes(`adminFutureFlagEnabled(flags, '${flag}') ? ${fn}() : Promise.resolve(null)`),
      `${fn} runs only when ${flag} is ON`,
    );
  }
  const loadBody = src.slice(src.indexOf('async function loadBilling'), src.indexOf('}', src.indexOf('return { flags,')) + 1);
  assert.ok(!loadBody.includes('listAdminFlags(),'), 'listAdminFlags is not fired alongside the billing fetches');
  assert.ok(src.includes('enabled={'), 'NotAvailable receives the fetched enabled value');
  assert.ok(src.includes('HOST_PASS_PLAN'), 'Host Pass comes from the shared constant');
  assert.ok(src.includes('Planned — not on sale. Legal gate pending.') || src.includes('statusCopy'));
  assert.ok(!src.includes('toLocaleString'), 'no revenue numbers are rendered');
});

test('accounts pages: real guest players only — no invented identity fields, no fake data', () => {
  const list = read('../src/app/admin/accounts/page.tsx');
  const detail = read('../src/app/admin/accounts/[playerId]/page.tsx');
  assert.ok(list.includes('listAdminPlayers'), 'directory lists real players from the API');
  assert.ok(detail.includes('listAdminPlayers'), 'detail reads the same real list');
  for (const src of [list, detail]) {
    assert.ok(!/type="(tel|email)"/.test(src), 'no phone/email input for guest players');
    assert.ok(!/player\.(phone|email)|phoneNumber|emailAddress/.test(src), 'no phone/email data field for guest players');
    assert.ok(!src.includes('latitude'), 'no raw coordinates anywhere');
  }
  assert.ok(detail.includes('NotAvailable'), 'purchases/roles/data-requests/login show NotAvailable');
  // Merge, 2026-11-27 (Meera fix 1): NotAvailable is now the flag-OFF
  // branch only — the page reads the live flags and the gated
  // endpoints, and renders live content when a flag is ON.
  assert.ok(detail.includes('listAdminFlags'), 'detail reads the live flag state');
  assert.ok(detail.includes('adminFutureFlagEnabled'), 'detail branches on the fetched flag value');
  assert.ok(detail.includes('getAdminDataRequests'), 'detail reads data requests when the flag is ON');
  assert.ok(detail.includes('getAdminLoginMethods'), 'detail reads login methods when the flag is ON');
  assert.ok(detail.includes('getAdminBillingTransactions'), 'detail reads purchases when the flag is ON');
  assert.ok(detail.includes('Ban this seat'), 'seat ban is a real action on the detail page');
  assert.ok(detail.includes('DPDP Act'), 'data requests name the DPDP Act');
});

test('home page: reads the public announcement/flags/config and shows a dismissible banner', () => {
  const src = read('../src/app/page.tsx');
  assert.ok(src.includes('loadPublicGameReads'), 'home reads the public admin endpoints at startup');
  assert.ok(src.includes('AnnouncementBanner'), 'home shows the announcement banner');
  assert.ok(src.includes('shouldShowAnnouncement'), 'dismissed announcements stay hidden this session');
});

test('admin layout: nav comes from the shared matrix, never a second copy', () => {
  const src = read('../src/app/admin/layout.tsx');
  assert.ok(src.includes('adminNavFor'), 'nav is filtered by the shared matrix');
  assert.ok(src.includes("router.replace('/admin/login')") || src.includes("'/admin/login'"), 'no session goes to login');
  assert.ok(src.includes('Sign out'), 'sign out is in the shell');
});

test('DO meter honesty: a server doMeter note means the UI shows "—", never a 0 as a real count', () => {
  const overview = read('../src/app/admin/page.tsx');
  const costs = read('../src/app/admin/costs/page.tsx');
  const client = read('../src/lib/admin/admin-client.ts');
  assert.ok(client.includes('doMeter'), 'client types carry the server doMeter note');
  assert.ok(overview.includes('data.doMeter'), 'overview renders the note instead of the count');
  assert.ok(costs.includes('data.doMeter'), 'costs renders the note instead of the count');
  assert.ok(
    costs.includes('The Cloudflare daily cap is checked on the Cloudflare dashboard'),
    'costs says honestly where the cap is checked',
  );
});

test('peak concurrency carries the server honesty note; audit shows the detail line', () => {
  const numbers = read('../src/app/admin/numbers/page.tsx');
  const audit = read('../src/app/admin/audit/page.tsx');
  assert.ok(numbers.includes('peakConcurrencyNote'), 'numbers renders the peak proxy note');
  assert.ok(audit.includes('entry.detail'), 'audit renders the entry detail when present');
});

test('users: the create form never offers Owner — the server only creates Admin/Staff here', () => {
  const src = read('../src/app/admin/users/page.tsx');
  assert.ok(!src.includes('<option value="owner">Owner — everything</option>'), 'no Owner option on create');
  assert.ok(src.includes('Owner accounts are created only by the first-time setup'));
  const client = read('../src/lib/admin/admin-client.ts');
  assert.ok(client.includes("role: 'admin' | 'staff'"), 'createAdminUser type matches the server');
});

test('NotAvailable reflects the fetched flag value (merge, Meera fix 1)', () => {
  const src = read('../src/components/admin/AdminUi.tsx');
  assert.ok(src.includes("data-future-enabled={enabled ? 'true' : 'false'}"), 'data-future-enabled is the fetched value, never hardcoded false');
  assert.ok(src.includes('enabled = false'), 'callers that have not fetched a flag still render the honest OFF state');
  assert.ok(src.includes("Flag: {flagKey} — {enabled ? 'on' : 'off'}"), 'the flag line names the live state');
});

test('config page uses the shared Toggle, not a hand-rolled switch (merge, Meera fix 5)', () => {
  const src = read('../src/app/admin/config/page.tsx');
  assert.ok(src.includes("import { Toggle } from '../../../components/ui/Toggle'"), 'config imports the shared Toggle');
  assert.ok(src.includes('<Toggle'), 'zone shrinking renders the shared Toggle');
  assert.ok(!src.includes('role="switch"'), 'no hand-rolled switch remains on the config page');
});

test('mode page explains the codename (merge, Meera fix 6)', () => {
  const src = read('../src/app/create/mode/page.tsx');
  assert.ok(src.includes('This is the name other players see.'), 'one-line explainer under the codename input');
});
