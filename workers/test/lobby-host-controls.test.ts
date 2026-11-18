import test from 'node:test';
import assert from 'node:assert/strict';
import {
  route, regenerateCodeBody, updateConfigBody, removePlayerBody,
} from '../src/http.js';
import {
  handleWsClientMessage,
  regenerateRoomCode, registerRoomCode, lookupRoomCode, unregisterRoomCode,
} from '../src/room-do.js';
import type { RoomDoState } from '../src/room-do.js';
import { validateWsClientMessage } from '../src/lib/validation.js';
import { sha256Hex } from '@pakdam/shared';
import type { LocationFix, Player, Room, RoomConfig } from '@pakdam/shared';

// ---------------------------------------------------------------------------
// Lobby host controls (D-M2 / D-M4 / D-M5 / D-M6, 2026-11-17).
//
// D-M2: host regenerates the room code from the lobby — the old code
//   stops working, the new code works for joining. Pure DO function
//   + code-index register/unregister + Worker route/schema.
// D-M4: lobby settings change live — the DO pure function
//   updateRoomConfig is already pinned in backend-wiring.test.ts /
//   live-wiring.test.ts (host-only, LOBBY-only, validated); this file
//   pins the pieces those tests do not: the Worker route + schema
//   that carry a live config save are the same handleSeatAction path
//   as remove-player (route + body asserted here), and the lobby
//   page calls it with the host token (web test in
//   live-client.test.ts covers the client side of the sibling
//   regenerate call).
// D-M5: host removes a player live — the DO op + Worker route are
//   pinned in live-wiring.test.ts / routes.test.ts; this file pins
//   the remove-player body schema rejects a missing target.
// D-M6: "Tell everyone" live reveal channel — WS `reveal.send`:
//   any seat shares its position, the DO validates the fix and
//   broadcasts a coarse 150 m `reveal` area to the whole room.
//
// Like the rest of workers/test/, these run against the runtime-free
// seams under plain node --test (workers/src/index.ts and
// room-do-class.ts import 'cloudflare:workers' and can only run
// under workerd / `wrangler dev` — the HTTP dispatch + DO-class ops
// behind these pure functions are covered by a wrangler-dev smoke,
// not here).
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
const mkFix = (playerId: string, atMs = 5000, lat = 23.35): LocationFix => ({
  playerId, roomId: 'r1', lat, lng: 85.32, accuracyMeters: 8,
  capturedAt: new Date(atMs).toISOString(), receivedAt: new Date(atMs).toISOString(), quality: 'good',
});
const mkConfig = (): RoomConfig => ({
  mode: 'classic', teamAssignment: 'random', maxPlayers: 30, hunterCount: 1,
  durationSeconds: 600, headStartSeconds: 60, pingIntervalSeconds: 180,
  zoneShrinkEnabled: false, zoneShrinkIntervalSeconds: 300,
  catchConfirmationRequired: true, playZoneEnabled: true,
  balanceHunters: true, randomDraw: true,
  zone: {
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
const mkLobbyState = (): RoomDoState => ({
  ...mkActiveState(),
  room: { ...mkActiveState().room, phase: 'LOBBY', startedAt: null, endsAt: null },
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

// --- D-M2: regenerate the room code ---------------------------------------

test('D-M2: regenerateRoomCode swaps the code for the host in the LOBBY and bumps the version', () => {
  const lobby = mkLobbyState();
  const res = regenerateRoomCode(lobby, 'h1', 'XYZ789');
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.oldRoomCode, 'ABC123');
  assert.equal(res.newRoomCode, 'XYZ789');
  assert.equal(res.state.room.roomCode, 'XYZ789');
  assert.equal(res.state.room.version, lobby.room.version + 1);
  assert.equal(res.state.serverSeq, lobby.serverSeq + 1);
  // The old state is untouched (pure function — no mutation).
  assert.equal(lobby.room.roomCode, 'ABC123');
});

test('D-M2: regenerateRoomCode refuses a non-host, a non-LOBBY room, a malformed code and the current code', () => {
  const lobby = mkLobbyState();
  assert.equal(regenerateRoomCode(lobby, 'r1', 'XYZ789').ok, false, 'a Runner must never change the code');
  assert.equal(regenerateRoomCode(lobby, '', 'XYZ789').ok, false, 'a missing actor must never default to the host');
  assert.equal(regenerateRoomCode(mkActiveState(), 'h1', 'XYZ789').ok, false, 'the code cannot change mid-match');
  assert.equal(regenerateRoomCode(lobby, 'h1', 'xyz789').ok, false, 'lowercase is not a valid code');
  assert.equal(regenerateRoomCode(lobby, 'h1', 'XYZ78').ok, false, 'a 5-char code is not valid');
  assert.equal(regenerateRoomCode(lobby, 'h1', 'ABC123').ok, false, 'regenerating to the current code is a no-op, not a change');
});

test('D-M2: code index register/unregister — unregister drops only the mapping that names this room', () => {
  const empty = {};
  const registered = registerRoomCode(empty, 'ABC123', 'r1');
  assert.equal(registered.conflict, false);
  assert.equal(lookupRoomCode(registered.index, 'ABC123'), 'r1');
  // Same code for a different room conflicts; the original mapping stands.
  assert.equal(registerRoomCode(registered.index, 'ABC123', 'r2').conflict, true);
  assert.equal(lookupRoomCode(registered.index, 'ABC123'), 'r1');
  // Unregistering with the WRONG roomId is a no-op — it must never
  // steal another room's code.
  assert.equal(lookupRoomCode(unregisterRoomCode(registered.index, 'ABC123', 'r2'), 'ABC123'), 'r1');
  // Unregistering the right room drops the code: the old code stops
  // resolving (and even if the unregister never landed, joins verify
  // against the room's new code — see regenerateRoomCode above).
  assert.equal(lookupRoomCode(unregisterRoomCode(registered.index, 'ABC123', 'r1'), 'ABC123'), null);
  // Unregistering an unknown code is a no-op, not an error.
  assert.deepEqual(unregisterRoomCode(registered.index, 'ZZZ999', 'r1'), registered.index);
});

test('D-M2: Worker route + body — POST /v1/rooms/:id/regenerate-code routes, and the body proves host authority', () => {
  assert.equal(route('/v1/rooms/r1/regenerate-code'), 'regenerate-code');
  assert.equal(route('/v1/rooms/r1/regenerate-code/'), 'not-found', 'no trailing-slash alias is invented');
  const ok = regenerateCodeBody.safeParse({ playerId: 'h1', hostToken: 'host-token-h1' });
  assert.equal(ok.success, true);
  // The host token is required: a body without it is 400, never a
  // host action on a display name or a reconnect token alone.
  assert.equal(regenerateCodeBody.safeParse({ playerId: 'h1' }).success, false);
  assert.equal(regenerateCodeBody.safeParse({ playerId: 'h1', hostToken: 'host-token-h1', roomCode: 'XYZ789' }).success, false,
    'the client never picks the new code — the server generates it, so a client-supplied code is rejected');
});

// --- D-M6: "Tell everyone" live reveal channel ----------------------------

test('D-M6: reveal.send from a Runner broadcasts a coarse 150 m reveal area to the room', () => {
  // r1's held fix is at 23.35 / 4000 ms — the reveal fix is a NEWER,
  // slightly moved fix, so it is not a duplicate retransmit.
  const res = send(mkActiveState(), 'r1', 'reveal.send', { fix: mkFix('r1', 4500, 23.351) }, 'rev-1');
  assert.equal(errCode(res), null);
  const reveal = res.replies.find((r) => r.type === 'reveal') as
    | { payload: { reveal: { byPlayerId: string; centre: { lat: number; lng: number }; radiusMeters: number } } }
    | undefined;
  assert.ok(reveal, 'a reveal reply is broadcast');
  assert.equal(reveal.payload.reveal.byPlayerId, 'r1');
  assert.deepEqual(reveal.payload.reveal.centre, { lat: 23.351, lng: 85.32 });
  assert.equal(reveal.payload.reveal.radiusMeters, 150, 'coarse area, like a ping — never an exact pin');
  // The fix is held as the seat's latest fix (same allowlisted fields
  // as a location.update), so the room knows where the revealer was.
  assert.equal(res.state.latestFix['r1']?.lat, 23.351);
});

test('D-M6: reveal.send works for the host too, and never starts the outside-zone countdown', () => {
  // The fixture fix (23.35 / 85.32) sits OUTSIDE the zone boundary
  // (23.40+), in an ACTIVE room — a location.update here would start
  // the 30 s outside-zone countdown. A reveal must not: it is a
  // deliberate share, not a tracking fix.
  const res = send(mkActiveState(), 'h1', 'reveal.send', { fix: mkFix('h1', 4500) }, 'rev-host-1');
  assert.equal(errCode(res), null);
  assert.equal(res.replies.some((r) => r.type === 'reveal'), true);
  assert.equal(res.state.outsideSinceMs['h1'], undefined, 'no outside-zone countdown from a reveal');
  assert.equal(res.state.outsideAccumMs['h1'], undefined);
});

test('D-M6: reveal.send rejects a seat that left, a malformed fix, and a stale fix', () => {
  const left = mkActiveState();
  left.players = left.players.map((p) => (p.playerId === 'r1' ? { ...p, leftAt: new Date(4500).toISOString() } : p));
  assert.equal(errCode(send(left, 'r1', 'reveal.send', { fix: mkFix('r1', 4500, 23.351) }, 'rev-left-1')), 'INVALID_STATE');
  const badLat = send(mkActiveState(), 'r1', 'reveal.send', { fix: { ...mkFix('r1', 4500, 23.351), lat: 200 } }, 'rev-bad-1');
  assert.equal(errCode(badLat), 'VALIDATION_FAILED');
  const wrongSeat = send(mkActiveState(), 'r1', 'reveal.send', { fix: mkFix('r2', 4500) }, 'rev-bad-2');
  assert.equal(errCode(wrongSeat), 'VALIDATION_FAILED', 'a seat cannot reveal another seat’s position');
  // Stale on arrival: r2 has no previous fix, captured 69 s before now.
  const stale = send(mkActiveState(), 'r2', 'reveal.send', { fix: mkFix('r2', 1000) }, 'rev-stale-1', 70_000);
  assert.equal(errCode(stale), 'VALIDATION_FAILED');
});

test('D-M6: reveal.send is shape-validated (WS validator) and idempotent on a duplicate commandId', () => {
  const valid = validateWsClientMessage({
    v: 1, type: 'reveal.send', roomId: 'r1', playerId: 'r1', clientSeq: 1, clientTs: 5000,
    commandId: 'rev-v-1', payload: { fix: mkFix('r1', 4500, 23.351) },
  });
  assert.equal(valid.ok, true);
  if (valid.ok) assert.equal(valid.mutating, true);
  const invalid = validateWsClientMessage({
    v: 1, type: 'reveal.send', roomId: 'r1', playerId: 'r1', clientSeq: 1, clientTs: 5000,
    commandId: 'rev-v-2', payload: { fix: { ...mkFix('r1', 4500, 23.351), lat: 200 } },
  });
  assert.equal(invalid.ok, false, 'a malformed fix never reaches the DO');
  const first = send(mkActiveState(), 'r1', 'reveal.send', { fix: mkFix('r1', 4500, 23.351) }, 'rev-dup-1');
  const second = send(first.state, 'r1', 'reveal.send', { fix: mkFix('r1', 4500, 23.351) }, 'rev-dup-1');
  assert.equal(second.replayed, true, 'a duplicate delivery returns the stored outcome, never a second reveal');
  assert.deepEqual(second.replies, first.replies);
});

// --- D-M4 / D-M5: the live lobby endpoints behind the settings sheet -----
// (The DO rules are pinned in backend-wiring / live-wiring; what is
// pinned here is the HTTP surface the lobby page actually calls.)

test('D-M4/D-M5: config + remove-player routes exist and their bodies require the host token', () => {
  assert.equal(route('/v1/rooms/r1/config'), 'config');
  assert.equal(route('/v1/rooms/r1/remove-player'), 'remove-player');
  // A config save without the full config is 400, never a partial
  // rewrite; a remove without a target is 400, never a blind removal.
  assert.equal(updateConfigBody.safeParse({ playerId: 'h1', hostToken: 'host-token-h1' }).success, false);
  assert.equal(removePlayerBody.safeParse({ playerId: 'h1', hostToken: 'host-token-h1' }).success, false);
  assert.equal(removePlayerBody.safeParse({ playerId: 'h1', hostToken: 'host-token-h1', targetPlayerId: 'r1' }).success, true);
  // Neither body accepts a bare reconnect token or display name in
  // place of the host token: the field is named hostToken and is required.
  assert.equal(removePlayerBody.safeParse({ playerId: 'h1', reconnectToken: 'seat-token-h1', targetPlayerId: 'r1' }).success, false);
});
