/**
 * Presence + snapshot-key + QR-scan + GPS-send-gate tests — v29.
 * Pure helpers only; no DOM, no network.
 */
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('./resolve-hooks.mjs', import.meta.url);

const {
  readPlayerPresence,
  readReconnectEndsAtMs,
  reconnectSecondsLeft,
  formatReconnectCountdown,
  isReconnectWindowExpired,
} = await import('../src/lib/presence.ts');
const {
  buildSnapshotKey,
  buildLastSnapshotKey,
  readSnapshotWatermarkMs,
  readSnapshotEpochMs,
  maxLastFixAtMs,
} = await import('../src/lib/snapshot-key.ts');
const {
  qrScanDimensions,
  qrScanIsDecodeFrame,
  qrScanShouldStop,
  QR_SCAN_STOP_AFTER_MS,
} = await import('../src/lib/qr-scan.ts');
const { shouldSendFix, GPS_SEND_MIN_INTERVAL_MS, GPS_SEND_MIN_MOVEMENT_M } = await import(
  '../src/lib/geolocation.ts'
);
const {
  shouldEjectForMissingFix,
  meDotMarkerStyle,
  ME_DOT_MARKER_SIZE_PX,
} = await import('../src/components/hud/play-map-logic.ts');

// -- presence (30 s rule readers) -------------------------------------------

test('presence: absent / unknown reads as present; only "away" is away', () => {
  assert.equal(readPlayerPresence({}), 'present');
  assert.equal(readPlayerPresence(null), 'present');
  assert.equal(readPlayerPresence({ presence: 'present' }), 'present');
  assert.equal(readPlayerPresence({ presence: 'away' }), 'away');
  assert.equal(readPlayerPresence({ presence: 'weird' }), 'present');
});

test('presence: reconnectEndsAtMs tolerant read', () => {
  assert.equal(readReconnectEndsAtMs({}), null);
  assert.equal(readReconnectEndsAtMs({ reconnectEndsAtMs: null }), null);
  assert.equal(readReconnectEndsAtMs({ reconnectEndsAtMs: 'soon' }), null);
  assert.equal(readReconnectEndsAtMs({ reconnectEndsAtMs: 1799999999999 }), 1799999999999);
});

test('presence: countdown is whole seconds, never negative; null with no window', () => {
  const now = 1_000_000;
  assert.equal(reconnectSecondsLeft(null, now), null);
  assert.equal(reconnectSecondsLeft(now + 23_400, now), 24);
  assert.equal(reconnectSecondsLeft(now - 5000, now), 0);
  assert.equal(formatReconnectCountdown(now + 23_400, now), '0:24');
  assert.equal(formatReconnectCountdown(null, now), null);
  assert.equal(isReconnectWindowExpired(now + 1000, now), false);
  assert.equal(isReconnectWindowExpired(now, now), true);
  assert.equal(isReconnectWindowExpired(null, now), false);
});

// -- snapshot key (R1) ------------------------------------------------------

function player(id, lastFixAt) {
  return {
    playerId: id,
    roomId: 'r',
    kind: 'guest',
    displayName: id,
    isHost: false,
    matchRole: null,
    team: null,
    joinedAt: '2026-11-23T00:00:00.000Z',
    leftAt: null,
    ejectedAt: null,
    connectionState: 'connected',
    lastFixAt,
    locationQuality: null,
    isReady: true,
    briefingConfirmed: false,
    ageGatePassed: true,
    suspensionCount: 0,
  };
}

test('snapshot key: exact format version:serverSeq:maxLastFixAtMs:epochMs', () => {
  const snapshot = {
    version: 3,
    serverSeq: 450,
    players: [player('a', '2026-11-23T00:01:00.000Z'), player('b', null)],
  };
  const expected = `3:450:${Date.parse('2026-11-23T00:01:00.000Z')}:null`;
  assert.equal(buildSnapshotKey(snapshot), expected);
  // No fixes at all keys on null (never 0), on the wire and in the string.
  assert.deepEqual(buildLastSnapshotKey({ version: 1, serverSeq: 7, players: [] }), {
    version: 1,
    serverSeq: 7,
    maxLastFixAtMs: null,
    epochMs: null,
  });
  assert.equal(buildSnapshotKey({ version: 1, serverSeq: 7, players: [] }), '1:7:null:null');
});

test('snapshot key: a moved watermark changes the key even when version+seq collide', () => {
  const before = {
    version: 3,
    serverSeq: 450,
    players: [player('a', '2026-11-23T00:01:00.000Z')],
  };
  const after = {
    version: 3,
    serverSeq: 450,
    players: [player('a', '2026-11-23T00:01:30.000Z')],
  };
  assert.notEqual(buildSnapshotKey(before), buildSnapshotKey(after));
});

test('snapshot key: a DO wake (new epochMs) changes the key even when nothing else moved', () => {
  const before = {
    version: 3,
    serverSeq: 450,
    maxLastFixAtMs: 1799999999999,
    epochMs: 1799999990000,
    players: [],
  };
  const after = { ...before, epochMs: 1799999995000 };
  assert.notEqual(buildSnapshotKey(before), buildSnapshotKey(after));
  assert.equal(buildSnapshotKey(before), '3:450:1799999999999:1799999990000');
});

test('snapshot key: server field wins over the computed watermark; real server shape (maxLastFixAtMs + epochMs)', () => {
  // Fix round M1: the old test fed `maxLastFixAt` — a field the server
  // never sends. A real server snapshot carries `maxLastFixAtMs` and
  // `epochMs` (top-level); the reader must use those, not the
  // players' lastFixAt, when they are present.
  const snapshot = {
    version: 1,
    serverSeq: 7,
    maxLastFixAtMs: 1799999999999,
    epochMs: 1799999990000,
    players: [player('a', '2026-11-23T00:01:00.000Z')],
  };
  assert.equal(readSnapshotWatermarkMs(snapshot), 1799999999999);
  assert.equal(readSnapshotEpochMs(snapshot), 1799999990000);
  assert.deepEqual(buildLastSnapshotKey(snapshot), {
    version: 1,
    serverSeq: 7,
    maxLastFixAtMs: 1799999999999,
    epochMs: 1799999990000,
  });
  assert.equal(buildSnapshotKey(snapshot), '1:7:1799999999999:1799999990000');
  // An explicit server null means nobody has a fix — null, never 0,
  // even though the players carry no fix either.
  assert.equal(
    readSnapshotWatermarkMs({ version: 1, serverSeq: 7, maxLastFixAtMs: null, players: [] }),
    null,
  );
  assert.equal(maxLastFixAtMs([]), 0);
});

test('snapshot key: an old server (no fields) falls back to the computed watermark', () => {
  const snapshot = {
    version: 2,
    serverSeq: 9,
    players: [player('a', '2026-11-23T00:02:00.000Z')],
  };
  assert.equal(readSnapshotWatermarkMs(snapshot), Date.parse('2026-11-23T00:02:00.000Z'));
  assert.equal(readSnapshotEpochMs(snapshot), null);
  assert.equal(
    buildSnapshotKey(snapshot),
    `2:9:${Date.parse('2026-11-23T00:02:00.000Z')}:null`,
  );
});

// -- QR scan caps (R4) ------------------------------------------------------

test('qr scan: base width 640, escalated capped at 1280, aspect kept', () => {
  assert.deepEqual(qrScanDimensions(1920, 1080, false), { width: 640, height: 360 });
  assert.deepEqual(qrScanDimensions(1920, 1080, true), { width: 1280, height: 720 });
  assert.deepEqual(qrScanDimensions(4000, 3000, true), { width: 1280, height: 960 });
  assert.deepEqual(qrScanDimensions(320, 240, true), { width: 320, height: 240 });
});

test('qr scan: every 3rd frame is a decode frame, escalated or not', () => {
  assert.equal(qrScanIsDecodeFrame(3), true);
  assert.equal(qrScanIsDecodeFrame(6), true);
  assert.equal(qrScanIsDecodeFrame(1), false);
  assert.equal(qrScanIsDecodeFrame(2), false);
  assert.equal(qrScanIsDecodeFrame(4), false);
});

test('qr scan: loop stops after ~18 s without a decode, never after a decode', () => {
  assert.equal(qrScanShouldStop(QR_SCAN_STOP_AFTER_MS - 1, false), false);
  assert.equal(qrScanShouldStop(QR_SCAN_STOP_AFTER_MS, false), true);
  assert.equal(qrScanShouldStop(QR_SCAN_STOP_AFTER_MS + 60_000, false), true);
  assert.equal(qrScanShouldStop(QR_SCAN_STOP_AFTER_MS + 60_000, true), false);
});

// -- GPS send gate (R7) -----------------------------------------------------

function fix(lat, lng, ts = 1_000_000) {
  return { lat, lng, accuracyMeters: 10, timestampMs: ts };
}

test('gps gate: first fix always sends', () => {
  assert.equal(shouldSendFix(fix(23.36, 85.33), null, 1_000_000), true);
});

test('gps gate: standing still inside 5 s does not send; at 5 s it sends', () => {
  const last = { fix: fix(23.36, 85.33), sentAtMs: 1_000_000 };
  assert.equal(shouldSendFix(fix(23.36, 85.33), last, 1_000_000 + 4_999), false);
  assert.equal(
    shouldSendFix(fix(23.36, 85.33), last, 1_000_000 + GPS_SEND_MIN_INTERVAL_MS),
    true,
  );
});

test('gps gate: ≥10 m movement sends at once (the load-bearing leg)', () => {
  const last = { fix: fix(23.36, 85.33), sentAtMs: 1_000_000 };
  // ~11 m north (0.0001 deg lat ≈ 11.1 m).
  assert.equal(shouldSendFix(fix(23.3601, 85.33), last, 1_000_000 + 1000), true);
  // ~5 m north stays gated.
  assert.equal(shouldSendFix(fix(23.360045, 85.33), last, 1_000_000 + 1000), false);
});

test('gps gate: constants are the decided values', () => {
  assert.equal(GPS_SEND_MIN_INTERVAL_MS, 5000);
  assert.equal(GPS_SEND_MIN_MOVEMENT_M, 10);
});

// -- (4a) missing-fix ejection: ACTIVE-only (H2) -----------------------------

function ejectionInput(overrides = {}) {
  return {
    mode: 'demo',
    phase: 'ACTIVE',
    activeAtMs: 1_000_000,
    lastSeenMs: 1_000_000,
    effectiveNowMs: 1_000_000,
    connectionState: 'connected',
    alreadyEjected: false,
    ...overrides,
  };
}

test('H2: a silent seat never ejects during HEAD_START, even after 60 s', () => {
  assert.equal(
    shouldEjectForMissingFix(
      ejectionInput({ phase: 'HEAD_START', activeAtMs: null, effectiveNowMs: 1_000_000 + 60_000 }),
    ),
    false,
    'the head start is for acquiring GPS — ejection only starts in ACTIVE',
  );
});

test('H2: ejection is 30 s into ACTIVE, not 30 s after match start', () => {
  // 3-min head start: ACTIVE began at T0+180s, last fix at T0.
  const base = ejectionInput({ activeAtMs: 1_000_000 + 180_000, lastSeenMs: 1_000_000 });
  assert.equal(
    shouldEjectForMissingFix({ ...base, effectiveNowMs: 1_000_000 + 180_000 + 29_000 }),
    false,
    '29 s into ACTIVE must not eject even though the last fix is 209 s old',
  );
  assert.equal(
    shouldEjectForMissingFix({ ...base, effectiveNowMs: 1_000_000 + 180_000 + 30_000 }),
    true,
    '30 s into ACTIVE ejects',
  );
});

test('H2: a fresh fix inside ACTIVE resets the clock; suspended seats never eject', () => {
  assert.equal(
    shouldEjectForMissingFix(
      ejectionInput({ lastSeenMs: 1_000_000 + 25_000, effectiveNowMs: 1_000_000 + 30_000 }),
    ),
    false,
    'a fix 5 s ago means only 5 s silent',
  );
  assert.equal(
    shouldEjectForMissingFix(
      ejectionInput({ connectionState: 'suspended', effectiveNowMs: 1_000_000 + 60_000 }),
    ),
    false,
  );
  assert.equal(
    shouldEjectForMissingFix(ejectionInput({ mode: 'live', effectiveNowMs: 1_000_000 + 60_000 })),
    false,
    'live mode never ejects client-side — the server enforces it',
  );
});

// -- own-position dot: square box, round by construction (D) ------------------

test('D: the me-dot marker style is square with a 50% radius (a dot, never a pill)', () => {
  const style = meDotMarkerStyle(false);
  assert.equal(style.width, style.height, 'width must equal height or the box elongates');
  assert.equal(style.width, `${ME_DOT_MARKER_SIZE_PX}px`);
  assert.equal(style.borderRadius, '999px');
  assert.equal(style.opacity, '1');
  assert.equal(meDotMarkerStyle(true).opacity, '0.35', 'a stale fix draws faded, not hidden');
});
