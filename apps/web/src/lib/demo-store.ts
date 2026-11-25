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
  type SuspensionReason,
} from '@pakdam/shared';
import {
  checkCatchProximity,
  confirmedTags,
  issueRunnerQrToken,
  resolveRunnerQrToken,
  randomOffsetShrinkBoundary as engineRandomOffsetShrinkBoundary,
  type RunnerQrToken,
} from '@pakdam/engine';

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
  /**
   * v30 follow-up (Diya review, item D): who paused the match (demo).
   * `safetyPauseDemo` used to take `_playerId` (explicitly unused) and
   * `demoSafety` hardcoded `pausedBy: null`, so the sheet could never
   * render "Match paused by <name> — clock frozen." The live path is
   * untouched — the server snapshot already carries `pausedBy`; this
   * is the demo mirror of it. Cleared on resume (setPhase) and replay.
   * Old rooms stored before this field existed read as null.
   */
  pausedByPlayerId: string | null;
  // NOTE (founder decision, v18): SOS is removed — no sosActive /
  // sosByPlayerId on the demo room, no sosDemo(), no SOS_DEMO_COPY.
  // The safety PAUSE stays.
  /** Announcements while away (demo: local only). */
  announcements: { text: string; byPlayerId: string; sentAt: string }[];
  /**
   * v18 fix round (B2): the ORIGINAL configured zone boundary, snapshotted
   * at match start (deep copy). Shrinks mutate `room.config.zone.boundary`
   * in place, so without this the replayed game would start on the final
   * shrunk zone. Restored in `replayDemoRoom`, then cleared so the next
   * match snapshots its own (possibly re-configured) boundary. Null
   * before the first match starts — and for rooms created before this
   * field existed, where there is nothing to restore.
   */
  originalZoneBoundary: GeoPolygon | null;
  /** Shrinks already applied (the stored shrinkPhases are size placeholders only). */
  appliedShrinks: number;
  /**
   * v24 (D1) — host-reconnect grace: epoch ms when the disconnected
   * host's 30 s grace expires, null when no grace is running. The
   * client NEVER computes the deadline — the demo sets it when the
   * host suspends (recordPlayerSuspension) and clears it on resume,
   * voluntary leave, replay, or expiry (expireHostGrace). Old rooms
   * stored before this field existed read as null (`?? null` at every
   * read site). Mirrors the live snapshot's `hostGraceEndsAtMs`.
   */
  hostGraceEndsAtMs: number | null;
  /**
   * v18 follow-up — claim-less runner QR tokens (hash ONLY, never the
   * raw). Persisted with the room, like a claim's qrTokenHash, so a
   * Hunter on another tab in the same demo can resolve a scan; the raw
   * value is never stored. One live record per Runner; a re-mint
   * replaces it. Mirrors the server's durable runner-token records.
   */
  runnerQrTokens: RunnerQrToken[];
}

/** In-memory only: raw catch tokens (never persisted), verified scans, latest fixes, idempotency keys. */
const rawCatchTokens = new Map<string, string>();
const verifiedCatchScans = new Set<string>();
/**
 * v18 follow-up — a scanned runner token bound to an already-open claim
 * (same-Hunter re-request): the claim keeps its own token hash and the
 * scanned raw's catchId-scoped hash is kept here as the previous hash,
 * so the scanned QR confirms too. Mirrors the server's
 * `previousQrTokenHash`. In-memory only, per tab — the tab that scanned
 * is the tab that confirms.
 */
const previousClaimTokenHash = new Map<string, string>();
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

/**
 * Delete a demo room outright (founder decision, 2026-11-21 — the demo
 * mirror of the server deleting a live room after a host cancel): the
 * room id, the code and every seat go at once. A later poll returns
 * null, which every room page reads as "deleted — go home". No-op when
 * the room is already gone.
 */
export function deleteDemoRoom(roomId: string): void {
  // v24 (D1): a deleted room has no grace to wake up for.
  clearHostGraceTimer(roomId);
  writeRooms(readRooms().filter((r) => r.room.roomId !== roomId));
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
    pausedByPlayerId: null,
    announcements: [],
    originalZoneBoundary: null,
    appliedShrinks: 0,
    hostGraceEndsAtMs: null,
    runnerQrTokens: [],
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
    // v24 (D1): a restored host seat is back — cancel any grace.
    if (existing.isHost) {
      demo.hostGraceEndsAtMs = null;
      clearHostGraceTimer(demo.room.roomId);
    }
    // v24 fix round (F5): the room may be hostless (host left, or a
    // grace expired with no successor) — a restored seat is the first
    // connected seat back, so re-trigger succession if one is owed.
    maybeTransferHostlessRoom(demo);
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
  // v24 fix round (F5): a new join is the first connected seat back
  // in a hostless room — re-trigger succession if one is owed.
  maybeTransferHostlessRoom(demo);
  saveRoom(demo);
  setCurrentPlayerId(player.playerId);
  return { room: demo, player, restored: false };
}

/** The demo's alarm: runs on every getRoom / getRoomByCode read. `listRooms` does NOT tick (a list read must not write). */
export function tickDemoRoom(demo: DemoRoom, nowMs: number = Date.now()): DemoRoom {
  const { room } = demo;
  if (TERMINAL_PHASES.includes(room.phase)) return demo;

  // Only written back when something actually changed — the play page
  // polls every 1 s, and the old code stringified + rewrote the whole
  // room to localStorage on every poll even in a completely idle game.
  let changed = false;

  // v24 (D1): host-reconnect grace expiry — runs even while the match
  // is safety-paused (succession is a room concern, not match-clock
  // progression: a paused match with a gone host still needs a host to
  // resume it), but never in a terminal phase (see above). The tick is
  // the demo's clock: pages poll every 1 s, so expiry lands within
  // ~1 s of the deadline in any tab that is reading the room — the
  // wake-up timer in recordPlayerSuspension only covers the case
  // where no tab is polling.
  if (expireHostGrace(demo, nowMs)) changed = true;

  if (room.phase === 'SAFETY_PAUSED') {
    // The grace expiry above already ran — persist it before
    // returning, or a paused match with a gone host could never gain
    // the host it needs to resume.
    if (changed) saveRoom(demo);
    return demo; // nothing completes while paused
  }

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
    // B2: snapshot the ORIGINAL configured zone before any shrink can
    // mutate it — a deep copy, so the shrink's new boundary never
    // aliases the snapshot. `replayDemoRoom` restores this.
    demo.originalZoneBoundary = demo.room.config.zone.boundary.map((p) => ({ ...p }));
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
    // v30 follow-up (item D): the pauser is forgotten on resume —
    // a resumed match has nobody "pausing" it any more.
    demo.pausedByPlayerId = null;
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

/**
 * A7 (v18 fix round): demo mirror of the server's physical-tag gate
 * (`checkCatchProximity` in @pakdam/engine — both phones need a recent
 * fix within 100 m, same reasons as the server). Enforced on demo
 * request and confirm paths.
 *
 * Demo limitation (cannot mirror the server exactly): `latestFixes` is
 * per-tab, in-memory only — coordinates are never persisted or shared
 * (HNT-068) — so this tab normally holds only MY fix, never the other
 * seat's. When either fix is absent in this tab the gate cannot be
 * evaluated and the catch proceeds (the divergence: a far-apart tag
 * between two different tabs is not caught by the demo gate). When both
 * fixes ARE present in this tab (same-tab testing, or a seat that
 * recorded both), the engine check decides exactly as the server does,
 * including the stale-fix rejection.
 */
function checkDemoCatchProximity(
  hunterPlayerId: string,
  runnerPlayerId: string,
): void {
  const hunterFix = latestFixes.get(hunterPlayerId) ?? null;
  const runnerFix = latestFixes.get(runnerPlayerId) ?? null;
  if (hunterFix === null || runnerFix === null) return;
  const result = checkCatchProximity({ hunterFix, runnerFix, nowMs: Date.now() });
  if (!result.ok) throw new Error(result.reason);
}

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
  /**
   * v18 follow-up — when the claim comes from a scanned runner QR, the
   * claim carries the SAME raw value (catchId-scoped hash of it), so
   * the Hunter's later confirm with the scanned token verifies
   * unchanged and the Runner keeps showing the same QR. Omitted for a
   * name claim, which mints a fresh token.
   */
  opts?: { rawToken?: string },
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
  // A7 (c): the Hunter's own state gates the claim, mirroring the
  // server's `catch.request` (same order, same words).
  if (hunter.ejectedAt !== null || hunter.leftAt !== null) {
    throw new Error('An ejected or departed Hunter cannot tag.');
  }
  if (hunter.connectionState === 'suspended' || hunter.connectionState === 'disconnected') {
    throw new Error('A suspended or disconnected Hunter cannot tag.');
  }
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
  // A7 (a): physical-tag gate — same position as the server's
  // `catch.request` (after the open-claim early return, so a
  // same-Hunter re-request is not re-gated).
  checkDemoCatchProximity(hunterPlayerId, runnerPlayerId);
  const rawToken = opts?.rawToken ?? newCatchToken();
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

/** A scan verifies hash + expiry + pending state; success records the scan for confirmCatch('qr-scan'). Verification alone never confirms. A token also verifies against the previous hash bound by a scanned runner token (v18 follow-up — the claim keeps its own token and the scanned QR confirms too). */
export function verifyCatchScan(catchId: string, rawToken: string): boolean {
  const demo = readRooms()
    .flatMap((r) => r.catches)
    .find((c) => c.catchId === catchId);
  if (!demo) return false;
  if (demo.state !== 'requested' && demo.state !== 'awaiting-confirmation') return false;
  const ageMs = Date.now() - new Date(demo.requestedAt).getTime();
  if (ageMs > CATCH_TOKEN_TTL_SECONDS * 1000) return false;
  const hash = hashCatchTokenSync(catchId, rawToken);
  if (hash !== demo.qrTokenHash && hash !== (previousClaimTokenHash.get(catchId) ?? null)) return false;
  verifiedCatchScans.add(catchId);
  return true;
}

// ---------------------------------------------------------------------------
// Claim-less runner QR token (v18 follow-up — demo parity with the server)
// ---------------------------------------------------------------------------

/**
 * Demo mirror of the server `catch.runner-token` mint: the Runner mints
 * their own QR token with NO claim open and shows it the moment they tap
 * "Got Tagged". Same rules as the server (same order): Runner only,
 * ACTIVE only, a disputed catch, an open claim, an already-caught
 * Runner, an ejected Runner or a suspended/disconnected Runner all
 * reject with the server's plain words. One live token per Runner — a re-mint REPLACES the previous
 * record at once, so the old QR dies immediately. The record is
 * hash-only (`runner:` domain, via the engine's `issueRunnerQrToken`);
 * the raw token is returned once to the Runner and never stored.
 */
export async function mintRunnerQrToken(
  demo: DemoRoom,
  runnerPlayerId: string,
): Promise<{ token: string; runnerId: string; expiresAt: string }> {
  const runner = demo.players.find((p) => p.playerId === runnerPlayerId);
  if (!runner || runner.leftAt !== null) {
    throw new Error('Seat not found in this room.');
  }
  if (runner.matchRole !== 'runner') {
    throw new Error('Only a Runner can show a catch QR.');
  }
  if (demo.room.phase !== 'ACTIVE') {
    throw new Error('Catches can only be made while the match is live.');
  }
  if (
    demo.catches.some(
      (c) => c.runnerPlayerId === runnerPlayerId && c.state === 'disputed',
    )
  ) {
    throw new Error('That catch is with the host — wait for the host to resolve it.');
  }
  if (
    demo.catches.some(
      (c) =>
        c.runnerPlayerId === runnerPlayerId &&
        (c.state === 'requested' || c.state === 'awaiting-confirmation'),
    )
  ) {
    throw new Error('A Hunter has already claimed you — show the QR for that claim.');
  }
  if (
    demo.catches.some(
      (c) => c.runnerPlayerId === runnerPlayerId && c.state === 'confirmed',
    )
  ) {
    throw new Error('You have already been caught.');
  }
  // A7 (b): an ejected Runner cannot mint — the server rejects via
  // `isCatchableRunner`, with this reason.
  if (runner.ejectedAt !== null) {
    throw new Error('You cannot be caught right now — reconnect first, then try again.');
  }
  if (
    runner.connectionState === 'suspended' ||
    runner.connectionState === 'disconnected'
  ) {
    throw new Error('You cannot be caught right now — reconnect first, then try again.');
  }
  demo.runnerQrTokens ??= [];
  demo.runnerQrTokens = demo.runnerQrTokens.filter(
    (r) => r.runnerPlayerId !== runnerPlayerId,
  );
  const { token, record } = await issueRunnerQrToken(runnerPlayerId, Date.now());
  demo.runnerQrTokens.push(record);
  saveRoom(demo);
  return {
    token,
    runnerId: runnerPlayerId,
    expiresAt: new Date(record.expiresAtMs).toISOString(),
  };
}

/**
 * Demo mirror of the server `catch.request` scan path: a Hunter scans a
 * Runner's QR and the token resolves the Runner from the hash — no
 * runnerId needed. Same rules as the server (via the engine's
 * `resolveRunnerQrToken`): malformed / no match → "That QR didn't
 * match — scan the Runner's QR again."; expired → "That QR expired —
 * ask the Runner to show a fresh QR."; already used → "That QR was
 * already used — ask the Runner to show a fresh QR." A resolved token
 * creates the claim carrying the SAME raw value (so the Hunter's later
 * confirm with the scanned token verifies unchanged and the Runner
 * keeps showing the same QR); a same-Hunter re-request binds it as the
 * claim's previous hash instead. The token is consumed either way. A
 * FAILED request (Runner not catchable, another Hunter's claim) does
 * NOT consume the token — the Hunter can retry with the same QR.
 */
export async function scanRunnerQrToken(
  demo: DemoRoom,
  hunterPlayerId: string,
  rawToken: string,
): Promise<{ catch: CatchEvent; rawToken: string }> {
  const resolved = await resolveRunnerQrToken(
    demo.runnerQrTokens ?? [],
    rawToken,
    Date.now(),
  );
  if (resolved.status === 'unknown') {
    throw new Error("That QR didn't match — scan the Runner's QR again.");
  }
  if (resolved.status === 'expired') {
    throw new Error('That QR expired — ask the Runner to show a fresh QR.');
  }
  if (resolved.status === 'used') {
    throw new Error('That QR was already used — ask the Runner to show a fresh QR.');
  }
  const record = resolved.record as RunnerQrToken;
  const runnerId = record.runnerPlayerId;
  const open = demo.catches.find(
    (c) =>
      c.runnerPlayerId === runnerId &&
      (c.state === 'requested' || c.state === 'awaiting-confirmation'),
  );
  if (open && open.hunterPlayerId === hunterPlayerId) {
    // Same-Hunter re-request returns the open claim (idempotent) — the
    // scanned token binds as its previous hash and is consumed.
    previousClaimTokenHash.set(open.catchId, hashCatchTokenSync(open.catchId, rawToken));
    record.used = true;
    saveRoom(demo);
    return { catch: open, rawToken };
  }
  // No open claim: create it with the scanned token as the claim's own
  // token. requestCatch re-validates (catchable Runner, no other
  // Hunter's claim); a throw leaves the token unconsumed.
  const { catch: claim } = requestCatch(demo, hunterPlayerId, runnerId, undefined, {
    rawToken,
  });
  record.used = true;
  saveRoom(demo);
  return { catch: claim, rawToken };
}

export type ConfirmCatchHow = 'qr-scan' | 'manual-confirm' | 'host-review';

/**
 * v18 runner Self Confirm (demo mirror of the server `catch.self-confirm`
 * WS op): the Runner names the Hunter who tagged them and the tag
 * completes with NO confirmation needed from the Hunter and NO QR/token.
 * Creates the claim if none is open for that Hunter + Runner, then
 * confirms it in the same op. Same validations as the server (same
 * order): ACTIVE only; sender a free, present Runner; named seat a
 * Hunter still in play; a disputed catch, an already-caught Runner, or
 * an open claim by a DIFFERENT Hunter all reject. A failed self-confirm
 * rolls back a claim it just created, so no dangling claim is left
 * behind. The physical-tag gate (both phones within 100 m) now runs
 * on the demo confirm paths too, via `checkDemoCatchProximity` —
 * subject to the demo limitation noted there (the other seat's fix is
 * usually absent in this tab, so the gate only bites when both fixes
 * are present in this tab).
 */
export function selfConfirmCatch(
  demo: DemoRoom,
  runnerPlayerId: string,
  hunterPlayerId: string,
): CatchEvent {
  if (demo.room.phase !== 'ACTIVE') {
    throw new Error('Catches only count while the match is live.');
  }
  const runner = demo.players.find((p) => p.playerId === runnerPlayerId);
  if (!runner || runner.matchRole !== 'runner') {
    throw new Error('Only a Runner can self-confirm a tag.');
  }
  if (runner.leftAt !== null || runner.ejectedAt !== null) {
    throw new Error('That player is no longer in play.');
  }
  if (
    demo.catches.some(
      (c) => c.runnerPlayerId === runnerPlayerId && c.state === 'confirmed',
    )
  ) {
    throw new Error('That Runner was already caught.');
  }
  if (
    demo.catches.some(
      (c) => c.runnerPlayerId === runnerPlayerId && c.state === 'disputed',
    )
  ) {
    throw new Error('That catch is with the host — wait for the host to resolve it.');
  }
  const hunter = demo.players.find((p) => p.playerId === hunterPlayerId);
  if (!hunter) throw new Error('That Hunter is not in the room.');
  if (hunter.matchRole !== 'hunter') {
    throw new Error('That player is not a Hunter.');
  }
  if (hunter.leftAt !== null || hunter.ejectedAt !== null) {
    throw new Error('That Hunter is no longer in play.');
  }
  // Follow-up B: the suspended-Hunter check — live added it in v18,
  // and this demo path missed it. `requestCatch` below checks it when
  // it CREATES the claim, but an ALREADY-OPEN claim skips that call,
  // so a tag against a Hunter who went away after claiming completed
  // here where live refuses. Same words as `requestCatch`, same order
  // (after left/ejected, before the open-claim reuse).
  if (hunter.connectionState === 'suspended' || hunter.connectionState === 'disconnected') {
    throw new Error('A suspended or disconnected Hunter cannot tag.');
  }
  const open = demo.catches.find(
    (c) =>
      c.runnerPlayerId === runnerPlayerId &&
      (c.state === 'requested' || c.state === 'awaiting-confirmation'),
  );
  if (open && open.hunterPlayerId !== hunterPlayerId) {
    throw new Error('Another Hunter has already claimed this Runner.');
  }
  let c = open;
  let createdHere = false;
  if (!c) {
    // requestCatch re-validates phase / roles / suspension / open claims.
    const created = requestCatch(demo, hunterPlayerId, runnerPlayerId);
    c = created.catch;
    createdHere = true;
  }
  try {
    return confirmCatch(demo, c.catchId, runnerPlayerId, 'manual-confirm');
  } catch (err) {
    if (createdHere) {
      demo.catches = demo.catches.filter((x) => x.catchId !== (c as CatchEvent).catchId);
      rawCatchTokens.delete((c as CatchEvent).catchId);
      saveRoom(demo);
    }
    throw err;
  }
}

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
  // A7 (a): physical-tag gate on both confirm paths (server
  // `catch.confirm` runs the same check). Host review resolves a
  // disputed tag on judgment, not proximity, so it is not gated.
  if (how !== 'host-review') {
    checkDemoCatchProximity(c.hunterPlayerId, c.runnerPlayerId);
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
  demo.runnerQrTokens = [];
  latestFixes.clear();
  saveRoom(demo);
}

/**
 * v18 replay (demo mirror of `POST /v1/rooms/:id/replay`): host-only reset
 * of a FINISHED room to LOBBY so the same room/code can play again.
 * Only from a terminal phase (COMPLETED / CANCELLED / ABANDONED / EXPIRED).
 * Kept: room id + code, host, roster, full config (incl. zone boundary).
 * Restored (B2, v18 fix round): the ORIGINAL configured zone boundary
 * from `originalZoneBoundary` (snapshotted at match start) — the replayed
 * game starts on the configured zone, never the final shrunk one. When
 * no snapshot exists (a room whose match started before B2), the current
 * boundary is kept: there is nothing to restore.
 * Cleared: result, startedAt/endsAt/pausedAt, pause state, shrink count,
 * all catches, pending pings, outside-zone countdowns, raw catch tokens,
 * stale announcements (A10); every seat still in the room gets role/team
 * null, `isReady` false, briefing un-confirmed, suspension count 0,
 * ejection cleared, `connectionState` back to `connected` and
 * `locationQuality` cleared (A10 — a suspended seat must not carry its
 * suspension into the next game). Seats that LEFT stay left. Live GPS
 * fixes are kept (current positions, not match state) — `latestFixes` is
 * untouched, as on the server. There is no demo last-disconnect tracking
 * to clear (disconnect tracking lives in the live snapshot path only).
 */
export function replayDemoRoom(demo: DemoRoom, actorPlayerId: string): DemoRoom {
  const actor = demo.players.find((p) => p.playerId === actorPlayerId);
  if (!actor || actor.playerId !== demo.room.hostPlayerId) {
    throw new Error('Only the host can replay the room.');
  }
  if (!TERMINAL_PHASES.includes(demo.room.phase)) {
    throw new Error(
      `Only a finished room can be replayed — this room is ${demo.room.phase}.`,
    );
  }
  // In-memory catch state dies with the catches (raw tokens, verified
  // scans, idempotency keys are keyed by the old catch ids — only this
  // room's entries are cleared, never another room's).
  const oldCatchIds = new Set(demo.catches.map((c) => c.catchId));
  for (const catchId of oldCatchIds) {
    rawCatchTokens.delete(catchId);
    verifiedCatchScans.delete(catchId);
    previousClaimTokenHash.delete(catchId);
  }
  for (const [key, catchId] of catchIdempotency) {
    if (oldCatchIds.has(catchId)) catchIdempotency.delete(key);
  }
  demo.room.phase = 'LOBBY';
  demo.room.result = null;
  demo.room.startedAt = null;
  demo.room.endsAt = null;
  demo.room.pausedAt = null;
  demo.pausedFrom = null;
  // v30 follow-up (item D): a replayed room has no pauser on record.
  demo.pausedByPlayerId = null;
  // v24 (D1): a replayed room has no grace running — every kept seat
  // rejoins connected below.
  demo.hostGraceEndsAtMs = null;
  clearHostGraceTimer(demo.room.roomId);
  // B2: restore the ORIGINAL configured zone (shrinks mutated the
  // boundary in place). Deep-copy again so the next match's shrinks
  // never alias the snapshot — the snapshot itself is then cleared so
  // the next match snapshots its own (possibly re-configured) boundary.
  if (demo.originalZoneBoundary) {
    demo.room.config = {
      ...demo.room.config,
      zone: {
        ...demo.room.config.zone,
        boundary: demo.originalZoneBoundary.map((p) => ({ ...p })),
      },
    };
  }
  demo.originalZoneBoundary = null;
  demo.appliedShrinks = 0;
  demo.catches = [];
  demo.runnerQrTokens = [];
  demo.pings = [];
  demo.lastPingAtMs = {};
  demo.outsideSinceMs = {};
  demo.outsideAccumMs = {};
  // A10: stale announcements from the finished game do not carry over.
  demo.announcements = [];
  for (const p of demo.players) {
    if (p.leftAt !== null) continue;
    p.matchRole = null;
    p.team = null;
    p.isReady = false;
    p.briefingConfirmed = false;
    p.suspensionCount = 0;
    p.ejectedAt = null;
    // A10: a suspended seat must not carry its suspension into the
    // next game — every kept seat rejoins the lobby connected, with no
    // stale location-quality flag.
    p.connectionState = 'connected';
    p.locationQuality = null;
  }
  demo.room.version += 1;
  saveRoom(demo);
  return demo;
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

/** v24 (D1): 30 s a disconnected host has to come back before the crown moves. */
const HOST_GRACE_MS = 30_000;

/**
 * v28 fix round — which suspension reasons start the host grace.
 * Mirrors live (`workers/src/room-do.ts` `suspendSeat`): a grace
 * starts ONLY for an actually-gone host, i.e. `'network-lost'` /
 * `'heartbeat-timeout'` — and only the server-side socket-close and
 * heartbeat sweeps ever assert those (`room-do-class.ts`); the
 * `player.suspended` handler allow-lists client-supplied reasons to
 * `'tab-hidden'` / `'screen-locked'` / `'unknown'` and maps anything
 * else to `'unknown'`, so a client can never start a grace. Live
 * maps gps-denied to `reportSuspended('unknown')`
 * (`play/page.tsx:447-452`: "never transfers host, never starts a
 * grace"), so `'gps-denied'`, `'unknown'` and `'screen-locked'`
 * suspend the seat WITHOUT a grace or a succession clock.
 *
 * `'tab-hidden'` is the ONE demo-only exception: the demo has no
 * socket, so no server-side sweep can ever detect an actually-gone
 * host — tab-hidden IS the demo's disconnect signal (a demo host who
 * backgrounds/closes the tab would otherwise keep host
 * indefinitely). Any reason outside this set fails closed: no grace.
 */
const GRACE_START_REASONS = new Set(['tab-hidden', 'network-lost', 'heartbeat-timeout']);

/**
 * One wake-up timer per room, in this tab only. The demo alarm
 * (tickDemoRoom, on every read) is the real expiry mechanism — pages
 * poll every 1 s — but a room nobody is polling would never tick, so
 * the suspending tab also sets a timer that simply re-reads the room
 * (which re-runs the alarm). The timer never transfers anything
 * itself: the transfer at expiry lives in expireHostGrace, and the
 * hostless re-trigger in maybeTransferHostlessRoom, so a throttled
 * background-tab timer can only ever be late, never wrong.
 */
const hostGraceTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearHostGraceTimer(roomId: string): void {
  const timer = hostGraceTimers.get(roomId);
  if (timer !== undefined) {
    clearTimeout(timer);
    hostGraceTimers.delete(roomId);
  }
}

function scheduleHostGraceTimer(roomId: string): void {
  clearHostGraceTimer(roomId);
  hostGraceTimers.set(
    roomId,
    setTimeout(() => {
      hostGraceTimers.delete(roomId);
      // The read re-runs the demo alarm, which expires the grace and
      // transfers the crown when the deadline has passed.
      getRoom(roomId);
    }, HOST_GRACE_MS),
  );
}

/**
 * v24 (D1) — host-reconnect grace expiry. Mutates only, never saves:
 * the caller (tickDemoRoom, or the suspend/resume/leave paths via
 * saveRoom) owns persistence. Returns true when anything changed.
 *
 * Transfer eligibility is the v23 rule unchanged: earliest-joined
 * remaining CONNECTED seat (by joinedAt; role/caught not consulted).
 * No successor at expiry = no transfer — the suspended host keeps the
 * crown until one exists to take it (same as v23), and the grace is
 * still cleared so the tick does not re-evaluate it on every poll.
 * The crown is NOT stuck there forever: the first seat to join or
 * resume afterwards re-triggers succession via
 * maybeTransferHostlessRoom (v24 fix round, F5).
 */
function expireHostGrace(demo: DemoRoom, nowMs: number): boolean {
  const endsAtMs = demo.hostGraceEndsAtMs ?? null;
  if (endsAtMs === null || nowMs < endsAtMs) return false;
  demo.hostGraceEndsAtMs = null;
  const host = demo.players.find((p) => p.playerId === demo.room.hostPlayerId);
  // Host already back (resume clears the grace, so this is defence in
  // depth): nothing to transfer, just clear the stale deadline.
  if (!host || host.connectionState !== 'suspended') return true;
  const next = demo.players
    .filter(
      (p) =>
        p.playerId !== host.playerId &&
        p.leftAt === null &&
        p.connectionState === 'connected',
    )
    .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))[0];
  if (!next) return true;
  host.isHost = false;
  next.isHost = true;
  demo.room.hostPlayerId = next.playerId;
  return true;
}

/**
 * v24 fix round (F5, Diya) — hostless re-trigger. Mutates only, never
 * saves: the caller (joinRoom / resumePlayer) owns persistence via
 * saveRoom. Returns true when the crown moved.
 *
 * Mirrors the live `leftAt` re-trigger: a room whose host is gone —
 * left (`leftAt !== null`, e.g. a voluntary leave with no connected
 * successor at the time) or suspended with no running unexpired grace
 * (grace null because it expired with no successor, or lapsed past
 * its deadline before the tick cleared it) — hands the crown to the
 * earliest-joined remaining CONNECTED seat as soon as one exists.
 * The seat that triggers it need not be the one that takes the crown:
 * eligibility is the same v23 rule as expireHostGrace / leaveRoom.
 * While a grace is running and unexpired the host keeps the crown
 * and this is a no-op — the transfer then belongs to expireHostGrace.
 *
 * Called from joinRoom (seat-restore and new join) and resumePlayer
 * (which resumePlayerOnCatchPageArrival also funnels through), the
 * two paths by which a connected seat first appears after the room
 * went hostless. The 1 s tick does NOT call it: expireHostGrace
 * already transfers at the expiry moment when a successor exists,
 * and a tick with no join/resume has nothing new to transfer to.
 */
function maybeTransferHostlessRoom(demo: DemoRoom): boolean {
  const host = demo.players.find((p) => p.playerId === demo.room.hostPlayerId);
  if (!host) return false;
  // Host still present and connected: nothing hostless to fix. (A
  // restored host seat is connected again, so a rejoining host keeps
  // the crown — the same seat, not a transfer.)
  if (host.leftAt === null && host.connectionState !== 'suspended') return false;
  // A grace still running and unexpired: the host keeps the crown
  // until it expires — expireHostGrace owns that transfer.
  const endsAtMs = demo.hostGraceEndsAtMs ?? null;
  if (endsAtMs !== null && endsAtMs > Date.now()) return false;
  const next = demo.players
    .filter(
      (p) =>
        p.playerId !== host.playerId &&
        p.leftAt === null &&
        p.connectionState === 'connected',
    )
    .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))[0];
  if (!next) return false;
  // A lapsed grace (deadline passed, tick not yet run) is cleared
  // here so the room never keeps a dead deadline past the transfer.
  demo.hostGraceEndsAtMs = null;
  clearHostGraceTimer(demo.room.roomId);
  host.isHost = false;
  next.isHost = true;
  demo.room.hostPlayerId = next.playerId;
  return true;
}

/**
 * Reasons the demo can suspend a seat (v28 fix round, Zara V3 — the
 * parameter used to be an untyped `string`, interpolated verbatim
 * into a player-visible announcement below, so a typo'd reason would
 * have reached the screen). It is the live `SuspensionReason` union
 * (shared/types.ts — 'tab-hidden' | 'screen-locked' |
 * 'network-lost' | 'heartbeat-timeout' | 'unknown') PLUS the demo's
 * own reason: the demo has no socket, so a GPS denial is detected
 * client-side and reported as `'gps-denied'` (play/page.tsx), a
 * reason live never passes (live maps it to `reportSuspended(
 * 'unknown')`). 'network-lost' / 'heartbeat-timeout' are in the
 * union for parity but the demo never passes them — only the
 * server-side sweep asserts those, via `suspendSeat` directly.
 * The grace gate below (`GRACE_START_REASONS`) still typechecks:
 * it is a `Set<string>`, and every member of this union that can
 * start a grace ('tab-hidden') is in it, while 'gps-denied' /
 * 'unknown' / 'screen-locked' suspend WITHOUT a grace, like live.
 */
export type DemoSuspensionReason = SuspensionReason | 'gps-denied';

export function recordPlayerSuspension(
  demo: DemoRoom,
  playerId: string,
  reason: DemoSuspensionReason,
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
  // v24 (D1) — host-reconnect grace (founder decision, 2026-11-21):
  // a suspended HOST does NOT transfer at once. The crown stays with
  // the host for 30 s; the transfer happens only when the grace
  // expires (expireHostGrace, run by the demo alarm on every read plus
  // the wake-up timer below), to the earliest-joined remaining
  // CONNECTED seat (by joinedAt; role/caught not consulted) — the same
  // eligibility as the v23 succession. v28 fix round: the grace starts
  // ONLY for a GRACE_START_REASONS reason (see the set above) — a
  // 'gps-denied' / 'unknown' / 'screen-locked' suspension suspends
  // the seat WITHOUT a grace, exactly like live. No grace in a
  // terminal phase (live agrees), and no transfer when no connected
  // seat remains at expiry — the suspended host keeps the crown until
  // one exists to take it, and the first seat to join or resume
  // afterwards takes it via maybeTransferHostlessRoom (v24 fix round,
  // F5).
  if (
    player.isHost &&
    !TERMINAL_PHASES.includes(demo.room.phase) &&
    GRACE_START_REASONS.has(reason)
  ) {
    demo.hostGraceEndsAtMs = Date.now() + HOST_GRACE_MS;
    scheduleHostGraceTimer(demo.room.roomId);
  }
  saveRoom(demo);
}

/** Resume is a no-op unless the player is actually suspended; returns true only when a suspended player was actually resumed. */
export function resumePlayer(demo: DemoRoom, playerId: string): boolean {
  const player = demo.players.find((p) => p.playerId === playerId);
  if (!player || player.connectionState !== 'suspended') return false;
  player.connectionState = 'connected';
  player.lastFixAt = new Date().toISOString();
  // v24 (D1): the host came back inside the grace — cancel it, the
  // host stays host. (A non-host resume has no grace to cancel.)
  if (player.isHost) {
    demo.hostGraceEndsAtMs = null;
    clearHostGraceTimer(demo.room.roomId);
  }
  // v24 fix round (F5): the room may be hostless (host left, or a
  // grace expired with no successor) — a resumed seat is the first
  // connected seat back, so re-trigger succession if one is owed.
  // No-op while a grace is still running and unexpired.
  maybeTransferHostlessRoom(demo);
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

/** Leave: marks leftAt + disconnected; host-leave transfers host to the earliest-joined remaining CONNECTED player (suspended seats are skipped — the same eligibility as the disconnect succession, so all demo transfer paths agree). */
export function leaveRoom(demo: DemoRoom, playerId: string): void {
  const player = demo.players.find((p) => p.playerId === playerId);
  if (!player) return;
  player.leftAt = new Date().toISOString();
  player.connectionState = 'disconnected';
  if (player.isHost) {
    player.isHost = false;
    // v24 (D1): a voluntary leave is really leaving — no grace, the
    // succession below is immediate (unchanged). Cancel any grace
    // that was running from an earlier disconnect.
    demo.hostGraceEndsAtMs = null;
    clearHostGraceTimer(demo.room.roomId);
    const next = demo.players
      .filter((p) => p.leftAt === null && p.connectionState === 'connected')
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

/** Safety pause (any player). NOTE (founder decision, v18): SOS is removed — there is no sosDemo() and no "Tell everyone / I'm safe" broadcast; the safety PAUSE stays. */
export function safetyPauseDemo(demo: DemoRoom, playerId: string): void {
  if (demo.room.phase !== 'HEAD_START' && demo.room.phase !== 'ACTIVE') return;
  // v30 follow-up (item D): record WHO paused, before setPhase saves
  // the room — demoSafety reads this, so the sheet renders
  // "Match paused by <name> — clock frozen." (live path untouched).
  demo.pausedByPlayerId = playerId;
  setPhase(demo, 'SAFETY_PAUSED');
}

export function safetyResumeDemo(demo: DemoRoom): void {
  if (demo.room.phase !== 'SAFETY_PAUSED') return;
  setPhase(demo, demo.pausedFrom ?? 'ACTIVE');
}

// -- F2: phase polling / auto-navigate ----------------------------------------

/**
 * Poll the demo room every 1 s (lobby, play and catch pages). Returns the
 * room or null. Callers navigate to /play when `phase` leaves LOBBY —
 * guarded to fire once (see `watchDemoPhase`).
 */
/**
 * Cheap change key for a demo room (B13/B14): a small string built from
 * the fields the UI actually reads, WITHOUT stringifying the whole room
 * (whose zone boundary alone is a long coordinate list). `room.version`
 * only bumps on a few mutations (config save, phase set, shrink, end),
 * so the key also covers every field other mutations touch without a
 * version bump: ready/connection/fix/left/ejected per player, catch
 * states, ping ids, announcements, and the team-pick fields
 * `setTeamAssignment` / `setSelectedHunters` change without bumping the
 * version. Two polls with the same key mean nothing the UI reads
 * changed, so the caller can skip its re-render outright; a different
 * key means "maybe changed" and the caller falls back to the full
 * JSON comparison before applying.
 */
export function demoRoomChangeKey(demo: DemoRoom | null): string {
  if (!demo) return 'null';
  const { room } = demo;
  const players = demo.players
    .map(
      (p) =>
        `${p.playerId}|${p.displayName}|${p.team ?? ''}|${p.matchRole ?? ''}|${p.isReady ? 1 : 0}|${p.connectionState}|${p.lastFixAt ?? ''}|${p.leftAt ?? ''}|${p.ejectedAt ?? ''}|${p.isHost ? 1 : 0}`,
    )
    .join(';');
  const catches = demo.catches
    .map((c) => `${c.catchId}:${c.state}:${c.confirmedAt ?? ''}:${c.disputedAt ?? ''}`)
    .join(';');
  const runnerTokens = (demo.runnerQrTokens ?? [])
    .map(
      (r) =>
        `${r.runnerPlayerId}:${r.tokenHash.slice(0, 8)}:${r.expiresAtMs}:${r.used ? 1 : 0}`,
    )
    .join(';');
  const pings = demo.pings.map((p) => `${p.pingId}:${p.createdAt}`).join(';');
  const announcements = demo.announcements
    .map((a) => `${a.sentAt}:${a.byPlayerId}:${a.text}`)
    .join(';');
  return [
    room.version,
    room.phase,
    room.roomCode,
    room.hostPlayerId,
    // v24 (D1): the grace deadline itself — without it, a poll that
    // only clears/sets the grace (no other key field changing) would
    // be skipped as identical and the "waiting for host" line would
    // go stale.
    demo.hostGraceEndsAtMs ?? '',
    room.startedAt ?? '',
    room.endsAt ?? '',
    room.pausedAt ?? '',
    room.result ? JSON.stringify(room.result) : '',
    room.config.teamAssignment,
    room.config.selectedHunterIds.join(','),
    room.config.hunterCount,
    demo.pausedFrom ?? '',
    // v30 follow-up (item D): the pauser — without it, a poll that
    // only records who paused would be skipped as identical and the
    // sheet would keep rendering "Match paused — clock frozen."
    demo.pausedByPlayerId ?? '',
    demo.appliedShrinks,
    JSON.stringify(demo.lastPingAtMs),
    players,
    catches,
    runnerTokens,
    pings,
    announcements,
  ].join('~');
}

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
