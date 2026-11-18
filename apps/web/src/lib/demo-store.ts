/**
 * DEMO MODE store — OFFLINE FALLBACK ONLY (wiring 2026-11-17).
 * This is NOT the primary path: when a Worker URL is configured
 * (NEXT_PUBLIC_WORKER_URL) the PWA plays through the real Worker /
 * Durable Object backend (apps/web/src/lib/websocket.ts:
 * createLivePakdamSocket, plus the REST helpers in
 * lib/live-room-client.ts), and this store is used ONLY when no
 * Worker is configured, or when a create/join hits a Worker that is
 * unreachable (network failure). A live room is never silently
 * downgraded to this store mid-room. Everything here is local only:
 * the engine runs in the browser, rooms persist to localStorage, and
 * a reload wipes nothing but a live room never lives here.
 * Production uses the Workers/DO backend (workers/) — this store is NOT it.
 * Privacy: rooms persist to localStorage WITHOUT any coordinates (HNT-068).
 * Location fixes are held in memory only and dropped on match end.
 *
 * SERVER PARITY (2026-11-18, demo divergences fixed in place — retiring
 * the demo would have meant rewriting every create/join/host/play/catch
 * demo branch, so the store was made to behave like the DO instead):
 * - Roles are assigned ONCE, at HEAD_START (workers/src/room-do.ts
 *   startMatch) — never re-drawn on the HEAD_START→ACTIVE flip or on a
 *   safety resume.
 * - The match clock starts at HEAD_START (startedAt/endsAt set there,
 *   like startMatch), NOT at ACTIVE. tickDemoRoom is the demo's alarm:
 *   getRoom runs it, so the 1 s play/catch polling flips HEAD_START→
 *   ACTIVE when the head start elapses and completes the match when
 *   endsAt is reached (resolveModeOutcome, timeExpired=true — the
 *   Runners win if any survive the clock), exactly like the DO's
 *   alarmTick. Nothing completes while SAFETY_PAUSED.
 * - A safety pause freezes the clock: pause records pausedAt +
 *   pausedFrom (the phase paused from); resume shifts startedAt,
 *   endsAt and headStartStartedAt forward by the pause and returns to
 *   pausedFrom (server safety.resume, GL-08) — it never hard-codes
 *   ACTIVE and never restarts the head start. While paused, reads
 *   project the deadlines forward by the elapsed pause so the HUD
 *   shows a frozen clock (projection only — nothing is persisted
 *   until resume).
 * - Catches mirror the DO's catch.request / catch.confirm rules: the
 *   requester must be a Hunter, the target a free Runner, phase
 *   ACTIVE, one pending catch per Runner (a re-request by the SAME
 *   Hunter returns the open claim — the demo's idempotency; a
 *   different Hunter gets CONFLICT, GL-05), and an already-caught
 *   Runner cannot be claimed again. Confirming is authenticated:
 *   'qr-scan' needs the claiming Hunter AND a scan this tab just
 *   verified (verifyCatchScan — token hash + expiry, single-use via
 *   the verified-scan record); 'manual-confirm' is Runner-only
 *   (server GL-04); no-how is the host resolving a DISPUTED catch
 *   (server resolveDisputedCatch, resolution 'host-review'). An
 *   expired QR never confirms: expiry is enforced lazily on every
 *   catch operation and by the tick, like the DO. Callers pass
 *   `actorId` — a confirm/dispute with no actor is FORBIDDEN.
 *   `nowMs` on the clock-sensitive functions is an injectable clock
 *   for tests only; production callers omit it.
 */
import { assignRoles, balancedHunterCount, transition, resolveCatch, expireCatch, issueCatchToken, verifyCatchToken, recordSuspension, applyConfirmedTag, resolveModeOutcome, modeTurnsRunner } from '@pakdam/engine';
import { CALIBRATION_OPEN, generateRoomCode, resolveHostToggles, validateRoomConfig } from '@pakdam/shared';
import type { CatchEvent, MatchPhase, Player, Room, RoomConfig, TeamAssignment } from '@pakdam/shared';

export interface DemoRoom { room: Room; players: Player[]; catches: CatchEvent[]; checkins: string[]; events: { at: string; text: string }[]; /** When the head start began (ISO) — the play page advances HEAD_START→ACTIVE from this + the configured headStartSeconds, so a reload does not restart the head start. Null in rooms created before this field existed. */ headStartStartedAt: string | null; /** Phase the match was in when safety-paused (server `pausedFrom`, room-do.ts safety.resume) — resume returns here, never hard-codes ACTIVE. Null when not paused. */ pausedFrom: MatchPhase | null; /** Per-catch QR expiry (ms epoch) — the token's expiresAtMs from issueCatchToken. Persisted (a timestamp, not a secret); the raw token itself stays in-memory only, like the server's pendingTokens. Rooms created before this field existed have none and fall back to requestedAt + TTL. */ catchExpiresAtMs: Record<string, number> }
const KEY = 'pakdam.demo.rooms.v1';
const rawCatchTokens = new Map<string, string>(); // in-memory only — raw tokens are NEVER persisted (HNT-049/050)
/** Catch ids whose QR was verified by a scan in THIS tab (verifyCatchScan).
 *  A 'qr-scan' confirm consumes the entry: a confirm with no verified
 *  scan behind it is rejected, so the scan — not a bare button tap — is
 *  what proves the two players were together. In-memory only, like the
 *  raw tokens; a reload clears it, and the Hunter simply scans again. */
const verifiedCatchScans = new Set<string>();
/** Idempotency keys seen by requestCatch (demo equivalent of the DO's
 *  (seat, commandId) store): a retry with the same key returns the
 *  original claim instead of opening a second one. In-memory only. */
const catchIdempotency = new Map<string, string>();
/** Rooms written before pausedFrom / catchExpiresAtMs existed get the
 *  defaults so old localStorage rooms keep working. */
function normalise(dr: DemoRoom): DemoRoom {
  if (dr.pausedFrom === undefined) dr.pausedFrom = null;
  if (dr.catchExpiresAtMs === undefined) dr.catchExpiresAtMs = {};
  if (dr.headStartStartedAt === undefined) dr.headStartStartedAt = null;
  return dr;
}
function load(): Record<string, DemoRoom> {
  if (typeof window === 'undefined') return {};
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, DemoRoom>;
    for (const dr of Object.values(all)) normalise(dr);
    return all;
  } catch { return {}; }
}
function save(all: Record<string, DemoRoom>): void { localStorage.setItem(KEY, JSON.stringify(all)); }
function shiftIso(iso: string | null, ms: number): string | null {
  return iso ? new Date(Date.parse(iso) + ms).toISOString() : null;
}
/** QR expiry for a catch: the stored expiresAtMs, else the legacy
 *  requestedAt + TTL fallback (rooms / catches from before the field). */
function catchExpiresAtMs(dr: DemoRoom, c: CatchEvent): number {
  return dr.catchExpiresAtMs[c.catchId] ?? (new Date(c.requestedAt).getTime() + CALIBRATION_OPEN.catchTokenTtlSeconds * 1000);
}
/** Lazily expire one overdue pending catch (DO catch.confirm does the
 *  same check on every attempt). Returns true when it expired. */
function expireCatchIfOverdue(dr: DemoRoom, c: CatchEvent, nowMs: number): boolean {
  if ((c.state === 'requested' || c.state === 'awaiting-confirmation') && nowMs > catchExpiresAtMs(dr, c)) {
    Object.assign(c, expireCatch(c));
    return true;
  }
  return false;
}
/** While SAFETY_PAUSED the match clock is frozen: reads project
 *  startedAt / endsAt / headStartStartedAt forward by the pause so
 *  far, so the HUD, the head-start countdown and the shrink clock all
 *  stand still. Projection ONLY — the stored values are untouched
 *  until resume shifts them for real (setPhase). */
function projectPausedClock(dr: DemoRoom, nowMs: number): DemoRoom {
  if (dr.room.phase !== 'SAFETY_PAUSED' || !dr.room.pausedAt) return dr;
  const shiftMs = nowMs - Date.parse(dr.room.pausedAt);
  if (shiftMs <= 0) return dr;
  return {
    ...dr,
    room: { ...dr.room, startedAt: shiftIso(dr.room.startedAt, shiftMs), endsAt: shiftIso(dr.room.endsAt, shiftMs) },
    headStartStartedAt: shiftIso(dr.headStartStartedAt, shiftMs),
  };
}
/**
 * Demo alarm tick — the DO alarmTick's local equivalent. Runs on every
 * getRoom / getRoomByCode read (the play and catch pages poll those
 * every second), so a demo match advances without a server:
 *  1. overdue pending catches expire;
 *  2. HEAD_START flips to ACTIVE when the head start elapses
 *     (from startedAt — the clock starts at HEAD_START, like
 *     startMatch — falling back to headStartStartedAt for legacy
 *     rooms whose startedAt was only set at ACTIVE);
 *  3. a live phase whose endsAt has passed completes via RESOLVING,
 *     with the mode-aware time-expired outcome (computeOutcome:
 *     Runners win if any survive the clock).
 * Never fires while SAFETY_PAUSED (the tick needs no pause logic —
 * resume shifts the deadlines, so a paused room cannot reach them).
 * Returns the stored room (unprojected) or null. listRooms does NOT
 * tick: a list read must not write.
 */
export function tickDemoRoom(roomId: string, nowMs: number = Date.now()): DemoRoom | null {
  const all = load(); const dr = all[roomId]; if (!dr) return null;
  if (dr.room.phase === 'SAFETY_PAUSED') return dr;
  let changed = false;
  for (const c of dr.catches) if (expireCatchIfOverdue(dr, c, nowMs)) changed = true;
  if (dr.room.phase === 'HEAD_START') {
    const headStartBase = dr.room.startedAt ?? dr.headStartStartedAt;
    if (headStartBase && nowMs >= Date.parse(headStartBase) + dr.room.config.headStartSeconds * 1000) {
      dr.room.phase = transition(dr.room.phase, 'ACTIVE'); dr.room.version += 1; changed = true;
      dr.events.push({ at: new Date(nowMs).toISOString(), text: 'Head start over — the match is live' });
    }
  }
  if ((dr.room.phase === 'ACTIVE' || dr.room.phase === 'HEAD_START') && dr.room.endsAt && nowMs >= Date.parse(dr.room.endsAt)) {
    const caught = dr.catches.filter((x) => x.state === 'confirmed').map((x) => x.runnerPlayerId);
    const result = {
      ...resolveModeOutcome(dr.players, caught, true, dr.room.config.mode),
      durationSeconds: dr.room.startedAt ? Math.max(0, Math.floor((nowMs - Date.parse(dr.room.startedAt)) / 1000)) : 0,
    };
    dr.room.phase = transition(dr.room.phase, 'RESOLVING');
    dr.room.result = result;
    dr.room.phase = transition(dr.room.phase, 'COMPLETED');
    dr.room.version += 1; changed = true;
    dr.events.push({ at: new Date(nowMs).toISOString(), text: `Time up — match complete (${result.outcome === 'hunters-win' ? 'Hunters win' : 'Runners win'})` });
  }
  if (changed) save(all);
  return dr;
}
export function listRooms(): DemoRoom[] { return Object.values(load()).map((dr) => projectPausedClock(dr, Date.now())); }
export function getRoom(roomId: string, nowMs: number = Date.now()): DemoRoom | null {
  const dr = tickDemoRoom(roomId, nowMs);
  return dr ? projectPausedClock(dr, nowMs) : null;
}
export function getRoomByCode(code: string, nowMs: number = Date.now()): DemoRoom | null {
  const found = Object.values(load()).find((r) => r.room.roomCode === code.toUpperCase()) ?? null;
  if (!found) return null;
  const dr = tickDemoRoom(found.room.roomId, nowMs);
  return dr ? projectPausedClock(dr, nowMs) : null;
}
function uid(): string { return crypto.randomUUID(); }
/** Room invite code — crypto randomness (shared `generateRoomCode`),
 *  never Math.random: a code must not be guessable. */
function code(): string { return generateRoomCode(); }
export function createRoom(hostName: string, config: RoomConfig): DemoRoom {
  // No venue/area name: the game starts from the host's GPS + a zone on
  // the map (redesign 2026-11-17). RoomConfig has no venueName field any
  // more and the old 'Play zone' shim is deleted — nothing fills one in.
  // Host-setup toggles saved before they existed are normalised to
  // their legacy defaults (all OFF) so old rooms keep their behaviour.
  const errors = validateRoomConfig(config);
  if (errors.length) throw new Error(errors.join('; '));
  const toggles = resolveHostToggles(config);
  const stored: RoomConfig = { ...config, ...toggles };
  const roomId = uid();
  const host: Player = { playerId: uid(), roomId, kind: 'host-account', displayName: hostName, isHost: true, matchRole: null, team: null, reconnectTokenHash: 'demo-' + uid(), joinedAt: new Date().toISOString(), leftAt: null, connectionState: 'connected', lastFixAt: null, locationQuality: 'unknown', isReady: true, briefingConfirmed: true, ageGatePassed: true, suspensionCount: 0, ejectedAt: null };
  const room: Room = { roomId, roomCode: code(), hostPlayerId: host.playerId, phase: 'LOBBY', version: 1, config: stored, createdAt: new Date().toISOString(), startedAt: null, endsAt: null, pausedAt: null, result: null };
  const dr: DemoRoom = { room, players: [host], catches: [], checkins: [], events: [{ at: new Date().toISOString(), text: `Room created by ${hostName}` }], headStartStartedAt: null, pausedFrom: null, catchExpiresAtMs: {} };
  const all = load(); all[roomId] = dr; save(all); return dr;
}
export function joinRoom(roomId: string, displayName: string): Player {
  const all = load(); const dr = all[roomId]; if (!dr) throw new Error('ROOM_NOT_FOUND');
  const trimmed = displayName.trim();
  // Rejoining with an existing display name RESTORES that player's
  // seat — same playerId, same role, host powers if host — instead of
  // creating a duplicate (founder bug, 2026-11-17: rejoining as the
  // host name created a duplicate non-host player and the host lost
  // the Start button). Matching is case-insensitive on the trimmed
  // name; a player who left rejoins as connected again (ejectedAt,
  // if set, stays — rejoining never un-ejects). The restore runs
  // before the room-full check (the seat is already theirs) and in
  // any phase (it is a resume, not a new join); brand-new players
  // still need a free seat and an open lobby.
  const existing = dr.players.find((p) => p.displayName.trim().toLowerCase() === trimmed.toLowerCase());
  if (existing) {
    existing.leftAt = null;
    // An ejected seat must NOT flip back to 'connected' while
    // ejectedAt is set (same rule as the DO, QA BE-09): an ejected
    // Runner rejoining looked live again while still ejected.
    existing.connectionState = existing.ejectedAt ? existing.connectionState : 'connected';
    dr.events.push({ at: new Date().toISOString(), text: `${existing.displayName} rejoined` });
    save(all); return existing;
  }
  // Room-full counts ACTIVE seats only (QA 2026-11-17, MP-FULL-COUNT):
  // players who left stay in the roster with leftAt set, and the old
  // `players.length` check counted them — a room with leavers reported
  // "full" with free seats.
  if (dr.players.filter((p) => !p.leftAt).length >= dr.room.config.maxPlayers) throw new Error('Room is full');
  if (dr.room.phase !== 'LOBBY') throw new Error('Room is not open for joining');
  const p: Player = { playerId: uid(), roomId, kind: 'guest', displayName: trimmed, isHost: false, matchRole: null, team: null, reconnectTokenHash: 'demo-' + uid(), joinedAt: new Date().toISOString(), leftAt: null, connectionState: 'connected', lastFixAt: null, locationQuality: 'unknown', isReady: false, briefingConfirmed: false, ageGatePassed: true, suspensionCount: 0, ejectedAt: null };
  dr.players.push(p); dr.events.push({ at: new Date().toISOString(), text: `${trimmed} joined` }); save(all); return p;
}
export function setPhase(roomId: string, to: MatchPhase, nowMs: number = Date.now()): DemoRoom {
  const all = load(); const dr = all[roomId]; if (!dr) throw new Error('ROOM_NOT_FOUND');
  const from = dr.room.phase;
  // Resume from a safety pause returns to the phase the match was
  // paused from (server safety.resume, GL-08) — the caller asks for
  // ACTIVE, the store resolves it to HEAD_START when the pause began
  // there, so a pause during the head start never skips the rest of
  // it. transition() still enforces the legal edge either way.
  let target = to;
  if (from === 'SAFETY_PAUSED' && to === 'ACTIVE') target = dr.pausedFrom ?? 'ACTIVE';
  dr.room.phase = transition(from, target); dr.room.version += 1;
  const nowIso = new Date(nowMs).toISOString();
  if (target === 'SAFETY_PAUSED') {
    // Pause freezes the clock: the pause start and the phase paused
    // from are recorded; resume shifts the deadlines (below). The
    // tick never completes a paused room, and reads project the
    // deadlines forward while paused (projectPausedClock).
    dr.room.pausedAt = nowIso;
    dr.pausedFrom = from;
  } else if (from === 'SAFETY_PAUSED' && (target === 'ACTIVE' || target === 'HEAD_START')) {
    // Resume: shift the match clock forward by the pause (server
    // safety.resume) — a pause eats no match time and the head start
    // does not expire while everyone is standing still. Roles are
    // NOT re-drawn here (they were drawn once, at HEAD_START).
    const pauseMs = Math.max(0, nowMs - (dr.room.pausedAt ? Date.parse(dr.room.pausedAt) : nowMs));
    dr.room.startedAt = shiftIso(dr.room.startedAt, pauseMs);
    dr.room.endsAt = shiftIso(dr.room.endsAt, pauseMs);
    dr.headStartStartedAt = shiftIso(dr.headStartStartedAt, pauseMs);
    dr.room.pausedAt = null;
    dr.pausedFrom = null;
    dr.events.push({ at: nowIso, text: `Safety pause lifted — the game resumes (${target === 'HEAD_START' ? 'head start' : 'active play'})` });
  }
  // The match clock starts at HEAD_START (server startMatch), NOT at
  // ACTIVE: startedAt/endsAt are set on the fresh HEAD_START entry,
  // and the ACTIVE flip never resets them — the old code reset both
  // on every entry to ACTIVE, so a safety resume silently granted a
  // whole new match duration. A legacy room that reached ACTIVE
  // without HEAD_START (startedAt still null) gets its clock here,
  // once, instead of never having one.
  const freshHeadStart = target === 'HEAD_START' && from === 'COUNTDOWN';
  if (freshHeadStart) {
    if (!dr.room.startedAt) {
      dr.room.startedAt = nowIso;
      dr.room.endsAt = new Date(nowMs + dr.room.config.durationSeconds * 1000).toISOString();
    }
    dr.headStartStartedAt = nowIso;
  } else if (target === 'ACTIVE' && from === 'HEAD_START' && !dr.room.startedAt) {
    dr.room.startedAt = nowIso;
    dr.room.endsAt = new Date(nowMs + dr.room.config.durationSeconds * 1000).toISOString();
  }
  if (freshHeadStart || (target === 'ACTIVE' && from === 'HEAD_START' && !dr.players.some((p) => p.matchRole))) {
    // Roles are assigned ONCE, when the game starts (HEAD_START) — the
    // head start IS the match starting. They are NEVER re-drawn on the
    // HEAD_START -> ACTIVE step: re-assigning there re-shuffled the
    // Hunters (4 of 5 probe trials changed Hunter between head start
    // and active play, 2026-11-17 final verification), so the role a
    // player revealed during the head start could flip when play
    // began. The ACTIVE arm above only assigns when NO role exists
    // yet (a room that reached ACTIVE without HEAD_START, e.g. a
    // legacy room) — otherwise the HEAD_START draw stands. The DO
    // assigns once in startMatch for the same reason.
    // Roles are assigned when the game starts, honouring the host's
    // team assignment AND the Balance / Random toggles:
    // - Balance ON: the Hunter count is set from the roster that
    //   actually joined (provisional table, calibration OPEN).
    // - Random ON (teamAssignment 'random' + randomDraw): Hunters are
    //   drawn at random (a real shuffle). Random OFF in legacy rooms
    //   keeps the deterministic join-order draw existing rooms rely
    //   on (the host is first, so the host is the Hunter).
    // - Host picks (teamAssignment 'selected'): the host-picked Hunters
    //   are used when exactly the effective count were picked; if the
    //   balance changed the count, the pick is trimmed to the effective
    //   count, and if too few (or none) were picked the shortfall is
    //   drawn at random — the match never fails to start over a stale
    //   pick. The stored hunterCount is updated to the effective count
    //   so the dashboard and summary agree with the game. Classic
    //   and Infection are the only modes; neither forces a Hunter
    //   count, so Balance can raise the count here.
    const c = dr.room.config;
    const toggles = resolveHostToggles(c);
    let effective = toggles.balanceHunters ? balancedHunterCount(dr.players.length) : c.hunterCount;
    effective = Math.max(1, Math.min(effective, dr.players.length - 1));
    const picked = c.selectedHunterIds;
    let note = '';
    if (c.teamAssignment === 'selected' && picked.length === effective) {
      dr.players = assignRoles(dr.players, effective, { teamAssignment: 'selected', selectedHunterIds: picked });
      note = `Host picked ${effective} Hunter${effective === 1 ? '' : 's'} in the lobby.`;
    } else {
      if (c.teamAssignment === 'selected' && picked.length > effective) {
        note = `Host-picked Hunters trimmed to ${effective} (balanced count for ${dr.players.length} players).`;
      } else if (c.teamAssignment === 'selected') {
        note = `Only ${picked.length} Hunter${picked.length === 1 ? '' : 's'} picked for a ${effective}-Hunter game — drawing at random instead.`;
      } else if (toggles.randomDraw) {
        note = `${effective} Hunter${effective === 1 ? '' : 's'} drawn at random.`;
      }
      if (toggles.balanceHunters && effective !== c.hunterCount) {
        note += ` Balance set the Hunter count from the roster (${dr.players.length} players).`;
      }
      dr.players = assignRoles(dr.players, effective, { teamAssignment: 'random', shuffle: toggles.randomDraw });
    }
    dr.room.config.hunterCount = effective;
    if (note) dr.events.push({ at: new Date().toISOString(), text: `Roles assigned — ${note}` });
  }
  save(all); return dr;
}
/** Host changes how teams are picked (lobby only). Switching to Random
 *  clears any host-picked Hunters. */
export function setTeamAssignment(roomId: string, assignment: TeamAssignment): DemoRoom {
  const all = load(); const dr = all[roomId]; if (!dr) throw new Error('ROOM_NOT_FOUND');
  if (dr.room.phase !== 'LOBBY') throw new Error('INVALID_STATE: teams can only be changed in the lobby');
  dr.room.config.teamAssignment = assignment;
  if (assignment === 'random') dr.room.config.selectedHunterIds = [];
  dr.events.push({ at: new Date().toISOString(), text: `Host set team assignment to ${assignment === 'selected' ? 'Selected (host picks the Hunters)' : 'Random'}` });
  save(all); return dr;
}
/** Host picks exactly hunterCount Hunters from the joined players
 *  (lobby only, teamAssignment 'selected'). */
export function setSelectedHunters(roomId: string, playerIds: string[]): DemoRoom {
  const all = load(); const dr = all[roomId]; if (!dr) throw new Error('ROOM_NOT_FOUND');
  if (dr.room.phase !== 'LOBBY') throw new Error('INVALID_STATE: Hunters can only be picked in the lobby');
  if (dr.room.config.teamAssignment !== 'selected') throw new Error('INVALID_STATE: team assignment is Random — switch to Selected first');
  if (playerIds.length !== dr.room.config.hunterCount) throw new Error(`VALIDATION_FAILED: pick exactly ${dr.room.config.hunterCount} Hunter(s)`);
  const joined = new Set(dr.players.map((p) => p.playerId));
  if (playerIds.some((id) => !joined.has(id))) throw new Error('VALIDATION_FAILED: picked Hunters must be joined players');
  if (new Set(playerIds).size !== playerIds.length) throw new Error('VALIDATION_FAILED: picked Hunters must not repeat a player');
  dr.room.config.selectedHunterIds = [...playerIds];
  const names = playerIds.map((id) => dr.players.find((p) => p.playerId === id)?.displayName ?? id).join(', ');
  dr.events.push({ at: new Date().toISOString(), text: `Host picked Hunters: ${names}` });
  save(all); return dr;
}
/** Host changes the game settings from the lobby settings sheet
 *  (lobby only — never after the match starts). The new config is
 *  validated exactly like a fresh room. If the Hunter count or the
 *  team assignment changed, any host-picked Hunters are cleared: the
 *  old pick may no longer hold the right number of players. */
export function updateRoomConfig(roomId: string, config: RoomConfig): DemoRoom {
  const all = load(); const dr = all[roomId]; if (!dr) throw new Error('ROOM_NOT_FOUND');
  if (dr.room.phase !== 'LOBBY') throw new Error('INVALID_STATE: settings can only be changed in the lobby');
  const trimmed: RoomConfig = { ...config, selectedHunterIds: config.selectedHunterIds.slice(0, config.hunterCount) };
  const errors = validateRoomConfig(trimmed);
  if (errors.length) throw new Error(errors.join('; '));
  const hunterCountChanged = trimmed.hunterCount !== dr.room.config.hunterCount;
  const assignmentChanged = trimmed.teamAssignment !== dr.room.config.teamAssignment;
  const toggles = resolveHostToggles(trimmed);
  dr.room.config = { ...trimmed, ...toggles };
  if (hunterCountChanged || assignmentChanged) dr.room.config.selectedHunterIds = [];
  dr.room.version += 1;
  dr.events.push({ at: new Date().toISOString(), text: 'Host updated the game settings' });
  save(all); return dr;
}
export function toggleReady(roomId: string, playerId: string): void {
  const all = load(); const dr = all[roomId]; if (!dr) return;
  const p = dr.players.find((x) => x.playerId === playerId); if (p) { p.isReady = !p.isReady; p.briefingConfirmed = true; save(all); }
}
export function requestCatch(roomId: string, hunterId: string, runnerId: string, opts?: { idempotencyKey?: string; nowMs?: number }): CatchEvent {
  const nowMs = opts?.nowMs ?? Date.now();
  const all = load(); const dr = all[roomId]; if (!dr) throw new Error('ROOM_NOT_FOUND');
  // Idempotent retry: the same key returns the original claim instead
  // of opening a second one (DO (seat, commandId) dedupe).
  if (opts?.idempotencyKey) {
    const priorId = catchIdempotency.get(`${roomId}:${opts.idempotencyKey}`);
    const prior = priorId ? dr.catches.find((x) => x.catchId === priorId) : undefined;
    if (prior) return prior;
  }
  // Server catch.request rules (room-do.ts): only a Hunter may claim,
  // only while ACTIVE, only on a Runner who is free, present and not
  // suspended — and one pending catch per Runner, whoever the Hunter
  // is (GL-05). A re-request by the SAME Hunter returns the open
  // claim (idempotent — a double-tap never opens a second claim); a
  // different Hunter gets CONFLICT, like the server.
  if (dr.room.phase !== 'ACTIVE') throw new Error(`INVALID_STATE: catches are not possible while the match is ${dr.room.phase}`);
  const hunter = dr.players.find((p) => p.playerId === hunterId);
  if (!hunter || hunter.matchRole !== 'hunter') throw new Error('FORBIDDEN: only a Hunter may request a catch');
  if (hunter.ejectedAt || hunter.leftAt) throw new Error('INVALID_STATE: an ejected or departed Hunter may not request a catch');
  const runner = dr.players.find((p) => p.playerId === runnerId);
  if (!runner || runner.matchRole !== 'runner' || runner.leftAt || runner.ejectedAt) throw new Error('VALIDATION_FAILED: runnerId is not a Runner in this room');
  if (runner.connectionState === 'suspended') throw new Error('Catch cannot complete while the Runner is suspended — they must reopen the PWA first');
  if (dr.catches.some((c) => c.runnerPlayerId === runnerId && c.state === 'confirmed')) throw new Error('INVALID_STATE: Runner is already caught');
  const pending = dr.catches.find((c) => c.runnerPlayerId === runnerId && (c.state === 'requested' || c.state === 'awaiting-confirmation'));
  if (pending) {
    if (pending.hunterPlayerId === hunterId) return pending;
    throw new Error('CONFLICT: a catch is already pending for this Runner');
  }
  // BUG FIX (fix round, found by the Playwright full-loop spec): the token
  // MUST be issued for this catch's own id. The old code issued it for a
  // throwaway uid() and gave the CatchEvent a different uid(), so
  // verifyCatchToken(catchId, raw, hash) could never match and the Hunter's
  // QR scan verification always failed. The DO handler (workers/src/room-do.ts)
  // already did this correctly; only the demo store had the mismatch.
  const catchId = uid();
  const tok = issueCatchToken(catchId, CALIBRATION_OPEN.catchTokenTtlSeconds, nowMs);
  const c: CatchEvent = { catchId, roomId, hunterPlayerId: hunterId, runnerPlayerId: runnerId, state: 'awaiting-confirmation', qrTokenHash: tok.hash, requestedAt: new Date(nowMs).toISOString(), confirmedAt: null, disputedAt: null, resolution: null, gpsEvidence: 'absent' };
  rawCatchTokens.set(c.catchId, tok.raw);
  dr.catchExpiresAtMs[c.catchId] = tok.expiresAtMs;
  if (opts?.idempotencyKey) catchIdempotency.set(`${roomId}:${opts.idempotencyKey}`, c.catchId);
  dr.catches.push(c);
  // Runner confirmation is ALWAYS required (founder-corrected catch
  // flow, 2026-11-17): a tag never counts at once — the catch stays
  // pending until the Runner confirms or disputes it.
  save(all); return c;
}
/** Shared tail of a confirmed catch: apply the mode rule (out vs turn)
 *  and complete the match when the mode's win rule is met. The win
 *  completion only runs while the match is live (server
 *  maybeCompleteOnWin) — confirming a disputed catch after the match
 *  already ended records the tag but never rewrites the result. */
function applyConfirmedCatch(dr: DemoRoom, c: CatchEvent): void {
  const tag = applyConfirmedTag(dr.players, c.runnerPlayerId, dr.room.config.mode);
  dr.players = tag.players;
  if (dr.room.phase !== 'ACTIVE' && dr.room.phase !== 'HEAD_START') return;
  const caught = dr.catches.filter((x) => x.state === 'confirmed').map((x) => x.runnerPlayerId);
  const result = resolveModeOutcome(dr.players, caught, false, dr.room.config.mode);
  if (result.outcome === 'hunters-win') {
    dr.room.phase = 'RESOLVING';
    dr.room.result = { ...result, durationSeconds: dr.room.startedAt ? Math.floor((Date.now() - new Date(dr.room.startedAt).getTime()) / 1000) : 0 };
    dr.room.phase = 'COMPLETED';
  }
}
/**
 * Confirm a pending catch. Authenticated, like the DO's catch.confirm
 * (and resolveDisputedCatch for the host path) — a call with no actor
 * is FORBIDDEN, and the actor must be entitled to the path it takes:
 * - 'qr-scan': the claiming Hunter, and only after this tab verified
 *   the Runner's QR for this catch (verifyCatchScan records it; the
 *   entry is consumed here, so one scan completes one claim). A
 *   confirm with no verified scan behind it is rejected — the scan,
 *   not a bare call, proves the two players were together.
 * - 'manual-confirm': the named Runner only (server GL-04 — the
 *   camera-unavailable fallback is the Runner's own consent).
 * - 'host-review' (how omitted): the host resolving a DISPUTED catch
 *   after checking with both players in person (server
 *   resolveDisputedCatch); the catch must be disputed.
 * Every path first expires an overdue claim (the DO does the same on
 * confirm — an expired QR never confirms), requires a pending claim
 * (a second confirm is CONFLICT, never a double-apply), and — for
 * the QR / manual paths — requires the match to be ACTIVE with the
 * Runner still a free, non-suspended Runner (server GL-09).
 */
export function confirmCatch(roomId: string, catchId: string, how?: 'qr-scan' | 'manual-confirm' | 'host-review', actorId?: string, nowMs: number = Date.now()): void {
  const all = load(); const dr = all[roomId]; if (!dr) return;
  const c = dr.catches.find((x) => x.catchId === catchId); if (!c) return;
  if (!actorId) throw new Error('FORBIDDEN: a catch confirm needs the confirming player');
  if (expireCatchIfOverdue(dr, c, nowMs)) { save(all); throw new Error('VALIDATION_FAILED: this QR expired — ask the Hunter to request a new one'); }
  // No `how` means the host resolving a disputed catch — default it
  // BEFORE the state guards, or the disputed guard below would
  // reject the very call it is meant to allow.
  const resolution = how ?? 'host-review';
  if (c.state === 'confirmed') throw new Error(`CONFLICT: catch is already ${c.state}`);
  if (c.state === 'disputed' && resolution !== 'host-review') throw new Error(`CONFLICT: catch is ${c.state} — only the host can resolve it after checking with both players`);
  if (c.state !== 'requested' && c.state !== 'awaiting-confirmation' && !(c.state === 'disputed' && resolution === 'host-review')) {
    throw new Error(`CONFLICT: catch is ${c.state}`);
  }
  if (resolution === 'host-review') {
    if (actorId !== dr.room.hostPlayerId) throw new Error('FORBIDDEN: only the host may resolve a disputed catch');
    if (c.state !== 'disputed') throw new Error(`CONFLICT: catch is ${c.state}, not disputed`);
    Object.assign(c, { state: 'confirmed' as const, confirmedAt: new Date(nowMs).toISOString(), resolution: 'host-review' as const });
    dr.events.push({ at: new Date(nowMs).toISOString(), text: `Host confirmed a disputed catch after checking with both players` });
    applyConfirmedCatch(dr, c);
    save(all);
    return;
  }
  if (dr.room.phase !== 'ACTIVE') throw new Error(`INVALID_STATE: catches cannot complete while the match is ${dr.room.phase}`);
  const runner = dr.players.find((p) => p.playerId === c.runnerPlayerId);
  if (runner?.connectionState === 'suspended') throw new Error('INVALID_STATE: Runner is suspended — a catch cannot complete while the Runner is suspended');
  if (runner?.ejectedAt) throw new Error('INVALID_STATE: Runner was ejected from the game');
  if (runner?.matchRole !== 'runner') throw new Error('INVALID_STATE: only a Runner can be tagged');
  if (resolution === 'qr-scan') {
    if (actorId !== c.hunterPlayerId) throw new Error('FORBIDDEN: only the claiming Hunter may confirm this catch with a QR scan');
    if (!verifiedCatchScans.has(catchId)) throw new Error('VALIDATION_FAILED: no verified QR scan for this catch — scan the Runner’s QR first');
    verifiedCatchScans.delete(catchId);
  } else {
    if (actorId !== c.runnerPlayerId) throw new Error('FORBIDDEN: only the named Runner may confirm this catch manually');
  }
  Object.assign(c, resolveCatch(c, 'confirm', new Date(nowMs).toISOString(), resolution));
  const turns = modeTurnsRunner(dr.room.config.mode);
  dr.events.push({ at: new Date(nowMs).toISOString(), text: turns ? `Catch confirmed — Runner turned Hunter` : `Catch confirmed — Runner caught` });
  applyConfirmedCatch(dr, c);
  save(all);
}
export function disputeCatch(roomId: string, catchId: string, actorId?: string, nowMs: number = Date.now()): void {
  const all = load(); const dr = all[roomId]; if (!dr) return;
  const c = dr.catches.find((x) => x.catchId === catchId); if (!c) return;
  // Server catch.dispute: Runner-only, on a pending claim; an
  // overdue claim expires instead of disputing. A dispute with no
  // actor is FORBIDDEN. (The server also requires a reason string;
  // the demo UI collects none — that gap stays open, see report.)
  if (!actorId) throw new Error('FORBIDDEN: a catch dispute needs the disputing player');
  if (actorId !== c.runnerPlayerId) throw new Error('FORBIDDEN: only the named Runner may dispute this catch');
  if (expireCatchIfOverdue(dr, c, nowMs)) { save(all); throw new Error('VALIDATION_FAILED: this QR expired — ask the Hunter to request a new one'); }
  if (c.state !== 'requested' && c.state !== 'awaiting-confirmation') throw new Error(`CONFLICT: catch is ${c.state}`);
  Object.assign(c, resolveCatch(c, 'dispute', new Date(nowMs).toISOString())); save(all);
}
export function expireOldCatches(roomId: string, nowMs: number = Date.now()): void {
  const all = load(); const dr = all[roomId]; if (!dr) return;
  dr.catches.forEach((c) => { expireCatchIfOverdue(dr, c, nowMs); });
  save(all);
}
export function getCatchRaw(catchId: string): string | undefined { return rawCatchTokens.get(catchId); }
/** Verify a scanned QR token against the open claim. There is NO typed
 *  code in Pakdam — the token lives only inside the Runner's QR, and
 *  this is the only place it is checked. The check is hash + expiry +
 *  pending state: an expired QR fails even with the right token, and
 *  the claim is marked expired when the check finds it overdue. A
 *  successful verify records the scan so confirmCatch('qr-scan') can
 *  accept it — verification alone never confirms a catch. */
export function verifyCatchScan(roomId: string, catchId: string, raw: string, nowMs: number = Date.now()): boolean {
  const all = load(); const dr = all[roomId]; if (!dr) return false;
  const c = dr.catches.find((x) => x.catchId === catchId); if (!c || !c.qrTokenHash) return false;
  if (expireCatchIfOverdue(dr, c, nowMs)) { save(all); return false; }
  if (c.state !== 'requested' && c.state !== 'awaiting-confirmation') return false;
  const ok = verifyCatchToken(catchId, raw, c.qrTokenHash);
  if (ok) verifiedCatchScans.add(catchId);
  return ok;
}
export function recordPlayerSuspension(roomId: string, playerId: string): string {
  const all = load(); const dr = all[roomId]; if (!dr) return '';
  const p = dr.players.find((x) => x.playerId === playerId); if (!p) return '';
  const { player, outcome } = recordSuspension(p, CALIBRATION_OPEN.suspensionCountBeforeHostCheckin);
  dr.players = dr.players.map((x) => (x.playerId === playerId ? player : x));
  dr.events.push({ at: new Date().toISOString(), text: outcome.reason }); save(all); return outcome.reason;
}
/** Resume a suspended player: reopening the PWA (or tapping the
 *  play page's "Resume sharing" button) brings them back to
 *  `connected` — this is what makes the catch page's "they must
 *  reopen the PWA first" satisfiable. A suspended player who returns
 *  is location-known again; the timer kept running while they were
 *  away, and the suspension count stays on the record. Returns true
 *  only when a suspended player was actually resumed. */
export function resumePlayer(roomId: string, playerId: string): boolean {
  const all = load(); const dr = all[roomId]; if (!dr) return false;
  const p = dr.players.find((x) => x.playerId === playerId); if (!p || p.connectionState !== 'suspended') return false;
  p.connectionState = 'connected';
  p.lastFixAt = new Date().toISOString();
  dr.events.push({ at: new Date().toISOString(), text: `${p.displayName} reopened the app — back to connected` });
  save(all); return true;
}
export function hostCheckin(roomId: string, note: string): void {
  const all = load(); const dr = all[roomId]; if (!dr) return;
  dr.checkins.push(`${new Date().toISOString()} — ${note}`); dr.events.push({ at: new Date().toISOString(), text: `Host check-in: ${note}` }); save(all);
}
/** Record that a player just sent a fresh location fix (the manual
 *  "Refresh my location" button, founder rule 2026-11-17). Timestamp
 *  ONLY — no coordinates are ever stored in this demo store (HNT-068).
 *  In production the same tap calls PakdamSocket.sendLocationUpdate
 *  (apps/web/src/lib/websocket.ts) with the fresh fix; here the
 *  timestamp is what the dots and freshness rows show ("Last updated
 *  just now"). Also marks the player connected again. */
export function recordPlayerFix(roomId: string, playerId: string): void {
  const all = load(); const dr = all[roomId]; if (!dr) return;
  const p = dr.players.find((x) => x.playerId === playerId); if (!p) return;
  p.lastFixAt = new Date().toISOString(); p.connectionState = 'connected'; save(all);
}
/** Record a device-side zone-exit alert (founder rule, 2026-11-17).
 *  The player's phone checked locally whether its fix is inside the
 *  zone — no location was sent for the check itself. Only on crossing
 *  outside does the phone send exactly ONE alert, and this is it: the
 *  event log records the crossing, which is what starts the 30-second
 *  return countdown on the server (first-seen-outside). The caller
 *  guards to once per crossing (the flag resets when the player is
 *  back inside). In production the same crossing sends one
 *  location.update with the fix via PakdamSocket, and the Durable
 *  Object records first-seen-outside from it (workers/src/room-do.ts). */
export function recordZoneExit(roomId: string, playerId: string): void {
  const all = load(); const dr = all[roomId]; if (!dr) return;
  const p = dr.players.find((x) => x.playerId === playerId); if (!p) return;
  dr.events.push({ at: new Date().toISOString(), text: `${p.displayName} left the play zone — 30-second return countdown started` }); save(all);
}
export function leaveRoom(roomId: string, playerId: string): void {
  const all = load(); const dr = all[roomId]; if (!dr) return;
  const p = dr.players.find((x) => x.playerId === playerId);
  if (p) { p.leftAt = new Date().toISOString(); p.connectionState = 'disconnected'; }
  // QA 2026-11-17 (MP-HOST-LEAVE): the host leaving orphaned the room
  // (same gap as the DO) — transfer host to the earliest-joined player
  // still in the room so someone can still start / resume. A lone host
  // leaving transfers to nobody; the room keeps its (departed) host id.
  if (p?.isHost) {
    const successor = dr.players
      .filter((x) => x.playerId !== playerId && !x.leftAt && !x.ejectedAt)
      .sort((a, b) => Date.parse(a.joinedAt) - Date.parse(b.joinedAt))[0];
    if (successor) {
      p.isHost = false;
      successor.isHost = true;
      dr.room.hostPlayerId = successor.playerId;
      dr.events.push({ at: new Date().toISOString(), text: `Host transferred to ${successor.displayName} — ${p.displayName} left` });
    }
  }
  save(all);
}
/** Eject a player for staying outside the play zone past the 30-second
 *  return countdown (founder rule, 2026-11-17 — the countdown and the
 *  ejection are both enforced here, not just displayed). Sets
 *  ejectedAt: the player stays in the room record (leftAt stays null)
 *  but is out of play — the roster and results show them as ejected,
 *  they are no longer a free Runner, and no catch can target them.
 *  If the ejection leaves no Runner free, the match completes as a
 *  Hunters win — the same completion as every Runner caught, because
 *  no Runner is left in play (resolveModeOutcome already excludes
 *  ejected players from survivors). Returns true when the player was
 *  ejected, false when they were already ejected, not found, or the
 *  match is not running (no ejection while paused or in the lobby). */
export function ejectPlayer(roomId: string, playerId: string): boolean {
  const all = load(); const dr = all[roomId]; if (!dr) return false;
  const p = dr.players.find((x) => x.playerId === playerId); if (!p || p.ejectedAt) return false;
  if (dr.room.phase !== 'ACTIVE' && dr.room.phase !== 'HEAD_START') return false;
  p.ejectedAt = new Date().toISOString();
  dr.events.push({ at: new Date().toISOString(), text: `${p.displayName} was ejected — outside the play zone for 30 seconds` });
  const caught = dr.catches.filter((x) => x.state === 'confirmed').map((x) => x.runnerPlayerId);
  const result = resolveModeOutcome(dr.players, caught, false, dr.room.config.mode);
  if (result.outcome === 'hunters-win') {
    dr.room.phase = 'RESOLVING';
    dr.room.result = { ...result, durationSeconds: dr.room.startedAt ? Math.floor((Date.now() - new Date(dr.room.startedAt).getTime()) / 1000) : 0 };
    dr.room.phase = 'COMPLETED';
    dr.events.push({ at: new Date().toISOString(), text: 'Match complete — Hunters win (no Runner left in play)' });
  }
  save(all); return true;
}
/** Per-tab player identity (founder bug, 2026-11-17): sessionStorage,
 *  NOT localStorage. localStorage is shared across every tab of the
 *  origin, so a second player joining in another tab overwrote the
 *  host tab's identity — the host lost the Start button the moment
 *  anyone else joined on the same device. sessionStorage belongs to
 *  one tab: each tab keeps its own player, and a reload in the same
 *  tab still restores the room and the role (sessionStorage survives
 *  a reload). A brand-new tab starts with no identity and rejoins by
 *  display name — joinRoom restores the seat, host powers included. */
const PLAYER_KEY = 'pakdam.playerId';
export function currentPlayerId(): string | null {
  if (typeof window === 'undefined') return null;
  return sessionStorage.getItem(PLAYER_KEY);
}
export function setCurrentPlayerId(id: string): void {
  sessionStorage.setItem(PLAYER_KEY, id);
}
export function clearCurrentPlayerId(): void {
  sessionStorage.removeItem(PLAYER_KEY);
}
