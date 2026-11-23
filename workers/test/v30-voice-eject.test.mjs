import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { RoomStore, emptyMemory } = await import('../src/room-do.ts');
const { DEFAULT_ROOM_CONFIG } = await import('@pakdam/shared');

// F2 (v30 AppSec) — an ejected seat keeps no live team voice: the DO
// `voice.signal` handler must reject an ejected sender with FORBIDDEN
// before the team check, so its signals are never forwarded. A
// non-ejected teammate's signal is unaffected. Harness mirrors
// v30-happy-path.test.mjs.
const T0 = 1_780_000_000_000;

const TRIANGLE = [
  { lat: 23.3, lng: 85.28 },
  { lat: 23.3, lng: 85.38 },
  { lat: 23.4, lng: 85.33 },
];
const INSIDE = { lat: 23.35, lng: 85.33 };

function player(playerId, displayName, isHost = false) {
  return {
    playerId,
    roomId: 'room-1',
    kind: 'guest',
    displayName,
    isHost,
    matchRole: null,
    team: null,
    reconnectTokenHash: `reconnect-hash-${playerId}`,
    joinedAt: new Date(T0 - 1000).toISOString(),
    leftAt: null,
    ejectedAt: null,
    connectionState: 'connected',
    lastFixAt: null,
    locationQuality: null,
    isReady: true,
    briefingConfirmed: true,
    ageGatePassed: true,
    suspensionCount: 0,
  };
}

// Host + 3 hunters + 1 runner, selected teams so roles are
// deterministic. Three hunters so a same-team control still exists
// after one of them is ejected.
function makeStore() {
  const config = {
    ...DEFAULT_ROOM_CONFIG,
    headStartSeconds: 0,
    pingIntervalSeconds: 0,
    durationSeconds: 3600,
    zoneShrinkEnabled: false,
    zoneShrinkIntervalSeconds: 60,
    playZoneEnabled: true,
    zone: { boundary: TRIANGLE, shrinkPhases: [] },
    teamAssignment: 'selected',
    selectedHunterIds: ['hu1', 'hu2', 'hu3'],
    hunterCount: 3,
    balanceHunters: false,
    randomDraw: false,
  };
  const players = [
    player('h1', 'Host', true),
    player('hu1', 'Hunter 1'),
    player('hu2', 'Hunter 2'),
    player('hu3', 'Hunter 3'),
    player('r1', 'Runner 1'),
  ];
  const state = {
    room: {
      roomId: 'room-1',
      roomCode: 'ABCDEF',
      hostPlayerId: 'h1',
      phase: 'LOBBY',
      version: 1,
      config,
      createdAt: new Date(T0 - 1000).toISOString(),
      startedAt: null,
      endsAt: null,
      pausedAt: null,
      result: null,
    },
    players,
    catches: [],
    hostTokens: { h1: 'host-hash' },
    serverSeq: 0,
    gameEventLog: [],
    lastPingAtMs: {},
    paused: false,
    pausedBy: null,
    pausedFrom: null,
    eventLog: [],
    shrinkIndexApplied: 0,
    tickets: [],
    idempotency: [],
    idempotentReplies: [],
    pendingPings: [],
    pendingPingRecipients: {},
    runnerQrTokens: [],
  };
  return new RoomStore(state, emptyMemory());
}

async function sendFix(store, playerId, atMs) {
  const r = await store.handleWsMessage(
    { playerId, sessionId: 's1' },
    {
      type: 'location.update',
      commandId: `fix-${playerId}-${atMs}`,
      payload: { fix: { ...INSIDE, accuracyMeters: 10, timestampMs: atMs } },
    },
    atMs,
  );
  assert.equal(
    r.events.some((e) => e.type === 'error'),
    false,
    `fix for ${playerId} at ${atMs} must be accepted`,
  );
}

async function sendVoiceSignal(store, fromPlayerId, toPlayerId, commandId, atMs, kind = 'join', sdp = undefined) {
  return store.handleWsMessage(
    { playerId: fromPlayerId, sessionId: 's1' },
    {
      type: 'voice.signal',
      commandId,
      payload: { toPlayerId, kind, ...(sdp !== undefined ? { sdp } : {}) },
    },
    atMs,
  );
}

function errorOf(result) {
  return result.events.find((e) => e.type === 'error');
}

test('F2: ejected seat voice.signal is FORBIDDEN and never forwarded; teammate signal passes', async () => {
  const store = makeStore();
  for (const id of ['h1', 'hu1', 'hu2', 'hu3', 'r1']) await sendFix(store, id, T0 + 500);
  const start = store.startMatch({ playerId: 'h1', hostTokenHash: 'host-hash', nowMs: T0 });
  assert.equal(start.ok, true, 'startMatch must succeed');
  store.alarmTick(T0 + 1000);
  assert.equal(store.room.phase, 'ACTIVE');
  assert.equal(store.player('hu1').team, 'hunters');
  assert.equal(store.player('hu2').team, 'hunters');

  // Control: a live hunter signalling a same-team hunter is forwarded.
  const live = await sendVoiceSignal(store, 'hu1', 'hu2', 'voice-live-1', T0 + 2000);
  assert.equal(errorOf(live), undefined, 'live teammate signal must not error');
  const forwarded = live.events.find((e) => e.type === 'voice.signal');
  assert.ok(forwarded, 'live teammate signal must be forwarded');
  assert.deepEqual(forwarded.recipients, ['hu2']);

  // Eject hu1 (the DO's own ejection stamps `ejectedAt`; the seat
  // stays in the room record with `leftAt` null — that is the hole).
  store.player('hu1').ejectedAt = new Date(T0 + 3000).toISOString();
  assert.equal(store.player('hu1').leftAt, null);

  // Same-team target, same kind — only the ejection differs. The
  // signal must be rejected, never forwarded.
  const ejected = await sendVoiceSignal(store, 'hu1', 'hu2', 'voice-ejected-1', T0 + 4000);
  const err = errorOf(ejected);
  assert.ok(err, 'ejected seat signal must produce an error event');
  assert.equal(err.payload.code, 'FORBIDDEN');
  assert.equal(
    ejected.events.some((e) => e.type === 'voice.signal'),
    false,
    'ejected seat signal must not be forwarded to any peer',
  );

  // The ejection of one seat does not silence the rest of the team.
  const stillLive = await sendVoiceSignal(store, 'hu2', 'hu3', 'voice-live-2', T0 + 5000);
  assert.equal(errorOf(stillLive), undefined, 'non-ejected teammate signal must not error');
  assert.ok(stillLive.events.find((e) => e.type === 'voice.signal'), 'non-ejected signal must forward');
});

test('F2: a non-ejected teammate signalling an ejected seat is FORBIDDEN and nothing is forwarded (join + offer)', async () => {
  const store = makeStore();
  for (const id of ['h1', 'hu1', 'hu2', 'hu3', 'r1']) await sendFix(store, id, T0 + 500);
  const start = store.startMatch({ playerId: 'h1', hostTokenHash: 'host-hash', nowMs: T0 });
  assert.equal(start.ok, true, 'startMatch must succeed');
  store.alarmTick(T0 + 1000);
  assert.equal(store.room.phase, 'ACTIVE');

  // Control: hu1 signalling hu2 (both live, same team) forwards.
  const live = await sendVoiceSignal(store, 'hu1', 'hu2', 'voice-target-live', T0 + 2000);
  assert.equal(errorOf(live), undefined, 'live target signal must not error');
  assert.ok(live.events.find((e) => e.type === 'voice.signal'), 'live target signal must forward');

  // In-flight handshake: hu2 offered to hu1 before ejection (the
  // sender-side block can never fire for this — the ejected seat
  // sends nothing post-ejection, only the teammate's answer does).
  // Eject hu2; hu1 is the non-ejected teammate still signalling it.
  store.player('hu2').ejectedAt = new Date(T0 + 3000).toISOString();
  assert.equal(store.player('hu2').leftAt, null);

  for (const [kind, commandId, sdp] of [
    ['join', 'voice-target-ejected-join', undefined],
    ['offer', 'voice-target-ejected-offer', 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n'],
  ]) {
    const blocked = await sendVoiceSignal(store, 'hu1', 'hu2', commandId, T0 + 4000, kind, sdp);
    const err = errorOf(blocked);
    assert.ok(err, `${kind}: signal to an ejected seat must produce an error event`);
    assert.equal(err.payload.code, 'FORBIDDEN', `${kind}: error code must be FORBIDDEN`);
    assert.equal(
      blocked.events.some((e) => e.type === 'voice.signal'),
      false,
      `${kind}: signal to an ejected seat must not be forwarded`,
    );
    // The error goes to the sending teammate only; the ejected
    // target receives nothing at all.
    assert.deepEqual(
      blocked.events.flatMap((e) => e.recipients ?? []),
      ['hu1'],
      `${kind}: only the sender may receive anything`,
    );
  }

  // The ejection of the target does not silence the rest of the team.
  const stillLive = await sendVoiceSignal(store, 'hu1', 'hu3', 'voice-target-live-2', T0 + 5000);
  assert.equal(errorOf(stillLive), undefined, 'signal to a live teammate must not error');
  assert.ok(stillLive.events.find((e) => e.type === 'voice.signal'), 'signal to a live teammate must forward');
});
