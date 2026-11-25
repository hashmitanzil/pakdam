import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { RoomStore, emptyMemory } = await import('../src/room-do.ts');
const { handleStart } = await import('../src/http.ts');
const sharedNs = await import('@pakdam/shared');
const {
  DEFAULT_ROOM_CONFIG,
  WS_MESSAGE_RATE_LIMITS,
  hashHostToken,
} = sharedNs;

globalThis.fetch = async () => ({ ok: true });

// v34 — Zara AppSec round-1 fixes, server pins (coordinator-routed).
// Each test names the Zara item it pins. The two "verify intent"
// items (pin.place / announcement.send scoping) needed NO code change:
// BEHAVIOUR.md §broadcast-scoping says "everything else broadcasts
// to the room", and §2 names the announcement as the public "I'm safe"
// check-in — both are public by design. See the report.
const T0 = 1_780_000_000_000;

const TRIANGLE = [
  { lat: 23.3, lng: 85.28 },
  { lat: 23.3, lng: 85.38 },
  { lat: 23.4, lng: 85.33 },
];

function player(playerId, displayName, opts = {}) {
  return {
    playerId,
    roomId: 'room-1',
    kind: 'guest',
    displayName,
    isHost: opts.isHost ?? false,
    matchRole: opts.matchRole ?? null,
    team: opts.team ?? null,
    reconnectTokenHash: `reconnect-hash-${playerId}`,
    joinedAt: new Date(opts.joinedAtMs ?? T0 - 1000).toISOString(),
    leftAt: opts.leftAt ?? null,
    ejectedAt: opts.ejectedAt ?? null,
    connectionState: opts.connectionState ?? 'connected',
    lastFixAt: null,
    locationQuality: null,
    isReady: true,
    briefingConfirmed: true,
    ageGatePassed: true,
    suspensionCount: 0,
  };
}

function makeStore({ phase = 'LOBBY', players, catches = [] } = {}) {
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
    selectedHunterIds: ['hu1'],
    hunterCount: 1,
    balanceHunters: false,
    randomDraw: false,
  };
  const list =
    players ??
    [
      player('h1', 'Host', { isHost: true, joinedAtMs: T0 - 4000 }),
      player('hu1', 'Hunter 1', { matchRole: 'hunter', team: 'hunters', joinedAtMs: T0 - 3000 }),
      player('r1', 'Runner 1', { matchRole: 'runner', team: 'runners', joinedAtMs: T0 - 2000 }),
      player('r2', 'Runner 2', { matchRole: 'runner', team: 'runners', joinedAtMs: T0 - 1000 }),
    ];
  const live = phase !== 'LOBBY';
  const state = {
    room: {
      roomId: 'room-1',
      roomCode: 'ABCDEF',
      hostPlayerId: 'h1',
      phase,
      version: 1,
      config,
      createdAt: new Date(T0 - 1000).toISOString(),
      startedAt: live ? new Date(T0).toISOString() : null,
      endsAt: live ? new Date(T0 + 3600_000).toISOString() : null,
      pausedAt: null,
      result: null,
    },
    players: list,
    catches,
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

function startActive(store, atMs = T0) {
  const r = store.startMatch({ playerId: 'h1', hostTokenHash: 'host-hash', nowMs: atMs });
  assert.equal(r.ok, true, `startMatch must succeed: ${r.ok ? '' : r.error}`);
  store.alarmTick(atMs + 1000, { liveSocketCount: 4 });
  assert.equal(store.room.phase, 'ACTIVE');
}

async function sendWs(store, playerId, type, payload, commandId, atMs) {
  return store.handleWsMessage({ playerId, sessionId: 's1' }, { type, commandId, payload }, atMs);
}

function errorCodes(result) {
  return result.events.filter((e) => e.type === 'error').map((e) => e.payload.code);
}

function pendingCatch(catchId, runnerId, hunterId) {
  return {
    catchId,
    roomId: 'room-1',
    hunterPlayerId: hunterId,
    runnerPlayerId: runnerId,
    state: 'awaiting-confirmation',
    qrTokenHash: 'qr-hash',
    requestedAt: new Date(T0).toISOString(),
    confirmedAt: null,
    resolution: null,
  };
}

// ---------------------------------------------------------------------------
// Zara 6a — getCatchToken refuses ejected/left seats
// ---------------------------------------------------------------------------

test('v34 Zara 6a: getCatchToken refuses an ejected runner (403) and a left runner (409); a live runner still gets the token', async () => {
  // Live runner: token issued.
  {
    const store = makeStore({ phase: 'ACTIVE', catches: [pendingCatch('c1', 'r1', 'hu1')] });
    // The store is built ACTIVE with the catch pending — that is all
    // getCatchToken needs (no startMatch call: the phase is already live).
    const r = await store.getCatchToken({
      playerId: 'r1',
      reconnectTokenHash: 'reconnect-hash-r1',
      catchId: 'c1',
      nowMs: T0 + 1000,
    });
    assert.equal(r.ok, true, `live runner must get a token: ${r.ok ? '' : r.error}`);
    assert.equal(typeof r.value.token, 'string');
    assert.equal(r.value.token.length, 32, 'catch token is 32 hex chars (128-bit)');
  }
  // Ejected runner: 403 FORBIDDEN, no token.
  {
    const store = makeStore({
      phase: 'ACTIVE',
      catches: [pendingCatch('c1', 'r1', 'hu1')],
      players: [
        player('h1', 'Host', { isHost: true, joinedAtMs: T0 - 4000 }),
        player('hu1', 'Hunter 1', { matchRole: 'hunter', team: 'hunters', joinedAtMs: T0 - 3000 }),
        player('r1', 'Runner 1', { matchRole: 'runner', team: 'runners', joinedAtMs: T0 - 2000, ejectedAt: new Date(T0 + 500).toISOString() }),
        player('r2', 'Runner 2', { matchRole: 'runner', team: 'runners', joinedAtMs: T0 - 1000 }),
      ],
    });
    const r = await store.getCatchToken({
      playerId: 'r1',
      reconnectTokenHash: 'reconnect-hash-r1',
      catchId: 'c1',
      nowMs: T0 + 1000,
    });
    assert.equal(r.ok, false, 'an ejected runner must get no token');
    assert.equal(r.code, 'FORBIDDEN');
    assert.equal(r.status, 403);
  }
  // Left runner: 409 CONFLICT, no token.
  {
    const store = makeStore({
      phase: 'ACTIVE',
      catches: [pendingCatch('c1', 'r1', 'hu1')],
      players: [
        player('h1', 'Host', { isHost: true, joinedAtMs: T0 - 4000 }),
        player('hu1', 'Hunter 1', { matchRole: 'hunter', team: 'hunters', joinedAtMs: T0 - 3000 }),
        player('r1', 'Runner 1', { matchRole: 'runner', team: 'runners', joinedAtMs: T0 - 2000, leftAt: new Date(T0 + 500).toISOString() }),
        player('r2', 'Runner 2', { matchRole: 'runner', team: 'runners', joinedAtMs: T0 - 1000 }),
      ],
    });
    const r = await store.getCatchToken({
      playerId: 'r1',
      reconnectTokenHash: 'reconnect-hash-r1',
      catchId: 'c1',
      nowMs: T0 + 1000,
    });
    assert.equal(r.ok, false, 'a left runner must get no token');
    assert.equal(r.code, 'CONFLICT');
    assert.equal(r.status, 409);
  }
});

// ---------------------------------------------------------------------------
// Zara 6c/6d — host transfer / succession never crowns an ejected seat
// ---------------------------------------------------------------------------

test('v34 Zara 6c: transferHost to an ejected seat is 409; to a live seat still works', () => {
  const store = makeStore();
  const ejected = store.player('r1');
  ejected.ejectedAt = new Date(T0 + 500).toISOString();
  const bad = store.transferHost({
    playerId: 'h1',
    hostTokenHash: 'host-hash',
    newHostPlayerId: 'r1',
    nowMs: T0 + 1000,
  });
  assert.equal(bad.ok, false, 'transfer to an ejected seat must refuse');
  assert.equal(bad.code, 'CONFLICT');
  assert.equal(store.room.hostPlayerId, 'h1', 'host must not move');
  const good = store.transferHost({
    playerId: 'h1',
    hostTokenHash: 'host-hash',
    newHostPlayerId: 'r2',
    nowMs: T0 + 1000,
  });
  assert.equal(good.ok, true, `transfer to a live seat must work: ${good.ok ? '' : good.error}`);
  assert.equal(store.room.hostPlayerId, 'r2');
});

test('v34 Zara 6d: leaveSeat skips an ejected earlier joiner and crowns the next live seat', () => {
  const store = makeStore();
  // hu1 joined earliest after the host — eject them, so the crown
  // must skip to r1 (not r2: r1 joined before r2 and is live).
  store.player('hu1').ejectedAt = new Date(T0 + 500).toISOString();
  const r = store.leaveSeat('h1', null, T0 + 1000);
  assert.equal(store.room.hostPlayerId, 'r1', 'host must go to r1, never the ejected hu1');
  assert.equal(store.player('r1').isHost, true);
  assert.equal(store.player('hu1').isHost, false, 'the ejected seat must not be host');
  assert.ok(r.events.some((e) => e.type === 'host.transferred'), 'the transfer must be announced');
});

test('v34 Zara 6d: succeedHostAfterDisconnect skips an ejected earliest joiner', () => {
  const store = makeStore();
  startActive(store);
  // hu1 is the earliest-joined seat after the host — eject them.
  store.player('hu1').ejectedAt = new Date(T0 + 1500).toISOString();
  const s = store.suspendSeat('h1', 'network-lost', T0 + 2000);
  assert.equal(s.events.length > 0, true, 'host must suspend');
  const t = store.succeedHostAfterDisconnect('h1', T0 + 2000);
  assert.equal(t.transferred, true, 'succession must happen');
  assert.equal(store.room.hostPlayerId, 'r1', 'host must go to r1, never the ejected hu1');
  assert.equal(store.player('hu1').isHost, false);
});

test('v34 Zara 6d: succeedHostIfSuspended left-branch skips an ejected seat on the re-trigger tick', () => {
  // Host left while every remaining seat was suspended, so leaveSeat
  // crowned nobody; the room is hostless with isHost on the absent
  // host. The first tick after a live seat returns must crown the
  // earliest-joined CONNECTED, non-ejected seat — not the ejected one.
  const store = makeStore({
    players: [
      player('h1', 'Host', { isHost: true, joinedAtMs: T0 - 4000, leftAt: new Date(T0 + 500).toISOString() }),
      player('hu1', 'Hunter 1', { matchRole: 'hunter', team: 'hunters', joinedAtMs: T0 - 3000, ejectedAt: new Date(T0 + 600).toISOString() }),
      player('r1', 'Runner 1', { matchRole: 'runner', team: 'runners', joinedAtMs: T0 - 2000 }),
      player('r2', 'Runner 2', { matchRole: 'runner', team: 'runners', joinedAtMs: T0 - 1000 }),
    ],
  });
  assert.equal(store.room.hostPlayerId, 'h1', 'host is still the absent h1 before the tick');
  const tick = store.alarmTick(T0 + 1000, { liveSocketCount: 2 });
  // hu1 joined earliest but is ejected; r1 is the earliest-joined
  // connected, non-ejected seat.
  assert.equal(store.room.hostPlayerId, 'r1', 'the re-trigger must crown r1, never the ejected hu1');
  assert.equal(store.player('hu1').isHost, false);
  assert.ok(tick.events.some((e) => e.type === 'host.transferred'), 'the transfer must be announced');
});

// ---------------------------------------------------------------------------
// Zara 6b — explicit ejected guards on mint + self-confirm
// ---------------------------------------------------------------------------

test('v34 Zara 6b: mintRunnerQrToken and selfConfirmCatch refuse an ejected runner at the op (not only via the engine)', async () => {
  const store = makeStore();
  startActive(store);
  store.player('r1').ejectedAt = new Date(T0 + 1500).toISOString();
  const mint = await store.mintRunnerQrToken({ playerId: 'r1', nowMs: T0 + 2000 });
  assert.equal(mint.ok, false, 'an ejected runner must mint no QR token');
  assert.equal(mint.code, 'FORBIDDEN');
  const self = store.selfConfirmCatch({ playerId: 'r1', hunterId: 'hu1', nowMs: T0 + 2000 });
  assert.equal(self.ok, false, 'an ejected runner must not self-confirm');
  assert.equal(self.code, 'FORBIDDEN');
  // A live runner is unaffected (mint works; self-confirm fails only
  // on the proximity gate, not on the ejected guard).
  const live = makeStore();
  startActive(live);
  const mint2 = await live.mintRunnerQrToken({ playerId: 'r1', nowMs: T0 + 2000 });
  assert.equal(mint2.ok, true, `a live runner must mint: ${mint2.ok ? '' : mint2.error}`);
});

// ---------------------------------------------------------------------------
// Zara 5a — WS safety.resume needs host-token proof
// ---------------------------------------------------------------------------

test('v34 Zara 5a: WS safety.resume needs the host token — no token refuses, the right token resumes, a non-host token refuses', async () => {
  const store = makeStore();
  startActive(store);
  // Real host-token hash in state (the factory's 'host-hash' is a
  // placeholder, not sha256 of anything — replace it with a real one).
  const rawHostToken = 'test-host-token-1234';
  store.state.hostTokens['h1'] = await hashHostToken(rawHostToken);
  // Pause (any player may pause).
  const paused = await sendWs(store, 'r1', 'safety.pause', { reason: 'test' }, 'pause-1', T0 + 2000);
  assert.equal(errorCodes(paused).length, 0, `pause must succeed: ${JSON.stringify(paused.events)}`);
  assert.equal(store.room.phase, 'SAFETY_PAUSED');
  // No token: FORBIDDEN.
  const noToken = await sendWs(store, 'h1', 'safety.resume', {}, 'resume-1', T0 + 3000);
  assert.ok(errorCodes(noToken).includes('FORBIDDEN'), 'resume without a host token must be FORBIDDEN');
  assert.equal(store.room.phase, 'SAFETY_PAUSED', 'the match must stay paused');
  // Wrong token: FORBIDDEN.
  const wrong = await sendWs(store, 'h1', 'safety.resume', { hostToken: 'wrong-token' }, 'resume-2', T0 + 3000);
  assert.ok(errorCodes(wrong).includes('FORBIDDEN'), 'resume with a wrong host token must be FORBIDDEN');
  // Non-host seat with the host token: verifyHost also requires
  // isHost, so a runner presenting the token still refuses.
  const runner = await sendWs(store, 'r1', 'safety.resume', { hostToken: rawHostToken }, 'resume-3', T0 + 3000);
  assert.ok(errorCodes(runner).includes('FORBIDDEN'), 'a non-host presenting the token must still refuse');
  // Right token from the host: resumes.
  const good = await sendWs(store, 'h1', 'safety.resume', { hostToken: rawHostToken }, 'resume-4', T0 + 3000);
  assert.equal(errorCodes(good).length, 0, `resume with the host token must succeed: ${JSON.stringify(good.events)}`);
  assert.equal(store.room.phase, 'ACTIVE', 'the match must resume to ACTIVE');
});

// ---------------------------------------------------------------------------
// Zara 8a/8b — voice rate 60/min + no live comms to caught spectators
// ---------------------------------------------------------------------------

test('v34 Zara 8a: voice.signal rate is 60/min/seat (was 600) — the 61st signal in a minute is RATE_LIMITED', async () => {
  assert.equal(
    WS_MESSAGE_RATE_LIMITS['voice.signal'].limit,
    60,
    'the calibration value must be 60/min/seat',
  );
  assert.equal(WS_MESSAGE_RATE_LIMITS['voice.signal'].windowSeconds, 60);
  const store = makeStore();
  startActive(store);
  let limitedAt = -1;
  for (let i = 1; i <= 61; i += 1) {
    const r = await sendWs(store, 'hu1', 'voice.signal', { toPlayerId: 'hu1', kind: 'join' }, `vs-${i}`, T0 + i * 500);
    if (errorCodes(r).includes('RATE_LIMITED')) {
      limitedAt = i;
      break;
    }
  }
  // 60 in a 60 s window: sends at 500 ms spacing span 30 s, so all 60
  // fit inside one window and the 61st must limit.
  assert.equal(limitedAt, 61, `the 61st voice.signal must limit, got ${limitedAt}`);
});

test('v34 Zara 8b: a caught spectator hears no live team comms — voice refused, radio/signal exclude them', async () => {
  const store = makeStore({
    phase: 'ACTIVE',
    catches: [
      {
        catchId: 'c1',
        roomId: 'room-1',
        hunterPlayerId: 'hu1',
        runnerPlayerId: 'r1',
        state: 'confirmed',
        qrTokenHash: 'qr-hash',
        requestedAt: new Date(T0).toISOString(),
        confirmedAt: new Date(T0 + 1000).toISOString(),
        resolution: 'confirmed',
      },
    ],
  });
  // r1 is a caught spectator; r2 is a live teammate.
  assert.equal(store.isCaughtSpectator('r1'), true, 'r1 must read as a caught spectator');
  assert.equal(store.isCaughtSpectator('r2'), false, 'r2 must not');
  // Voice TO the caught spectator: refused.
  const voice = await sendWs(store, 'r2', 'voice.signal', { toPlayerId: 'r1', kind: 'join' }, 'v-1', T0 + 2000);
  assert.ok(errorCodes(voice).includes('FORBIDDEN'), 'voice to a caught spectator must be FORBIDDEN');
  // Radio FROM a live teammate: recipients exclude the caught runner.
  const radio = await sendWs(store, 'r2', 'radio.send', { text: 'go go', kind: 'text' }, 'radio-1', T0 + 2000);
  assert.equal(errorCodes(radio).length, 0, 'live radio must send');
  const radioEvent = radio.events.find((e) => e.type === 'radio');
  assert.ok(radioEvent, 'a radio event must be emitted');
  assert.ok(!radioEvent.recipients.includes('r1'), 'radio must not reach the caught spectator');
  assert.ok(radioEvent.recipients.includes('r2'), 'radio must still reach live teammates');
  // Quick signal FROM a live teammate: same exclusion.
  const signal = await sendWs(store, 'r2', 'signal.send', { code: 'Stay spread out' }, 'sig-1', T0 + 2000);
  assert.equal(errorCodes(signal).length, 0, 'live signal must send');
  const signalEvent = signal.events.find((e) => e.type === 'signal');
  assert.ok(signalEvent, 'a signal event must be emitted');
  assert.ok(!signalEvent.recipients.includes('r1'), 'signal must not reach the caught spectator');
  // Voice FROM the caught spectator was already blocked (sender-side,
  // pre-existing) — still blocked.
  const fromCaught = await sendWs(store, 'r1', 'voice.signal', { toPlayerId: 'r2', kind: 'join' }, 'v-2', T0 + 2000);
  assert.ok(errorCodes(fromCaught).includes('FORBIDDEN'), 'voice from a caught spectator must stay FORBIDDEN');
});

// ---------------------------------------------------------------------------
// Zara 10b, re-pinned by v34 (Diya R3-N1) — verify-then-limit on
// host-token routes
// ---------------------------------------------------------------------------
//
// The old pin ("start attempts with DIFFERENT guessed host tokens
// share one room+seat bucket — the 6th is 429") IS the R3-N1 hole:
// the seat bucket was keyed by the client-supplied playerId, so any
// room member who read the host's playerId from a snapshot could
// burn the host's budget with 5 unauthenticated calls and 429 the
// host's real Start for up to 60 s. The seat bucket is now touched
// ONLY after the DO verifies the host token, so forged attempts
// cannot consume it. What the new design still throttles:
//   - hammering with ONE presented credential (pre-auth bucket, per
//     credential — the 6th repeat of the SAME guessed token 429s);
//   - genuinely excessive VERIFIED calls (seat bucket — the 6th
//     verified start 429s, and it still binds across a token
//     rotation by the verified holder, where the per-credential
//     pre-auth bucket alone would not).
// Rotating guessed tokens get fresh pre-auth buckets and each 403s
// at verify — accepted: host tokens are 128-bit, guessing is
// infeasible, and each attempt is still refused by the DO.

function makeVerifyStubEnv(validHashes) {
  const ops = [];
  return {
    ops,
    env: {
      ROOM_DO: {
        idFromName: (name) => name,
        get: () => ({
          fetch: async (_url, init) => {
            const body = JSON.parse(String(init?.body ?? '{}'));
            ops.push(body.op);
            if (body.op === 'verify-host-token') {
              return new Response(
                JSON.stringify({ ok: true, valid: validHashes.has(body.hostTokenHash) }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
              );
            }
            return new Response(
              JSON.stringify({ ok: true, phase: 'HEAD_START', roomCode: 'ABCDEF', playerCount: 3 }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          },
        }),
      },
    },
  };
}

async function startCall(env, roomId, playerId, hostToken) {
  const req = new Request(`http://x/v1/rooms/${roomId}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId, hostToken }),
  });
  const res = await handleStart(req, { env, ctx: { waitUntil: () => undefined } }, roomId);
  return res.status;
}

test('v34 R3-N1: forged starts with the host playerId do NOT burn the host bucket — the host real Start still succeeds', async () => {
  // start is 5/min/seat. Six forged attempts with the host's
  // playerId and a DIFFERENT guessed token each time: every one must
  // 403 at verify, none may 429, and the host's real Start afterwards
  // must still reach the DO and succeed.
  const roomId = 'room-r3-n1-start';
  const playerId = '11111111-2222-4333-8444-555555555555';
  const realHash = await hashHostToken('real-host-token');
  const stub = makeVerifyStubEnv(new Set([realHash]));
  const statuses = [];
  for (let i = 0; i < 6; i += 1) {
    statuses.push(await startCall(stub.env, roomId, playerId, `guessed-token-${i}`));
  }
  assert.deepEqual(
    statuses,
    [403, 403, 403, 403, 403, 403],
    `six forged starts must each 403 at verify, never 429: got ${JSON.stringify(statuses)}`,
  );
  assert.equal(
    stub.ops.filter((op) => op === 'start').length,
    0,
    'no forged attempt may reach the start op',
  );
  const real = await startCall(stub.env, roomId, playerId, 'real-host-token');
  assert.equal(real, 200, `the host's real Start must still succeed after 6 forged attempts, got ${real}`);
  assert.equal(
    stub.ops.filter((op) => op === 'start').length,
    1,
    'the real Start must reach the DO exactly once',
  );
});

test('v34 R3-N1: hammering with ONE guessed host token still 429s at the pre-auth bucket', async () => {
  const roomId = 'room-r3-n1-preauth';
  const playerId = '22222222-2222-4333-8444-555555555555';
  const stub = makeVerifyStubEnv(new Set());
  const statuses = [];
  for (let i = 0; i < 6; i += 1) {
    statuses.push(await startCall(stub.env, roomId, playerId, 'same-guessed-token'));
  }
  assert.deepEqual(
    statuses,
    [403, 403, 403, 403, 403, 429],
    `five repeats pass the pre-auth bucket (DO 403s them), the 6th must 429: got ${JSON.stringify(statuses)}`,
  );
  assert.equal(
    stub.ops.filter((op) => op === 'verify-host-token').length,
    5,
    'the 429d attempt must never reach the DO',
  );
});

test('v34 R3-N1: genuinely excessive VERIFIED starts still 429 — and the seat bucket binds across a token rotation', async () => {
  const roomId = 'room-r3-n1-seat';
  const playerId = '33333333-2222-4333-8444-555555555555';
  const hashA = await hashHostToken('real-host-token-a');
  const hashB = await hashHostToken('real-host-token-b');
  const stub = makeVerifyStubEnv(new Set([hashA, hashB]));
  const statuses = [];
  // Three verified starts on token A, then three on token B (a
  // rotation). The per-credential pre-auth bucket alone would allow
  // all six (3 + 3 under the 5/min cap each); the per-seat bucket
  // must stop the 6th.
  for (const token of ['real-host-token-a', 'real-host-token-a', 'real-host-token-a', 'real-host-token-b', 'real-host-token-b', 'real-host-token-b']) {
    statuses.push(await startCall(stub.env, roomId, playerId, token));
  }
  assert.deepEqual(
    statuses,
    [200, 200, 200, 200, 200, 429],
    `five verified starts pass, the 6th must 429 at the seat bucket: got ${JSON.stringify(statuses)}`,
  );
  assert.equal(
    stub.ops.filter((op) => op === 'start').length,
    5,
    'the 429d attempt must never reach the start op',
  );
});
