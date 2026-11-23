import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { buildSnapshot } = await import('../src/snapshot.ts');

// F1 (v30 AppSec) — the snapshot must not leak an opponent's GPS
// liveness outside the lobby: `lastFixAt` / `locationQuality` are
// null for every non-viewer once play starts, while the LOBBY keeps
// them (the roster shows per-player freshness there) and the viewer's
// own fields stay intact in every phase.
const T0 = 1_780_000_000_000;
const FIX_AT = new Date(T0).toISOString();

function player(playerId, displayName, team, matchRole, isHost = false) {
  return {
    playerId,
    roomId: 'room-1',
    kind: 'guest',
    displayName,
    isHost,
    matchRole,
    team,
    reconnectTokenHash: `reconnect-hash-${playerId}`,
    joinedAt: new Date(T0 - 1000).toISOString(),
    leftAt: null,
    ejectedAt: null,
    connectionState: 'connected',
    lastFixAt: FIX_AT,
    locationQuality: 'good',
    isReady: true,
    briefingConfirmed: true,
    ageGatePassed: true,
    suspensionCount: 0,
  };
}

function snapshot(phase, viewerPlayerId, fixAtById = {}) {
  const room = {
    roomId: 'room-1',
    roomCode: 'ABCDEF',
    hostPlayerId: 'h1',
    phase,
    version: 1,
    config: {},
    createdAt: new Date(T0 - 1000).toISOString(),
    startedAt: phase === 'LOBBY' ? null : new Date(T0).toISOString(),
    endsAt: null,
    pausedAt: null,
    result: null,
  };
  const players = [
    player('h1', 'Host', 'runners', 'runner', true),
    player('hu1', 'Hunter', 'hunters', 'hunter'),
    player('r1', 'Runner', 'runners', 'runner'),
  ].map((p) =>
    fixAtById[p.playerId] === undefined
      ? p
      : { ...p, lastFixAt: new Date(fixAtById[p.playerId]).toISOString() },
  );
  return buildSnapshot({
    room,
    players,
    viewerPlayerId,
    viewerIsHost: viewerPlayerId === 'h1',
    serverSeq: 1,
    locationStatus: { h1: 'known', hu1: 'known', r1: 'known' },
    catches: [],
    safetyState: { paused: false, pausedBy: null, pausedAt: null },
    missedAnnouncements: [],
    fixes: {},
    hostGraceEndsAtMs: null,
    epochMs: T0,
  });
}

function byId(snap, playerId) {
  return snap.players.find((p) => p.playerId === playerId);
}

test('F1: in LOBBY an opponent keeps lastFixAt / locationQuality', () => {
  const snap = snapshot('LOBBY', 'hu1');
  const opponent = byId(snap, 'r1');
  assert.equal(opponent.lastFixAt, FIX_AT);
  assert.equal(opponent.locationQuality, 'good');
  // Teammate and viewer also intact in the lobby.
  assert.equal(byId(snap, 'h1').lastFixAt, FIX_AT);
  assert.equal(byId(snap, 'hu1').lastFixAt, FIX_AT);
});

// Every non-lobby phase of the 12-phase union
// (`packages/shared/src/types.ts` MatchPhase) — 'RESULTS' is NOT a
// real phase and must never appear here again.
const NON_LOBBY_PHASES = [
  'DRAFT',
  'READY_CHECK',
  'COUNTDOWN',
  'HEAD_START',
  'ACTIVE',
  'SAFETY_PAUSED',
  'RESOLVING',
  'COMPLETED',
  'CANCELLED',
  'ABANDONED',
  'EXPIRED',
];

test('F1: outside LOBBY a non-viewer is redacted, the viewer is intact', () => {
  for (const phase of NON_LOBBY_PHASES) {
    const snap = snapshot(phase, 'hu1');
    const opponent = byId(snap, 'r1');
    assert.equal(opponent.lastFixAt, null, `${phase}: opponent lastFixAt must be null`);
    assert.equal(opponent.locationQuality, null, `${phase}: opponent locationQuality must be null`);
    // Teammates are redacted too — liveness is per-viewer only.
    assert.equal(byId(snap, 'h1').lastFixAt, null, `${phase}: non-viewer lastFixAt must be null`);
    assert.equal(byId(snap, 'h1').locationQuality, null);
    // The viewer's own fields are untouched.
    assert.equal(byId(snap, 'hu1').lastFixAt, FIX_AT, `${phase}: viewer lastFixAt must survive`);
    assert.equal(byId(snap, 'hu1').locationQuality, 'good');
    // connectionState is NOT redacted (host-grace banner needs it).
    assert.equal(opponent.connectionState, 'connected');
    // The watermark is per-viewer (viewer + same-team only): this
    // fixture gives the viewer no same-team teammate, so it equals
    // the viewer's own fix time — never the roster max.
    assert.equal(snap.maxLastFixAtMs, T0, `${phase}: watermark must be the viewer's own fix time`);
  }
});

test('F1: 2-player game — a fresher opponent fix must not move the watermark', () => {
  // Supported minimum, literal 2-seat roster: viewer hunter fixed
  // at T0 - 5000, the sole opponent runner fixed fresher at T0.
  // Roster-wide the max would be T0 (the opponent's); per-viewer
  // it must be the viewer's own.
  for (const phase of NON_LOBBY_PHASES) {
    const room = {
      roomId: 'room-1',
      roomCode: 'ABCDEF',
      hostPlayerId: 'hu1',
      phase,
      version: 1,
      config: {},
      createdAt: new Date(T0 - 1000).toISOString(),
      startedAt: phase === 'LOBBY' ? null : new Date(T0).toISOString(),
      endsAt: null,
      pausedAt: null,
      result: null,
    };
    const players = [
      { ...player('hu1', 'Hunter', 'hunters', 'hunter', true), lastFixAt: new Date(T0 - 5000).toISOString() },
      { ...player('r1', 'Runner', 'runners', 'runner'), lastFixAt: new Date(T0).toISOString() },
    ];
    const snap = buildSnapshot({
      room,
      players,
      viewerPlayerId: 'hu1',
      viewerIsHost: true,
      serverSeq: 1,
      locationStatus: { hu1: 'known', r1: 'known' },
      catches: [],
      safetyState: { paused: false, pausedBy: null, pausedAt: null },
      missedAnnouncements: [],
      fixes: {},
      hostGraceEndsAtMs: null,
      epochMs: T0,
    });
    assert.equal(
      snap.maxLastFixAtMs,
      T0 - 5000,
      `${phase}: watermark must equal the viewer's own fix time, not the fresher opponent's`,
    );
    assert.equal(byId(snap, 'r1').lastFixAt, null, `${phase}: opponent lastFixAt must be null`);
  }
});

test('F1: a fresher same-team fix DOES move the watermark; a fresher opponent fix does not', () => {
  // Viewer hunter at T0 - 5000, same-team hunter teammate at T0,
  // opponent runner freshest at T0 + 10000. Watermark must be the
  // teammate's T0 — the opponent's freshness stays invisible.
  const room = {
    roomId: 'room-1',
    roomCode: 'ABCDEF',
    hostPlayerId: 'h1',
    phase: 'ACTIVE',
    version: 1,
    config: {},
    createdAt: new Date(T0 - 1000).toISOString(),
    startedAt: new Date(T0).toISOString(),
    endsAt: null,
    pausedAt: null,
    result: null,
  };
  const players = [
    { ...player('h1', 'Host', 'runners', 'runner', true), lastFixAt: new Date(T0 + 10000).toISOString() },
    { ...player('hu1', 'Hunter', 'hunters', 'hunter'), lastFixAt: new Date(T0 - 5000).toISOString() },
    { ...player('hu2', 'Hunter 2', 'hunters', 'hunter'), lastFixAt: new Date(T0).toISOString() },
  ];
  const snap = buildSnapshot({
    room,
    players,
    viewerPlayerId: 'hu1',
    viewerIsHost: false,
    serverSeq: 1,
    locationStatus: { h1: 'known', hu1: 'known', hu2: 'known' },
    catches: [],
    safetyState: { paused: false, pausedBy: null, pausedAt: null },
    missedAnnouncements: [],
    fixes: {},
    hostGraceEndsAtMs: null,
    epochMs: T0,
  });
  assert.equal(snap.maxLastFixAtMs, T0);
});
