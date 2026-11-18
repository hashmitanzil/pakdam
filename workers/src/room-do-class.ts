import { DurableObject } from 'cloudflare:workers';
import {
  recoverState, snapshotForRecovery, snapshotForPlayer, alarmTick,
  addPlayer, startMatch, handleWsClientMessage, validateHello,
  buildWsSnapshot, applySuspension, buildPlayerSuspended, logGameEvent,
  issueHostToken, verifyHostToken, transferHost, updateRoomConfig,
  resolveDisputedCatch, endMatch, verifyReconnectToken,
  registerWsTicket, markWsTicketRedeemed, ticketRenewalDue, buildRenewalRequired,
  registerRoomCode, lookupRoomCode, unregisterRoomCode, regenerateRoomCode,
  type CodeIndex, type RoomDoState,
} from './room-do.js';
import { CALIBRATION_OPEN, createGameEvent, isValidDisplayName, isValidRoomCode, sha256Hex, validateRoomConfig } from '@pakdam/shared';
import type { Player, Room, WsServerMessage } from '@pakdam/shared';
import {
  persistMatchResult, persistCatchInsert, persistCatchUpdate, persistSafetyEvent,
} from './supabase.js';

/** Worker environment for this DO: the ROOM_DO binding (itself, for
 *  sub-room lookups the API mission may add), the plain ENVIRONMENT
 *  var from wrangler.toml, and the optional Supabase bindings
 *  (Worker 5 — SUPABASE_URL plain var, SUPABASE_SERVICE_ROLE_KEY
 *  secret; absent/empty means "run without Supabase persistence").
 *  No secrets are read here. DurableObjectState /
 *  DurableObjectNamespace are globals from @cloudflare/workers-types
 *  (the workers tsconfig lists it in `types`) — they are NOT module
 *  exports of 'cloudflare:workers'. */
interface RoomDoEnv {
  ROOM_DO: DurableObjectNamespace;
  ENVIRONMENT: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}

const STATE_KEY = 'room-state';

/** Room-code index (Worker F, 2026-11-17): the singleton index
 *  instance is the RoomDurableObject addressed by this fixed name —
 *  `env.ROOM_DO.idFromName(CODE_INDEX_DO_NAME)` in index.ts. It
 *  holds NO room state (its `this.state` stays null); the code →
 *  roomId map lives under CODE_INDEX_KEY in its own storage, so
 *  room ops and index ops can never see each other's data. The
 *  index instance never accepts a WebSocket and its alarm() is a
 *  no-op (load() returns null — see below). */
export const CODE_INDEX_DO_NAME = 'pakdam:code-index';
const CODE_INDEX_KEY = 'code-index';

/** Broadcast fan-out (17 §3.3): most server messages go to every
 *  socket in the room; a few go only to their parties. Direct replies
 *  (error, heartbeat.ack, snapshot, welcome, auth.*) go only to the
 *  sender — the caller handles those, this helper covers broadcasts.
 *  - catch.* → the Hunter, the Runner, and the host only.
 *  - signal / pin / radio → the sender's team + the host only
 *    (radio with no team yet — the lobby — goes to the whole lobby).
 *  - everything else broadcast → all sockets.
 *  Catches are ALSO filtered in snapshots (buildWsSnapshot), so a
 *  seat that misses the live broadcast never learns another seat's
 *  catch from a re-sync. */
function broadcastRecipients(msg: WsServerMessage, s: RoomDoState, senderId: string | null): Set<string> | 'all' {
  const allPlayers = s.players.map((p) => p.playerId);
  if (msg.type === 'catch.requested' || msg.type === 'catch.confirmed' || msg.type === 'catch.disputed' || msg.type === 'catch.expired' || msg.type === 'catch.rejected') {
    const c = (msg.payload as { catch: { hunterPlayerId: string; runnerPlayerId: string } }).catch;
    const parties = new Set([c.hunterPlayerId, c.runnerPlayerId, s.room.hostPlayerId]);
    return new Set(allPlayers.filter((id) => parties.has(id)));
  }
  if (msg.type === 'signal' || msg.type === 'pin') {
    const sender = s.players.find((p) => p.playerId === senderId);
    const team = sender?.team ?? null;
    return new Set(allPlayers.filter((id) => {
      const p = s.players.find((x) => x.playerId === id)!;
      return p.isHost || (team !== null && p.team === team);
    }));
  }
  if (msg.type === 'radio') {
    // Team Radio text (D-M7): the sender's team + the host — the
    // other team never receives it. In the lobby nobody has a team
    // yet, so the message goes to the whole lobby (that is the lobby
    // radio). Unlike signal/pin, a null team here must NOT collapse
    // to host-only, or the lobby radio would reach one seat.
    const sender = s.players.find((p) => p.playerId === senderId);
    const team = sender?.team ?? null;
    if (team === null) return new Set(allPlayers);
    return new Set(allPlayers.filter((id) => {
      const p = s.players.find((x) => x.playerId === id)!;
      return p.isHost || p.team === team;
    }));
  }
  if (msg.type === 'voice.signal') {
    // Voice (D-M1) is UNICAST, not team broadcast: exactly the named
    // recipient — and deliberately NOT the host. The DO handler
    // (room-do.ts) already verified sender and recipient share a team;
    // this fan-out must not widen it to the team or the host, or the
    // other team's host would hear the signalling (and learn who is
    // talking to whom). A signal to a seat with no live socket simply
    // reaches nobody.
    const to = (msg.payload as { toPlayerId?: string }).toPlayerId;
    return new Set(allPlayers.filter((id) => id === to));
  }
  if (msg.type === 'ping') {
    // WIRING 2026-11-17: a scheduled ping is a coarse Runner area for
    // HUNTERS only (plus the host, who sees everything). Runners must
    // never receive another Runner's ping — the alarm generates them,
    // this filter keeps them off the wrong sockets.
    const ping = (msg.payload as { ping: { subjectPlayerId: string } }).ping;
    return new Set(allPlayers.filter((id) => {
      const p = s.players.find((x) => x.playerId === id)!;
      return p.isHost || p.matchRole === 'hunter';
    }).filter((id) => id !== ping.subjectPlayerId));
  }
  return 'all';
}

const DIRECT_TYPES = new Set(['error', 'heartbeat.ack', 'snapshot', 'welcome', 'auth.refreshed', 'ticket.renewal-required']);

/**
 * Durable Object per active room — authoritative engine + WS fan-out.
 *
 * The DO is the SOLE authority for active gameplay: presence, match
 * state, timers, teams, ping distribution, catch confirmation, zone
 * transitions, completion (founder-approved final stack, 2026-11-17).
 * State lives in memory while hot and in `ctx.storage` (redacted
 * snapshot — no raw coordinates, no token hashes) across hibernation;
 * on wake it is recovered with `recoverState` (players suspended +
 * location unknown until a fresh foreground fix arrives).
 *
 * Ops (called by the Worker entry over internal fetch):
 *   create { room, host, hostTokenHash } — initialise a room + host
 *     seat + the host token hash (Worker 5, SEC-06)
 *   add-player { displayName, kind, reconnectToken? } — join
 *     (restores on duplicate display name ONLY with the seat's
 *     reconnect token — SEC-06; new seats are never host — SEC-03)
 *   start { actorId }            — HEAD_START + startedAt/endsAt
 *   verify-host-token { playerId, token } — read-only host-token check
 *   issue-host-token { playerId, reconnectToken } — mint/rotate the
 *     host token for the current host seat (Worker 5)
 *   transfer-host { actorId, newHostPlayerId } — explicit host
 *     transfer; the old host's token entry is deleted (Worker 5)
 *   update-config { actorId, config } — host-only LOBBY settings
 *   remove-player { actorId, targetPlayerId } — host-only LOBBY removal
 *   regenerate-code { actorId, roomCode } — host-only LOBBY code change (D-M2)
 *   unregister-code { roomCode, roomId } — index only: drop an old code mapping (D-M2)
 *   resolve-catch { catchId, actorId, decision } — host resolves a
 *     disputed catch (Worker 5)
 *   lifecycle { action, playerId } — start/pause/resume/end over REST
 *     (Worker 5; pause/resume reuse the WS handler)
 *   get-state { playerId, token } — recipient-filtered snapshot;
 *     the seat's reconnect token is verified by the DO itself
 *     (SEC-10 defence in depth; the Worker verified it first)
 *   register-ticket { ticketId, hash, roomId, playerId, purpose,
 *     expiresAtMs } — register a Worker-issued ticket (SEC-11) so
 *     the DO can validate renewals and the handshake itself
 *   register-code { roomCode, roomId } / lookup-code { roomCode } —
 *     the code → roomId INDEX, served by the singleton index
 *     instance (idFromName('pakdam:code-index')); handled before the
 *     room-state load, stored under a separate key (Worker F)
 *   ws (WebSocket upgrade)      — the Worker validates the ticket
 *     first and forwards the upgrade with x-pakdam-player-id /
 *     x-pakdam-ticket-id / x-pakdam-ticket-expires headers; the DO
 *     re-validates the ticket against its registry (SEC-11).
 *
 * Supabase (Worker 5): match results, catches and safety events are
 * persisted best-effort via ctx.waitUntil when the bindings exist —
 * a Supabase failure never fails a game request, and the DO stays
 * the authority. Raw coordinates and raw tokens are never persisted.
 *
 * Alarm: `alarmTick` (room-do.ts) is the timer authority — head-start
 * flip, match end, 30-second outside-zone ejection, zone shrink.
 * This class persists after every mutation and re-arms the alarm.
 */
export class RoomDurableObject extends DurableObject<RoomDoEnv> {
  private state: RoomDoState | null = null;
  /** Raw one-time catch tokens, in memory only (never persisted,
   *  never logged): catchId → { token, runnerPlayerId }. */
  private pendingTokens = new Map<string, { token: string; runnerPlayerId: string }>();

  constructor(ctx: DurableObjectState, env: RoomDoEnv) {
    super(ctx, env);
  }

  private async load(): Promise<RoomDoState | null> {
    if (this.state) return this.state;
    const saved = await this.ctx.storage.get<RoomDoState>(STATE_KEY);
    if (!saved) return null;
    this.state = recoverState(saved as never);
    return this.state;
  }

  private async persist(): Promise<void> {
    if (!this.state) return;
    await this.ctx.storage.put(STATE_KEY, snapshotForRecovery(this.state));
  }

  private async armAlarm(delayMs: number | null): Promise<void> {
    if (delayMs === null) return;
    await this.ctx.storage.setAlarm(Date.now() + delayMs);
  }

  /** Best-effort Supabase persistence (Worker 5) for one mutation.
   *  `prev` is the state before the mutation, `next` after it,
   *  `replies` the messages the mutation produced. Every write is
   *  fire-and-forget via ctx.waitUntil and returns false (never
   *  throws) when Supabase is unconfigured or unreachable — the DO
   *  stays the authority and a persistence failure never fails the
   *  game request. Persisted: rooms.result on a terminal transition
   *  (COMPLETED/CANCELLED with a result), catches on request and on
   *  every state change, safety_events on SOS / pause / resume.
   *  NEVER persisted: raw coordinates, raw tokens, WS tickets,
   *  pending pings, or the host-token hash. */
  private persistAfterMutation(prev: RoomDoState, next: RoomDoState, replies: WsServerMessage[]): void {
    if (next.room.result && prev.room.phase !== next.room.phase
      && (next.room.phase === 'COMPLETED' || next.room.phase === 'CANCELLED')) {
      this.ctx.waitUntil(persistMatchResult(this.env, next.room));
    }
    for (const reply of replies) {
      if (reply.type === 'catch.requested' || reply.type === 'catch.confirmed'
        || reply.type === 'catch.disputed' || reply.type === 'catch.rejected'
        || reply.type === 'catch.expired') {
        const c = next.catches.find((x) => x.catchId === (reply.payload as { catch: { catchId: string } }).catch.catchId);
        if (!c) continue;
        this.ctx.waitUntil(reply.type === 'catch.requested' ? persistCatchInsert(this.env, c) : persistCatchUpdate(this.env, c));
      } else if (reply.type === 'sos.raised') {
        const byPlayerId = (reply.payload as { byPlayerId: string }).byPlayerId;
        this.ctx.waitUntil(persistSafetyEvent(this.env, next.room.roomId, byPlayerId, 'sos', null));
      } else if (reply.type === 'safety.paused') {
        const byPlayerId = (reply.payload as { byPlayerId: string }).byPlayerId;
        const reason = (reply.payload as { reason: string | null }).reason ?? null;
        this.ctx.waitUntil(persistSafetyEvent(this.env, next.room.roomId, byPlayerId, 'safety-pause', reason));
      } else if (reply.type === 'safety.resumed') {
        const byPlayerId = (reply.payload as { byPlayerId: string }).byPlayerId;
        this.ctx.waitUntil(persistSafetyEvent(this.env, next.room.roomId, byPlayerId, 'safety-resume', null));
      }
    }
  }

  /** Start a match (shared by the `start` op and the `lifecycle`
   *  op's 'start' action): host-only + GL-03 rules via startMatch,
   *  then persist, arm the 1 s alarm, and broadcast room.state +
   *  match.started. Returns the HTTP response for the op. */
  private async runStart(state: RoomDoState, actorId: string, nowMs: number): Promise<Response> {
    const started = startMatch(state, actorId, nowMs);
    if (!started.ok) return new Response(started.error, { status: 409 });
    this.state = started.state;
    const startedAt = this.state.room.startedAt!;
    const endsAt = this.state.room.endsAt!;
    await this.persist();
    await this.armAlarm(1000);
    const startedRoom = this.state;
    await this.broadcast({
      v: 1, type: 'room.state', roomId: startedRoom.room.roomId, eventId: globalThis.crypto.randomUUID(),
      serverSeq: startedRoom.serverSeq, serverTs: nowMs,
      payload: { phase: 'HEAD_START', version: startedRoom.room.version, serverSeq: startedRoom.serverSeq, reason: 'match-started' },
    });
    await this.broadcast({
      v: 1, type: 'match.started', roomId: startedRoom.room.roomId, eventId: globalThis.crypto.randomUUID(),
      serverSeq: startedRoom.serverSeq, serverTs: nowMs,
      payload: { result: null, serverSeq: startedRoom.serverSeq },
    });
    return Response.json({ ok: true, phase: 'HEAD_START', startedAt, endsAt });
  }

  private async broadcast(msg: WsServerMessage, senderId: string | null = null): Promise<void> {
    if (!this.state) return;
    const recipients = broadcastRecipients(msg, this.state, senderId);
    // PERF (QA 2026-11-17): serialise ONCE per broadcast, not once per
    // recipient. The old loop called JSON.stringify(msg) inside the
    // per-socket loop, so one location.update fanned out to 30 sockets
    // paid 30 serialisations of the same message (measured: 266.6 ms
    // per 1000 fan-outs at 30 recipients vs 1.1 ms stringify-once).
    // Every recipient gets the identical bytes; behaviour is unchanged.
    const serialised = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as { playerId: string } | null;
      if (!att) continue;
      if (recipients !== 'all' && !recipients.has(att.playerId)) continue;
      try { ws.send(serialised); } catch { /* socket gone — close handler cleans up */ }
    }
  }

  private async sendTo(playerId: string, msg: WsServerMessage): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as { playerId: string } | null;
      if (att?.playerId === playerId) {
        try { ws.send(JSON.stringify(msg)); } catch { /* socket gone */ }
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    // WebSocket upgrade (forwarded by the Worker after ticket validation).
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const playerId = request.headers.get('x-pakdam-player-id');
      const ticketId = request.headers.get('x-pakdam-ticket-id');
      const ticketExpiresAtMs = Number(request.headers.get('x-pakdam-ticket-expires') ?? '');
      if (!playerId || !ticketId) return new Response('missing seat headers', { status: 400 });
      const state = await this.load();
      if (!state) return new Response('room not found', { status: 404 });
      // SEC-11: the DO validates the handshake ticket itself — the
      // forwarded ticketId must resolve to a registered, UNREDEEMED,
      // unexpired record for this room + seat (the Worker registered
      // it when it issued the ticket and redeemed its own copy
      // first). This is the second layer behind the Worker's 4401
      // check: a ticket that was never issued, was issued for another
      // room/seat, has expired, or was already used never opens a
      // socket here. The DO marks its copy redeemed too, so a
      // replayed upgrade fails even if the Worker check is ever
      // bypassed.
      const rec = (state.wsTickets ?? []).find((r) => r.ticketId === ticketId);
      if (!rec || rec.roomId !== state.room.roomId || rec.playerId !== playerId
        || rec.purpose !== 'connect' || rec.status !== 'valid' || Date.now() > rec.expiresAtMs) {
        return new Response('WS ticket is not valid for this room and seat', { status: 4401 });
      }
      this.state = markWsTicketRedeemed(state, ticketId).state;
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({
        playerId, ticketId,
        ticketExpiresAtMs: Number.isFinite(ticketExpiresAtMs) ? ticketExpiresAtMs : rec.expiresAtMs,
        renewalWarned: false,
      });
      const nowMs = Date.now();
      server.send(JSON.stringify({
        v: 1, type: 'welcome', roomId: state.room.roomId,
        eventId: globalThis.crypto.randomUUID(), serverSeq: state.serverSeq, serverTs: nowMs,
        payload: { playerId, serverSeq: state.serverSeq, serverTs: nowMs, protocolVersion: 1 },
      } satisfies WsServerMessage));
      server.send(JSON.stringify(buildWsSnapshot(state, playerId, nowMs)));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
    let body: Record<string, unknown>;
    try { body = await request.json() as Record<string, unknown>; } catch { return new Response('invalid JSON', { status: 400 }); }
    const op = body['op'];
    const nowMs = Date.now();

    // Code → roomId index ops (Worker F, 2026-11-17). Handled BEFORE
    // the room-state load below: the singleton index instance holds
    // NO room state (load() returns null there), and the map lives
    // under CODE_INDEX_KEY, not STATE_KEY. Only the Worker calls
    // these ops, and only on the index stub
    // (idFromName(CODE_INDEX_DO_NAME)) — a room stub would carry a
    // different (empty) map, so a mis-addressed call can never
    // corrupt a room or answer a lookup for one. The map holds ONLY
    // code → roomId: the lookup answer cannot leak a player list,
    // config, tokens or location, because none of those exist here.
    if (op === 'register-code') {
      const roomCode = body['roomCode'];
      const roomId = body['roomId'];
      if (typeof roomCode !== 'string' || !isValidRoomCode(roomCode)
        || typeof roomId !== 'string' || roomId.length === 0) {
        return new Response('roomCode (6 chars A-Z0-9) + roomId required', { status: 400 });
      }
      const index = (await this.ctx.storage.get<CodeIndex>(CODE_INDEX_KEY)) ?? {};
      const registered = registerRoomCode(index, roomCode, roomId);
      if (registered.conflict) {
        return new Response('room code already registered to another room', { status: 409 });
      }
      await this.ctx.storage.put(CODE_INDEX_KEY, registered.index);
      return Response.json({ ok: true, roomCode, roomId });
    }

    if (op === 'lookup-code') {
      const roomCode = body['roomCode'];
      if (typeof roomCode !== 'string' || !isValidRoomCode(roomCode)) {
        return new Response('roomCode must be 6 characters A-Z0-9', { status: 400 });
      }
      const index = (await this.ctx.storage.get<CodeIndex>(CODE_INDEX_KEY)) ?? {};
      const roomId = lookupRoomCode(index, roomCode);
      if (!roomId) return new Response('unknown room code', { status: 404 });
      return Response.json({ ok: true, roomId });
    }

    if (op === 'unregister-code') {
      // D-M2 regenerate: drop the OLD code → roomId mapping, but
      // only when it names THIS room (unregisterRoomCode is a no-op
      // otherwise, so a mis-addressed call can never steal another
      // room's code). The old code stops working even if this call
      // never lands — joins verify the code against the room's
      // roomCode — but unregistering keeps the lookup honest too.
      const roomCode = body['roomCode'];
      const roomId = body['roomId'];
      if (typeof roomCode !== 'string' || !isValidRoomCode(roomCode)
        || typeof roomId !== 'string' || roomId.length === 0) {
        return new Response('roomCode (6 chars A-Z0-9) + roomId required', { status: 400 });
      }
      const index = (await this.ctx.storage.get<CodeIndex>(CODE_INDEX_KEY)) ?? {};
      await this.ctx.storage.put(CODE_INDEX_KEY, unregisterRoomCode(index, roomCode, roomId));
      return Response.json({ ok: true, roomCode, roomId });
    }

    if (op === 'create') {
      const room = body['room'] as Room | undefined;
      const host = body['host'] as Player | undefined;
      const hostTokenHash = body['hostTokenHash'];
      if (!room || !host) return new Response('room + host required', { status: 400 });
      // SECURITY (QA 2026-11-17, SEC-08): the `create` op previously
      // accepted any caller-supplied room + host verbatim — no room-code
      // format, no host binding, no config validation. A caller could
      // create a room with an arbitrary code, a host seat that is not
      // the room's host, or an out-of-range config (e.g. maxPlayers far
      // above 30). All three are now checked; the Worker/DO is the
      // authority, never the caller's claim.
      // Worker 5 (SEC-06): the host token hash is REQUIRED — a room
      // without one would have no host authority at all. Only the
      // hash is stored (state.hostTokens); the raw token was already
      // returned once to the host by the Worker.
      if (typeof hostTokenHash !== 'string' || hostTokenHash.length === 0) {
        return new Response('hostTokenHash required', { status: 400 });
      }
      if (typeof room.roomCode !== 'string' || !isValidRoomCode(room.roomCode)) {
        return new Response('roomCode must be 6 characters A-Z0-9', { status: 400 });
      }
      if (!host.isHost || host.playerId !== room.hostPlayerId || host.roomId !== room.roomId) {
        return new Response('host seat must be the room host', { status: 400 });
      }
      const configErrors = validateRoomConfig(room.config);
      if (configErrors.length > 0) {
        return new Response(`invalid room config: ${configErrors.join('; ')}`, { status: 400 });
      }
      const initial: RoomDoState = {
        room, players: [host], latestFix: {}, outsideSinceMs: {}, outsideAccumMs: {},
        lastZoneBoundary: null, gameEventLog: [], pendingPings: [], catches: [],
        activeCatchIds: [], lastPingAtMs: {}, hostTokens: { [host.playerId]: hostTokenHash as string },
        serverSeq: 1, paused: false, pausedBy: null, pausedFrom: null, sosActive: false,
        eventLog: [], idempotency: [], wsTickets: [], wsRate: {},
      };
      this.state = logGameEvent(initial, createGameEvent('PLAYER_JOINED', room.roomId, host.playerId, {
        displayName: host.displayName, kind: host.kind,
      }));
      await this.persist();
      await this.armAlarm(30_000);
      return Response.json({ ok: true, roomId: room.roomId, roomCode: room.roomCode });
    }

    const state = await this.load();
    if (!state) return new Response('room not found', { status: 404 });

    if (op === 'add-player') {
      const displayName = body['displayName'];
      const kind = body['kind'];
      const reconnectToken = typeof body['reconnectToken'] === 'string' ? body['reconnectToken'] as string : undefined;
      // SECURITY (QA 2026-11-17, SEC-03/04/05): the display name is
      // validated server-side here (400 before addPlayer's own throw);
      // `isHost` from the caller is IGNORED entirely — new seats are
      // never host (addPlayer no longer takes an isHost argument; a
      // restore keeps the seat's existing flag). The room-full check
      // and the LOBBY phase check apply to NEW joins only: restoring
      // an existing seat is a resume, so it bypasses both, matching
      // the demo store.
      // Worker 5 (SEC-06): a RESTORE requires the seat's reconnect
      // token — addPlayer throws FORBIDDEN without it (or with a
      // wrong one), mapped to 403 here. A NEW join needs no token.
      if (typeof displayName !== 'string' || !isValidDisplayName(displayName) || (kind !== 'guest' && kind !== 'host-account')) {
        return new Response('displayName (1–30 chars, no URL) + kind required', { status: 400 });
      }
      const restoring = state.players.some(
        (p) => p.displayName.trim().toLowerCase() === (displayName as string).trim().toLowerCase(),
      );
      if (!restoring) {
        if (state.room.phase !== 'LOBBY') {
          return new Response(`room is not open for joining while the match is ${state.room.phase}`, { status: 409 });
        }
        if (state.players.filter((p) => !p.leftAt).length >= state.room.config.maxPlayers) {
          return new Response('room is full', { status: 409 });
        }
      }
      let result: ReturnType<typeof addPlayer>;
      try {
        result = addPlayer(state, displayName, kind, nowMs, { reconnectToken });
      } catch (e) {
        const message = e instanceof Error ? e.message : 'join failed';
        if (message.startsWith('FORBIDDEN')) return new Response(message, { status: 403 });
        if (message.startsWith('VALIDATION_FAILED')) return new Response(message, { status: 400 });
        if (message.startsWith('INVALID_STATE')) return new Response(message, { status: 409 });
        return new Response(message, { status: 400 });
      }
      this.state = result.state;
      await this.persist();
      await this.broadcast(result.message);
      // The raw reconnect token goes back ONLY in this HTTPS response
      // (once, to the joining seat) — never in a broadcast, never logged.
      const { reconnectTokenHash: _hash, ...playerView } = result.player;
      return Response.json({ ok: true, player: playerView, reconnectToken: result.reconnectToken, restored: result.restored });
    }

    if (op === 'start') {
      // SECURITY (QA 2026-11-17, SEC-09): the match may be started ONLY
      // by the host seat. The previous code defaulted a missing actorId
      // to the host (`actorId ?? hostPlayerId`), so ANY caller that
      // omitted actorId started the match as the host. A missing or
      // non-host actorId is now 403. (The Worker also verifies the
      // host token first — this is the second layer, Worker 5.)
      const actorId = body['actorId'];
      if (typeof actorId !== 'string' || actorId !== state.room.hostPlayerId) {
        return new Response('only the host may start the match', { status: 403 });
      }
      // QA 2026-11-17 (GL-03): the old code jumped LOBBY -> HEAD_START
      // directly — an illegal transition that threw INVALID_STATE, with
      // no role assignment, no minimum-player check and no ready check.
      // startMatch (room-do.ts, pure + unit-tested) enforces all of
      // them and walks LOBBY -> READY_CHECK -> COUNTDOWN -> HEAD_START.
      // Shared with the `lifecycle` op's 'start' action (runStart).
      return this.runStart(state, actorId, nowMs);
    }

    if (op === 'verify-host-token') {
      // Read-only: does the presented raw host token belong to the
      // CURRENT host seat? The hash in state.hostTokens is compared
      // — the raw token is never stored or logged. The Worker calls
      // this before every host-only action (start, config,
      // remove-player, transfer, resolve, lifecycle start/resume/
      // end). No state change. (Worker 5, SEC-06.)
      const playerId = body['playerId'];
      const token = body['token'];
      if (typeof playerId !== 'string' || typeof token !== 'string') {
        return new Response('playerId + token required', { status: 400 });
      }
      return Response.json({ ok: verifyHostToken(state, playerId, token) });
    }

    if (op === 'issue-host-token') {
      // Mint (or rotate) the host token for the CURRENT host seat.
      // The caller proves the host seat with their reconnect token
      // first — the DO verifies it against the stored hash AND that
      // the seat isHost. The raw token is returned ONCE in this
      // response; only its hash is stored (state.hostTokens). A
      // rotation replaces the previous hash, so a leaked old host
      // token dies. 403 when the seat is not the host or the
      // reconnect token does not match — deliberately one message
      // for both, so the response never says which check failed.
      // (Worker 5, SEC-06.)
      const playerId = body['playerId'];
      const reconnectToken = body['reconnectToken'];
      if (typeof playerId !== 'string' || typeof reconnectToken !== 'string') {
        return new Response('playerId + reconnectToken required', { status: 400 });
      }
      const player = state.players.find((p) => p.playerId === playerId);
      if (!player || !player.isHost
        || sha256Hex(reconnectToken) !== player.reconnectTokenHash) {
        return new Response('only the host seat may hold a host token', { status: 403 });
      }
      const issued = issueHostToken(state, playerId);
      if (!issued.ok) return new Response(issued.error, { status: 403 });
      this.state = issued.state;
      await this.persist();
      return Response.json({ ok: true, hostToken: issued.token });
    }

    if (op === 'transfer-host') {
      // Explicit host transfer (Worker 5). The DO enforces
      // host-only + successor-in-room; the old host's token entry
      // is deleted by transferHost, and the successor holds NO host
      // token until they call issue-host-token. Broadcasts
      // host.transferred so every client re-renders the host.
      const actorId = body['actorId'];
      const newHostPlayerId = body['newHostPlayerId'];
      if (typeof actorId !== 'string' || typeof newHostPlayerId !== 'string') {
        return new Response('actorId + newHostPlayerId required', { status: 400 });
      }
      const transferred = transferHost(state, actorId, newHostPlayerId, nowMs);
      if (!transferred.ok) {
        const status = transferred.error.startsWith('only the host') ? 403 : 400;
        return new Response(transferred.error, { status });
      }
      this.state = transferred.state;
      await this.persist();
      await this.broadcast(transferred.message);
      return Response.json({ ok: true, newHostPlayerId });
    }

    if (op === 'resolve-catch') {
      // Host resolves a disputed catch (Worker 5). The DO enforces
      // host-only + catch-must-be-disputed; a confirm applies the
      // mode/win rules, a reject voids the claim. Broadcasts
      // catch.confirmed / catch.rejected (+ match.completed when the
      // confirm ends the match) and persists the catch row.
      const catchId = body['catchId'];
      const actorId = body['actorId'];
      const decision = body['decision'];
      if (typeof catchId !== 'string' || typeof actorId !== 'string'
        || (decision !== 'confirmed' && decision !== 'rejected')) {
        return new Response('catchId + actorId + decision (confirmed|rejected) required', { status: 400 });
      }
      const resolved = resolveDisputedCatch(state, catchId, actorId, decision, nowMs);
      if (!resolved.ok) {
        const status = resolved.error.startsWith('only the host') ? 403
          : resolved.error.startsWith('unknown catchId') ? 404 : 409;
        return new Response(resolved.error, { status });
      }
      const prev = state;
      this.state = resolved.state;
      await this.persist();
      for (const msg of resolved.messages) await this.broadcast(msg);
      this.persistAfterMutation(prev, resolved.state, resolved.messages);
      const { qrTokenHash: _hash, ...catchView } = resolved.catch;
      return Response.json({ ok: true, catch: catchView });
    }

    if (op === 'lifecycle') {
      // Match lifecycle over REST (Worker 5). start/resume/end are
      // host-only (the Worker verified the host token first; the DO
      // re-checks actorId === host here). pause is any player (the
      // Worker verified the reconnect token first). pause/resume are
      // delegated to the WS handler with a server-generated commandId
      // — the same server-authoritative validation as the §3.3
      // messages — and the replies are broadcast like WS replies.
      const action = body['action'];
      const playerId = body['playerId'];
      if (typeof action !== 'string' || typeof playerId !== 'string') {
        return new Response('action + playerId required', { status: 400 });
      }
      if (action === 'start') {
        if (playerId !== state.room.hostPlayerId) {
          return new Response('only the host may start the match', { status: 403 });
        }
        return this.runStart(state, playerId, nowMs);
      }
      if (action === 'pause' || action === 'resume') {
        const type = action === 'pause' ? 'safety.pause' : 'safety.resume';
        const payload = action === 'pause' ? { reason: null } : {};
        const handled = handleWsClientMessage(state, playerId, {
          v: 1, type, commandId: globalThis.crypto.randomUUID(), payload,
        }, nowMs);
        const first = handled.replies[0];
        if (first?.type === 'error') {
          const code = (first.payload as { code?: string }).code ?? 'VALIDATION_FAILED';
          const status = code === 'FORBIDDEN' ? 403 : code === 'INVALID_STATE' ? 409 : 400;
          return new Response(code, { status });
        }
        const prev = state;
        this.state = handled.state;
        await this.persist();
        for (const reply of handled.replies) await this.broadcast(reply, playerId);
        this.persistAfterMutation(prev, handled.state, handled.replies);
        return Response.json({ ok: true, phase: this.state.room.phase, serverSeq: this.state.serverSeq });
      }
      if (action === 'end') {
        if (playerId !== state.room.hostPlayerId) {
          return new Response('only the host may end the match', { status: 403 });
        }
        const ended = endMatch(state, playerId, nowMs);
        if (!ended.ok) {
          const status = ended.error.startsWith('only the host') ? 403 : 409;
          return new Response(ended.error, { status });
        }
        const prev = state;
        this.state = ended.state;
        await this.persist();
        for (const msg of ended.messages) await this.broadcast(msg);
        this.persistAfterMutation(prev, ended.state, ended.messages);
        return Response.json({ ok: true, phase: 'CANCELLED', result: this.state.room.result });
      }
      return new Response(`unknown lifecycle action: ${action}`, { status: 400 });
    }

    if (op === 'verify-code') {
      // Read-only: does the presented room code match this room?
      // The Worker calls this before forwarding a join, so a guest
      // must know the code, not just the roomId. No state change;
      // the code itself is never logged.
      const roomCode = body['roomCode'];
      if (typeof roomCode !== 'string') return new Response('roomCode required', { status: 400 });
      return Response.json({ ok: roomCode === state.room.roomCode });
    }

    if (op === 'verify-reconnect') {
      // Read-only: does the presented raw reconnect token belong to
      // this seat? The hash on the player record is compared — the
      // raw token is never stored or logged. The Worker calls this
      // before issuing a WS ticket for the seat. No state change.
      const playerId = body['playerId'];
      const token = body['token'];
      if (typeof playerId !== 'string' || typeof token !== 'string') {
        return new Response('playerId + token required', { status: 400 });
      }
      const player = state.players.find((p) => p.playerId === playerId);
      return Response.json({ ok: player !== undefined && sha256Hex(token) === player.reconnectTokenHash });
    }

    if (op === 'get-state') {
      const playerId = body['playerId'];
      const token = body['token'];
      if (typeof playerId !== 'string') return new Response('playerId required', { status: 400 });
      // SEC-10 (2026-11-17): defence in depth — the Worker already
      // verified this seat's reconnect token before forwarding, but
      // the DO checks it itself too, so a snapshot can never leave
      // this room on a playerId alone. 403 on a missing/wrong token,
      // 404 when the playerId is not a seat (SEC-02, IDOR guard).
      if (typeof token !== 'string' || !verifyReconnectToken(state, playerId, token)) {
        return new Response('reconnect token does not match this seat', { status: 403 });
      }
      const snap = snapshotForPlayer(state, playerId);
      if (!snap) return new Response('not a player in this room', { status: 404 });
      return Response.json(snap);
    }

    if (op === 'register-ticket') {
      // SEC-11: the Worker registers every ticket it issues (hash
      // only) so the DO can validate `auth.refresh` renewals and
      // check the handshake ticket on upgrade. Internal op — the
      // Worker is the only caller. No state is persisted for this
      // (wsTickets are memory-only by design), and the record is
      // never returned to any client.
      const ticketId = body['ticketId'];
      const hash = body['hash'];
      const ticketRoomId = body['roomId'];
      const ticketPlayerId = body['playerId'];
      const purpose = body['purpose'];
      const expiresAtMs = body['expiresAtMs'];
      if (typeof ticketId !== 'string' || typeof hash !== 'string' || typeof ticketPlayerId !== 'string'
        || ticketRoomId !== state.room.roomId || (purpose !== 'connect' && purpose !== 'renew')
        || typeof expiresAtMs !== 'number') {
        return new Response('ticketId + hash + roomId + playerId + purpose + expiresAtMs required', { status: 400 });
      }
      this.state = registerWsTicket(state, {
        ticketId, hash, roomId: state.room.roomId, playerId: ticketPlayerId,
        purpose, issuedAtMs: nowMs, expiresAtMs, status: 'valid',
      });
      return Response.json({ ok: true, ticketId });
    }

    if (op === 'update-config') {
      // WIRING 2026-11-17: host changes the lobby settings (mode,
      // teams, Hunters picked, timings, zone rules). Host-only,
      // LOBBY-only; the full new config is re-validated. Mirrors the
      // demo store's updateRoomConfig: changing the Hunter count or
      // the team assignment clears any host-picked Hunters (the old
      // pick may no longer hold the right number). Broadcasts
      // room.state so every lobby client re-renders from the server.
      // (Worker 5: the rules now live in the pure updateRoomConfig,
      // room-do.ts — this op is the thin DO-class wrapper around it.)
      const actorId = body['actorId'];
      const config = body['config'] as Room['config'] | undefined;
      if (typeof actorId !== 'string' || actorId !== state.room.hostPlayerId) {
        return new Response('only the host may change the settings', { status: 403 });
      }
      if (state.room.phase !== 'LOBBY') {
        return new Response('settings can only be changed in the lobby', { status: 409 });
      }
      if (!config) return new Response('config required', { status: 400 });
      const updated = updateRoomConfig(state, actorId, config);
      if (!updated.ok) return new Response(updated.error, { status: 409 });
      this.state = updated.state;
      await this.persist();
      await this.broadcast({
        v: 1, type: 'room.state', roomId: state.room.roomId, eventId: globalThis.crypto.randomUUID(),
        serverSeq: this.state.serverSeq, serverTs: nowMs,
        payload: { phase: this.state.room.phase, version: this.state.room.version, serverSeq: this.state.serverSeq, reason: 'config-updated' },
      });
      return Response.json({ ok: true, room: this.state.room });
    }

    if (op === 'remove-player') {
      // WIRING 2026-11-17: host removes a player from the LOBBY.
      // Host-only, LOBBY-only, never the host seat. The seat is
      // marked left (same as leave) and a player.removed broadcast
      // goes out; the player can rejoin with the room code.
      const actorId = body['actorId'];
      const targetPlayerId = body['targetPlayerId'];
      if (typeof actorId !== 'string' || actorId !== state.room.hostPlayerId) {
        return new Response('only the host may remove a player', { status: 403 });
      }
      if (state.room.phase !== 'LOBBY') {
        return new Response('players can only be removed in the lobby', { status: 409 });
      }
      if (typeof targetPlayerId !== 'string') return new Response('targetPlayerId required', { status: 400 });
      const target = state.players.find((p) => p.playerId === targetPlayerId);
      if (!target) return new Response('player not in this room', { status: 404 });
      if (target.isHost) return new Response('the host cannot be removed', { status: 409 });
      if (target.leftAt) return new Response('player already left', { status: 409 });
      const removedAt = new Date(nowMs).toISOString();
      this.state = {
        ...state,
        players: state.players.map((p) => (p.playerId === targetPlayerId
          ? { ...p, leftAt: removedAt, connectionState: 'disconnected' as const } : p)),
        serverSeq: state.serverSeq + 1,
      };
      await this.persist();
      const { reconnectTokenHash: _hash, ...view } = { ...target, leftAt: removedAt, connectionState: 'disconnected' as const };
      await this.broadcast({
        v: 1, type: 'player.removed', roomId: state.room.roomId, eventId: globalThis.crypto.randomUUID(),
        serverSeq: this.state.serverSeq, serverTs: nowMs,
        payload: { player: view, serverSeq: this.state.serverSeq },
      });
      return Response.json({ ok: true });
    }

    if (op === 'regenerate-code') {
      // D-M2: host regenerates the room code from the lobby. The
      // Worker generated the new code and already registered it in
      // the code index for this room before calling, so this op only
      // swaps it into the room (pure regenerateRoomCode: host-only,
      // LOBBY-only, shape + differs-from-current). Broadcasts
      // room.state so every lobby client re-renders with the new
      // code — the old code is dead from this moment (joins verify
      // against room.roomCode), and the Worker unregisters the old
      // index mapping right after.
      const actorId = body['actorId'];
      const roomCode = body['roomCode'];
      if (typeof actorId !== 'string' || actorId !== state.room.hostPlayerId) {
        return new Response('only the host may change the room code', { status: 403 });
      }
      if (typeof roomCode !== 'string') return new Response('roomCode required', { status: 400 });
      const regenerated = regenerateRoomCode(state, actorId, roomCode);
      if (!regenerated.ok) {
        const status = regenerated.error.startsWith('only the host') ? 403
          : regenerated.error.startsWith('room code can only change') ? 409 : 400;
        return new Response(regenerated.error, { status });
      }
      this.state = regenerated.state;
      await this.persist();
      await this.broadcast({
        v: 1, type: 'room.state', roomId: state.room.roomId, eventId: globalThis.crypto.randomUUID(),
        serverSeq: this.state.serverSeq, serverTs: nowMs,
        payload: { phase: this.state.room.phase, version: this.state.room.version, serverSeq: this.state.serverSeq, reason: 'code-regenerated' },
      });
      return Response.json({ ok: true, roomCode: regenerated.newRoomCode, oldRoomCode: regenerated.oldRoomCode });
    }

    if (op === 'get-catch-token') {
      const catchId = body['catchId'];
      const playerId = body['playerId'];
      if (typeof catchId !== 'string' || typeof playerId !== 'string') return new Response('catchId + playerId required', { status: 400 });
      const entry = this.pendingTokens.get(catchId);
      const c = state.catches.find((x) => x.catchId === catchId);
      if (!entry || !c || c.runnerPlayerId !== playerId || (c.state !== 'requested' && c.state !== 'awaiting-confirmation')) {
        return new Response('no token for this catch and seat', { status: 404 });
      }
      // Worker 5 (BE-BK-02 contract): the Runner's client needs to
      // know when the token dies — expiresAt is requestedAt +
      // catchTokenTtlSeconds (120 s, CALIBRATION_OPEN, placeholder).
      const expiresAt = new Date(Date.parse(c.requestedAt) + CALIBRATION_OPEN.catchTokenTtlSeconds * 1000).toISOString();
      return Response.json({ ok: true, token: entry.token, catchId, expiresAt });
    }

    return new Response(`unknown op: ${String(op)}`, { status: 400 });
  }

  async alarm(): Promise<void> {
    const state = await this.load();
    if (!state) return;
    const tick = alarmTick(state, Date.now());
    this.state = tick.state;
    await this.persist();
    for (const msg of tick.messages) await this.broadcast(msg);
    // Worker 5: a tick that completes the match (timer expiry, last
    // Runner ejected) persists the result best-effort.
    this.persistAfterMutation(state, tick.state, tick.messages);
    await this.armAlarm(tick.alarmDelayMs);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as { playerId: string; ticketId: string; ticketExpiresAtMs?: number; renewalWarned?: boolean } | null;
    if (!att) { ws.close(4401, 'no seat'); return; }
    const state = await this.load();
    if (!state) { ws.close(1011, 'room gone'); return; }
    // SEC-11: the socket lives only as long as its ticket. Past
    // expiry the client must fetch a fresh ticket and reconnect once
    // (4401) — a stale socket never keeps playing on an expired
    // credential. The client is warned 30 s before expiry (below),
    // so a live client renews via `auth.refresh` first.
    if (att.ticketExpiresAtMs !== undefined && Date.now() > att.ticketExpiresAtMs) {
      ws.close(4401, 'WS ticket expired — request a fresh ticket');
      return;
    }
    let raw: unknown;
    try { raw = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message)); } catch {
      ws.send(JSON.stringify({ v: 1, type: 'error', roomId: state.room.roomId, eventId: globalThis.crypto.randomUUID(), serverSeq: state.serverSeq, serverTs: Date.now(), payload: { code: 'VALIDATION_FAILED', message: 'message must be JSON', retryable: false, retryAfterSeconds: null, requestId: globalThis.crypto.randomUUID(), details: null, serverTs: Date.now() } } satisfies WsServerMessage));
      return;
    }
    // hello is validated at handshake time, before any game message.
    if ((raw as Record<string, unknown>)['type'] === 'hello') {
      const validation = validateHello(raw);
      if (!validation.ok) { ws.close(validation.code === 'PROTOCOL_UNSUPPORTED' ? 4409 : 4400, validation.message); return; }
      return;
    }
    const nowMs = Date.now();
    const result = handleWsClientMessage(state, att.playerId, raw, nowMs);
    this.state = result.state;
    // Worker 5 (SEC-06): an automatic host transfer (host `leave`)
    // reassigns isHost/hostPlayerId only — the departed host's token
    // entry must die with the transfer, and the successor holds NO
    // host token until they call issue-host-token over HTTPS. The
    // pure leave handler cannot do this (it knows nothing about
    // hostTokens), so the class strips the entry when it sees the
    // host.transferred reply. verifyHostToken would already refuse
    // the old token (it checks playerId === room.hostPlayerId), but
    // leaving a dead entry in state would be a latent hole.
    const transfer = result.replies.find((r) => r.type === 'host.transferred');
    if (transfer) {
      const prevHost = (transfer.payload as { previousHostPlayerId: string }).previousHostPlayerId;
      if (this.state.hostTokens?.[prevHost] !== undefined) {
        const hostTokens = { ...this.state.hostTokens };
        delete hostTokens[prevHost];
        this.state = { ...this.state, hostTokens };
      }
    }
    await this.persist();
    // The raw one-time catch token (catch.request) goes to the RUNNER's
    // seat only, via the get-catch-token op — never on the wire here.
    if (result.issuedCatchToken) {
      this.pendingTokens.set(result.issuedCatchToken.catchId, {
        token: result.issuedCatchToken.token,
        runnerPlayerId: result.issuedCatchToken.runnerPlayerId,
      });
    }
    for (const reply of result.replies) {
      if (DIRECT_TYPES.has(reply.type)) {
        try { ws.send(JSON.stringify(reply)); } catch { /* socket gone */ }
      } else {
        await this.broadcast(reply, att.playerId);
      }
    }
    // Re-arm the alarm after any mutation (a new outside-zone segment
    // or a head start needs the 1 s tick).
    const tick = alarmTick(this.state, Date.now());
    if (tick.messages.length > 0 || tick.state !== this.state) {
      this.state = tick.state;
      await this.persist();
      for (const msg of tick.messages) await this.broadcast(msg);
    }
    await this.armAlarm(tick.alarmDelayMs);
    // Worker 5: best-effort Supabase persistence for this mutation
    // (match completion, catch state changes, safety events) — the
    // alarm tick's own messages are included, so a win on the tick
    // is persisted too.
    this.persistAfterMutation(state, this.state, [...result.replies, ...tick.messages]);
    // SEC-11: ticket renewal, enforced here in the DO (the Worker is
    // not on the WS path, so it cannot validate `auth.refresh`).
    if (result.authRefreshFailed) {
      // A bad renewal ticket is an auth failure: close 4401 so the
      // client fetches a fresh ticket and reconnects once.
      ws.close(4401, result.authRefreshFailed.message);
      return;
    }
    if (result.authRefreshed) {
      // Swap the socket's ticket binding to the renewed ticket (new
      // expiry, warning flag reset) — the `auth.refreshed` reply was
      // already sent to the sender above (DIRECT_TYPES).
      ws.serializeAttachment({
        ...att,
        ticketId: result.authRefreshed.ticketId,
        ticketExpiresAtMs: result.authRefreshed.expiresAtMs,
        renewalWarned: false,
      });
      return;
    }
    // SEC-11: warn once when the socket's ticket expires within 30 s
    // so the client renews before the expiry close above fires.
    if (att.ticketExpiresAtMs !== undefined && !att.renewalWarned
      && ticketRenewalDue(att.ticketExpiresAtMs, Date.now())) {
      try {
        ws.send(JSON.stringify(buildRenewalRequired(state.room.roomId, new Date(att.ticketExpiresAtMs).toISOString(), Date.now())));
      } catch { /* socket gone */ }
      ws.serializeAttachment({ ...att, renewalWarned: true });
    }
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    const att = ws.deserializeAttachment() as { playerId: string } | null;
    const state = await this.load();
    if (!att || !state) return;
    const { state: suspended } = applySuspension(state, att.playerId);
    const built = buildPlayerSuspended(suspended, att.playerId, 'network-lost', Date.now());
    const withEvent = logGameEvent(built.state, createGameEvent('PLAYER_DISCONNECTED', state.room.roomId, att.playerId, {
      playerId: att.playerId, reason: 'network',
    }));
    this.state = withEvent;
    await this.persist();
    await this.broadcast(built.message, att.playerId);
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    // Treat like a close: suspend the seat so the room sees it.
    await this.webSocketClose(ws, 1011, 'error', false);
  }
}
