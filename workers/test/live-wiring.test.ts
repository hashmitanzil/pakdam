import test from 'node:test';
import assert from 'node:assert/strict';
import {
  route, handleWsUpgrade, createTicketStore,
  hostTokenBody, lifecycleBody, catchTokenBody, updateConfigBody,
  removePlayerBody, transferBody, joinBody, ticketBody,
} from '../src/http.js';
import { WsTicketStore } from '../src/auth.js';
import {
  addPlayer, startMatch, handleWsClientMessage, buildWsSnapshot,
  snapshotForPlayer, snapshotForRecovery, recoverState,
  alarmTick, issueHostToken, verifyHostToken, verifyReconnectToken,
  transferHost, updateRoomConfig,
} from '../src/room-do.js';
import type { RoomDoState } from '../src/room-do.js';
import { buildPing, PING_AREA_RADIUS_M, snapshotPings } from '@pakdam/engine';
import { issueCatchToken, verifyCatchToken } from '@pakdam/engine';
import { sha256Hex } from '@pakdam/shared';
import type { LocationFix, Player, Room, RoomConfig } from '@pakdam/shared';

// ---------------------------------------------------------------------------
// Worker 8 — regression tests for live wiring (Forge Mission 001).
//
// LIVE tests run against the runtime-free seams (workers/src/auth.ts,
// workers/src/http.ts, workers/src/room-do.ts, @pakdam/engine) under
// plain node --test, like the rest of workers/test/.
//
// CONTRACT-ONLY tests are marked `{ skip: true }` and quote the contract
// they pin. They exist because the seam they need is NOT importable
// under plain node:
//   * workers/src/index.ts (the HTTP front door) and
//     workers/src/room-do-class.ts (the Durable Object class) import
//     'cloudflare:workers', so they can only run under workerd /
//     `wrangler dev`. Un-skip a CONTRACT-ONLY test only once a workerd
//     harness exists — never by editing source to make it pass.
// No test in this file edits, or depends on editing, any source file.
//
// NOTE (2026-11-17, verified while writing these tests): the codebase
// moved under this worker. Worker 5 landed a SEPARATE host token
// (SEC-06 fix) and the wiring worker landed scheduled pings in
// alarmTick, token-gated restore in addPlayer, and SEC-11 renew
// tickets. These tests pin the CURRENT contracts, quoted from the
// source as it stands — not the pre-Worker-5 shape.
// ---------------------------------------------------------------------------

const mkRoom = (over: Partial<Room> = {}): Room => ({
  roomId: 'r1', roomCode: 'ABC123', hostPlayerId: 'h1', phase: 'LOBBY',
  version: 3, config: {} as never, createdAt: new Date().toISOString(),
  startedAt: null, endsAt: null, pausedAt: null, result: null, ...over,
});
const mkPlayer = (id: string, isHost = false): Player => ({
  playerId: id, roomId: 'r1', kind: isHost ? 'host-account' : 'guest', displayName: id,
  isHost, matchRole: isHost ? 'hunter' : 'runner', team: isHost ? 'hunters' : 'runners',
  reconnectTokenHash: sha256Hex(`reconnect-token-for-${id}`),
  joinedAt: new Date().toISOString(), leftAt: null, connectionState: 'connected',
  lastFixAt: null, locationQuality: 'unknown', isReady: true, briefingConfirmed: true,
  ageGatePassed: true, suspensionCount: 0, ejectedAt: null,
});
const mkFix = (playerId: string, atMs = 5000): LocationFix => ({
  playerId, roomId: 'r1', lat: 23.35, lng: 85.32, accuracyMeters: 8,
  capturedAt: new Date(atMs).toISOString(), receivedAt: new Date(atMs).toISOString(), quality: 'good',
});
const mkConfig = (): RoomConfig => ({
  mode: 'classic', teamAssignment: 'random', maxPlayers: 30, hunterCount: 1,
  durationSeconds: 600, headStartSeconds: 60, pingIntervalSeconds: 180,
  zoneShrinkEnabled: false, zoneShrinkIntervalSeconds: 300,
  catchConfirmationRequired: true, playZoneEnabled: true,
  balanceHunters: true, randomDraw: true,
  zone: {
    // Deliberately AWAY from the 23.35 / 85.32 fix used by the
    // fixtures, so a leak assertion on the fix coordinates cannot
    // false-positive on the public zone boundary (the boundary IS
    // public — every player sees the play area on the map; only
    // PLAYER fixes are secret).
    boundary: [
      { lat: 23.40, lng: 85.40 }, { lat: 23.40, lng: 85.405 },
      { lat: 23.405, lng: 85.405 }, { lat: 23.405, lng: 85.40 },
    ],
    shrinkPhases: [],
  },
  safeAreas: [], noGoAreas: [],
  selectedHunterIds: [], hostOnSiteConfirmed: true,
});
/** ACTIVE room, host h1 (Hunter) + runners r1, r2; r1 holds a fix. */
const mkActiveState = (): RoomDoState => ({
  room: {
    ...mkRoom(),
    phase: 'ACTIVE',
    startedAt: new Date(1000).toISOString(), endsAt: new Date(1000 + 600_000).toISOString(),
    config: mkConfig(),
  },
  players: [mkPlayer('h1', true), mkPlayer('r1'), mkPlayer('r2')],
  latestFix: { r1: mkFix('r1', 4000) },
  outsideSinceMs: {}, outsideAccumMs: {}, lastZoneBoundary: null,
  gameEventLog: [], pendingPings: [], catches: [], activeCatchIds: [],
  lastPingAtMs: {}, hostTokens: {},
  serverSeq: 9, paused: false, pausedBy: null, sosActive: false,
  eventLog: [], idempotency: [], wsTickets: [], wsRate: {},
});
const send = (state: RoomDoState, playerId: string, type: string, payload: Record<string, unknown>, commandId: string, nowMs = 5000) =>
  handleWsClientMessage(state, playerId, {
    v: 1, type, roomId: 'r1', playerId, clientSeq: 1, clientTs: nowMs,
    commandId, payload,
  }, nowMs);
const errCode = (res: { replies: { type: string }[] }): string | null => {
  const e = res.replies.find((r) => r.type === 'error') as { payload?: { code?: string } } | undefined;
  return e?.payload?.code ?? null;
};
/** Precise leak check for a serialised wire message. NOTE: this does
 *  NOT use snapshotLeakKeys here — that helper flags '"lat"'/'"lng"'
 *  ANYWHERE in the JSON, which false-positives on the PUBLIC zone
 *  boundary (every player sees the play area). The security property
 *  is narrower: no PLAYER fix coordinates, no token values, no token
 *  hashes, no pending pings. The zone boundary corners (23.40 /
 *  85.40) are deliberately far from the fixture fix (23.35 / 85.32)
 *  so the fix-coordinate check below cannot collide with them. */
const assertNoSecretLeak = (json: string, secrets: string[], label: string) => {
  assert.ok(!json.includes('"lat":23.35') && !json.includes('"lng":85.32'), `${label}: no player fix coordinates`);
  for (const s of secrets) assert.ok(!json.includes(s), `${label}: must not contain ${s.slice(0, 12)}…`);
  assert.ok(!json.includes('pendingPings'), `${label}: no pending pings`);
  assert.ok(!json.includes('latestFix'), `${label}: no raw fixes`);
};

// --- (1) Host actions without a host token are rejected (SEC-06) -------
// Two credentials, two jobs (room-do.ts, Worker 5): the RECONNECT
// token proves a SEAT (WS tickets, rejoin, snapshots); the HOST token
// proves HOST authority (start, config, remove-player, transfer,
// dispute resolution, lifecycle start/resume/end). A display name
// alone never proves host. The WS layer binds every message to the
// seat its ticket redeemed, so WS host actions are gated on the
// sender being the host seat; the HTTP routes gate on the host token.

test('SEC-06 (1a): startMatch rejects a non-host actor and a missing actor; only the host seat starts', () => {
  const lobby: RoomDoState = {
    ...mkActiveState(),
    room: { ...mkActiveState().room, phase: 'LOBBY', startedAt: null, endsAt: null },
  };
  assert.equal(startMatch(lobby, 'r1', 5000).ok, false, 'a Runner must never start the match');
  assert.equal(startMatch(lobby, '', 5000).ok, false, 'a missing actorId must never default to the host (SEC-09)');
  assert.equal(startMatch(lobby, 'h1', 5000).ok, true, 'the host seat starts');
});

test('SEC-06 (1b): safety.resume and announcement.send from a non-host are FORBIDDEN and change no state', () => {
  // Pause first (any player may pause — safety is not host-gated),
  // then a Runner tries to resume and to announce.
  const paused = send(mkActiveState(), 'r1', 'safety.pause', { reason: 'someone is hurt' }, 'lw-pause-1');
  assert.equal(errCode(paused), null, 'a non-host CAN pause for safety');
  assert.equal(paused.state.paused, true);
  const seqBefore = paused.state.serverSeq;

  const resume = send(paused.state, 'r1', 'safety.resume', {}, 'lw-resume-1');
  assert.equal(errCode(resume), 'FORBIDDEN');
  assert.equal(resume.state.paused, true, 'the match stays paused');
  assert.equal(resume.state.serverSeq, seqBefore, 'a rejected command mutates nothing');
  assert.equal(resume.state.room.phase, 'SAFETY_PAUSED');

  const announce = send(paused.state, 'r1', 'announcement.send', { text: 'I am the host now' }, 'lw-ann-1');
  assert.equal(errCode(announce), 'FORBIDDEN');
  assert.equal(announce.state.serverSeq, seqBefore);

  // The host seat can do both.
  const hostResume = send(paused.state, 'h1', 'safety.resume', {}, 'lw-resume-2');
  assert.equal(errCode(hostResume), null);
  assert.equal(hostResume.state.paused, false);
  assert.equal(hostResume.state.room.phase, 'ACTIVE');
  const hostAnnounce = send(hostResume.state, 'h1', 'announcement.send', { text: 'back to the game' }, 'lw-ann-2');
  assert.equal(errCode(hostAnnounce), null);
  assert.equal(hostAnnounce.replies.some((r) => r.type === 'announcement'), true);
});

test('SEC-06 (1c): a display name alone never proves host — startMatch trusts the seat id, not the name', () => {
  // A Runner who renames themself to the host's display name still
  // cannot start: the gate compares playerId to room.hostPlayerId.
  const lobby: RoomDoState = {
    ...mkActiveState(),
    players: [mkPlayer('h1', true), { ...mkPlayer('r1'), displayName: 'h1' }],
    room: { ...mkActiveState().room, phase: 'LOBBY', startedAt: null, endsAt: null },
  };
  assert.equal(startMatch(lobby, 'r1', 5000).ok, false);
});

test('SEC-06 (1d): issueHostToken mints a per-seat host token, stores ONLY its hash, and only for the host seat', () => {
  const state = mkActiveState();
  const issued = issueHostToken(state, 'h1');
  assert.equal(issued.ok, true);
  if (!issued.ok) return;
  assert.ok(issued.token.length > 0, 'a raw host token is returned once, for the single HTTPS response');
  assert.equal(issued.state.hostTokens?.['h1'], sha256Hex(issued.token), 'only the hash is stored');
  assert.ok(!JSON.stringify(issued.state).includes(issued.token), 'the raw token is nowhere in state');
  assert.ok(!('hostToken' in issued.state.players[0]!), 'the hash never rides on the Player record');
  // The wire snapshot carries neither the raw token nor its hash:
  // hostTokens lives in DO state, never in a snapshot payload.
  const snap = buildWsSnapshot(issued.state, 'r1', 5000);
  assertNoSecretLeak(JSON.stringify(snap), [issued.token, sha256Hex(issued.token)], 'snapshot for r1');
  // A non-host seat and an unknown seat get no host token.
  assert.equal(issueHostToken(state, 'r1').ok, false, 'a Runner holds no host token');
  assert.equal(issueHostToken(state, 'nobody').ok, false);
});

test('SEC-06 (1e): verifyHostToken accepts only the current host token — wrong / empty / non-host / previous-host all fail', () => {
  const state = mkActiveState();
  const issued = issueHostToken(state, 'h1');
  assert.equal(issued.ok, true);
  if (!issued.ok) return;
  const withToken = issued.state;
  assert.equal(verifyHostToken(withToken, 'h1', issued.token), true);
  assert.equal(verifyHostToken(withToken, 'h1', 'wrong-token'), false);
  assert.equal(verifyHostToken(withToken, 'h1', ''), false);
  assert.equal(verifyHostToken(withToken, 'r1', issued.token), false, 'the host token never verifies for a non-host seat');
  assert.equal(verifyHostToken(withToken, 'r2', issued.token), false);
  // A seat credential must never confer host powers on its own: the
  // RECONNECT token is not a host token.
  assert.equal(verifyHostToken(withToken, 'h1', 'reconnect-token-for-h1'), false);
  // Rotation kills the old token.
  const rotated = issueHostToken(withToken, 'h1');
  assert.equal(rotated.ok, true);
  if (!rotated.ok) return;
  assert.notEqual(rotated.token, issued.token, 'rotation mints a fresh token');
  assert.equal(verifyHostToken(rotated.state, 'h1', issued.token), false, 'a leaked old host token dies on rotation');
  assert.equal(verifyHostToken(rotated.state, 'h1', rotated.token), true);
  // The host-token hash survives hibernation (snapshotForRecovery
  // keeps it in ...rest) — the host keeps host powers after a wake.
  const recovered = recoverState({ ...snapshotForRecovery(rotated.state), serverSeq: 9 });
  assert.equal(verifyHostToken(recovered, 'h1', rotated.token), true);
});

test('SEC-06 (1f): transferHost deletes the old host token — authority does not survive a transfer', () => {
  const state = mkActiveState();
  const issued = issueHostToken(state, 'h1');
  assert.equal(issued.ok, true);
  if (!issued.ok) return;
  const transferred = transferHost(issued.state, 'h1', 'r1', 5000);
  assert.equal(transferred.ok, true);
  if (!transferred.ok) return;
  assert.equal(transferred.state.room.hostPlayerId, 'r1');
  assert.equal(transferred.state.players.find((p) => p.playerId === 'r1')?.isHost, true);
  assert.equal(transferred.state.players.find((p) => p.playerId === 'h1')?.isHost, false);
  assert.equal(verifyHostToken(transferred.state, 'h1', issued.token), false, 'the old host token is dead');
  assert.equal(verifyHostToken(transferred.state, 'r1', issued.token), false, 'the successor inherits no token');
  // The successor must mint their own token with their reconnect token.
  const successorToken = issueHostToken(transferred.state, 'r1');
  assert.equal(successorToken.ok, true);
  if (successorToken.ok) assert.equal(verifyHostToken(successorToken.state, 'r1', successorToken.token), true);
  // Only the host may transfer; not to themself; not to an absent seat.
  assert.equal(transferHost(state, 'r1', 'r2', 5000).ok, false, 'a non-host cannot transfer host powers');
  assert.equal(transferHost(state, 'h1', 'h1', 5000).ok, false);
  assert.equal(transferHost(state, 'h1', 'nobody', 5000).ok, false);
});

test('SEC-06 (1g): updateRoomConfig is host-only and LOBBY-only, and validates the new config', () => {
  const lobby: RoomDoState = { ...mkActiveState(), room: { ...mkActiveState().room, phase: 'LOBBY', startedAt: null, endsAt: null } };
  assert.equal(updateRoomConfig(lobby, 'r1', mkConfig()).ok, false, 'a Runner cannot rewrite the room rules');
  assert.equal(updateRoomConfig(mkActiveState(), 'h1', mkConfig()).ok, false, 'rules cannot change mid-match');
  const bad = updateRoomConfig(lobby, 'h1', { ...mkConfig(), maxPlayers: 31 });
  assert.equal(bad.ok, false, 'an out-of-range config is rejected by the same authority as create');
  const ok = updateRoomConfig(lobby, 'h1', { ...mkConfig(), hunterCount: 2 });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.state.room.config.hunterCount, 2);
    assert.ok(ok.state.room.version > lobby.room.version);
  }
  // Changing hunter count / assignment clears a host-picked Hunter list.
  const picked = updateRoomConfig(
    { ...lobby, room: { ...lobby.room, config: { ...mkConfig(), teamAssignment: 'selected', selectedHunterIds: ['r1'] } } },
    'h1', { ...mkConfig(), teamAssignment: 'selected', hunterCount: 2, selectedHunterIds: ['r1'] },
  );
  assert.equal(picked.ok, true);
  if (picked.ok) assert.deepEqual(picked.state.room.config.selectedHunterIds, [], 'a stale pick never survives a count change');
});

test('SEC-06 (1h): host-action bodies require the HOST token — a reconnect token in its place fails the strict schema', () => {
  // hostTokenBody / updateConfigBody / removePlayerBody / transferBody
  assert.equal(hostTokenBody.safeParse({ playerId: 'h1', hostToken: 'tok' }).success, true);
  assert.equal(hostTokenBody.safeParse({ playerId: 'h1' }).success, false, 'missing hostToken is 400');
  assert.equal(hostTokenBody.safeParse({ playerId: 'h1', reconnectToken: 'tok' }).success, false,
    'a reconnect token is NOT a host token — the field name matters, it is not accepted in its place');
  assert.equal(hostTokenBody.safeParse({ playerId: 'h1', hostToken: 'tok', reconnectToken: 'tok' }).success, false,
    'strict schema: no extra credential rides along');
  assert.equal(updateConfigBody.safeParse({ playerId: 'h1', hostToken: 'tok', config: mkConfig() }).success, true);
  assert.equal(updateConfigBody.safeParse({ playerId: 'h1', reconnectToken: 'tok', config: mkConfig() }).success, false);
  assert.equal(removePlayerBody.safeParse({ playerId: 'h1', hostToken: 'tok', targetPlayerId: 'r2' }).success, true);
  assert.equal(removePlayerBody.safeParse({ playerId: 'h1', reconnectToken: 'tok', targetPlayerId: 'r2' }).success, false);
  assert.equal(transferBody.safeParse({ playerId: 'h1', hostToken: 'tok', newHostPlayerId: 'r1' }).success, true);
  // Lifecycle: start/resume/end need hostToken, pause needs
  // reconnectToken — the schema carries both as optional; the
  // handler enforces exactly the credential the action needs.
  assert.equal(lifecycleBody.safeParse({ action: 'start', playerId: 'h1', hostToken: 'tok' }).success, true);
  assert.equal(lifecycleBody.safeParse({ action: 'pause', playerId: 'r1', reconnectToken: 'tok' }).success, true);
  assert.equal(lifecycleBody.safeParse({ action: 'explode', playerId: 'h1' }).success, false);
  // Routes for the host actions exist (Worker 5 + wiring).
  assert.equal(route('/v1/rooms/r1/start'), 'start');
  assert.equal(route('/v1/rooms/r1/config'), 'config');
  assert.equal(route('/v1/rooms/r1/remove-player'), 'remove-player');
  assert.equal(route('/v1/rooms/r1/host/token'), 'host-token');
  assert.equal(route('/v1/rooms/r1/host/transfer'), 'host-transfer');
  assert.equal(route('/v1/rooms/r1/lifecycle'), 'lifecycle');
  assert.equal(route('/v1/rooms/r1/catches/c1/resolve'), 'catch-resolve');
});

test('SEC-06 (1i): restore-by-display-name REQUIRES the seat reconnect token — a name alone never restores, not even the host', () => {
  // The SEC-06 gap recorded in the old addPlayer comment is CLOSED
  // (Worker 5): "A restore with a missing or wrong token throws
  // FORBIDDEN and restores nothing."
  const state = mkActiveState();
  const hostName = state.players.find((p) => p.isHost)!.displayName;
  assert.throws(
    () => addPlayer(state, hostName, 'guest', 5000),
    /FORBIDDEN.*reconnect token is required/,
    'no token: the host seat must not restore on its display name alone',
  );
  assert.throws(
    () => addPlayer(state, hostName, 'guest', 5000, { reconnectToken: 'wrong-token' }),
    /FORBIDDEN/,
    'wrong token: no restore',
  );
  // The correct stored token restores the same host seat.
  const restored = addPlayer(state, hostName, 'guest', 5000, { reconnectToken: 'reconnect-token-for-h1' });
  assert.equal(restored.restored, true);
  assert.equal(restored.player.playerId, 'h1');
  assert.equal(restored.player.isHost, true, 'a restored host seat keeps host powers — but host ACTIONS still need the host token');
  assert.equal(restored.reconnectToken, '', 'restore mints no token');
  // ...and a restored host seat still cannot act as host without it.
  assert.equal(verifyHostToken(restored.state, 'h1', 'reconnect-token-for-h1'), false,
    'restoring the host seat does not mint or reveal a host token');
});

// CONTRACT-ONLY — POST /v1/rooms/:id/start without a valid HOST token.
// Contract, quoted from workers/src/index.ts (handleStart, Worker 5):
//   "Auth (Worker 5, SEC-06): the HOST token — not the reconnect
//    token, not a display name. The DO enforces host-only (SEC-09,
//    403) plus min-3 / all-ready / role assignment (GL-03) and
//    returns 409 when the room is not ready to start."
//   hostTokenBody: missing field is 400 (strict schema); a wrong
//   token, or a non-host seat, is 403 ('host token does not match
//   this host seat').
// Skipped: index.ts imports 'cloudflare:workers' via room-do-class.ts.
// BLOCKER (2026-11-17, found while writing this test): even under
// workerd this would fail today — the DO class (room-do-class.ts)
// dispatches NO 'verify-host-token' op (its op list is create /
// add-player / start / verify-code / verify-reconnect / get-state /
// update-config / remove-player / get-catch-token) and the create op
// never stores the hostTokenHash the Worker sends it. So verifyHost
// always gets a 400 'unknown op' and POST /start can never succeed
// until the dispatch + create-op storage land.
test('SEC-06/SEC-09 CONTRACT-ONLY: POST /v1/rooms/:id/start without the host token is 400/403, never a start', { skip: true }, async () => {
  const base = process.env['PAKDAM_WORKER_URL'];
  if (!base) throw new Error('PAKDAM_WORKER_URL is not set — run this test against a workerd/dev Worker');
  const roomId = 'r1';
  const noToken = await fetch(`${base}/v1/rooms/${roomId}/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId: 'h1' }), // no hostToken
  });
  assert.equal(noToken.status, 400, 'a missing hostToken fails the strict hostTokenBody');
  const reconnectAsHost = await fetch(`${base}/v1/rooms/${roomId}/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId: 'h1', reconnectToken: 'seat-token' }),
  });
  assert.equal(reconnectAsHost.status, 400, 'a reconnect token is not a host token');
  const wrongToken = await fetch(`${base}/v1/rooms/${roomId}/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId: 'r1', hostToken: 'not-the-host-token' }),
  });
  assert.equal(wrongToken.status, 403, 'a wrong token, or a non-host seat, must never start the match');
});

// CONTRACT-ONLY — POST /v1/rooms/:id/host/token issues/rotates the host token.
// Contract, quoted from workers/src/index.ts (handleHostToken, Worker 5):
//   "issue or ROTATE the host token for the current host seat. The
//    caller proves the host seat with their reconnect token
//    (ticketBody); the DO checks seat + isHost, then mints a fresh
//    host token and stores only its hash — the previous host token
//    for that seat dies on rotation. ... Response 200:
//    { ok: true, hostToken } — the raw token, returned ONCE, never
//    logged. 403 when the seat is not the host or the reconnect
//    token does not match."
// Skipped: same workerd reason as above, plus the same blocker — the
// DO class has no 'issue-host-token' dispatch yet.
test('SEC-06 CONTRACT-ONLY: POST /v1/rooms/:id/host/token mints the host token once, only for the host seat', { skip: true }, async () => {
  const base = process.env['PAKDAM_WORKER_URL'];
  if (!base) throw new Error('PAKDAM_WORKER_URL is not set — run this test against a workerd/dev Worker');
  const roomId = 'r1';
  const res = await fetch(`${base}/v1/rooms/${roomId}/host/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId: 'h1', reconnectToken: 'reconnect-token-for-h1' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { ok?: boolean; hostToken?: string };
  assert.equal(body.ok, true);
  assert.equal(typeof body.hostToken, 'string');
  assert.ok((body.hostToken ?? '').length > 0);
  const nonHost = await fetch(`${base}/v1/rooms/${roomId}/host/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId: 'r1', reconnectToken: 'reconnect-token-for-r1' }),
  });
  assert.equal(nonHost.status, 403, 'a non-host seat can never mint a host token');
});

// --- (2) Reconnect with a stored token restores the same player --------

test('reconnect (2a): a stored WS ticket restores the same seat; wrong / missing / reused / expired tickets do not', () => {
  const store = createTicketStore();
  const issued = store.issue('r1', 'p1', 'connect', 60_000, 1000);

  // Stored ticket, same seat: upgrade succeeds and consumes it.
  const first = handleWsUpgrade(store, issued.ticket, 'r1', 'p1', 2000);
  assert.equal(first.ok, true);
  if (first.ok) assert.equal(typeof first.ticketId, 'string');

  // The same ticket again: single-use — TICKET_REUSED, 4401.
  assert.deepEqual(handleWsUpgrade(store, issued.ticket, 'r1', 'p1', 2000), {
    ok: false, code: 'TICKET_REUSED', closeCode: 4401,
    message: 'WS ticket already redeemed — request a fresh ticket',
  });

  // Wrong token, missing token, wrong seat, wrong room: all 4401.
  assert.deepEqual(handleWsUpgrade(store, 'wrong-token', 'r1', 'p1', 2000).ok, false);
  const missing = handleWsUpgrade(store, null, 'r1', 'p1', 2000);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, 'TICKET_INVALID');
  const otherSeat = store.issue('r1', 'p1', 'connect', 60_000, 3000);
  assert.deepEqual(handleWsUpgrade(store, otherSeat.ticket, 'r1', 'p2', 4000).ok, false);
  assert.deepEqual(handleWsUpgrade(store, otherSeat.ticket, 'r2', 'p1', 4000).ok, false);

  // Expired ticket: TICKET_EXPIRED, not INVALID.
  const short = store.issue('r1', 'p1', 'connect', 1000, 5000);
  const expired = handleWsUpgrade(store, short.ticket, 'r1', 'p1', 5000 + 1001);
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.code, 'TICKET_EXPIRED');

  // SEC-11: a 'renew' ticket is for auth.refresh on an EXISTING
  // socket only — it must never open a new socket.
  const renew = store.issue('r1', 'p1', 'renew', 60_000, 6000);
  const renewUpgrade = handleWsUpgrade(store, renew.ticket, 'r1', 'p1', 7000);
  assert.equal(renewUpgrade.ok, false);
  if (!renewUpgrade.ok) assert.equal(renewUpgrade.code, 'TICKET_INVALID');
});

test('reconnect (2b): reissuing a ticket revokes the earlier unredeemed one — a stale stored ticket cannot reconnect', () => {
  const store = new WsTicketStore();
  const first = store.issue('r1', 'p1', 'connect', 60_000, 1000);
  const second = store.issue('r1', 'p1', 'connect', 60_000, 2000);
  assert.deepEqual(store.redeem(first.ticket, 'r1', 'p1', 3000), { ok: false, code: 'TICKET_INVALID' });
  assert.equal(store.redeem(second.ticket, 'r1', 'p1', 3000).ok, true);
});

test('reconnect (2c): verifyReconnectToken checks the stored hash — the raw token is never stored or logged', () => {
  const state = mkActiveState();
  assert.equal(verifyReconnectToken(state, 'h1', 'reconnect-token-for-h1'), true);
  assert.equal(verifyReconnectToken(state, 'h1', 'wrong-token'), false);
  assert.equal(verifyReconnectToken(state, 'h1', ''), false);
  assert.equal(verifyReconnectToken(state, 'r1', 'reconnect-token-for-h1'), false, 'a token belongs to one seat only');
  assert.equal(verifyReconnectToken(state, 'nobody', 'reconnect-token-for-h1'), false);
});

test('reconnect (2d): addPlayer restores the SAME seat on display name + token and mints NO new token — the client reuses the stored one', () => {
  const base = mkActiveState();
  // Simulate a fresh join first (LOBBY phase, new name).
  const lobby: RoomDoState = { ...base, room: { ...base.room, phase: 'LOBBY', startedAt: null, endsAt: null } };
  const joined = addPlayer(lobby, 'New Runner', 'guest', 5000);
  assert.equal(joined.restored, false);
  assert.ok(joined.reconnectToken.length > 0, 'a new seat receives a raw reconnect token exactly once');
  assert.equal(sha256Hex(joined.reconnectToken), joined.player.reconnectTokenHash, 'only the hash is stored');
  assert.ok(!JSON.stringify(joined.message).includes(joined.reconnectToken), 'the raw token is never in a broadcast');

  // Same display name + the stored token: the SAME playerId comes
  // back, and no new token is issued.
  const restored = addPlayer(joined.state, 'New Runner', 'guest', 6000, { reconnectToken: joined.reconnectToken });
  assert.equal(restored.restored, true);
  assert.equal(restored.player.playerId, joined.player.playerId, 'reconnect restores the same seat, not a duplicate');
  assert.equal(restored.reconnectToken, '', 'restore mints no token — the stored token is the credential');
  assert.equal(restored.player.reconnectTokenHash, joined.player.reconnectTokenHash, 'the stored hash is unchanged');
  assert.equal(restored.state.players.filter((p) => p.displayName === 'New Runner').length, 1, 'no duplicate seat');
  // And a restore with NO token (or a wrong one) throws instead.
  assert.throws(() => addPlayer(joined.state, 'New Runner', 'guest', 7000), /FORBIDDEN/);
  assert.throws(() => addPlayer(joined.state, 'New Runner', 'guest', 7000, { reconnectToken: 'wrong' }), /FORBIDDEN/);
});

// CONTRACT-ONLY — POST /v1/rooms/:id/ws-ticket requires the stored reconnect token.
// Contract, quoted from workers/src/index.ts (handleWsTicket):
//   "Issuing a new ticket revokes any other unredeemed ticket for the
//    seat (17 §2.5) ... a WS ticket is issued only after the DO
//    verifies the seat's reconnect token" — a wrong token is 403
//    ('reconnect token does not match this seat').
// Skipped: index.ts imports 'cloudflare:workers' via room-do-class.ts.
// Run under workerd against a live Worker.
test('reconnect CONTRACT-ONLY: POST /v1/rooms/:id/ws-ticket with a wrong or missing reconnect token is 403', { skip: true }, async () => {
  const base = process.env['PAKDAM_WORKER_URL'];
  if (!base) throw new Error('PAKDAM_WORKER_URL is not set — run this test against a workerd/dev Worker');
  const res = await fetch(`${base}/v1/rooms/r1/ws-ticket`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId: 'p1', reconnectToken: 'wrong-token' }),
  });
  assert.equal(res.status, 403);
  const body = await res.json() as { error?: string };
  assert.match(body.error ?? '', /reconnect token does not match this seat/);
});

// --- (3) Catch-token route serves the token only to an authorised player in the same room (BE-BK-02) ---

test('catch-token (3a): catch.request returns the raw token ONLY as a server-side value — never in any reply, snapshot, or log surface', () => {
  const state = mkActiveState();
  const req = send(state, 'h1', 'catch.request', { runnerId: 'r1' }, 'lw-catch-1');
  assert.equal(errCode(req), null);
  assert.ok(req.issuedCatchToken, 'the server returns the one-time token to the DO class for runner-only delivery');
  const raw = req.issuedCatchToken!.token;
  assert.equal(req.issuedCatchToken!.runnerPlayerId, 'r1');
  assert.equal(verifyCatchToken(req.issuedCatchToken!.catchId, raw, req.state.catches[0]!.qrTokenHash!), true);

  // No reply carries the raw token (the §3.3 catalogue has no
  // runner-only token message — the DO class delivers it via the
  // get-catch-token op, never on the wire here).
  assert.ok(!JSON.stringify(req.replies).includes(raw), 'no WS reply carries the raw catch token');
  // No snapshot for ANY seat carries it — Hunter, Runner, or bystander.
  for (const seat of ['h1', 'r1', 'r2']) {
    const snap = buildWsSnapshot(req.state, seat, 5000);
    assertNoSecretLeak(JSON.stringify(snap), [raw, req.state.catches[0]!.qrTokenHash!], `snapshot for ${seat}`);
  }
  // The game-event log is redacted too (HNT-068).
  assert.ok(!JSON.stringify(req.state.gameEventLog).includes(raw));
});

test('catch-token (3b): snapshots show a pending catch ONLY to its parties (Hunter, Runner, host) — never to a bystander', () => {
  const state = mkActiveState();
  const req = send(state, 'h1', 'catch.request', { runnerId: 'r1' }, 'lw-catch-2');
  const snapFor = (seat: string) => {
    const snap = buildWsSnapshot(req.state, seat, 5000);
    if (snap.type !== 'snapshot') throw new Error('expected snapshot');
    return snap.payload.activeCatches;
  };
  assert.equal(snapFor('h1').length, 1, 'host sees the pending catch (status-only)');
  assert.equal(snapFor('r1').length, 1, 'the Runner sees their own catch');
  assert.deepEqual(snapFor('r2'), [], 'a bystander Runner sees nothing');
  assert.equal(snapshotForPlayer(req.state, 'not-a-seat'), null, 'a non-member gets no snapshot at all (SEC-02)');
  // The catch view never carries the QR token hash, for any recipient.
  for (const seat of ['h1', 'r1']) {
    assert.ok(!('qrTokenHash' in snapFor(seat)[0]!), `catch view for ${seat} must not carry qrTokenHash`);
  }
});

test('catch-token (3c): catch.confirm accepts only the exact token from the Runner QR — a wrong token never confirms', () => {
  const state = mkActiveState();
  const req = send(state, 'h1', 'catch.request', { runnerId: 'r1' }, 'lw-catch-3');
  const catchId = req.issuedCatchToken!.catchId;
  const wrong = send(req.state, 'r1', 'catch.confirm', { catchId, qrToken: 'WRONGTOKEN' }, 'lw-catch-4');
  assert.equal(errCode(wrong), 'VALIDATION_FAILED');
  assert.equal(wrong.state.catches[0]!.state, 'requested', 'a wrong token leaves the catch pending');
  const right = send(req.state, 'r1', 'catch.confirm', { catchId, qrToken: req.issuedCatchToken!.token }, 'lw-catch-5');
  assert.equal(errCode(right), null);
  assert.equal(right.state.catches[0]!.state, 'confirmed');
  assert.equal(verifyCatchToken(catchId, 'WRONGTOKEN', req.state.catches[0]!.qrTokenHash!), false);
  assert.equal(issueCatchToken(catchId, 120, 5000).raw.length, 12, 'catch tokens are 12-char one-time values');
});

test('catch-token (3d): the catch-token body proves the seat with its reconnect token — never a display name', () => {
  assert.equal(catchTokenBody.safeParse({ playerId: 'r1', reconnectToken: 'tok', catchId: 'c1' }).success, true);
  assert.equal(catchTokenBody.safeParse({ playerId: 'r1', catchId: 'c1' }).success, false, 'no reconnect token, no token');
  assert.equal(catchTokenBody.safeParse({ playerId: 'r1', reconnectToken: 'tok' }).success, false, 'no catchId, no token');
  assert.equal(route('/v1/rooms/r1/catch-token'), 'catch-token');
});

// CONTRACT-ONLY — BE-BK-02: the get-catch-token op over HTTP.
// Contract, quoted from workers/src/room-do-class.ts (fetch, op 'get-catch-token'):
//   "get-catch-token { catchId, playerId } — the raw one-time catch
//    token for the RUNNER's seat only (the Runner shows it as a QR;
//    the Hunter scans it). Never persisted; lost on hibernation,
//    which expires the catch — the documented recovery rule."
// and workers/src/index.ts (handleCatchToken): the seat is proven
// with the reconnect token first (403 otherwise); the DO enforces
// runner-only + open-catch-only and returns 404 when there is no
// token for this catch and seat.
// Skipped: the op lives in the Durable Object class + Worker entry,
// which import 'cloudflare:workers'. Run under workerd.
test('catch-token CONTRACT-ONLY (BE-BK-02): get-catch-token serves the token only to the Runner seat in the same room', { skip: true }, async () => {
  const base = process.env['PAKDAM_WORKER_URL'];
  if (!base) throw new Error('PAKDAM_WORKER_URL is not set — run this test against a workerd/dev Worker');
  const roomId = 'r1';
  const call = (playerId: string, reconnectToken = 'reconnect-token') => fetch(`${base}/v1/rooms/${roomId}/catch-token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ catchId: 'catch-1', playerId, reconnectToken }),
  });
  // Hunter, host-as-bystander, and a seat from another room: 404.
  assert.equal((await call('h1')).status, 404);
  assert.equal((await call('r2')).status, 404);
  assert.equal((await call('not-a-seat')).status, 404);
  // The Runner seat in this room, while the catch is pending: 200 + token.
  const runner = await call('r1');
  assert.equal(runner.status, 200);
  const body = await runner.json() as { ok?: boolean; token?: string; catchId?: string };
  assert.equal(body.ok, true);
  assert.equal(typeof body.token, 'string');
  assert.equal(body.catchId, 'catch-1');
});

// --- (4) Server pings are generated on schedule and carry no raw opponent positions ---

test('pings (4a): buildPing makes a COARSE area for Hunters only — fixed 150 m radius, subject + expiry set, no raw pin', () => {
  const fix = mkFix('r1', 5000);
  const ping = buildPing('ping-1', 'r1', fix, 5000, 300);
  assert.equal(ping.subjectPlayerId, 'r1');
  assert.equal(ping.recipientRole, 'hunters', 'a ping is addressed to Hunters, never to Runners');
  assert.equal(ping.roomId, 'r1');
  if (!('centre' in ping.uncertainty)) throw new Error('expected a centre-based coarse area');
  assert.equal(ping.uncertainty.radiusMeters, PING_AREA_RADIUS_M);
  assert.equal(PING_AREA_RADIUS_M, 150, 'coarse area radius is the documented placeholder (calibration OPEN)');
  assert.equal(ping.expiresAt, new Date(5000 + 300_000).toISOString(), 'pending pings expire — stale pings are never delivered');
  assert.equal(ping.ageSeconds, 0);
  assert.equal(ping.qualityAtPing, 'good');
  // A ping has no top-level lat/lng fields — the position lives only
  // inside the coarse uncertainty area, never as a bare pin.
  assert.ok(!('lat' in ping) && !('lng' in ping));
});

test('pings (4b): pending pings never leak through snapshots, recovery, or the wire — a Runner never sees another Runner’s ping', () => {
  const state: RoomDoState = {
    ...mkActiveState(),
    pendingPings: [buildPing('ping-1', 'r1', mkFix('r1', 5000), 5000, 300)],
  };
  for (const seat of ['h1', 'r1', 'r2']) {
    const snap = buildWsSnapshot(state, seat, 5000);
    assertNoSecretLeak(JSON.stringify(snap), [], `snapshot for ${seat}`);
    assert.ok(!JSON.stringify(snap).includes('ping-1'), `snapshot for ${seat} must not carry a pending ping`);
    if (snap.type === 'snapshot') assert.ok(!('pendingPings' in snap.payload));
  }
  // Recovery drops pending pings entirely (HNT-120): they are re-computed.
  assert.deepEqual(snapshotPings(state.pendingPings, 5000), []);
});

test('pings (4c): alarmTick emits one coarse ping per free Runner every pingIntervalSeconds — ACTIVE only, fresh fix only', () => {
  // Match started at 1000 ms; interval 180 s. r1's fix is fresh at
  // tick time (received 180_000, tick 181_000 — inside FIX_TTL_MS);
  // r2 holds no fix at all, so r2 is never pinged.
  const state: RoomDoState = {
    ...mkActiveState(),
    latestFix: { r1: mkFix('r1', 180_000) },
  };
  const tick = alarmTick(state, 181_000);
  const pings = tick.messages.filter((m) => m.type === 'ping');
  assert.equal(pings.length, 1, 'exactly one ping: r1 has a fresh fix, r2 has none — never invent a position');
  const payload = (pings[0] as { payload?: { ping?: { subjectPlayerId?: string; recipientRole?: string; uncertainty?: unknown; expiresAt?: string } } }).payload?.ping;
  assert.equal(payload?.subjectPlayerId, 'r1');
  assert.equal(payload?.recipientRole, 'hunters');
  assert.ok(payload?.uncertainty && typeof payload.uncertainty === 'object' && 'radiusMeters' in payload.uncertainty);
  assert.equal((payload.uncertainty as { radiusMeters?: number }).radiusMeters, PING_AREA_RADIUS_M);
  assert.ok(payload.expiresAt, 'a delivered ping still carries its expiry');
  // The ping's position lives ONLY inside the coarse uncertainty
  // area — never as top-level lat/lng fields (a bare pin). The
  // centre IS the fix by documented design (engine pings.ts: "the
  // centre is the fix, but the radius is the fixed coarse area");
  // the coarseness is the 150 m radius, not a displaced centre.
  assert.ok(!('lat' in (payload as unknown as Record<string, unknown>))
    && !('lng' in (payload as unknown as Record<string, unknown>)),
  'no top-level lat/lng on the ping — the position is only inside uncertainty');
  assert.deepEqual(
    Object.keys(payload.uncertainty as Record<string, unknown>).sort(),
    ['centre', 'radiusMeters'],
    'the uncertainty area is exactly a centre + a radius, nothing else',
  );
  // Schedule memory: a second tick inside the same interval pings nobody.
  const again = alarmTick(tick.state, 182_000);
  assert.deepEqual(again.messages.filter((m) => m.type === 'ping'), [], 'no duplicate ping inside one interval');
  // ...but the next interval pings r1 again (fix kept fresh).
  const fresh: RoomDoState = { ...again.state, latestFix: { r1: mkFix('r1', 360_000) } };
  const next = alarmTick(fresh, 361_000);
  assert.equal(next.messages.filter((m) => m.type === 'ping').length, 1, 'the next interval pings again');
});

test('pings (4d): no pings during HEAD_START, none when the interval is 0, none when the zone is off', () => {
  const base: RoomDoState = {
    ...mkActiveState(),
    latestFix: { r1: mkFix('r1', 180_000) },
  };
  // HEAD_START: Hunters get no locations while Runners are hiding.
  // Tick DURING the head start (started 1000, head start 60 s, tick
  // 32_000) with a short 30 s ping interval, so a ping WOULD fire on
  // schedule if the phase gate were missing.
  const headStart: RoomDoState = {
    ...base,
    latestFix: { r1: mkFix('r1', 31_000) },
    room: {
      ...base.room, phase: 'HEAD_START',
      config: { ...base.room.config, pingIntervalSeconds: 30 },
    },
  };
  const headStartTick = alarmTick(headStart, 32_000);
  assert.equal(headStartTick.state.room.phase, 'HEAD_START', 'the head start has not elapsed yet');
  assert.deepEqual(headStartTick.messages.filter((m) => m.type === 'ping'), []);
  // pingIntervalSeconds 0 = no pings at all (types.ts: "0 = no pings").
  const silent: RoomDoState = {
    ...base, room: { ...base.room, config: { ...base.room.config, pingIntervalSeconds: 0 } },
  };
  assert.deepEqual(alarmTick(silent, 181_000).messages.filter((m) => m.type === 'ping'), []);
  // Play zone off = no pings (classic hide and seek has no zone).
  const noZone: RoomDoState = {
    ...base, room: { ...base.room, config: { ...base.room.config, playZoneEnabled: false } },
  };
  assert.deepEqual(alarmTick(noZone, 181_000).messages.filter((m) => m.type === 'ping'), []);
  // A stale fix (older than FIX_TTL_MS) is purged before the ping
  // section, so it never pings from dead coordinates.
  const stale: RoomDoState = { ...base, latestFix: { r1: mkFix('r1', 4000) } };
  const ticked = alarmTick(stale, 181_000);
  assert.deepEqual(ticked.messages.filter((m) => m.type === 'ping'), []);
  assert.deepEqual(ticked.state.latestFix, {}, 'the stale fix is dropped from DO memory');
});

// --- (5) Create/join over HTTPS returns the credential the client must store ---

test('create/join (5a): a new seat gets exactly one raw reconnect token; the stored record holds only its hash', () => {
  const lobby: RoomDoState = { ...mkActiveState(), room: { ...mkActiveState().room, phase: 'LOBBY', startedAt: null, endsAt: null } };
  const first = addPlayer(lobby, 'Runner One', 'guest', 5000);
  const second = addPlayer(first.state, 'Runner Two', 'guest', 6000);
  assert.ok(first.reconnectToken.length > 0 && second.reconnectToken.length > 0);
  assert.notEqual(first.reconnectToken, second.reconnectToken, 'tokens are per-seat, never shared');
  for (const join of [first, second]) {
    assert.equal(sha256Hex(join.reconnectToken), join.player.reconnectTokenHash);
    assert.ok(!('reconnectToken' in join.player), 'the raw token is not on the player record');
    assert.ok(!JSON.stringify(join.message).includes(join.reconnectToken));
  }
});

test('create/join (5b): joinBody carries the reconnect token for restores (optional for a new join); ws-ticket takes an optional purpose', () => {
  assert.equal(joinBody.safeParse({ displayName: 'Runner One', kind: 'guest', roomCode: 'ABC123' }).success, true);
  assert.equal(joinBody.safeParse({ displayName: 'Runner One', kind: 'guest', roomCode: 'ABC123', reconnectToken: 'stored-token' }).success, true);
  assert.equal(ticketBody.safeParse({ playerId: 'p1', reconnectToken: 'tok' }).success, true);
  assert.equal(ticketBody.safeParse({ playerId: 'p1', reconnectToken: 'tok', purpose: 'connect' }).success, true);
  assert.equal(ticketBody.safeParse({ playerId: 'p1', reconnectToken: 'tok', purpose: 'renew' }).success, true);
  assert.equal(ticketBody.safeParse({ playerId: 'p1', reconnectToken: 'tok', purpose: 'bogus' }).success, false);
});

// CONTRACT-ONLY — POST /v1/rooms and POST /v1/rooms/:id/join return the credentials.
// Contract, quoted from workers/src/index.ts (handleCreateRoom, Worker 5):
//   "The host's reconnect token: raw value returned ONCE in this
//    response (HTTPS only) — the stored record holds the hash only."
//   "The host token (Worker 5, SEC-06): a SEPARATE credential that
//    proves HOST authority ... Raw value returned ONCE in this
//    response; only its hash goes to the DO (hostTokens), never the
//    Player record, never a snapshot, never a log."
//   "return json({ ok: true, roomId, roomCode, hostPlayerId,
//    reconnectToken, hostToken }, 201);"
//   handleJoin / DO 'add-player' op: "The raw reconnect token goes
//   back ONLY in this HTTPS response (once, to the joining seat) —
//   never in a broadcast, never logged."
// Skipped: index.ts imports 'cloudflare:workers' via room-do-class.ts.
// Run under workerd against a live Worker. (Same DO-class blocker as
// the start test applies to the host-token half: the create op never
// stores the hostTokenHash it is sent, so a host token from the 201
// cannot verify until that storage lands.)
test('create/join CONTRACT-ONLY: POST /v1/rooms returns BOTH credentials (201); POST join returns the seat token once', { skip: true }, async () => {
  const base = process.env['PAKDAM_WORKER_URL'];
  if (!base) throw new Error('PAKDAM_WORKER_URL is not set — run this test against a workerd/dev Worker');
  const validConfig = {
    ...mkConfig(),
    zone: {
      boundary: [
        { lat: 23.35, lng: 85.32 }, { lat: 23.35, lng: 85.325 },
        { lat: 23.355, lng: 85.325 }, { lat: 23.355, lng: 85.32 },
      ],
      shrinkPhases: [],
    },
  };
  const created = await fetch(`${base}/v1/rooms`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'Host One', kind: 'guest', config: validConfig, ageGatePassed: true }),
  });
  assert.equal(created.status, 201);
  const room = await created.json() as { ok?: boolean; roomId?: string; roomCode?: string; hostPlayerId?: string; reconnectToken?: string; hostToken?: string };
  assert.equal(room.ok, true);
  assert.equal(typeof room.reconnectToken, 'string');
  assert.ok((room.reconnectToken ?? '').length > 0, 'create must return the seat credential the client stores');
  assert.equal(typeof room.hostToken, 'string');
  assert.ok((room.hostToken ?? '').length > 0, 'create must return the SEPARATE host credential the client stores');
  assert.notEqual(room.hostToken, room.reconnectToken, 'the two credentials must differ');
  assert.equal(typeof room.hostPlayerId, 'string');
  assert.equal(typeof room.roomCode, 'string');

  const joined = await fetch(`${base}/v1/rooms/${room.roomId}/join`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'Runner One', kind: 'guest', roomCode: room.roomCode }),
  });
  assert.equal(joined.status, 200);
  const seat = await joined.json() as { ok?: boolean; reconnectToken?: string; restored?: boolean; player?: { playerId?: string } };
  assert.equal(seat.ok, true);
  assert.equal(seat.restored, false);
  assert.equal(typeof seat.reconnectToken, 'string');
  assert.ok((seat.reconnectToken ?? '').length > 0, 'join must return the seat credential the client stores');
});

// CONTRACT-ONLY — GET /v1/rooms/:id now requires the seat credential (Worker 5, SEC-06).
// Contract, quoted from workers/src/index.ts (handleGetState):
//   "a playerId alone no longer opens the room. The caller proves
//    the seat with the raw reconnect token — via `Authorization:
//    Bearer <token>` (preferred: query strings can land in edge
//    access logs) or `?reconnectToken=` as a fallback. ... a wrong
//    token is 403 ('reconnect token does not match this seat')"
//   and a missing token is 400. The snapshot itself is still
//   recipient-filtered (HNT-038) and 404s for a non-seat (SEC-02).
// Skipped: workerd only (index.ts imports 'cloudflare:workers').
test('get-state CONTRACT-ONLY: GET /v1/rooms/:id without the seat reconnect token is 400; with a wrong one, 403', { skip: true }, async () => {
  const base = process.env['PAKDAM_WORKER_URL'];
  if (!base) throw new Error('PAKDAM_WORKER_URL is not set — run this test against a workerd/dev Worker');
  const noToken = await fetch(`${base}/v1/rooms/r1?playerId=p1`);
  assert.equal(noToken.status, 400);
  const wrongToken = await fetch(`${base}/v1/rooms/r1?playerId=p1`, {
    headers: { Authorization: 'Bearer wrong-token' },
  });
  assert.equal(wrongToken.status, 403);
});
