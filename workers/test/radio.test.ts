import test from 'node:test';
import assert from 'node:assert/strict';
import { handleWsClientMessage } from '../src/room-do.js';
import type { RoomDoState } from '../src/room-do.js';
import { validateWsClientMessage } from '../src/lib/validation.js';
import type { Player, Room, Team } from '@pakdam/shared';

/**
 * Team Radio TEXT (D-M7) — Durable Object relay.
 * The DO is the authority: a `radio.send` is validated (1–140 chars),
 * stamped with the sender's display name from the seat record (never
 * a client claim), and broadcast as `radio` to the sender's TEAM only
 * (fan-out in workers/src/room-do-class.ts broadcastRecipients; the
 * lobby — no teams yet — goes to the whole lobby). Text is ephemeral:
 * no snapshot carries radio history. Voice is a separate channel
 * (D-M1, voice.signal) and is NOT covered here.
 * Run: `pnpm --filter pakdam-workers run build && pnpm --filter pakdam-workers test`
 * (or root `pnpm test`).
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
const send = (state: RoomDoState, playerId: string, payload: Record<string, unknown>, commandId?: string, nowMs = 5000) =>
  handleWsClientMessage(state, playerId, {
    v: 1, type: 'radio.send', roomId: 'r1', playerId, clientSeq: 1, clientTs: nowMs,
    commandId: commandId ?? `radio-cmd-${++cmd}`, payload,
  }, nowMs);
const errCode = (res: { replies: { type: string }[] }): string | null => {
  const e = res.replies.find((r) => r.type === 'error') as { payload?: { code?: string } } | undefined;
  return e?.payload?.code ?? null;
};
const radioPayload = (res: { replies: { type: string }[] }): Record<string, unknown> | null => {
  const r = res.replies.find((x) => x.type === 'radio') as { payload?: { radio?: Record<string, unknown> } } | undefined;
  return r?.payload?.radio ?? null;
};

test('radio.send: a Runner text message is relayed as radio, stamped with the seat display name', () => {
  const state = mkState();
  const res = send(state, 'r1', { text: 'Moving to a new spot' });
  assert.equal(errCode(res), null);
  assert.equal(res.replies.length, 1);
  assert.equal(res.replies[0]?.type, 'radio');
  const radio = radioPayload(res)!;
  assert.equal(radio['text'], 'Moving to a new spot');
  assert.equal(radio['kind'], 'text');
  assert.equal(radio['senderName'], 'r1', 'sender name comes from the seat, not the client');
  assert.equal(radio['playerId'], 'r1');
  assert.equal(radio['roomId'], 'r1');
  assert.equal(typeof radio['messageId'], 'string');
  assert.equal(typeof radio['sentAt'], 'string');
  assert.equal(res.state.serverSeq, 10);
});

test('radio.send: quick kind is preserved; kind defaults to text when omitted', () => {
  const state = mkState();
  const quick = send(state, 'r1', { text: 'Stay spread out', kind: 'quick' });
  assert.equal(errCode(quick), null);
  assert.equal(radioPayload(quick)!['kind'], 'quick');
  const plain = send(state, 'r1', { text: 'hello' });
  assert.equal(radioPayload(plain)!['kind'], 'text');
});

test('radio.send: a lobby seat (no team yet) can send — that IS the lobby radio', () => {
  const state = mkState(undefined, [mkPlayer('h1', 'hunters', true), mkPlayer('r1', null), mkPlayer('r2', null)]);
  const res = send(state, 'r1', { text: 'Ready when you are', kind: 'quick' });
  assert.equal(errCode(res), null);
  assert.equal(res.replies[0]?.type, 'radio');
});

test('radio.send: host turning Hunters’ radio off blocks Hunter text, not Runner text', () => {
  const state = mkState(false);
  assert.equal(errCode(send(state, 'h1', { text: 'Cover the far edge' })), 'FORBIDDEN');
  assert.equal(errCode(send(state, 'r1', { text: 'I’m safe for now' })), null);
  // Absent toggle = ON (legacy rooms): Hunters can send.
  assert.equal(errCode(send(mkState(), 'h1', { text: 'Cover the far edge' })), null);
});

test('radio.send: empty, whitespace-only, over-140-char and bad-kind texts are rejected, state unchanged', () => {
  const state = mkState();
  assert.equal(errCode(send(state, 'r1', { text: '' })), 'VALIDATION_FAILED');
  assert.equal(errCode(send(state, 'r1', { text: '   ' })), 'VALIDATION_FAILED');
  assert.equal(errCode(send(state, 'r1', { text: 'x'.repeat(141) })), 'VALIDATION_FAILED');
  assert.equal(errCode(send(state, 'r1', { text: 'x'.repeat(140) })), null, '140 chars is the cap, not 139');
  assert.equal(errCode(send(state, 'r1', { text: 'hi', kind: 'shout' })), 'VALIDATION_FAILED');
  const failed = send(state, 'r1', { text: '' });
  assert.equal(failed.state.serverSeq, 9, 'a rejected send changes no state');
});

test('radio.send: an ejected or left seat cannot send', () => {
  const ejected = mkState(undefined, [
    mkPlayer('h1', 'hunters', true),
    { ...mkPlayer('r1', 'runners'), ejectedAt: new Date().toISOString() },
    mkPlayer('r2', 'runners'),
  ]);
  assert.equal(errCode(send(ejected, 'r1', { text: 'hi' })), 'INVALID_STATE');
  const left = mkState(undefined, [
    mkPlayer('h1', 'hunters', true), mkPlayer('r1', 'runners'),
    { ...mkPlayer('r2', 'runners'), leftAt: new Date().toISOString() },
  ]);
  assert.equal(errCode(send(left, 'r2', { text: 'hi' })), 'INVALID_STATE');
});

test('radio.send: a retried commandId returns the stored reply once (replayed, no second effect)', () => {
  const state = mkState();
  const first = send(state, 'r1', { text: 'hello team' }, 'radio-retry-1');
  assert.equal(errCode(first), null);
  assert.equal(first.state.serverSeq, 10);
  const second = send(first.state, 'r1', { text: 'hello team' }, 'radio-retry-1');
  assert.equal(second.replayed, true);
  assert.deepEqual(second.replies, first.replies);
  assert.equal(second.state.serverSeq, 10, 'the replay bumps no sequence');
});

test('radio.send: the 11th message in a minute is RATE_LIMITED (10/min per seat)', () => {
  let state = mkState();
  for (let i = 0; i < 10; i++) {
    const res = send(state, 'r1', { text: `msg ${i}` });
    assert.equal(errCode(res), null, `message ${i + 1} must be allowed`);
    state = res.state;
  }
  assert.equal(errCode(send(state, 'r1', { text: 'msg 10' })), 'RATE_LIMITED');
});

test('radio.send: shape validation (workers/src/lib/validation.ts) accepts 140 chars, rejects 141', () => {
  const ok = validateWsClientMessage({ v: 1, type: 'radio.send', roomId: 'r1', playerId: 'r1', payload: { text: 'x'.repeat(140), kind: 'text' } });
  assert.equal(ok.ok, true);
  const tooLong = validateWsClientMessage({ v: 1, type: 'radio.send', roomId: 'r1', playerId: 'r1', payload: { text: 'x'.repeat(141) } });
  assert.equal(tooLong.ok, false);
  const empty = validateWsClientMessage({ v: 1, type: 'radio.send', roomId: 'r1', playerId: 'r1', payload: { text: '' } });
  assert.equal(empty.ok, false);
});

// CONTRACT-ONLY (room-do-class.ts imports 'cloudflare:workers', so it
// cannot run under plain node --test): the fan-out for a `radio`
// broadcast is team-only + host in a match, and the whole lobby when
// the sender has no team yet. Un-skip only once a workerd harness
// exists — never by editing source to make it pass.
test('radio fan-out (CONTRACT-ONLY): team + host receive it, the other team does not; lobby goes to all', { skip: true }, () => {
  // broadcastRecipients('radio', state, senderId) in
  // workers/src/room-do-class.ts: sender team 'runners' → {r1, r2,
  // h1-as-host}; sender team null (lobby) → every player.
  assert.ok(false, 'needs a workerd harness for room-do-class.ts');
});
