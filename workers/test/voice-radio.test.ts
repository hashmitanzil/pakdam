import test from 'node:test';
import assert from 'node:assert/strict';
import { handleWsClientMessage } from '../src/room-do.js';
import type { RoomDoState } from '../src/room-do.js';
import type { Player, Room, Team } from '@pakdam/shared';

/**
 * Voice radio (D-M1) — Durable Object team-only enforcement.
 * The DO is the authority: a `voice.signal` is forwarded to exactly
 * one teammate and rejected otherwise. Audio never reaches the DO —
 * these tests cover the signalling gate only (shape is covered by
 * vitest/voice-signalling.test.ts, the mesh by vitest/voice-radio.test.ts).
 * Run: `npm run build --workspace=workers && npm test --workspace=workers`
 * (or root `npm test`).
 */

const mkRoom = (huntersCanTalk?: boolean): Room => ({
  roomId: 'r1', roomCode: 'ABC123', hostPlayerId: 'h1', phase: 'ACTIVE',
  version: 3,
  config: { huntersCanTalk } as never,
  createdAt: new Date().toISOString(), startedAt: null, endsAt: null, pausedAt: null, result: null,
});
const mkPlayer = (id: string, team: Team | null, isHost = false): Player => ({
  playerId: id, roomId: 'r1', kind: isHost ? 'host-account' : 'guest', displayName: id,
  isHost, matchRole: team === 'hunters' ? 'hunter' : team === 'runners' ? 'runner' : null, team,
  reconnectTokenHash: 'hash', joinedAt: new Date().toISOString(),
  leftAt: null, connectionState: 'connected', lastFixAt: null,
  locationQuality: 'unknown', isReady: true, briefingConfirmed: true,
  ageGatePassed: true, suspensionCount: 0, ejectedAt: null,
});
const mkState = (huntersCanTalk?: boolean, players?: Player[]): RoomDoState => ({
  room: mkRoom(huntersCanTalk),
  players: players ?? [mkPlayer('h1', 'hunters', true), mkPlayer('h2', 'hunters'), mkPlayer('r1', 'runners'), mkPlayer('r2', 'runners')],
  latestFix: {}, outsideSinceMs: {}, outsideAccumMs: {},
  lastZoneBoundary: null, gameEventLog: [], pendingPings: [],
  catches: [], activeCatchIds: [], serverSeq: 9, paused: false,
  pausedBy: null, sosActive: false, eventLog: [], idempotency: [],
  hostTokens: {}, lastPingAtMs: {}, wsTickets: [], wsRate: {},
});

let cmd = 0;
const send = (state: RoomDoState, playerId: string, payload: Record<string, unknown>, nowMs = 5000) =>
  handleWsClientMessage(state, playerId, {
    v: 1, type: 'voice.signal', roomId: 'r1', playerId, clientSeq: 1, clientTs: nowMs,
    commandId: `voice-cmd-${++cmd}`, payload,
  }, nowMs);
const errCode = (res: { replies: { type: string }[] }): string | null => {
  const e = res.replies.find((r) => r.type === 'error') as { payload?: { code?: string } } | undefined;
  return e?.payload?.code ?? null;
};

test('voice.signal: same-team join is forwarded as voice.signal to the named teammate only', () => {
  const state = mkState();
  const res = send(state, 'r1', { toPlayerId: 'r2', kind: 'join' });
  assert.equal(errCode(res), null);
  assert.equal(res.replies.length, 1);
  assert.equal(res.replies[0]?.type, 'voice.signal');
  if (res.replies[0]?.type === 'voice.signal') {
    assert.equal(res.replies[0].payload.fromPlayerId, 'r1');
    assert.equal(res.replies[0].payload.toPlayerId, 'r2');
    assert.equal(res.replies[0].payload.kind, 'join');
  }
  assert.equal(res.state.serverSeq, 10);
});

test('voice.signal: offer/answer/ice forward their SDP/candidate to the teammate', () => {
  const state = mkState();
  const offer = send(state, 'r1', { toPlayerId: 'r2', kind: 'offer', sdp: 'v=0 offer' });
  assert.equal(errCode(offer), null);
  if (offer.replies[0]?.type === 'voice.signal') assert.equal(offer.replies[0].payload.sdp, 'v=0 offer');
  const ice = send(state, 'r2', { toPlayerId: 'r1', kind: 'ice', candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5000 typ host' } });
  assert.equal(errCode(ice), null);
  if (ice.replies[0]?.type === 'voice.signal') {
    assert.deepEqual(ice.replies[0].payload.candidate, { candidate: 'candidate:1 1 udp 1 1.2.3.4 5000 typ host' });
  }
});

test('voice.signal: cross-team is FORBIDDEN — the other team never receives it', () => {
  const state = mkState();
  assert.equal(errCode(send(state, 'r1', { toPlayerId: 'h1', kind: 'join' })), 'FORBIDDEN');
  assert.equal(errCode(send(state, 'h1', { toPlayerId: 'r1', kind: 'offer', sdp: 'v=0 x' })), 'FORBIDDEN');
  // A cross-team attempt changes no state.
  const before = send(state, 'r1', { toPlayerId: 'h1', kind: 'join' });
  assert.equal(before.state.serverSeq, 9);
});

test('voice.signal: lobby seats (no team yet) cannot signal — voice waits for teams', () => {
  const state = mkState(undefined, [mkPlayer('h1', 'hunters', true), mkPlayer('r1', null), mkPlayer('r2', null)]);
  assert.equal(errCode(send(state, 'r1', { toPlayerId: 'r2', kind: 'join' })), 'FORBIDDEN');
});

test('voice.signal: self, unknown recipient and left seats are rejected', () => {
  const state = mkState();
  assert.equal(errCode(send(state, 'r1', { toPlayerId: 'r1', kind: 'join' })), 'VALIDATION_FAILED');
  assert.equal(errCode(send(state, 'r1', { toPlayerId: 'ghost', kind: 'join' })), 'FORBIDDEN');
  const left = mkState(undefined, [
    mkPlayer('h1', 'hunters', true), mkPlayer('r1', 'runners'),
    { ...mkPlayer('r2', 'runners'), leftAt: new Date().toISOString() },
  ]);
  assert.equal(errCode(send(left, 'r1', { toPlayerId: 'r2', kind: 'join' })), 'INVALID_STATE');
  assert.equal(errCode(send(left, 'r2', { toPlayerId: 'r1', kind: 'join' })), 'INVALID_STATE');
});

test('voice.signal: offer/answer need SDP, ice needs a candidate, oversized SDP is rejected', () => {
  const state = mkState();
  assert.equal(errCode(send(state, 'r1', { toPlayerId: 'r2', kind: 'offer' })), 'VALIDATION_FAILED');
  assert.equal(errCode(send(state, 'r1', { toPlayerId: 'r2', kind: 'answer' })), 'VALIDATION_FAILED');
  assert.equal(errCode(send(state, 'r1', { toPlayerId: 'r2', kind: 'ice' })), 'VALIDATION_FAILED');
  assert.equal(errCode(send(state, 'r1', { toPlayerId: 'r2', kind: 'offer', sdp: 'x'.repeat(8193) })), 'VALIDATION_FAILED');
  assert.equal(errCode(send(state, 'r1', { toPlayerId: 'r2', kind: 'teleport' })), 'VALIDATION_FAILED');
});

test('voice.signal: host turning Hunters’ radio off blocks Hunter voice, not Runner voice', () => {
  const state = mkState(false);
  assert.equal(errCode(send(state, 'h1', { toPlayerId: 'h2', kind: 'join' })), 'FORBIDDEN');
  assert.equal(errCode(send(state, 'r1', { toPlayerId: 'r2', kind: 'join' })), null);
});
