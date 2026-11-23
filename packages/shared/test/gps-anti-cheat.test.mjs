import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const {
  checkFixMovement,
  resolveGpsAntiCheatConfig,
} = await import('../src/gps-validation.ts');
const { GPS_ANTI_CHEAT_DEFAULTS, GPS_VIOLATION_WINDOW_MS } = await import('../src/calibration.ts');

// v29 (Gap 1) — GPS anti-cheat movement check: pure function tests.
// The thresholds come from the founder-approved reliability spec §2
// (50 m/s sustained, 80 m/s burst within 3 s, teleport >500 m with
// dt <10 s, flag after 3 violations in 5 min). 1° latitude ≈ 111,320 m.
const T0 = 1_780_000_000_000;
const BASE = { lat: 23.35, lng: 85.33, accuracyMeters: 10, timestampMs: T0 };
const METERS_PER_DEG_LAT = 111_320;

function at(northMeters, atMs, accuracyMeters = 10) {
  return {
    lat: BASE.lat + northMeters / METERS_PER_DEG_LAT,
    lng: BASE.lng,
    accuracyMeters,
    timestampMs: atMs,
  };
}

test('checkFixMovement: receipt time defeats forged device timestamps (F3)', () => {
  // 60 m jumps, 1 s apart by SERVER receipt — but the device
  // timestamps are forged ~361 s apart (alternating the 60 s stale
  // / 5 min future bounds validateFix allows). Device-dt reads
  // ~0.17 m/s and never flags; receipt-dt reads 60 m/s.
  const forgedPrev = at(0, T0 - 60_000);
  const forgedCurr = at(60, T0 + 1000 + 300_000);
  const byDevice = checkFixMovement(forgedPrev, forgedCurr);
  assert.ok(byDevice.speedMps < 1, `device dt must look harmless, got ${byDevice.speedMps}`);
  assert.equal(byDevice.teleport, false);
  const byReceipt = checkFixMovement(forgedPrev, forgedCurr, {
    prevReceiptMs: T0,
    currReceiptMs: T0 + 1000,
  });
  assert.equal(byReceipt.dtMs, 1000, 'dt is the receipt dt');
  assert.ok(byReceipt.speedMps > 55 && byReceipt.speedMps < 65, `receipt speed must be ~60 m/s, got ${byReceipt.speedMps}`);
});

test('checkFixMovement: no previous fix reports no movement', () => {
  const m = checkFixMovement(null, BASE);
  assert.equal(m.speedMps, 0);
  assert.equal(m.distanceM, 0);
  assert.equal(m.teleport, false);
});

test('checkFixMovement: walking 1.4 m/s is neither speed nor teleport', () => {
  const m = checkFixMovement(BASE, at(1.4, T0 + 1000));
  assert.ok(m.speedMps > 1 && m.speedMps < 2, `walking speed must be ~1.4 m/s, got ${m.speedMps}`);
  assert.equal(m.teleport, false);
});

test('checkFixMovement: 60 m/s sustained (60 m in 1 s) is speed, not teleport', () => {
  const m = checkFixMovement(BASE, at(60, T0 + 1000));
  assert.ok(m.speedMps > 55 && m.speedMps < 65, `got ${m.speedMps}`);
  assert.equal(m.distanceM < 500, true, '60 m is under the teleport gap');
  assert.equal(m.teleport, false);
});

test('checkFixMovement: 800 m in 1 s is a teleport (and a burst)', () => {
  const m = checkFixMovement(BASE, at(800, T0 + 1000));
  assert.ok(m.distanceM > 500, `got ${m.distanceM}`);
  assert.equal(m.dtMs, 1000);
  assert.equal(m.teleport, true);
  assert.ok(m.speedMps > 80, `800 m/s must exceed the burst ceiling, got ${m.speedMps}`);
});

test('checkFixMovement: 800 m in 30 s is NOT a teleport (dt >= 10 s)', () => {
  const m = checkFixMovement(BASE, at(800, T0 + 30_000));
  assert.equal(m.teleport, false);
  // 800 m / 30 s ≈ 26.7 m/s — under the sustained ceiling too.
  assert.ok(m.speedMps < 50, `got ${m.speedMps}`);
});

test('checkFixMovement: 500 m exactly is not a teleport (strictly greater)', () => {
  const m = checkFixMovement(BASE, at(500, T0 + 1000));
  assert.equal(m.teleport, false);
});

test('checkFixMovement: dt <= 0 reports speed 0 but teleport still applies on distance alone', () => {
  const m = checkFixMovement(BASE, at(800, T0));
  assert.equal(m.speedMps, 0);
  assert.equal(m.teleport, true);
});

test('resolveGpsAntiCheatConfig: defaults are warn-only', () => {
  const cfg = resolveGpsAntiCheatConfig();
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.warnOnly, true);
  assert.equal(cfg.action, 'warn');
  assert.equal(cfg.maxSpeedMs, 50);
  assert.equal(cfg.burstMaxMs, 80);
  assert.equal(cfg.burstWindowMs, 3000);
  assert.equal(cfg.teleportMaxGapM, 500);
  assert.equal(cfg.teleportMaxGapMs, 10_000);
  assert.equal(cfg.violationThreshold, 3);
});

test('resolveGpsAntiCheatConfig: overrides merge onto defaults', () => {
  const cfg = resolveGpsAntiCheatConfig({ action: 'eject', violationThreshold: 2 });
  assert.equal(cfg.action, 'eject');
  assert.equal(cfg.violationThreshold, 2);
  assert.equal(cfg.maxSpeedMs, 50, 'unspecified fields keep defaults');
  assert.equal(cfg.enabled, true);
});

test('calibration defaults match the spec thresholds', () => {
  assert.equal(GPS_ANTI_CHEAT_DEFAULTS.action, 'warn');
  assert.equal(GPS_ANTI_CHEAT_DEFAULTS.maxSpeedMs, 50);
  assert.equal(GPS_ANTI_CHEAT_DEFAULTS.burstMaxMs, 80);
  assert.equal(GPS_ANTI_CHEAT_DEFAULTS.burstWindowMs, 3000);
  assert.equal(GPS_ANTI_CHEAT_DEFAULTS.teleportMaxGapM, 500);
  assert.equal(GPS_ANTI_CHEAT_DEFAULTS.teleportMaxGapMs, 10_000);
  assert.equal(GPS_ANTI_CHEAT_DEFAULTS.violationThreshold, 3);
  assert.equal(GPS_VIOLATION_WINDOW_MS, 5 * 60 * 1000);
});
