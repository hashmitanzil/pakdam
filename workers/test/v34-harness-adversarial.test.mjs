import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { RoomStore, emptyMemory } = await import('../src/room-do.ts');
const { DEFAULT_ROOM_CONFIG, hashWsTicket } = await import('@pakdam/shared');

// v34 HARNESS (Arjun, QA) — approach (d): adversarial / fuzz.
//
// Malformed payloads, duplicate/replayed tokens, out-of-order
// operations, double submits, stale sequence numbers. Every case must
// end in a named error envelope (or a clean no-op) — never a crash,
// never a silent state change, never a second application of the same
// action. All behaviour below was read from workers/src/room-do.ts
// and packages/engine/src/catch.ts before pinning it.

const T0 = 1_780_000_000_000;
const TRIANGLE = [
  { lat: 23.3, lng: 85.28 },
  { lat: 23.3, lng: 85.38 },
  { lat: 23.4, lng: 85.33 },
];
const INSIDE = { lat: 23.35, lng: 85.33 };

function player(id, displayName, isHost = false) {
  return {
    playerId: id, roomId: 'room-1', kind: 'guest', displayName, isHost,
    matchRole: null, team: null, reconnectTokenHash: `reconnect-hash-${id}`,
    joinedAt: new Date(T0 - 1000).toISOString(), leftAt: null, ejectedAt: null,
    connectionState: 'connected', lastFixAt: null, locationQuality: null,
    isReady: true, briefingConfirmed: true, ageGatePassed: true, suspensionCount: 0,
  };
}

function makeStore() {
  const config = {
    ...DEFAULT_ROOM_CONFIG,
    headStartSeconds: 0, pingIntervalSeconds: 0, durationSeconds: 3600,
    zoneShrinkEnabled: false, zoneShrinkIntervalSeconds: 60, playZoneEnabled: true,
    zone: { boundary: TRIANGLE, shrinkPhases: [] },
    teamAssignment: 'selected', selectedHunterIds: ['hu1'], hunterCount: 1,
    balanceHunters: false, randomDraw: false,
  };
  const state = {
    room: {
      roomId: 'room-1', roomCode: 'ABCDEF', hostPlayerId: 'h1', phase: 'LOBBY',
      version: 1, config, createdAt: new Date(T0 - 1000).toISOString(),
      startedAt: null, endsAt: null, pausedAt: null, result: null,
    },
    players: [player('h1', 'Host', true), player('hu1', 'Hunter 1'), player('r1', 'Runner 1')],
    catches: [], hostTokens: { h1: 'host-hash' }, serverSeq: 0,
    gameEventLog: [], lastPingAtMs: {}, paused: false, pausedBy: null, pausedFrom: null,
    eventLog: [], shrinkIndexApplied: 0, tickets: [], idempotency: [],
    idempotentReplies: [], pendingPings: [], pendingPingRecipients: {}, runnerQrTokens: [],
  };
  return new RoomStore(state, emptyMemory());
}

function start(store, atMs = T0) {
  const r = store.startMatch({ playerId: 'h1', hostTokenHash: 'host-hash', nowMs: atMs });
  assert.equal(r.ok, true, `startMatch must succeed: ${r.ok ? '' : r.error}`);
  return r;
}

async function sendWs(store, playerId, type, payload, commandId, atMs, sessionId = 's1') {
  return store.handleWsMessage({ playerId, sessionId }, { type, commandId, payload }, atMs);
}

function errorOf(result) {
  return result.events.find((e) => e.type === 'error');
}

function errorCode(result) {
  const e = errorOf(result);
  return e ? e.payload.code : null;
}

async function sendFix(store, playerId, atMs, point = INSIDE, accuracyMeters = 10) {
  return sendWs(store, playerId, 'location.update', {
    fix: { ...point, accuracyMeters, timestampMs: atMs },
  }, `fix-${playerId}-${atMs}`, atMs);
}

async function startActive(store) {
  start(store);
  store.alarmTick(T0 + 1000); // HEAD_START (0 s) -> ACTIVE
  assert.equal(store.room.phase, 'ACTIVE');
  await sendFix(store, 'hu1', T0 + 2000);
  await sendFix(store, 'r1', T0 + 2000);
}

async function openClaim(store, atMs = T0 + 3000) {
  const r = await sendWs(store, 'hu1', 'catch.request', { runnerId: 'r1' }, 'claim-1', atMs);
  assert.equal(errorOf(r), undefined, `claim must open: ${JSON.stringify(r.events)}`);
  const ev = r.events.find((e) => e.type === 'catch.requested');
  assert.ok(ev, 'catch.requested must be emitted');
  return ev.payload.catch;
}

// --- malformed payloads -------------------------------------------------

test('v34 harness adversarial: unknown message types get VALIDATION_FAILED, never a crash', async () => {
  const store = makeStore();
  for (const junk of ['reveal.send', 'safety.sos', 'zone.preview', 'game.hack', '', 'HELLO']) {
    const r = await sendWs(store, 'h1', junk, {}, `unk-${junk || 'empty'}`, T0);
    assert.equal(errorCode(r), 'VALIDATION_FAILED', `${junk || '(empty)'} must be VALIDATION_FAILED`);
    assert.match(errorOf(r).payload.message, /Unknown message type/);
    assert.equal(store.room.phase, 'LOBBY', 'an unknown type must not move the machine');
  }
  // Removed types are unknown even when the name looks familiar.
  const sos = await sendWs(store, 'h1', 'safety.sos', {}, 'unk-sos-2', T0);
  assert.equal(errorCode(sos), 'VALIDATION_FAILED');
});

test('v34 harness adversarial: malformed GPS fixes are rejected with the right code, never stored', async () => {
  const store = makeStore();
  const bad = [
    [{}, 'VALIDATION_FAILED'],
    [null, 'VALIDATION_FAILED'],
    [{ lat: 91, lng: 85.33, accuracyMeters: 10, timestampMs: T0 }, 'VALIDATION_FAILED'],
    [{ lat: 23.35, lng: 181, accuracyMeters: 10, timestampMs: T0 }, 'VALIDATION_FAILED'],
    [{ lat: Number.NaN, lng: 85.33, accuracyMeters: 10, timestampMs: T0 }, 'VALIDATION_FAILED'],
    [{ lat: 23.35, lng: 85.33, accuracyMeters: 0, timestampMs: T0 }, 'VALIDATION_FAILED'],
    [{ lat: 23.35, lng: 85.33, accuracyMeters: -5, timestampMs: T0 }, 'VALIDATION_FAILED'],
    [{ lat: 23.35, lng: 85.33, accuracyMeters: 1001, timestampMs: T0 }, 'VALIDATION_FAILED'],
    [{ lat: 23.35, lng: 85.33, accuracyMeters: 10, timestampMs: 'soon' }, 'VALIDATION_FAILED'],
    [{ lat: '23.35', lng: 85.33, accuracyMeters: 10, timestampMs: T0 }, 'VALIDATION_FAILED'],
  ];
  for (const [fix, code] of bad) {
    const r = await sendWs(store, 'r1', 'location.update', { fix }, `badfix-${JSON.stringify(fix).length}-${code}`, T0);
    assert.equal(errorCode(r), code, `fix ${JSON.stringify(fix)} must be ${code}`);
  }
  // A fix from the far future is clock skew / replay, not staleness.
  // v34 (Diya R2-6) — it carries the distinct CLOCK_SKEW code so the
  // client can warn about the phone clock instead of failing silently.
  const future = await sendWs(store, 'r1', 'location.update', {
    fix: { ...INSIDE, accuracyMeters: 10, timestampMs: T0 + 3600_000 },
  }, 'badfix-future', T0);
  assert.equal(errorCode(future), 'CLOCK_SKEW');
  assert.match(errorOf(future).payload.message, /too far in the future/);
  // A fix that arrived too old is STALE_LOCATION, not VALIDATION_FAILED.
  const stale = await sendWs(store, 'r1', 'location.update', {
    fix: { ...INSIDE, accuracyMeters: 10, timestampMs: T0 - 600_000 },
  }, 'badfix-stale', T0);
  assert.equal(errorCode(stale), 'STALE_LOCATION');
  assert.equal(store.mem.latestFix['r1'], undefined, 'no malformed fix may land in memory');
});

test('v34 harness adversarial: ready.set with a non-boolean is rejected; a boolean still works after', async () => {
  const store = makeStore();
  for (const v of ['yes', 1, null, {}, []]) {
    const r = await sendWs(store, 'r1', 'ready.set', { isReady: v }, `ready-bad-${String(v)}`, T0);
    assert.equal(errorCode(r), 'VALIDATION_FAILED');
  }
  assert.equal(store.player('r1').isReady, true, 'rejected ready.set must not flip readiness');
  const ok = await sendWs(store, 'r1', 'ready.set', { isReady: false }, 'ready-good', T0);
  assert.equal(errorOf(ok), undefined);
  assert.equal(store.player('r1').isReady, false);
});

test('v34 harness adversarial: radio text must be 1-200 chars; quick signals are a closed set', async () => {
  const store = makeStore();
  const empty = await sendWs(store, 'h1', 'radio.send', { text: '   ' }, 'radio-empty', T0);
  assert.equal(errorCode(empty), 'VALIDATION_FAILED');
  const long = await sendWs(store, 'h1', 'radio.send', { text: 'x'.repeat(201) }, 'radio-long', T0);
  assert.equal(errorCode(long), 'VALIDATION_FAILED');
  const notString = await sendWs(store, 'h1', 'radio.send', { text: 42 }, 'radio-num', T0);
  assert.equal(errorCode(notString), 'VALIDATION_FAILED');
  const quickBad = await sendWs(store, 'h1', 'radio.send', { text: 'FREE PIZZA', kind: 'quick' }, 'radio-quick-bad', T0);
  assert.equal(errorCode(quickBad), 'VALIDATION_FAILED');
  assert.match(errorOf(quickBad).payload.message, /closed set/);
});

// --- duplicate / replayed tokens ----------------------------------------

test('v34 harness adversarial: a runner QR token is single-use — replay gets FORBIDDEN, never a second claim', async () => {
  const store = makeStore();
  await startActive(store);
  // Runner mints a claim-less token.
  const minted = await sendWs(store, 'r1', 'catch.runner-token', {}, 'mint-1', T0 + 3000);
  const issued = minted.events.find((e) => e.type === 'catch.runner-token');
  assert.ok(issued, 'mint must issue a token');
  const token = issued.payload.token;
  assert.match(token, /^[0-9A-F]{32}$/, 'a runner token is 32 uppercase hex');
  // Hunter scans it: claim opens, token consumed.
  const first = await sendWs(store, 'hu1', 'catch.request', { qrToken: token }, 'scan-1', T0 + 4000);
  assert.equal(errorOf(first), undefined, JSON.stringify(first.events));
  assert.equal(store.state.catches.length, 1);
  // A second Hunter (or the same one, new commandId) replaying the same
  // QR gets FORBIDDEN — the token is spent.
  const replay = await sendWs(store, 'hu1', 'catch.request', { qrToken: token }, 'scan-2', T0 + 5000);
  assert.equal(errorCode(replay), 'FORBIDDEN');
  assert.match(errorOf(replay).payload.message, /already used/);
  assert.equal(store.state.catches.length, 1, 'a replay must not open a second claim');
});

test('v34 harness adversarial: a garbage QR, an unknown QR and a mismatched runnerId are all refused distinctly', async () => {
  const store = makeStore();
  await startActive(store);
  const garbage = await sendWs(store, 'hu1', 'catch.request', { qrToken: 'not-a-token' }, 'scan-garbage', T0 + 3000);
  assert.equal(errorCode(garbage), 'VALIDATION_FAILED');
  const unknown = await sendWs(store, 'hu1', 'catch.request', { qrToken: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, 'scan-unknown', T0 + 3100);
  assert.equal(errorCode(unknown), 'FORBIDDEN');
  assert.match(errorOf(unknown).payload.message, /didn't match/);
  const none = await sendWs(store, 'hu1', 'catch.request', {}, 'scan-none', T0 + 3200);
  assert.equal(errorCode(none), 'VALIDATION_FAILED');
  assert.match(errorOf(none).payload.message, /needs runnerId/);
  // Token for r1 but runnerId says the host: mismatch refuses.
  const minted = await sendWs(store, 'r1', 'catch.runner-token', {}, 'mint-2', T0 + 3300);
  const token = minted.events.find((e) => e.type === 'catch.runner-token').payload.token;
  const mismatch = await sendWs(store, 'hu1', 'catch.request', { qrToken: token, runnerId: 'h1' }, 'scan-mismatch', T0 + 3400);
  assert.equal(errorCode(mismatch), 'VALIDATION_FAILED');
  assert.match(errorOf(mismatch).payload.message, /different Runner/);
  assert.equal(store.state.catches.length, 0, 'no refused scan may create a claim');
});

test('v34 harness adversarial: a rotated runner token dies instantly — the old QR never verifies', async () => {
  const store = makeStore();
  await startActive(store);
  const first = await sendWs(store, 'r1', 'catch.runner-token', {}, 'mint-a', T0 + 3000);
  const oldToken = first.events.find((e) => e.type === 'catch.runner-token').payload.token;
  const second = await sendWs(store, 'r1', 'catch.runner-token', {}, 'mint-b', T0 + 3100);
  const newToken = second.events.find((e) => e.type === 'catch.runner-token').payload.token;
  assert.notEqual(newToken, oldToken, 're-minting replaces the token');
  const replay = await sendWs(store, 'hu1', 'catch.request', { qrToken: oldToken }, 'scan-old', T0 + 3200);
  assert.equal(errorCode(replay), 'FORBIDDEN', 'the rotated-out QR must not resolve');
  assert.equal(store.state.catches.length, 0);
});

test('v34 harness adversarial: a WS ticket redeemed twice is TICKET_REUSED; the raw value never lands in durable state', async () => {
  const store = makeStore();
  const minted = await store.mintJoinTicket('r1', T0);
  assert.equal(minted.ok, true);
  const hash = await hashWsTicket(minted.value.ticket);
  assert.equal(store.redeemTicketForConnect(hash, T0 + 1000).ok, true);
  const second = store.redeemTicketForConnect(hash, T0 + 2000);
  assert.equal(second.ok, false);
  assert.equal(second.code, 'TICKET_REUSED');
  // An expired ticket is dead, not reusable.
  const late = await store.mintJoinTicket('hu1', T0);
  assert.equal(late.ok, true);
  const lateHash = await hashWsTicket(late.value.ticket);
  const expired = store.redeemTicketForConnect(lateHash, T0 + 61_000);
  assert.equal(expired.ok, false);
  assert.equal(expired.code, 'TICKET_EXPIRED');
});

// --- out-of-order operations --------------------------------------------

test('v34 harness adversarial: catch before start, confirm with no claim, confirm twice', async () => {
  const store = makeStore();
  // LOBBY: no catch can open.
  const early = await sendWs(store, 'hu1', 'catch.request', { runnerId: 'r1' }, 'early-1', T0);
  assert.equal(errorCode(early), 'INVALID_STATE');
  assert.match(errorOf(early).payload.message, /while the match is live/);
  assert.equal(store.state.catches.length, 0);
  // Confirm with no claim at all.
  const ghost = await sendWs(store, 'hu1', 'catch.confirm', { catchId: 'no-such-catch', qrToken: '' }, 'ghost-1', T0);
  assert.equal(errorCode(ghost), 'CATCH_EXPIRED');
  // A Runner cannot tag: role gate fires before proximity.
  await startActive(store);
  const runnerTags = await sendWs(store, 'r1', 'catch.request', { runnerId: 'r1' }, 'runner-tags', T0 + 3000);
  assert.equal(errorCode(runnerTags), 'FORBIDDEN');
  assert.match(errorOf(runnerTags).payload.message, /Only a Hunter/);
  // Open a claim, confirm it once (Runner manual confirm), then confirm
  // again: the second confirm is CONFLICT, never a double-apply.
  const claim = await openClaim(store, T0 + 4000);
  const first = await sendWs(store, 'r1', 'catch.confirm', { catchId: claim.catchId, qrToken: '', manualConfirm: true }, 'confirm-1', T0 + 5000);
  assert.equal(errorOf(first), undefined, JSON.stringify(first.events));
  assert.ok(first.events.some((e) => e.type === 'catch.confirmed'));
  assert.equal(store.state.catches.filter((c) => c.state === 'confirmed').length, 1);
  const again = await sendWs(store, 'r1', 'catch.confirm', { catchId: claim.catchId, qrToken: '', manualConfirm: true }, 'confirm-2', T0 + 6000);
  assert.equal(errorCode(again), 'CONFLICT');
  assert.equal(store.state.catches.filter((c) => c.state === 'confirmed').length, 1,
    'a second confirm must not double-apply the tag');
});

test('v34 harness adversarial: tagging an already-caught Runner is CONFLICT; a Hunter cannot tag from suspension', async () => {
  const store = makeStore();
  await startActive(store);
  const claim = await openClaim(store, T0 + 3000);
  await sendWs(store, 'r1', 'catch.confirm', { catchId: claim.catchId, qrToken: '', manualConfirm: true }, 'confirm-1', T0 + 4000);
  assert.deepEqual(store.caughtRunnerIds(), ['r1']);
  const retag = await sendWs(store, 'hu1', 'catch.request', { runnerId: 'r1' }, 'retag-1', T0 + 5000);
  assert.equal(errorCode(retag), 'CONFLICT');
  // Suspend the Hunter, then try to open a claim on a (fresh) second
  // runner — need a second runner, so use a fresh store with two runners.
  const store2 = makeStore();
  store2.state.players.push(player('r2', 'Runner 2'));
  start(store2);
  store2.alarmTick(T0 + 1000);
  await sendFix(store2, 'hu1', T0 + 2000);
  await sendFix(store2, 'r2', T0 + 2000);
  store2.suspendSeat('hu1', 'network-lost', T0 + 2500);
  const suspendedTag = await sendWs(store2, 'hu1', 'catch.request', { runnerId: 'r2' }, 'susp-tag', T0 + 3000);
  assert.equal(errorCode(suspendedTag), 'FORBIDDEN');
  assert.match(errorOf(suspendedTag).payload.message, /suspended or disconnected Hunter/);
});

// --- double submits / stale sequences ------------------------------------

test('v34 harness adversarial: the same commandId twice replays the cached reply — one claim, one radio, no re-broadcast', async () => {
  const store = makeStore();
  await startActive(store);
  const first = await sendWs(store, 'hu1', 'catch.request', { runnerId: 'r1' }, 'dup-cmd-1', T0 + 3000);
  assert.equal(errorOf(first), undefined);
  assert.equal(store.state.catches.length, 1);
  const replay = await sendWs(store, 'hu1', 'catch.request', { runnerId: 'r1' }, 'dup-cmd-1', T0 + 3100);
  assert.equal(errorOf(replay), undefined, 'a replay returns the cached reply, never an error');
  assert.equal(store.state.catches.length, 1, 'a replay must not open a second claim');
  assert.deepEqual(
    replay.events.filter((e) => e.type === 'catch.requested').map((e) => e.payload.catch.catchId),
    [store.state.catches[0].catchId],
    'the replay carries the ORIGINAL claim, narrowed to the replier',
  );
  // Radio: same commandId replays the original event; a NEW commandId
  // with the same text inside 5 s is content-deduped to silence.
  const radio1 = await sendWs(store, 'h1', 'radio.send', { text: 'hello team' }, 'radio-cmd-1', T0 + 4000);
  assert.equal(radio1.events.filter((e) => e.type === 'radio').length, 1);
  const radioReplay = await sendWs(store, 'h1', 'radio.send', { text: 'hello team' }, 'radio-cmd-1', T0 + 4100);
  assert.equal(radioReplay.events.filter((e) => e.type === 'radio').length, 1,
    'same commandId replays the original radio event');
  const radioDupe = await sendWs(store, 'h1', 'radio.send', { text: 'hello team' }, 'radio-cmd-2', T0 + 4200);
  assert.equal(radioDupe.events.filter((e) => e.type === 'radio').length, 0,
    'a new commandId with identical text inside 5 s is dropped silently');
  assert.equal(errorOf(radioDupe), undefined, 'the drop is silent, not an error');
  // After the 5 s window the same text sends again.
  const radioLater = await sendWs(store, 'h1', 'radio.send', { text: 'hello team' }, 'radio-cmd-3', T0 + 9500);
  assert.equal(radioLater.events.filter((e) => e.type === 'radio').length, 1);
});

test('v34 harness adversarial: a stale snapshot key gets a full snapshot; a current key gets snapshot.unchanged', async () => {
  const store = makeStore();
  const snap1 = await sendWs(store, 'h1', 'snapshot.request', { lastServerSeq: 0 }, 'snap-1', T0);
  const full = snap1.events.find((e) => e.type === 'snapshot');
  assert.ok(full, 'no key at all gets a full snapshot');
  const key = {
    version: full.payload.version,
    serverSeq: store.state.serverSeq,
    maxLastFixAtMs: full.payload.maxLastFixAtMs ?? null,
    epochMs: full.payload.epochMs,
  };
  const unchanged = await sendWs(store, 'h1', 'snapshot.request', { lastServerSeq: 0, lastSnapshotKey: key }, 'snap-2', T0);
  assert.ok(unchanged.events.some((e) => e.type === 'snapshot.unchanged'),
    'a current key gets the tiny unchanged reply');
  assert.equal(unchanged.events.some((e) => e.type === 'snapshot'), false);
  // One fix later the key is stale: full snapshot again, never unchanged.
  await sendFix(store, 'h1', T0 + 2000);
  const stale = await sendWs(store, 'h1', 'snapshot.request', { lastServerSeq: 0, lastSnapshotKey: key }, 'snap-3', T0 + 2000);
  assert.ok(stale.events.some((e) => e.type === 'snapshot'), 'a stale key gets a full snapshot');
  assert.equal(stale.events.some((e) => e.type === 'snapshot.unchanged'), false);
});

test('v34 harness adversarial: a client-supplied network-lost suspension cannot force host succession', async () => {
  const store = makeStore();
  const r = await sendWs(store, 'h1', 'player.suspended', { reason: 'network-lost' }, 'susp-client-1', T0);
  assert.equal(errorOf(r), undefined);
  assert.equal(store.player('h1').connectionState, 'suspended', 'the seat IS suspended');
  assert.equal(store.hostGraceEndsAtMs(), null,
    'a client-claimed network-lost must NOT start the host grace (only the server-side sweep may)');
  assert.equal(store.reconnectEndsAtMs('h1'), null,
    'a client-claimed network-lost must NOT start a 30 s return window');
});

test('v34 harness adversarial: oversized voice payloads are refused; cross-team voice is FORBIDDEN', async () => {
  // Two Hunters, so the size checks run same-team (the team-only
  // check fires before the size checks — a Hunter signalling a Runner
  // is FORBIDDEN before any byte is counted).
  const store = makeStore();
  store.state.players.push(player('hu2', 'Hunter 2'));
  store.state.room.config.selectedHunterIds = ['hu1', 'hu2'];
  store.state.room.config.hunterCount = 2;
  start(store);
  store.alarmTick(T0 + 1000);
  await sendFix(store, 'hu1', T0 + 2000);
  await sendFix(store, 'hu2', T0 + 2000);
  await sendFix(store, 'r1', T0 + 2000);
  const bigCandidate = await sendWs(store, 'hu1', 'voice.signal',
    { toPlayerId: 'hu2', kind: 'ice', candidate: { c: 'x'.repeat(9000) } }, 'voice-big', T0 + 3000);
  assert.equal(errorCode(bigCandidate), 'VALIDATION_FAILED');
  assert.match(errorOf(bigCandidate).payload.message, /too large/);
  const bigSdp = await sendWs(store, 'hu1', 'voice.signal',
    { toPlayerId: 'hu2', kind: 'offer', sdp: 'x'.repeat(9000) }, 'voice-sdp', T0 + 3100);
  assert.equal(errorCode(bigSdp), 'VALIDATION_FAILED');
  // An unknown kind is refused before any relay.
  const badKind = await sendWs(store, 'hu1', 'voice.signal',
    { toPlayerId: 'hu2', kind: 'candidate', candidate: {} }, 'voice-kind', T0 + 3150);
  assert.equal(errorCode(badKind), 'VALIDATION_FAILED');
  assert.match(errorOf(badKind).payload.message, /Unknown voice signal kind/);
  // Cross-team in ACTIVE: a Hunter may not signal a Runner.
  const cross = await sendWs(store, 'hu1', 'voice.signal',
    { toPlayerId: 'r1', kind: 'offer', sdp: 'v=0' }, 'voice-cross', T0 + 3200);
  assert.equal(errorCode(cross), 'FORBIDDEN');
  assert.match(errorOf(cross).payload.message, /team-only/);
  // Unknown target: refused, nothing relayed.
  const ghostTarget = await sendWs(store, 'hu1', 'voice.signal',
    { toPlayerId: 'no-such-player', kind: 'offer', sdp: 'v=0' }, 'voice-ghost', T0 + 3300);
  assert.equal(errorCode(ghostTarget), 'VALIDATION_FAILED');
  assert.match(errorOf(ghostTarget).payload.message, /not in the room/);
  // Same-team, well-formed: relayed to the target only.
  const good = await sendWs(store, 'hu1', 'voice.signal',
    { toPlayerId: 'hu2', kind: 'offer', sdp: 'v=0' }, 'voice-good', T0 + 3400);
  assert.equal(errorOf(good), undefined);
  const relayed = good.events.find((e) => e.type === 'voice.signal');
  assert.ok(relayed, 'a valid same-team signal must be relayed');
  assert.deepEqual(relayed.recipients, ['hu2'], 'voice relays to the named peer only, never the room');
});

test('v34 harness adversarial: a caught spectator cannot message the live team, but can still send fixes', async () => {
  const store = makeStore();
  await startActive(store);
  const claim = await openClaim(store, T0 + 3000);
  await sendWs(store, 'r1', 'catch.confirm', { catchId: claim.catchId, qrToken: '', manualConfirm: true }, 'confirm-1', T0 + 4000);
  assert.deepEqual(store.caughtRunnerIds(), ['r1']);
  const radio = await sendWs(store, 'r1', 'radio.send', { text: 'I am out but talking' }, 'radio-caught', T0 + 5000);
  assert.equal(errorCode(radio), 'FORBIDDEN');
  assert.match(errorOf(radio).payload.message, /spectating/);
  const signal = await sendWs(store, 'r1', 'signal.send', { code: 'HELP' }, 'signal-caught', T0 + 5100);
  assert.equal(errorCode(signal), 'FORBIDDEN');
  // Fixes still accepted: the Runner is a real person in the field.
  const fix = await sendFix(store, 'r1', T0 + 6000);
  assert.equal(errorOf(fix), undefined, 'a caught Runner fix must still be accepted');
});
