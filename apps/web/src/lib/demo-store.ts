/**
 * Demo store — PROTOCOL-MAP §9. The OFFLINE fallback only: a local engine
 * in the browser. A live room is never silently downgraded to demo mid-room.
 * Demo and live state are never mixed in one room.
 *
 * Persistence: rooms persist to localStorage under `pakdam.demo.rooms.v1`
 * WITHOUT any coordinates (HNT-068); location fixes are held in memory only
 * and dropped on match end; raw catch tokens are in-memory only
 * (`rawCatchTokens` map), verified scans in-memory only, catch idempotency
 * keys in-memory only.
 *
 * Demo parity with the DO (built in from the start, §12):
 * - Demo pings AUTO-FIRE on schedule (the old demo needed a button).
 * - Demo shrink uses the RANDOM-OFFSET draw, never concentric (§4.5).
 * - Demo SOS says plainly it notifies nobody (§4.8).
 * - P0-1: demo resumes a suspended player on catch-page arrival and on
 *   tab-visible. P0-2: catch auto-select + name-only picker (see
 *   `resolveEffectiveRunner` / `listCatchPickerNames`).
 * - F2: demo guests auto-navigate to /play when the phase leaves LOBBY —
 *   pages poll with `pollDemoRoom` (1 s) and `watchDemoPhase`.
 */
import {
  CATCH_TOKEN_TTL_SECONDS,
  DEFAULT_ROOM_CONFIG,
  MATCH_PHASE_TRANSITIONS,
  MIN_PLAYERS,
  PENDING_PING_TTL_SECONDS,
  PING_AREA_RADIUS_M,
  TERMINAL_PHASES,
  balancedHunterCount,
  isValidDisplayName,
  newCatchToken,
  newId,
  validateRoomConfig,
  type CatchEvent,
  type CatchView,
  type GeoPoint,
  type GeoPolygon,
  type LocationFix,
  type MatchPhase,
  type MatchResult,
  type Ping,
  type Player,
  type Room,
  type RoomConfig,
} from '@pakdam/shared';
import { confirmedTags, randomOffsetShrinkBoundary as engineRandomOffsetShrinkBoundary } from '@pakdam/engine';

export type { CatchEvent, CatchView, GeoPoint, GeoPolygon, LocationFix, MatchPhase, MatchResult, Ping, Player, Room, RoomConfig };

const DEMO_ROOMS_KEY = 'pakdam.demo.rooms.v1';
const DEMO_PLAYER_ID_KEY = 'pakdam.playerId';

/** One demo room: the room + roster + local-only state (never persisted with coordinates). */
export interface DemoRoom {
  room: Room;
  players: Player[];
  catches: CatchEvent[];
  /** Last DELIVERED ping per player (timestamps only, no coordinates). */
  lastPingAtMs: Record<string, number>;
  /** Delivered pings, kept until the next ping replaces them (§4.6). */
  pings: Ping[];
  /** Per-player outside-zone countdown state (memory only). */
  outsideSinceMs: Record<string, number>;
  outsideAccumMs: Record<string, number>;
  /** Phase paused from (safety pause resumes here, never hard-coded ACTIVE). */
  pausedFrom: MatchPhase | null;
  /** Demo SOS notifies NOBODY — it only sets this local flag. */
  sosActive: boolean;
  sosByPlayerId: string | null;
  /** Announcements while away (demo: local only). */
  announcements: { text: string; byPlayerId: string; sentAt: string }[];
  /** Shrinks already applied (the stored shrinkPhases are size placeholders only). */
  appliedShrinks: number;
}

/** In-memory only: raw catch tokens (never persisted), verified scans, latest fixes, idempotency keys. */
const rawCatchTokens = new Map<string, string>();
const verifiedCatchScans = new Set<string>();
const latestFixes = new Map<string, LocationFix>();
const catchIdempotency = new Map<string, string>();

// -- Persistence (no coordinates ever written) -------------------------------

function readRooms(): DemoRoom[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(DEMO_ROOMS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DemoRoom[]) : [];
  } catch {
    return [];
  }
}

function writeRooms(rooms: DemoRoom[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DEMO_ROOMS_KEY, JSON.stringify(rooms));
  } catch {
    // Storage full — demo state is best-effort.
  }
}

function saveRoom(room: DemoRoom): void {
  const rooms = readRooms().filter((r) => r.room.roomId !== room.room.roomId);
  rooms.push(room);
  writeRooms(rooms);
}

// -- Zone shrink: the engine owns the canonical random-offset draw (§4.5).
// This wrapper keeps the demo store's GeoPolygon-returning call shape;
// the draw itself (random offset, never concentric, fallbacks) lives in
// @pakdam/engine — it is NOT re-implemented here.

/**
 * Random-offset next zone (§4.5, PUBG-style): the engine scales the
 * boundary toward its centroid by the shrink factor, then moves the
 * smaller shape to a RANDOMLY selected position fully inside the current
 * boundary — NEVER concentric. Returns the boundary unchanged until the
 * shape closes (3+ points).
 */
export function randomOffsetShrinkBoundary(boundary: GeoPolygon): GeoPolygon {
  if (boundary.length < 3) return boundary;
  return engineRandomOffsetShrinkBoundary(boundary).boundary;
}

// -- Room lifecycle -----------------------------------------------------------

function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function newPlayer(
  roomId: string,
  displayName: string,
  isHost: boolean,
): Player {
  const now = new Date().toISOString();
  return {
    playerId: newId(),
    roomId,
    kind: 'guest',
    displayName,
    isHost,
    matchRole: null,
    team: null,
    reconnectTokenHash: '',
    joinedAt: now,
    leftAt: null,
    ejectedAt: null,
    connectionState: 'connected',
    lastFixAt: null,
    locationQuality: null,
    isReady: false,
    briefingConfirmed: false,
    ageGatePassed: true,
    suspensionCount: 0,
  };
}

/** Create a demo room. The host seat is created ready + briefing confirmed. */
export function createRoom(
  displayName: string,
  config: RoomConfig = DEFAULT_ROOM_CONFIG,
): DemoRoom {
  if (!isValidDisplayName(displayName)) {
    throw new Error('Enter a name between 1 and 30 characters.');
  }
  const issues = validateRoomConfig({ ...config, hostOnSiteConfirmed: true });
  if (issues.length > 0) throw new Error(`Setup not accepted: ${issues[0]}`);
  const roomId = newId();
  const host = newPlayer(roomId, displayName.trim(), true);
  host.isReady = true;
  host.briefingConfirmed = true;
  const room: Room = {
    roomId,
    roomCode: generateRoomCode(),
    hostPlayerId: host.playerId,
    phase: 'LOBBY',
    version: 1,
    config,
    createdAt: new Date().toISOString(),
    startedAt: null,
    endsAt: null,
    pausedAt: null,
    result: null,
  };
  const demo: DemoRoom = {
    room,
    players: [host],
    catches: [],
    lastPingAtMs: {},
    pings: [],
    outsideSinceMs: {},
    outsideAccumMs: {},
    pausedFrom: null,
    sosActive: false,
    sosByPlayerId: null,
    announcements: [],
    appliedShrinks: 0,
  };
  saveRoom(demo);
  setCurrentPlayerId(host.playerId);
  return demo;
}

/** Join a demo room. Rejoining with an existing display name (case-insensitive) RESTORES the seat; an ejected seat stays ejected. */
export function joinRoom(
  roomId: string,
  displayName: string,
): { room: DemoRoom; player: Player; restored: boolean } {
  const demo = getRoom(roomId);
  if (!demo) throw new Error('Game not found or ended.');
  if (demo.room.phase !== 'LOBBY') throw new Error('Full, or no longer open.');
  const name = displayName.trim();
  if (!isValidDisplayName(name)) {
    throw new Error('Enter a name between 1 and 30 characters.');
  }
  const existing = demo.players.find(
    (p) => p.displayName.toLowerCase() === name.toLowerCase(),
  );
  if (existing) {
    existing.leftAt = null;
    existing.connectionState = 'connected';
    saveRoom(demo);
    setCurrentPlayerId(existing.playerId);
    return { room: demo, player: existing, restored: true };
  }
  const active = demo.players.filter((p) => p.leftAt === null);
  if (active.length >= demo.room.config.maxPlayers) {
    throw new Error('Full, or no longer open.');
  }
  const player = newPlayer(roomId, name, false);
  demo.players.push(player);
  saveRoom(demo);
  setCurrentPlayerId(player.playerId);
  return { room: demo, player, restored: false };
}

/** The demo's alarm: runs on every getRoom / getRoomByCode read. `listRooms` does NOT tick (a list read must not write). */
export function tickDemoRoom(demo: DemoRoom, nowMs: number = Date.now()): DemoRoom {
  const { room } = demo;
  if (TERMINAL_PHASES.includes(room.phase)) return demo;
  if (room.phase === 'SAFETY_PAUSED') return demo; // nothing completes while paused

  // Only written back when something actually changed — the play page
  // polls every 1 s, and the old code stringified + rewrote the whole
  // room to localStorage on every poll even in a completely idle game.
  let changed = false;

  // Expire overdue pending catches.
  for (const c of demo.catches) {
    if (
      (c.state === 'requested' || c.state === 'awaiting-confirmation') &&
      nowMs - new Date(c.requestedAt).getTime() > CATCH_TOKEN_TTL_SECONDS * 1000
    ) {
      c.state = 'expired';
      changed = true;
    }
  }

  // HEAD_START → ACTIVE when the head start elapses.
  if (room.phase === 'HEAD_START' && room.startedAt) {
    const headStartEndsAt =
      new Date(room.startedAt).getTime() + room.config.headStartSeconds * 1000;
    if (nowMs >= headStartEndsAt) {
      setPhase(demo, 'ACTIVE');
      changed = true;
    }
  }

  // Match end at endsAt via RESOLVING with the mode-aware outcome.
  if (
    (room.phase === 'ACTIVE' || room.phase === 'HEAD_START') &&
    room.endsAt &&
    nowMs >= new Date(room.endsAt).getTime()
  ) {
    completeMatch(demo, nowMs);
    changed = true;
  }

  // Scheduled pings, ACTIVE only, play zone on, interval > 0 — AUTO-FIRE.
  // Mutual: free Runners ping to Hunters, free Hunters ping to Runners.
  // The ping clock starts at ACTIVE (head start end), never at match
  // start — the first ping is due one interval after the head start ends,
  // so no ping can fire the instant ACTIVE begins because its interval
  // elapsed during HEAD_START.
  if (
    room.phase === 'ACTIVE' &&
    room.config.playZoneEnabled &&
    room.config.pingIntervalSeconds > 0 &&
    room.startedAt
  ) {
    const intervalMs = room.config.pingIntervalSeconds * 1000;
    const activeAtMs =
      new Date(room.startedAt).getTime() + room.config.headStartSeconds * 1000;
    for (const runner of demo.players.filter(
      (p) => p.matchRole === 'runner' && p.leftAt === null && p.ejectedAt === null,
    )) {
      const last = demo.lastPingAtMs[runner.playerId] ?? activeAtMs;
      if (nowMs - last >= intervalMs) {
        if (fireDemoPing(demo, runner.playerId, nowMs)) changed = true;
      }
    }
    for (const hunter of demo.players.filter(
      (p) => p.matchRole === 'hunter' && p.leftAt === null && p.ejectedAt === null,
    )) {
      const last = demo.lastPingAtMs[hunter.playerId] ?? activeAtMs;
      if (nowMs - last >= intervalMs) {
        if (fireDemoPing(demo, hunter.playerId, nowMs)) changed = true;
      }
    }
  }

  // Zone shrink on schedule (random-offset draw, never concentric).
  if (
    room.phase === 'ACTIVE' &&
    room.config.zoneShrinkEnabled &&
    room.startedAt &&
    room.config.zone.boundary.length >= 3
  ) {
    const startedAtMs = new Date(room.startedAt).getTime();
    const intervalMs = room.config.zoneShrinkIntervalSeconds * 1000;
    const elapsed = nowMs - startedAtMs;
    const shrinkCount = Math.floor(elapsed / intervalMs);
    if (shrinkCount > demo.appliedShrinks) {
      const next = randomOffsetShrinkBoundary(demo.room.config.zone.boundary);
      demo.room.config = {
        ...demo.room.config,
        zone: { ...demo.room.config.zone, boundary: next },
      };
      demo.appliedShrinks = shrinkCount;
      demo.room.version += 1;
      changed = true;
    }
  }

  if (changed) saveRoom(demo);
  return demo;
}

/** Fire one demo ping for a free player (coarse 150 m area around the subject's ACTUAL fix — labelled simulated by the UI). Mutual: a Runner ping goes to Hunters, a Hunter ping goes to Runners. No fix = no ping (PROTOCOL-MAP §4.6): a ping must never invent a position, so a player who has never reported a fix simply does not ping. */
export function fireDemoPing(
  demo: DemoRoom,
  subjectPlayerId: string,
  nowMs: number = Date.now(),
): Ping | null {
  // Pings are ACTIVE-only: never fire during HEAD_START, even if a caller
  // forgets the tick's phase check.
  if (demo.room.phase !== 'ACTIVE') return null;
  const subject = demo.players.find((p) => p.playerId === subjectPlayerId);
  if (!subject || (subject.matchRole !== 'runner' && subject.matchRole !== 'hunter')) return null;
  const fix = latestFixes.get(subjectPlayerId);
  if (!fix) return null;
  const ping: Ping = {
    pingId: newId(),
    roomId: demo.room.roomId,
    subjectPlayerId,
    recipientRole: subject.matchRole === 'runner' ? 'hunters' : 'runners',
    uncertainty: { centre: { lat: fix.lat, lng: fix.lng }, radiusMeters: PING_AREA_RADIUS_M },
    ageSeconds: 0,
    qualityAtPing: null,
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + PENDING_PING_TTL_SECONDS * 1000).toISOString(),
  };
  // Pings stay until the next ping replaces them — replace, never timer-remove.
  demo.pings = demo.pings.filter((p) => p.subjectPlayerId !== subjectPlayerId);
  demo.pings.push(ping);
  demo.lastPingAtMs[subjectPlayerId] = nowMs;
  return ping;
}

export function getRoom(roomId: string): DemoRoom | null {
  const demo = readRooms().find((r) => r.room.roomId === roomId) ?? null;
  if (!demo) return null;
  return tickDemoRoom(demo);
}

export function getRoomByCode(code: string): DemoRoom | null {
  const normalized = code.trim().toUpperCase();
  const demo =
    readRooms().find((r) => r.room.roomCode === normalized) ?? null;
  if (!demo) return null;
  return tickDemoRoom(demo);
}

export function listRooms(): DemoRoom[] {
  return readRooms();
}

/** Enforces the state machine; resume from SAFETY_PAUSED returns to `pausedFrom`; clock starts at HEAD_START; roles assigned ONCE at HEAD_START. */
export function setPhase(demo: DemoRoom, phase: MatchPhase): void {
  const from = demo.room.phase;
  const allowed = MATCH_PHASE_TRANSITIONS[from] ?? [];
  if (!allowed.includes(phase)) {
    throw new Error(`Cannot move from ${from} to ${phase}.`);
  }
  if (phase === 'HEAD_START') {
    assignRoles(demo);
    const now = new Date();
    demo.room.startedAt = now.toISOString();
    demo.room.endsAt = new Date(
      now.getTime() + demo.room.config.durationSeconds * 1000,
    ).toISOString();
  }
  if (phase === 'SAFETY_PAUSED') {
    demo.pausedFrom = from;
    demo.room.pausedAt = new Date().toISOString();
  }
  if (from === 'SAFETY_PAUSED' && phase !== 'SAFETY_PAUSED') {
    // Resume shifts the deadlines forward by the pause and returns to pausedFrom.
    if (demo.room.pausedAt && demo.room.startedAt && demo.room.endsAt) {
      const pauseMs = Date.now() - new Date(demo.room.pausedAt).getTime();
      demo.room.startedAt = new Date(
        new Date(demo.room.startedAt).getTime() + pauseMs,
      ).toISOString();
      demo.room.endsAt = new Date(
        new Date(demo.room.endsAt).getTime() + pauseMs,
      ).toISOString();
    }
    demo.room.pausedAt = null;
  }
  demo.room.phase = phase;
  demo.room.version += 1;
  saveRoom(demo);
}

/** Roles are assigned ONCE, at HEAD_START — never re-drawn. */
export function assignRoles(demo: DemoRoom): void {
  const active = demo.players.filter((p) => p.leftAt === null);
  if (active.length < MIN_PLAYERS) throw new Error(`Need at least ${MIN_PLAYERS} players to start.`);
  const config = demo.room.config;
  // No silent clamp: a Hunter count that leaves no Runner is rejected by
  // the start gate (canStartDemoMatch) before this runs; if it somehow
  // reaches here, throw instead of silently drawing fewer Hunters.
  const hunterCount =
    config.balanceHunters === true
      ? balancedHunterCount(active.length)
      : config.hunterCount;
  if (hunterCount < 1 || hunterCount > active.length - 1) {
    throw new Error('Hunter count must leave at least one Runner.');
  }
  let hunters: Player[];
  if (config.teamAssignment === 'selected' && config.selectedHunterIds.length === hunterCount) {
    hunters = active.filter((p) => config.selectedHunterIds.includes(p.playerId));
  } else {
    const shuffled = [...active];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = shuffled[i];
      shuffled[i] = shuffled[j] as Player;
      shuffled[j] = tmp as Player;
    }
    hunters = shuffled.slice(0, hunterCount);
  }
  for (const player of active) {
    const isHunter = hunters.some((h) => h.playerId === player.playerId);
    player.matchRole = isHunter ? 'hunter' : 'runner';
    player.team = isHunter ? 'hunters' : 'runners';
  }
  demo.room.config = { ...config, hunterCount };
}

/** Start gate (demo mirrors the server gate): active seats ≥ 3 AND every active seat ready AND teams set. */
export function canStartDemoMatch(demo: DemoRoom): { canStart: boolean; reason: string | null } {
  const active = demo.players.filter((p) => p.leftAt === null);
  if (active.length < MIN_PLAYERS) {
    return { canStart: false, reason: `Need at least ${MIN_PLAYERS} players — share the room code above.` };
  }
  const config = demo.room.config;
  // Teams-ready uses the EFFECTIVE Hunter count (balance table when
  // Balance is ON), never the stored stepper value — the draw uses the
  // effective count, so the gate must agree with it.
  const hunterCount =
    config.balanceHunters === true
      ? balancedHunterCount(active.length)
      : config.hunterCount;
  if (hunterCount > active.length - 1) {
    return {
      canStart: false,
      reason: 'Hunter count must leave at least one Runner — lower it or wait for more players.',
    };
  }
  const notReady = active.filter((p) => !p.isReady);
  if (notReady.length > 0) {
    return {
      canStart: false,
      reason: `Waiting for: ${notReady.map((p) => p.displayName).join(', ')}.`,
    };
  }
  const teamsReady =
    config.teamAssignment === 'random' ||
    config.selectedHunterIds.length === hunterCount;
  if (!teamsReady) {
    return {
      canStart: false,
      reason: `Pick ${hunterCount} ${hunterCount === 1 ? 'Hunter' : 'Hunters'} first.`,
    };
  }
  return { canStart: true, reason: null };
}

/** Host starts the match: LOBBY → READY_CHECK → COUNTDOWN → HEAD_START (walked at once in demo). */
export function startDemoMatch(demo: DemoRoom): void {
  const gate = canStartDemoMatch(demo);
  if (!gate.canStart) throw new Error(gate.reason ?? 'Cannot start yet.');
  setPhase(demo, 'READY_CHECK');
  setPhase(demo, 'COUNTDOWN');
  setPhase(demo, 'HEAD_START');
}

export function setTeamAssignment(
  demo: DemoRoom,
  teamAssignment: 'random' | 'selected',
): void {
  if (demo.room.phase !== 'LOBBY') throw new Error('Teams can only change in the lobby.');
  demo.room.config = {
    ...demo.room.config,
    teamAssignment,
    selectedHunterIds: teamAssignment === 'random' ? [] : demo.room.config.selectedHunterIds,
  };
  saveRoom(demo);
}

export function setSelectedHunters(demo: DemoRoom, playerIds: string[]): void {
  if (demo.room.phase !== 'LOBBY') throw new Error('Teams can only change in the lobby.');
  const config = demo.room.config;
  if (playerIds.length !== config.hunterCount) {
    throw new Error(`Pick exactly ${config.hunterCount} Hunters.`);
  }
  const unique = new Set(playerIds);
  if (unique.size !== playerIds.length) throw new Error('Pick each Hunter once.');
  const joined = demo.players.filter((p) => p.leftAt === null).map((p) => p.playerId);
  if (!playerIds.every((id) => joined.includes(id))) {
    throw new Error('Pick players who have joined.');
  }
  demo.room.config = { ...config, selectedHunterIds: playerIds };
  saveRoom(demo);
}

/** Lobby only; re-validates; hunter-count/team-assignment change clears the pick. */
export function updateRoomConfig(demo: DemoRoom, config: RoomConfig): void {
  if (demo.room.phase !== 'LOBBY') throw new Error('Settings can only change in the lobby.');
  const issues = validateRoomConfig({ ...config, hostOnSiteConfirmed: true });
  if (issues.length > 0) throw new Error(`Setup not accepted: ${issues[0]}`);
  const old = demo.room.config;
  const pickCleared =
    config.hunterCount !== old.hunterCount || config.teamAssignment !== old.teamAssignment;
  demo.room.config = {
    ...config,
    selectedHunterIds: pickCleared ? [] : config.selectedHunterIds,
  };
  demo.room.version += 1;
  saveRoom(demo);
}

/** Flips isReady AND sets briefingConfirmed: true (one tap does both). */
export function toggleReady(demo: DemoRoom, playerId: string): void {
  const player = demo.players.find((p) => p.playerId === playerId);
  if (!player) throw new Error('Player not found.');
  player.isReady = !player.isReady;
  if (player.isReady) player.briefingConfirmed = true;
  saveRoom(demo);
}

// -- Catches (P0-2) -----------------------------------------------------------

export interface CatchRequestResult {
  catch: CatchEvent;
  /** Raw one-time token — in-memory only, for the Runner's QR. Never persisted, never shown as text. */
  rawToken: string;
}

/** Hunter claims a Runner. Same-Hunter re-request returns the open claim; a different Hunter gets CONFLICT. */
export function requestCatch(
  demo: DemoRoom,
  hunterPlayerId: string,
  runnerPlayerId: string,
  idempotencyKey?: string,
): CatchRequestResult {
  if (idempotencyKey) {
    const existingId = catchIdempotency.get(idempotencyKey);
    const existing = demo.catches.find((c) => c.catchId === existingId);
    if (existing) {
      return { catch: existing, rawToken: rawCatchTokens.get(existing.catchId) ?? '' };
    }
  }
  if (demo.room.phase !== 'ACTIVE') throw new Error('Catches only count while the match is live.');
  const hunter = demo.players.find((p) => p.playerId === hunterPlayerId);
  const runner = demo.players.find((p) => p.playerId === runnerPlayerId);
  if (!hunter || hunter.matchRole !== 'hunter') throw new Error('Only a Hunter can claim a tag.');
  if (!runner || runner.matchRole !== 'runner') throw new Error('That player is not a free Runner.');
  if (runner.leftAt !== null || runner.ejectedAt !== null) {
    throw new Error('That player is no longer in play.');
  }
  if (runner.connectionState === 'suspended') {
    throw new Error('That player is suspended — wait for them to come back.');
  }
  const open = demo.catches.find(
    (c) =>
      c.runnerPlayerId === runnerPlayerId &&
      (c.state === 'requested' || c.state === 'awaiting-confirmation'),
  );
  if (open) {
    if (open.hunterPlayerId === hunterPlayerId) {
      return { catch: open, rawToken: rawCatchTokens.get(open.catchId) ?? '' };
    }
    throw new Error('That Runner already has an open claim.');
  }
  const rawToken = newCatchToken();
  const catchEvent: CatchEvent = {
    catchId: newId(),
    roomId: demo.room.roomId,
    hunterPlayerId,
    runnerPlayerId,
    state: 'awaiting-confirmation',
    qrTokenHash: '',
    requestedAt: new Date().toISOString(),
    confirmedAt: null,
    disputedAt: null,
    resolution: null,
    gpsEvidence: 'absent',
  };
  // Hash construction mirrors the server's sha256(catchId + ':' + raw);
  // the demo uses a deterministic local digest (see hashCatchTokenSync)
  // because Web Crypto is async. Never used for a live catch.
  catchEvent.qrTokenHash = hashCatchTokenSync(catchEvent.catchId, rawToken);
  demo.catches.push(catchEvent);
  rawCatchTokens.set(catchEvent.catchId, rawToken);
  if (idempotencyKey) catchIdempotency.set(idempotencyKey, catchEvent.catchId);
  saveRoom(demo);
  return { catch: catchEvent, rawToken };
}

/** Synchronous hash for the demo store (Web Crypto is async; the demo uses a stable non-crypto digest for local verification only). */
function hashCatchTokenSync(catchId: string, raw: string): string {
  // Demo-only: the server uses sha256(catchId + ':' + raw). The demo keeps
  // the same input string and a deterministic digest so verifyCatchScan can
  // check it without async crypto. Never used for a live catch.
  const input = `${catchId}:${raw}`;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `demo-${(h2 >>> 0).toString(16)}${(h1 >>> 0).toString(16)}`;
}

/** The raw token for a Runner's QR (in-memory only). */
export function getCatchRaw(catchId: string): string | null {
  return rawCatchTokens.get(catchId) ?? null;
}

/** A scan verifies hash + expiry + pending state; success records the scan for confirmCatch('qr-scan'). Verification alone never confirms. */
export function verifyCatchScan(catchId: string, rawToken: string): boolean {
  const demo = readRooms()
    .flatMap((r) => r.catches)
    .find((c) => c.catchId === catchId);
  if (!demo) return false;
  if (demo.state !== 'requested' && demo.state !== 'awaiting-confirmation') return false;
  const ageMs = Date.now() - new Date(demo.requestedAt).getTime();
  if (ageMs > CATCH_TOKEN_TTL_SECONDS * 1000) return false;
  if (hashCatchTokenSync(catchId, rawToken) !== demo.qrTokenHash) return false;
  verifiedCatchScans.add(catchId);
  return true;
}

export type ConfirmCatchHow = 'qr-scan' | 'manual-confirm' | 'host-review';

/**
 * Confirm a catch. 'qr-scan': claiming Hunter + verified scan (consumed).
 * 'manual-confirm': named Runner only. 'host-review': host only, disputed
 * only. A second confirm is CONFLICT. Applies the mode rule + win check.
 */
export function confirmCatch(
  demo: DemoRoom,
  catchId: string,
  actorPlayerId: string,
  how: ConfirmCatchHow,
): CatchEvent {
  const c = demo.catches.find((x) => x.catchId === catchId);
  if (!c) throw new Error('Catch not found.');
  if (c.state === 'confirmed') throw new Error('That tag was already confirmed.');
  if (c.state !== 'requested' && c.state !== 'awaiting-confirmation' && c.state !== 'disputed') {
    throw new Error('That claim is no longer open.');
  }
  const actor = demo.players.find((p) => p.playerId === actorPlayerId);
  if (!actor) throw new Error('Player not found.');
  if (how === 'qr-scan') {
    if (actorPlayerId !== c.hunterPlayerId) throw new Error('Only the claiming Hunter can confirm a scan.');
    if (!verifiedCatchScans.has(catchId)) throw new Error('Scan the Runner’s QR first.');
    verifiedCatchScans.delete(catchId);
  } else if (how === 'manual-confirm') {
    if (actorPlayerId !== c.runnerPlayerId) throw new Error('Only the tagged Runner can confirm manually.');
    if (c.state === 'disputed') throw new Error('A disputed tag goes to the host.');
  } else {
    if (!actor.isHost) throw new Error('Only the host can resolve a disputed tag.');
    if (c.state !== 'disputed') throw new Error('Only a disputed tag goes to host review.');
  }
  if (demo.room.phase !== 'ACTIVE' && how !== 'host-review') {
    throw new Error('Catches only count while the match is live.');
  }
  const runner = demo.players.find((p) => p.playerId === c.runnerPlayerId);
  if (runner && runner.connectionState === 'suspended' && how !== 'host-review') {
    throw new Error('That player is suspended — wait for them to come back.');
  }
  c.state = 'confirmed';
  c.resolution = 'confirmed';
  c.confirmedAt = new Date().toISOString();
  applyConfirmedTag(demo, c);
  saveRoom(demo);
  return c;
}

/** Runner disputes a pending claim; an overdue claim expires instead. */
export function disputeCatch(
  demo: DemoRoom,
  catchId: string,
  actorPlayerId: string,
): CatchEvent {
  const c = demo.catches.find((x) => x.catchId === catchId);
  if (!c) throw new Error('Catch not found.');
  if (actorPlayerId !== c.runnerPlayerId) {
    throw new Error('Only the tagged Runner can dispute.');
  }
  if (c.state !== 'requested' && c.state !== 'awaiting-confirmation') {
    throw new Error('That claim is no longer open.');
  }
  c.state = 'disputed';
  c.disputedAt = new Date().toISOString();
  saveRoom(demo);
  return c;
}

/**
 * Host rejects a disputed catch (demo parity with the live resolve path,
 * `resolveLiveCatch(…, 'rejected')` → DO `resolve-catch`). Host-only,
 * disputed-only. The claim is voided — the Runner stays free and no tag
 * is applied. Mirrors `packages/engine` host resolution, which sets
 * state 'rejected' + resolution 'rejected'.
 */
export function rejectCatch(
  demo: DemoRoom,
  catchId: string,
  actorPlayerId: string,
): CatchEvent {
  const c = demo.catches.find((x) => x.catchId === catchId);
  if (!c) throw new Error('Catch not found.');
  const actor = demo.players.find((p) => p.playerId === actorPlayerId);
  if (!actor) throw new Error('Player not found.');
  if (!actor.isHost) throw new Error('Only the host can resolve a disputed tag.');
  if (c.state !== 'disputed') throw new Error('Only a disputed tag goes to host review.');
  c.state = 'rejected';
  c.resolution = 'rejected';
  saveRoom(demo);
  return c;
}

function applyConfirmedTag(demo: DemoRoom, c: CatchEvent): void {
  const runner = demo.players.find((p) => p.playerId === c.runnerPlayerId);
  if (!runner) return;
  if (demo.room.config.mode === 'infection') {
    // Infection: a tagged Runner flips to the Hunters.
    runner.matchRole = 'hunter';
    runner.team = 'hunters';
  }
  // Classic: the runner is out — recorded by the confirmed catch itself
  // (freeRunners excludes confirmed-caught runners). Nothing else mutates.
  maybeCompleteOnWin(demo);
}

function freeRunners(demo: DemoRoom): Player[] {
  const caughtIds = new Set(
    demo.catches.filter((c) => c.state === 'confirmed').map((c) => c.runnerPlayerId),
  );
  return demo.players.filter(
    (p) =>
      p.matchRole === 'runner' &&
      p.leftAt === null &&
      p.ejectedAt === null &&
      !caughtIds.has(p.playerId),
  );
}

function maybeCompleteOnWin(demo: DemoRoom): void {
  if (demo.room.phase !== 'ACTIVE') return;
  if (freeRunners(demo).length === 0) {
    completeMatch(demo, Date.now());
  }
}

function completeMatch(demo: DemoRoom, nowMs: number): void {
  const caughtRunnerIds = demo.catches
    .filter((c) => c.state === 'confirmed')
    .map((c) => c.runnerPlayerId);
  const survivingRunnerIds = freeRunners(demo).map((p) => p.playerId);
  const outcome =
    survivingRunnerIds.length === 0 ? 'hunters-win' : 'runners-win';
  const durationSeconds = demo.room.startedAt
    ? Math.max(0, Math.floor((nowMs - new Date(demo.room.startedAt).getTime()) / 1000))
    : 0;
  demo.room.result = {
    outcome,
    durationSeconds,
    caughtRunnerIds,
    survivingRunnerIds,
    tags: confirmedTags(demo.catches),
  };
  demo.room.phase = 'COMPLETED';
  demo.room.version += 1;
  latestFixes.clear();
  saveRoom(demo);
}

/** Host ends the round early (demo): completes the match now with the mode-aware outcome. No-op once terminal. */
export function endDemoMatch(demo: DemoRoom): void {
  if (TERMINAL_PHASES.includes(demo.room.phase)) return;
  completeMatch(demo, Date.now());
}

// -- P0-2: catch auto-select + name-only picker -------------------------------

export interface EffectiveRunnerResolution {
  /** The Runner to show, or null when the picker must render instead. */
  runnerId: string | null;
  /** Which rule resolved it (for the UI to explain nothing — it just renders). */
  source: 'url-param' | 'open-claim' | 'picker-choice' | 'latest-confirmed' | 'picker';
}

/**
 * The effective Runner, in order: (1) `?runner=` param; (2) an open claim
 * involving ME — as Runner (bare link lands on their own Step 2) or as
 * Hunter (returns to my open claim's Step 3); (3) the Step 1 picker choice;
 * (4) my most recent CONFIRMED catch involving me. With none of those, the
 * Step 1 picker renders instead of a "No Runner selected" dead end.
 */
export function resolveEffectiveRunner(
  demo: DemoRoom,
  myPlayerId: string,
  options?: { urlRunnerId?: string | null; pickerChoiceId?: string | null },
): EffectiveRunnerResolution {
  const open = demo.catches.find(
    (c) =>
      (c.state === 'requested' || c.state === 'awaiting-confirmation') &&
      (c.runnerPlayerId === myPlayerId || c.hunterPlayerId === myPlayerId),
  );
  if (options?.urlRunnerId) {
    const exists = demo.players.some((p) => p.playerId === options.urlRunnerId);
    if (exists) return { runnerId: options.urlRunnerId, source: 'url-param' };
  }
  if (open) return { runnerId: open.runnerPlayerId, source: 'open-claim' };
  if (options?.pickerChoiceId) {
    const exists = demo.players.some((p) => p.playerId === options.pickerChoiceId);
    if (exists) return { runnerId: options.pickerChoiceId, source: 'picker-choice' };
  }
  const latestConfirmed = [...demo.catches]
    .reverse()
    .find(
      (c) =>
        c.state === 'confirmed' &&
        (c.runnerPlayerId === myPlayerId || c.hunterPlayerId === myPlayerId),
    );
  if (latestConfirmed) {
    return { runnerId: latestConfirmed.runnerPlayerId, source: 'latest-confirmed' };
  }
  return { runnerId: null, source: 'picker' };
}

/**
 * Name-only picker (P0-2): display names ONLY, no roles. Exclusions are
 * only self, ejected/left players, already-caught Runners. A pick that
 * turns out not to be a Runner is rejected by the server (live) or by
 * `requestCatch` (demo) with a plain-language error — no role is revealed.
 */
export function listCatchPickerNames(
  demo: DemoRoom,
  myPlayerId: string,
): { playerId: string; displayName: string }[] {
  const caughtIds = new Set(
    demo.catches.filter((c) => c.state === 'confirmed').map((c) => c.runnerPlayerId),
  );
  return demo.players
    .filter(
      (p) =>
        p.playerId !== myPlayerId &&
        p.leftAt === null &&
        p.ejectedAt === null &&
        !caughtIds.has(p.playerId),
    )
    .map((p) => ({ playerId: p.playerId, displayName: p.displayName }));
}

// -- Suspension (P0-1) ---------------------------------------------------------

export function recordPlayerSuspension(
  demo: DemoRoom,
  playerId: string,
  reason: string,
): void {
  const player = demo.players.find((p) => p.playerId === playerId);
  if (!player) return;
  if (player.connectionState === 'suspended') return;
  player.connectionState = 'suspended';
  player.suspensionCount += 1;
  demo.announcements.push({
    text: `${player.displayName} is suspended (${reason}) — location unknown.`,
    byPlayerId: playerId,
    sentAt: new Date().toISOString(),
  });
  saveRoom(demo);
}

/** Resume is a no-op unless the player is actually suspended; returns true only when a suspended player was actually resumed. */
export function resumePlayer(demo: DemoRoom, playerId: string): boolean {
  const player = demo.players.find((p) => p.playerId === playerId);
  if (!player || player.connectionState !== 'suspended') return false;
  player.connectionState = 'connected';
  player.lastFixAt = new Date().toISOString();
  saveRoom(demo);
  return true;
}

/** Demo resume on catch-page arrival and on tab-visible (P0-1). */
export function resumePlayerOnCatchPageArrival(
  demo: DemoRoom,
  playerId: string,
): boolean {
  return resumePlayer(demo, playerId);
}

/** Timestamp ONLY (no coordinates stored); marks the player connected again. */
export function recordPlayerFix(
  demo: DemoRoom,
  playerId: string,
  fix: LocationFix,
): void {
  const player = demo.players.find((p) => p.playerId === playerId);
  if (!player) return;
  latestFixes.set(playerId, fix);
  player.connectionState = 'connected';
  player.lastFixAt = new Date(fix.timestampMs).toISOString();
  saveRoom(demo);
}

/** Logs the crossing (starts the 30 s countdown); the caller guards to once per crossing. */
export function recordZoneExit(demo: DemoRoom, playerId: string, nowMs: number = Date.now()): void {
  if (demo.outsideSinceMs[playerId] !== undefined) return;
  demo.outsideSinceMs[playerId] = nowMs;
  saveRoom(demo);
}

/** Leave: marks leftAt + disconnected; host-leave transfers host to the earliest-joined remaining player. */
export function leaveRoom(demo: DemoRoom, playerId: string): void {
  const player = demo.players.find((p) => p.playerId === playerId);
  if (!player) return;
  player.leftAt = new Date().toISOString();
  player.connectionState = 'disconnected';
  if (player.isHost) {
    player.isHost = false;
    const next = demo.players
      .filter((p) => p.leftAt === null)
      .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))[0];
    if (next) {
      next.isHost = true;
      demo.room.hostPlayerId = next.playerId;
    }
  }
  saveRoom(demo);
}

/** Eject (ACTIVE/HEAD_START only); if no Runner is left free, completes as Hunters win. */
export function ejectPlayer(demo: DemoRoom, playerId: string): void {
  if (demo.room.phase !== 'ACTIVE' && demo.room.phase !== 'HEAD_START') return;
  const player = demo.players.find((p) => p.playerId === playerId);
  if (!player || player.ejectedAt !== null) return;
  player.ejectedAt = new Date().toISOString();
  delete demo.outsideSinceMs[playerId];
  delete demo.outsideAccumMs[playerId];
  maybeCompleteOnWin(demo);
  saveRoom(demo);
}

/** Safety pause (any player); SOS notifies NOBODY in demo — the UI must say so plainly. */
export function safetyPauseDemo(demo: DemoRoom, _playerId: string): void {
  if (demo.room.phase !== 'HEAD_START' && demo.room.phase !== 'ACTIVE') return;
  setPhase(demo, 'SAFETY_PAUSED');
}

export function safetyResumeDemo(demo: DemoRoom): void {
  if (demo.room.phase !== 'SAFETY_PAUSED') return;
  setPhase(demo, demo.pausedFrom ?? 'ACTIVE');
}

export function sosDemo(demo: DemoRoom, playerId: string): void {
  demo.sosActive = true;
  demo.sosByPlayerId = playerId;
  saveRoom(demo);
}

export const SOS_DEMO_COPY =
  'SOS noted on this device only — nobody was notified. SOS alerts your host in this game. Pakdam is NOT an emergency service and does not call police or ambulance. If you are in danger, call your local emergency number.';

/** Host check-in (demo event log only). */
export function hostCheckin(demo: DemoRoom, playerId: string, text: string): void {
  demo.announcements.push({ text, byPlayerId: playerId, sentAt: new Date().toISOString() });
  saveRoom(demo);
}

// -- F2: phase polling / auto-navigate ----------------------------------------

/**
 * Poll the demo room every 1 s (lobby, play and catch pages). Returns the
 * room or null. Callers navigate to /play when `phase` leaves LOBBY —
 * guarded to fire once (see `watchDemoPhase`).
 */
export function pollDemoRoom(roomId: string): DemoRoom | null {
  return getRoom(roomId);
}

export interface PhaseWatchHandle {
  stop(): void;
}

/**
 * F2: watch a demo room's phase; when it leaves LOBBY, call `onLeaveLobby`
 * once (the guest auto-navigates to /play). Polls every 1 s.
 */
export function watchDemoPhase(
  roomId: string,
  onLeaveLobby: (room: DemoRoom) => void,
  intervalMs = 1000,
): PhaseWatchHandle {
  let fired = false;
  const timer = setInterval(() => {
    const demo = getRoom(roomId);
    if (!demo) return;
    if (!fired && demo.room.phase !== 'LOBBY') {
      fired = true;
      onLeaveLobby(demo);
    }
  }, intervalMs);
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

// -- Per-tab player identity ----------------------------------------------------

export function currentPlayerId(): string | null {
  if (typeof window === 'undefined') return null;
  return window.sessionStorage.getItem(DEMO_PLAYER_ID_KEY);
}

export function setCurrentPlayerId(playerId: string): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.setItem(DEMO_PLAYER_ID_KEY, playerId);
}
