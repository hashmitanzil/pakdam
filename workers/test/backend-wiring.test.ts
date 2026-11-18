import test from 'node:test';
import assert from 'node:assert/strict';
import {
  issueHostToken, verifyHostToken, transferHost, updateRoomConfig,
  resolveDisputedCatch, endMatch,
} from '../src/room-do.js';
import type { RoomDoState } from '../src/room-do.js';
import {
  supabaseConfigured, sbInsert, sbUpdate, persistRoomCreated,
} from '../src/supabase.js';
import { sha256Hex } from '@pakdam/shared';
import type { CatchEvent, Player, Room, RoomConfig } from '@pakdam/shared';

// ---------------------------------------------------------------------------
// Worker 5 (2026-11-17): host token (SEC-06), host transfer, config,
// dispute resolution, lifecycle end, Supabase client. Pure seams only —
// the HTTP front door (index.ts) and the DO class (room-do-class.ts)
// import 'cloudflare:workers' and are covered by the CONTRACT-ONLY
// tests in live-wiring.test.ts under `wrangler dev`.
// ---------------------------------------------------------------------------

const mkRoom = (over: Partial<Room> = {}): Room => ({
  roomId: 'r1', roomCode: 'ABC123', hostPlayerId: 'h1', phase: 'LOBBY',
  version: 3, config: {} as never, createdAt: new Date().toISOString(),
  startedAt: null, endsAt: null, pausedAt: null, result: null, ...over,
});
const mkPlayer = (id: string, isHost = false): Player => ({
  playerId: id, roomId: 'r1', kind: isHost ? 'host-account' : 'guest', displayName: id,
  isHost, matchRole: isHost ? 'hunter' : 'runner', team: isHost ? 'hunters' : 'runners',
  reconnectTokenHash: sha256Hex(`reconnect-${id}`),
  joinedAt: new Date().toISOString(), leftAt: null, connectionState: 'connected',
  lastFixAt: null, locationQuality: 'unknown', isReady: true, briefingConfirmed: true,
  ageGatePassed: true, suspensionCount: 0, ejectedAt: null,
});
const mkState = (over: Partial<RoomDoState> = {}): RoomDoState => {
  // Object.assign (not `{...defaults, ...over}`): spreading a Partial
  // makes every property `T | undefined` in the literal's type, which
  // fails the RoomDoState return type for required fields (wsTickets).
  const base: RoomDoState = {
  room: mkRoom(),
  players: [mkPlayer('h1', true), mkPlayer('r1'), mkPlayer('r2')],
  latestFix: {}, outsideSinceMs: {}, outsideAccumMs: {},
  lastZoneBoundary: null, gameEventLog: [], pendingPings: [],
  catches: [], activeCatchIds: [], serverSeq: 9, paused: false,
  pausedBy: null, sosActive: false, eventLog: [], idempotency: [],
  hostTokens: {}, lastPingAtMs: {}, wsTickets: [], wsRate: {},
  };
  return Object.assign(base, over);
};
const validConfig = {
  mode: 'classic', teamAssignment: 'random', maxPlayers: 30, hunterCount: 1,
  durationSeconds: 600, headStartSeconds: 60, pingIntervalSeconds: 180,
  zoneShrinkEnabled: false, zoneShrinkIntervalSeconds: 300,
  catchConfirmationRequired: true, playZoneEnabled: true,
  balanceHunters: true, randomDraw: true,
  zone: {
    boundary: [
      { lat: 23.35, lng: 85.32 }, { lat: 23.35, lng: 85.325 },
      { lat: 23.355, lng: 85.325 }, { lat: 23.355, lng: 85.32 },
    ],
    shrinkPhases: [],
  },
  safeAreas: [], noGoAreas: [], selectedHunterIds: [],
  hostOnSiteConfirmed: true,
} as unknown as RoomConfig;
const mkDisputedCatch = (over: Partial<CatchEvent> = {}): CatchEvent => ({
  catchId: 'c1', roomId: 'r1', hunterPlayerId: 'h1', runnerPlayerId: 'r1',
  state: 'disputed', qrTokenHash: 'qrhash', requestedAt: new Date(1000).toISOString(),
  confirmedAt: null, disputedAt: new Date(2000).toISOString(),
  resolution: 'neutral-review-required', gpsEvidence: 'present', ...over,
});
const mkActiveState = (mode: 'classic' | 'infection' = 'classic'): RoomDoState => mkState({
  room: mkRoom({
    phase: 'ACTIVE',
    startedAt: new Date(1000).toISOString(), endsAt: new Date(1000 + 600_000).toISOString(),
    config: { ...validConfig, mode } as never,
  }),
  catches: [mkDisputedCatch()], activeCatchIds: ['c1'],
});

// --- Host token (SEC-06) ---

test('host token: issue + verify for the host seat; non-host seats and wrong tokens never verify', () => {
  const state = mkState();
  assert.equal(verifyHostToken(state, 'h1', 'anything'), false, 'no token issued yet — nothing verifies');
  const issued = issueHostToken(state, 'h1');
  assert.equal(issued.ok, true);
  if (!issued.ok) throw new Error('expected issue to succeed');
  assert.ok(issued.token.length > 0);
  assert.equal(verifyHostToken(issued.state, 'h1', issued.token), true);
  assert.equal(verifyHostToken(issued.state, 'h1', 'wrong-token'), false);
  assert.equal(verifyHostToken(issued.state, 'r1', issued.token), false, 'a Runner can never present the host token as their own');
  assert.equal(verifyHostToken(issued.state, 'h1', ''), false);
  // Only the hash is stored — the raw token is never on the state.
  assert.ok(!JSON.stringify(issued.state).includes(issued.token), 'the raw host token is never stored');
  assert.equal(issued.state.hostTokens?.['h1'], sha256Hex(issued.token));
  // A non-host seat cannot be issued a host token at all.
  assert.equal(issueHostToken(state, 'r1').ok, false);
  assert.equal(issueHostToken(state, 'not-a-seat').ok, false);
});

test('host token: rotation replaces the old token — a leaked old token dies', () => {
  const first = issueHostToken(mkState(), 'h1');
  if (!first.ok) throw new Error('expected issue to succeed');
  const second = issueHostToken(first.state, 'h1');
  if (!second.ok) throw new Error('expected rotation to succeed');
  assert.notEqual(second.token, first.token);
  assert.equal(verifyHostToken(second.state, 'h1', second.token), true);
  assert.equal(verifyHostToken(second.state, 'h1', first.token), false, 'the pre-rotation token no longer verifies');
});

test('host transfer: successor becomes host, old host token dies, successor holds no token until issue', () => {
  const issued = issueHostToken(mkState(), 'h1');
  if (!issued.ok) throw new Error('expected issue to succeed');
  const state = issued.state;
  assert.equal(verifyHostToken(state, 'h1', issued.token), true);

  const transferred = transferHost(state, 'h1', 'r1', 5000);
  assert.equal(transferred.ok, true);
  if (!transferred.ok) throw new Error('expected transfer to succeed');
  assert.equal(transferred.state.room.hostPlayerId, 'r1');
  assert.equal(transferred.state.players.find((p) => p.playerId === 'r1')?.isHost, true);
  assert.equal(transferred.state.players.find((p) => p.playerId === 'h1')?.isHost, false);
  assert.equal(transferred.state.hostTokens?.['h1'], undefined, 'the old host token entry is deleted');
  assert.equal(verifyHostToken(transferred.state, 'h1', issued.token), false, 'the old host token never verifies again');
  assert.equal(verifyHostToken(transferred.state, 'r1', issued.token), false, 'the successor cannot reuse the old token');
  assert.equal(transferred.message.type, 'host.transferred');
  // The successor gets a fresh token through issue-host-token.
  const reissued = issueHostToken(transferred.state, 'r1');
  assert.equal(reissued.ok, true);
  if (!reissued.ok) throw new Error('expected reissue to succeed');
  assert.equal(verifyHostToken(reissued.state, 'r1', reissued.token), true);

  // Guards: only the host transfers; the successor must exist and be in the room.
  assert.equal(transferHost(state, 'r1', 'r2', 5000).ok, false, 'a non-host cannot transfer');
  assert.equal(transferHost(state, 'h1', 'not-a-seat', 5000).ok, false);
  assert.equal(transferHost(state, 'h1', 'h1', 5000).ok, false, 'transferring to yourself is a no-op error');
  const left = mkState({
    players: [mkPlayer('h1', true), { ...mkPlayer('r1'), leftAt: new Date(1000).toISOString() }, mkPlayer('r2')],
  });
  assert.equal(transferHost(left, 'h1', 'r1', 5000).ok, false, 'a player who left cannot become host');
});

// --- Config ---

test('updateRoomConfig: host-only, LOBBY-only, validated; hunter-count change clears the host pick', () => {
  const lobby = mkState({ room: mkRoom({ config: { ...validConfig, selectedHunterIds: ['r1'] } as never }) });
  // The client sends the FULL config: a pick survives only when the
  // sent config carries it (the update replaces the stored config).
  const updated = updateRoomConfig(lobby, 'h1', { ...validConfig, selectedHunterIds: ['r1'] });
  assert.equal(updated.ok, true);
  if (!updated.ok) throw new Error('expected update to succeed');
  assert.equal(updated.state.room.version, 4);
  assert.deepEqual(updated.state.room.config.selectedHunterIds, ['r1'], 'an unchanged pick survives');

  // ...but a hunter-count change clears the pick even when the sent
  // config still carries it (the stored pick is stale for the new count).
  const changed = updateRoomConfig(lobby, 'h1', { ...validConfig, hunterCount: 2, selectedHunterIds: ['r1'] });
  assert.equal(changed.ok, true);
  if (!changed.ok) throw new Error('expected update to succeed');
  assert.deepEqual(changed.state.room.config.selectedHunterIds, [], 'a hunter-count change clears the pick');

  assert.equal(updateRoomConfig(lobby, 'r1', validConfig).ok, false, 'a Runner cannot change settings');
  const active = mkState({ room: mkRoom({ phase: 'ACTIVE', config: validConfig as never }) });
  assert.equal(updateRoomConfig(active, 'h1', validConfig).ok, false, 'settings cannot change mid-match');
  assert.equal(
    updateRoomConfig(lobby, 'h1', { ...validConfig, maxPlayers: 31 }).ok,
    false, 'an out-of-range config is rejected',
  );
});

// --- Dispute resolution ---

test('resolveDisputedCatch: host confirm counts the tag (Classic) and records host-review', () => {
  const state = mkActiveState('classic');
  const resolved = resolveDisputedCatch(state, 'c1', 'h1', 'confirmed', 5000);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) throw new Error('expected resolve to succeed');
  assert.equal(resolved.catch.state, 'confirmed');
  assert.equal(resolved.catch.resolution, 'host-review');
  assert.equal(resolved.state.catches[0]?.state, 'confirmed');
  assert.deepEqual(resolved.state.activeCatchIds, [], 'the catch leaves the active list');
  assert.ok(resolved.messages.some((m) => m.type === 'catch.confirmed'));
  assert.equal(resolved.state.players.find((p) => p.playerId === 'r1')?.matchRole, 'runner', 'Classic: a confirmed tag does not flip the Runner');
  assert.equal(resolved.state.room.phase, 'ACTIVE', 'one Runner is still free — the match continues');
});

test('resolveDisputedCatch: host confirm flips the Runner in Infection; reject voids the claim', () => {
  const infection = mkActiveState('infection');
  const flipped = resolveDisputedCatch(infection, 'c1', 'h1', 'confirmed', 5000);
  assert.equal(flipped.ok, true);
  if (!flipped.ok) throw new Error('expected resolve to succeed');
  assert.equal(flipped.state.players.find((p) => p.playerId === 'r1')?.matchRole, 'hunter', 'Infection: a confirmed tag flips the Runner');

  const rejected = resolveDisputedCatch(mkActiveState('classic'), 'c1', 'h1', 'rejected', 5000);
  assert.equal(rejected.ok, true);
  if (!rejected.ok) throw new Error('expected resolve to succeed');
  assert.equal(rejected.catch.state, 'rejected');
  assert.equal(rejected.catch.resolution, 'host-review');
  assert.ok(rejected.messages.some((m) => m.type === 'catch.rejected'));
  assert.equal(rejected.state.players.find((p) => p.playerId === 'r1')?.matchRole, 'runner', 'a rejected claim leaves the Runner free');

  // Guards: only the host resolves, and only a disputed catch.
  assert.equal(resolveDisputedCatch(mkActiveState(), 'c1', 'r1', 'confirmed', 5000).ok, false, 'a Runner cannot resolve');
  const pending = mkActiveState();
  pending.catches = [mkDisputedCatch({ state: 'requested', resolution: null })];
  assert.equal(resolveDisputedCatch(pending, 'c1', 'h1', 'confirmed', 5000).ok, false, 'a merely requested catch is not disputed');
  assert.equal(resolveDisputedCatch(mkActiveState(), 'no-such-catch', 'h1', 'confirmed', 5000).ok, false);
});

// --- Lifecycle end ---

test('endMatch: host ends from any live phase; result is cancelled; coordinates are purged', () => {
  const active = mkActiveState('classic');
  active.latestFix = {
    r1: {
      playerId: 'r1', roomId: 'r1', lat: 23.35, lng: 85.32, accuracyMeters: 8,
      capturedAt: new Date(4000).toISOString(), receivedAt: new Date(4000).toISOString(), quality: 'good',
    },
  };
  const ended = endMatch(active, 'h1', 5000);
  assert.equal(ended.ok, true);
  if (!ended.ok) throw new Error('expected end to succeed');
  assert.equal(ended.state.room.phase, 'CANCELLED');
  assert.equal(ended.state.room.result?.outcome, 'cancelled');
  assert.deepEqual(ended.state.latestFix, {}, 'raw coordinates are purged at match end (HNT-068)');
  assert.deepEqual(ended.state.pendingPings, []);
  assert.ok(ended.messages.some((m) => m.type === 'match.cancelled'));

  const lobby = mkState();
  assert.equal(endMatch(lobby, 'h1', 5000).ok, true, 'a lobby can be cancelled too');
  assert.equal(endMatch(mkActiveState(), 'r1', 5000).ok, false, 'a Runner cannot end the match');
  const completed = mkState({ room: mkRoom({ phase: 'COMPLETED' }) });
  assert.equal(endMatch(completed, 'h1', 5000).ok, false, 'a completed match cannot be ended again');
});

// --- Supabase client ---

test('supabase: unconfigured when either binding is missing; helpers return false and never throw', async () => {
  assert.equal(supabaseConfigured({}), false);
  assert.equal(supabaseConfigured({ SUPABASE_URL: 'https://example.supabase.co' }), false);
  assert.equal(supabaseConfigured({ SUPABASE_SERVICE_ROLE_KEY: 'key' }), false);
  assert.equal(supabaseConfigured({ SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: 'key' }), false);
  assert.equal(
    supabaseConfigured({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'key' }),
    true,
  );
  // Unconfigured: every helper is a no-op false, never a throw.
  assert.equal(await sbInsert({}, 'rooms', { room_id: 'r1' }), false);
  assert.equal(await sbUpdate({}, 'rooms', { room_id: 'r1' }, { phase: 'LOBBY' }), false);
  assert.equal(await persistRoomCreated({}, mkRoom(), mkPlayer('h1', true)), false);
  // Configured but unreachable: still false, never a throw (connection
  // refused on loopback port 1 fails fast — no network dependency).
  const dead = { SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: 'key' };
  assert.equal(await sbInsert(dead, 'rooms', { room_id: 'r1' }), false);
});
