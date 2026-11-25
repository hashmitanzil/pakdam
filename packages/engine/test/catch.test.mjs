import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { checkCatchProximity } = await import('../src/catch.ts');

const NOW = 1_000_000;
const fix = (overrides = {}) => ({
  lat: 23.35,
  lng: 85.33,
  accuracyMeters: 8,
  timestampMs: NOW,
  ...overrides,
});

test('catch proximity: phones ~5 m apart can tag', () => {
  const result = checkCatchProximity({
    hunterFix: fix(),
    runnerFix: fix({ lat: 23.35004 }),
    nowMs: NOW,
  });
  assert.deepEqual(result, { ok: true, value: undefined });
});

test('catch proximity: phones ~50 m apart can tag (limit is 100 m)', () => {
  const result = checkCatchProximity({
    hunterFix: fix(),
    runnerFix: fix({ lat: 23.35045 }),
    nowMs: NOW,
  });
  assert.equal(result.ok, true);
});

test('catch proximity: a missing fix on either side waits for GPS', () => {
  assert.deepEqual(
    checkCatchProximity({ hunterFix: null, runnerFix: fix(), nowMs: NOW }),
    {
      ok: false,
      code: 'STALE_LOCATION',
      // v34 (Diya R2-9) — the reason names whose fix is missing: the
      // Runner tapping OK must be able to tell it is the Hunter's GPS.
      reason: "Waiting for the Hunter's GPS — they have no fix yet.",
    },
  );
  assert.deepEqual(
    checkCatchProximity({ hunterFix: fix(), runnerFix: null, nowMs: NOW }),
    {
      ok: false,
      code: 'STALE_LOCATION',
      reason: 'Waiting for GPS — move closer and try again.',
    },
  );
});

// v34 (Diya R2-9) — the rejection reason names whose fix is the problem:
// a coarse or stale HUNTER fix must not read as the Runner's "move
// closer". The code stays STALE_LOCATION in every case; only the reason
// distinguishes. No acceptance rule changes here (F1 stays open).
test('catch proximity: the reason names the Hunter when their fix is coarse or stale', () => {
  const coarseHunter = checkCatchProximity({
    hunterFix: fix({ accuracyMeters: 100 }),
    runnerFix: fix(),
    nowMs: NOW,
  });
  assert.equal(coarseHunter.ok, false);
  assert.equal(coarseHunter.code, 'STALE_LOCATION');
  assert.match(coarseHunter.reason, /Hunter's GPS is too rough/);
  assert.match(coarseHunter.reason, /±100 m/);
  const coarseRunner = checkCatchProximity({
    hunterFix: fix(),
    runnerFix: fix({ accuracyMeters: 100 }),
    nowMs: NOW,
  });
  assert.equal(coarseRunner.ok, false);
  assert.equal(coarseRunner.code, 'STALE_LOCATION');
  assert.match(coarseRunner.reason, /Your GPS is too rough/);
  const staleHunter = checkCatchProximity({
    hunterFix: fix({ timestampMs: NOW - 61_000 }),
    runnerFix: fix(),
    nowMs: NOW,
  });
  assert.equal(staleHunter.ok, false);
  assert.equal(staleHunter.code, 'STALE_LOCATION');
  assert.match(staleHunter.reason, /Hunter's GPS fix is stale/);
});

test('catch proximity: a fix older than 60 s waits for GPS', () => {
  const result = checkCatchProximity({
    hunterFix: fix({ timestampMs: NOW - 61_000 }),
    runnerFix: fix(),
    nowMs: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STALE_LOCATION');
});

test('catch proximity: phones in different cities are FORBIDDEN, not a tag', () => {
  const result = checkCatchProximity({
    hunterFix: fix(),
    runnerFix: fix({ lat: 25.5941, lng: 85.1376, timestampMs: NOW }),
    nowMs: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'FORBIDDEN');
  assert.match(result.reason, /too far apart/);
});

// v18 fix round (B1): liveness vs usability — a poor fix (accuracy
// worse than ±50 m) proves the phone is alive but its position is too
// coarse to judge a 100 m tag. Both fixes must be ±50 m or better.
test('catch proximity: a poor fix on either side waits for GPS (B1)', () => {
  const poorHunter = checkCatchProximity({
    hunterFix: fix({ accuracyMeters: 100 }),
    runnerFix: fix(),
    nowMs: NOW,
  });
  assert.equal(poorHunter.ok, false);
  assert.equal(poorHunter.code, 'STALE_LOCATION');
  const poorRunner = checkCatchProximity({
    hunterFix: fix(),
    runnerFix: fix({ accuracyMeters: 1000 }),
    nowMs: NOW,
  });
  assert.equal(poorRunner.ok, false);
  assert.equal(poorRunner.code, 'STALE_LOCATION');
});

test('catch proximity: ±50 m fixes can still tag; ±51 m cannot (B1 boundary)', () => {
  const atLimit = checkCatchProximity({
    hunterFix: fix({ accuracyMeters: 50 }),
    runnerFix: fix({ accuracyMeters: 50, lat: 23.35004 }),
    nowMs: NOW,
  });
  assert.deepEqual(atLimit, { ok: true, value: undefined });
  const overLimit = checkCatchProximity({
    hunterFix: fix({ accuracyMeters: 51 }),
    runnerFix: fix({ lat: 23.35004 }),
    nowMs: NOW,
  });
  assert.equal(overLimit.ok, false);
  assert.equal(overLimit.code, 'STALE_LOCATION');
});

// v18 fix round (F1): toCatchView strips BOTH server-only hashes.
test('toCatchView strips qrTokenHash AND previousQrTokenHash (F1)', async () => {
  const { toCatchView } = await import('../src/catch.ts');
  const claim = {
    catchId: 'c1',
    roomId: 'room-1',
    hunterPlayerId: 'hu1',
    runnerPlayerId: 'r1',
    state: 'awaiting-confirmation',
    qrTokenHash: 'current-hash',
    previousQrTokenHash: 'previous-hash',
    requestedAt: new Date(NOW).toISOString(),
    confirmedAt: null,
    disputedAt: null,
    resolution: null,
    gpsEvidence: 'present',
  };
  const view = toCatchView(claim);
  assert.equal('qrTokenHash' in view, false);
  assert.equal('previousQrTokenHash' in view, false);
  assert.equal(view.catchId, 'c1');
  assert.equal(view.state, 'awaiting-confirmation');
});

// v18 fix round (A1): a scanned token resolves against open claims.
test('resolveOpenClaimQrToken resolves a claim QR, its previous hash, and nothing else (A1)', async () => {
  const { issueCatchToken, resolveOpenClaimQrToken } = await import('../src/catch.ts');
  const { token, tokenHash } = await issueCatchToken('c1');
  const { token: oldToken, tokenHash: oldHash } = await issueCatchToken('c1');
  const claim = {
    catchId: 'c1',
    roomId: 'room-1',
    hunterPlayerId: 'hu1',
    runnerPlayerId: 'r1',
    state: 'awaiting-confirmation',
    qrTokenHash: tokenHash,
    previousQrTokenHash: oldHash,
    requestedAt: new Date(NOW).toISOString(),
    confirmedAt: null,
    disputedAt: null,
    resolution: null,
    gpsEvidence: 'present',
  };
  assert.equal((await resolveOpenClaimQrToken([claim], token, NOW))?.catchId, 'c1');
  assert.equal((await resolveOpenClaimQrToken([claim], oldToken, NOW))?.catchId, 'c1');
  assert.equal(await resolveOpenClaimQrToken([claim], 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', NOW), null);
  // Expired claim does not resolve (the sweep expires it instead).
  const expired = { ...claim, requestedAt: new Date(NOW - 130_000).toISOString() };
  assert.equal(await resolveOpenClaimQrToken([expired], token, NOW), null);
  // Decided claim does not resolve.
  const confirmed = { ...claim, state: 'confirmed' };
  assert.equal(await resolveOpenClaimQrToken([confirmed], token, NOW), null);
});
