/**
 * WebSocket client — PROTOCOL-MAP §2 (frozen contract v2.1) + BEHAVIOUR.md §3.3.
 *
 * - Ticket first over HTTPS (`POST /v1/rooms/:id/ws-ticket`), then
 *   `wss://…/v1/rooms/{id}/ws?ticket=…` — the ticket in the query string is
 *   the ONE sanctioned exception to "never put a token in a URL".
 * - `hello` is first, carries NO credential, protocol version must be 1.
 * - Heartbeat is actually configured: `HEARTBEAT_INTERVAL_MS` (30 s, OPEN)
 *   and `HEARTBEAT_MISSED_LIMIT` (3, OPEN) from @pakdam/shared — the old
 *   build had the timer code but no caller ever passed an interval, so the
 *   heartbeat never ran (D-12). This client always starts it.
 * - Close codes follow the CONTRACT (`WS_CLOSE_CODE_ACTION`), not the old
 *   client's 4400 branch: 4400 → fresh ticket, reconnect once, AND surface
 *   the failure; 4401 → fresh ticket, reconnect once, a second 4401 → closed;
 *   1000/4403/4409 never auto-reconnect; 1001/1006/1011/4413 back off
 *   (1 s base, doubling, 30 s ceiling, jitter ×0.5–1.0).
 * - v29 (founder's 30 s rule, 2026-11-22): reconnect keeps trying until
 *   the seat's 30 s return window ends — the old "max 5 attempts, then
 *   'reconnect failed — Retry'" gave up INSIDE the window. The deadline
 *   comes from the snapshot (`reconnectEndsAtMs` for my seat, fed in by
 *   `useRoomState` via `setReconnectWindowEndsAtMs`); when no snapshot
 *   has supplied one, the fallback is 30 s from the moment this client
 *   noticed the drop. Past the deadline the socket enters
 *   'reconnect-failed' with manual Retry as before. Terminal close
 *   codes (4403 seat removed, 4409, 1000) still never auto-reconnect,
 *   window or not. A retry reuses the same `commandId` per the rule
 *   below — reconnect itself mints nothing (it only fetches a ticket).
 * - Commands sent while disconnected are discarded, never queued (R12).
 * - On tab-hide the client sends best-effort `player.suspended`
 *   ('tab-hidden'); on visible it re-requests a snapshot.
 * - The DO resumes a suspended player on hello/reconnect (P0-1) — the
 *   client only has to reconnect and re-request the snapshot.
 */
import {
  CLIENT_VERSION,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MISSED_LIMIT,
  PROTOCOL_VERSION,
  RECONNECT_BACKOFF_BASE_MS,
  RECONNECT_BACKOFF_CEILING_MS,
  RECONNECT_MAX_ATTEMPTS,
  WS_CLOSE_CODE_ACTION,
  type LocationFix,
  type SuspensionReason,
  type WsClientMessageType,
  type WsConnectionState,
  type WsErrorPayload,
  type WsServerEnvelope,
  type WsSnapshotPayload,
} from '@pakdam/shared';
import { getSessionForRoom } from './session-credentials';
import { buildLastSnapshotKey, type LastSnapshotKey } from './snapshot-key';

/**
 * WS ticket TTL (v29 R8, fix round M2): the pushed ticket's REAL TTL is
 * 60 s — a ticket used 61 s after mint is expired server-side (4401).
 * The fallback horizon for a `ticket.renewed` payload without
 * `expiresAtMs` is this same 60 s, never longer.
 */
export const WS_TICKET_TTL_MS = 60_000;

export type { WsConnectionState, WsSnapshotPayload, WsErrorPayload };

export function getWorkerUrl(): string {
  return (process.env.NEXT_PUBLIC_WORKER_URL ?? '').replace(/\/+$/, '');
}

export function isLiveTransportEnabled(): boolean {
  return getWorkerUrl().length > 0;
}

export interface WsTicketResponse {
  ok: boolean;
  ticket: string;
  ticketId: string;
  expiresAtMs: number;
}

/** Fetch a single-use WS ticket over HTTPS. The value is never logged or stored. */
export async function fetchWsTicket(
  roomId: string,
  playerId: string,
  reconnectToken: string,
  purpose: 'connect' | 'renew' = 'connect',
): Promise<WsTicketResponse> {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) throw new Error('Live transport is not configured.');
  const response = await fetch(`${workerUrl}/v1/rooms/${roomId}/ws-ticket`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId, reconnectToken, purpose }),
  });
  if (!response.ok) {
    throw new Error(`Ticket request failed (${response.status}).`);
  }
  return (await response.json()) as WsTicketResponse;
}

export interface PakdamSocketOptions {
  roomId: string;
  playerId: string;
  /** Heartbeat interval in ms. Defaults to HEARTBEAT_INTERVAL_MS (30 s, OPEN). */
  heartbeatIntervalMs?: number;
  /** Missed heartbeats before the client closes the socket. Defaults to HEARTBEAT_MISSED_LIMIT (3, OPEN). */
  heartbeatMissedLimit?: number;
  /**
   * Connect timeout in ms (v28 fix round, Diya A3): a socket stuck in
   * CONNECTING forever fires no onclose and no onerror, so without
   * this the client would hang in 'connecting' with no retry and no
   * manual Retry. On timeout the open is treated as a failed connect
   * — the existing `scheduleReconnect` path (bounded backoff, then
   * 'reconnect-failed' with manual Retry), no new UX. Defaults to
   * 15 s. Only used by tests to shorten the wait.
   */
  connectTimeoutMs?: number;
  onSnapshot: (snapshot: WsSnapshotPayload) => void;
  onServerMessage?: (envelope: WsServerEnvelope) => void;
  onStateChange?: (state: WsConnectionState, detail?: string) => void;
  onError?: (error: WsErrorPayload) => void;
}

type AnyPayload = Record<string, unknown>;

export class PakdamSocket {
  readonly roomId: string;
  readonly playerId: string;

  private ws: WebSocket | null = null;
  private state: WsConnectionState = 'idle';
  private clientSeq = 0;
  private lastServerSeq = 0;
  /**
   * v29 (R5, fix round M1) — the last applied snapshot's wire key
   * (`{ version, serverSeq, maxLastFixAtMs, epochMs }`, see
   * `snapshot-key.ts`), recorded on every `snapshot` envelope and on
   * any snapshot the page applied from its first-paint GET (via
   * `noteAppliedSnapshot`). `requestSnapshot` / `resync` send it so
   * the server can answer `snapshot.unchanged` when nothing moved.
   * Null until the first snapshot lands — then the key field is sent
   * as null and the server answers a full snapshot (safe default).
   */
  private lastSnapshotKey: LastSnapshotKey | null = null;
  private lastRetryAfterSeconds = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private leaveTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private missedHeartbeats = 0;
  private freshTicketReconnectUsed = false;
  private closedByClient = false;
  private visibilityHandler: (() => void) | null = null;
  /**
   * v29 (30 s rule) — epoch ms when this seat's return window ends.
   * Authoritative when fed from the snapshot (`setReconnectWindowEndsAtMs`,
   * `reconnectEndsAtMs` for my seat); otherwise the fallback set in
   * `handleClose` (30 s from the drop as this client saw it). Null = no
   * window known — the old max-attempts rule applies. Cleared on
   * connect / manual retry / client close.
   */
  private reconnectDeadlineMs: number | null = null;
  /**
   * v29 (R8) — a ticket the server pushed over the socket
   * (`ticket.renewed`), held for the next connect / auth.refresh with
   * NO HTTP call. Single-use: consumed (cleared) on first use.
   * `expiresAtMs` is the payload's value when present, else the
   * 60 s fallback horizon (`WS_TICKET_TTL_MS` — the pushed ticket's
   * real TTL is 1 min).
   */
  private pushedTicket: { ticket: string; expiresAtMs: number } | null = null;
  // v28 (Diya F15): bounded retries for a snapshot re-request dropped
  // while the socket was down (see attachVisibility).
  private snapshotRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotRetriesUsed = 0;
  private readonly options: Required<
    Pick<PakdamSocketOptions, 'heartbeatIntervalMs' | 'heartbeatMissedLimit' | 'connectTimeoutMs'>
  > &
    PakdamSocketOptions;

  constructor(options: PakdamSocketOptions) {
    this.roomId = options.roomId;
    this.playerId = options.playerId;
    // v29 (R10): route-change socket churn is counted, not shared away
    // — the per-round-trip count (≈ 1 ws-ticket HTTP + 1 DO register +
    // 1 hello + 1 full snapshot ≈ 4–5 requests + the snapshot payload;
    // ~30 round trips ≈ ~150 requests/game) lives as a comment at
    // socket creation in `useRoomState.ts`, which owns this socket's
    // lifecycle. A single app-level socket was judged too invasive
    // for this build (route isolation: a catch-page crash can never
    // take the play socket with it).
    this.options = {
      ...options,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
      heartbeatMissedLimit: options.heartbeatMissedLimit ?? HEARTBEAT_MISSED_LIMIT,
      connectTimeoutMs: options.connectTimeoutMs ?? 15_000,
    };
  }

  get connectionState(): WsConnectionState {
    return this.state;
  }

  get lastAppliedServerSeq(): number {
    return this.lastServerSeq;
  }

  /** The last applied snapshot's R5 wire key, or null before the first snapshot. */
  get lastAppliedSnapshotKey(): LastSnapshotKey | null {
    return this.lastSnapshotKey;
  }

  /**
   * Record a snapshot the page applied outside the socket (the
   * first-paint GET) as the key `requestSnapshot` / `resync` send.
   * Snapshots arriving over the socket are recorded in `handleMessage`
   * — this only covers the GET path, so a re-fetch after first paint
   * can already answer `snapshot.unchanged`.
   */
  noteAppliedSnapshot(snapshot: WsSnapshotPayload): void {
    this.lastSnapshotKey = buildLastSnapshotKey(snapshot);
  }

  /** Open the socket: fetch a ticket, connect, send hello. */
  async connect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') return;
    this.closedByClient = false;
    this.setState('connecting');
    try {
      await this.connectWithFreshTicket();
    } catch (error) {
      this.scheduleReconnect(
        error instanceof Error ? error.message : 'Connection failed.',
      );
    }
  }

  /** Manual retry after `reconnect-failed`: resets attempts, fetches a fresh ticket. */
  async retry(): Promise<void> {
    this.reconnectAttempts = 0;
    this.reconnectDeadlineMs = null;
    this.freshTicketReconnectUsed = false;
    this.closedByClient = false;
    await this.connect();
  }

  /**
   * v29 (30 s rule) — feed the seat's return-window deadline from the
   * snapshot (`reconnectEndsAtMs` for my seat; null when no window
   * runs). The socket's reconnect loop consults it: while the deadline
   * is in the future, reconnect keeps trying past the old max-attempts
   * cap. A deadline that arrives while the socket already sits in
   * 'reconnect-failed' (e.g. the first-paint GET landed after the cap
   * fired) resumes reconnecting at once. A null clears the deadline —
   * while connected, snapshots keep clearing it, so the fallback set
   * on disconnect survives exactly while no snapshot arrives.
   */
  setReconnectWindowEndsAtMs(endsAtMs: number | null): void {
    this.reconnectDeadlineMs = endsAtMs;
    if (
      endsAtMs !== null &&
      endsAtMs > Date.now() &&
      this.state === 'reconnect-failed' &&
      !this.closedByClient
    ) {
      this.reconnectAttempts = 0;
      this.scheduleReconnect('Return window still open — retrying.');
    }
  }

  /**
   * Clean close: plain close, NO `leave` (P0-1). The socket close only
   * suspends the seat — the player is still in the room and a reconnect
   * resumes them. Leaving the room is `leave()` below: it sends `leave`
   * first, then closes. Cleanups (unmount / tab close) MUST call this,
   * never `leave()`, or a remount / reconnect would drop the seat.
   */
  close(reason: string | null = null): void {
    void reason;
    this.closedByClient = true;
    this.reconnectDeadlineMs = null;
    this.clearTimers();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, 'client closed');
    }
    this.ws = null;
    this.setState('closed');
    this.detachVisibility();
  }

  /**
   * Leave the room: best-effort `leave`, then close (P0-1). The `leave`
   * frame is given a short grace (200 ms) to flush before the socket
   * closes — closing immediately after `send` can drop the frame, and
   * the server would only suspend the seat instead of marking it left.
   * The server also closes the socket (1000) once it processes `leave`;
   * whichever close lands first wins and the grace timer is cleared.
   */
  leave(reason: string | null = null): boolean {
    this.closedByClient = true;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.close();
      return false;
    }
    const sent = this.sendCommand('leave', { reason });
    if (!sent) {
      this.close();
      return false;
    }
    this.leaveTimer = setTimeout(() => {
      this.leaveTimer = null;
      this.close();
    }, 200);
    return true;
  }

  // -- Outbound commands (all via sendCommand; false when disconnected) ---

  /**
   * Send a command. Retries must reuse the same `commandId` (the DO drops
   * repeats for 10 min) — pass the original id back in; a retry that mints
   * a fresh id is a new command and can double-apply (P1-9). There is no
   * automatic resend in this client: commands sent while disconnected are
   * discarded, never queued (R12), so the only retries are explicit ones
   * by the caller, which must carry the same `commandId`.
   */
  sendCommand<TPayload extends AnyPayload>(
    type: WsClientMessageType,
    payload: TPayload,
    commandId?: string,
  ): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false; // discarded, never queued (R12)
    const id = commandId ?? crypto.randomUUID();
    const envelope = {
      v: PROTOCOL_VERSION,
      type,
      commandId: id,
      idempotencyKey: id,
      roomId: this.roomId,
      playerId: this.playerId,
      clientSeq: this.clientSeq + 1,
      clientTs: Date.now(),
      payload,
    };
    this.clientSeq += 1;
    try {
      this.ws.send(JSON.stringify(envelope));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * v29 (R5, fix round M1) — ask for a snapshot, carrying the last
   * applied snapshot's wire key (`lastSnapshotKey`, alongside
   * `lastServerSeq` for compatibility) so the server can answer the
   * tiny `snapshot.unchanged` when nothing moved. Before the first
   * snapshot the key is null and the server answers a full snapshot.
   */
  requestSnapshot(): boolean {
    return this.sendCommand('snapshot.request', {
      lastServerSeq: this.lastServerSeq,
      lastSnapshotKey: this.lastSnapshotKey,
    });
  }

  resync(): boolean {
    return this.sendCommand('resync.request', {
      lastServerSeq: this.lastServerSeq,
      lastSnapshotKey: this.lastSnapshotKey,
    });
  }

  sendLocationUpdate(fix: LocationFix): boolean {
    return this.sendCommand('location.update', { fix });
  }

  /**
   * "I'm ready" — one tap, one message. The server folds
   * briefing.confirm into ready.set (Phase 3 #6), so no second message
   * (and no second save + broadcast + Supabase upsert) is sent.
   */
  setReady(isReady: boolean): boolean {
    return this.sendCommand('ready.set', { isReady });
  }

  sendRadio(text: string, kind: 'quick' | 'text' = 'text'): boolean {
    return this.sendCommand('radio.send', { text, kind });
  }

  sendSignal(code: string): boolean {
    return this.sendCommand('signal.send', { code });
  }

  sendVoiceSignal(
    toPlayerId: string,
    kind: 'join' | 'leave' | 'offer' | 'answer' | 'ice',
    sdp?: string,
    candidate?: unknown,
  ): boolean {
    return this.sendCommand('voice.signal', { toPlayerId, kind, sdp, candidate });
  }

  sendPin(point: { lat: number; lng: number }, label: string): boolean {
    return this.sendCommand('pin.place', { point, label });
  }

  sendAnnouncement(text: string): boolean {
    return this.sendCommand('announcement.send', { text });
  }

  // NOTE (founder decision, v18): SOS is removed from the web entirely —
  // `safetySos()` and the "I'm safe" check-in (`sendCheckIn()`, which was
  // just an announcement wrapper) are deleted. The safety PAUSE stays.
  // The radio quick chip 'I'm safe for now' is a live radio signal, not
  // SOS, and is untouched (see `QUICK_SIGNALS` + RadioStrip).

  requestCatch(runnerId: string): boolean {
    return this.sendCommand('catch.request', { runnerId });
  }

  /**
   * v18 follow-up — Runner mints their own claim-less QR token
   * (`catch.runner-token`, empty payload). The raw token comes back in
   * the direct `catch.runner-token` reply, once, to the Runner only.
   * A fresh commandId re-mints (the old QR dies at once); a retry of the
   * same mint reuses the same id so the server returns the cached reply
   * with the same token (idempotency). Omit the id for a fresh mint —
   * `sendCommand` mints one.
   */
  requestRunnerToken(commandId?: string): boolean {
    return this.sendCommand('catch.runner-token', {}, commandId);
  }

  /**
   * v18 follow-up — Hunter scans a Runner's QR: the raw token resolves
   * the Runner server-side, so no runnerId is needed. A failed scan
   * (proximity / not-catchable) does NOT consume the token — the Hunter
   * can retry with the same QR until its 120 s TTL runs out.
   */
  requestCatchByToken(qrToken: string): boolean {
    return this.sendCommand('catch.request', { qrToken });
  }

  /**
   * v18 runner Self Confirm: the Runner names the Hunter who tagged them
   * (`hunterId`) — no QR, no token, no Hunter confirmation needed. The
   * server creates the claim if none is open for that Hunter + Runner,
   * then confirms it in one atomic op.
   */
  sendCatchSelfConfirm(hunterId: string): boolean {
    return this.sendCommand('catch.self-confirm', { hunterId });
  }

  /** Runner confirms with the QR token (or manual confirm with no token). */
  sendCatchConfirm(
    catchId: string,
    qrToken: string,
    manualConfirm = false,
  ): boolean {
    return this.sendCommand('catch.confirm', {
      catchId,
      qrToken,
      manualConfirm,
      ...(manualConfirm ? { resolution: 'manual-confirm' } : {}),
    });
  }

  sendCatchDispute(catchId: string, reason: string): boolean {
    return this.sendCommand('catch.dispute', { catchId, reason });
  }

  safetyPause(reason: string | null = null): boolean {
    return this.sendCommand('safety.pause', { reason });
  }

  safetyResume(): boolean {
    return this.sendCommand('safety.resume', {});
  }

  /** Best-effort suspension notice (exempt from WS rate limits). */
  reportSuspended(reason: SuspensionReason): boolean {
    return this.sendCommand('player.suspended', { reason });
  }

  // -- Connection machinery -------------------------------------------------

  private async connectWithFreshTicket(): Promise<void> {
    const session = getSessionForRoom(this.roomId);
    const reconnectToken = session?.reconnectToken;
    if (!reconnectToken) {
      throw new Error('No live seat saved on this device for this room.');
    }
    const workerUrl = getWorkerUrl();
    // v29 (R8): a server-pushed ticket (`ticket.renewed`) is used first
    // — no HTTP leg. Single-use: consumed here, whatever happens next.
    const pushed = this.takePushedTicket();
    const ticket =
      pushed ??
      (await fetchWsTicket(this.roomId, this.playerId, reconnectToken, 'connect'));
    const wsUrl = `${workerUrl.replace(/^http/, 'ws')}/v1/rooms/${this.roomId}/ws?ticket=${encodeURIComponent(ticket.ticket)}`;
    await this.openSocket(wsUrl);
  }

  /** Consume the pushed ticket when it exists and is unexpired, else null. */
  private takePushedTicket(): WsTicketResponse | null {
    const pushed = this.pushedTicket;
    this.pushedTicket = null;
    if (!pushed || pushed.expiresAtMs <= Date.now()) return null;
    return { ok: true, ticket: pushed.ticket, ticketId: '', expiresAtMs: pushed.expiresAtMs };
  }

  private openSocket(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      let settled = false;
      // v28 fix round (Diya A3): a socket stuck in CONNECTING forever
      // fires no onclose and no onerror, and the heartbeat returns
      // early without counting missed — without this the client hung
      // in 'connecting' with no retry and no manual Retry. On timeout
      // the open is a failed connect: reject, and `connect()`'s catch
      // runs the existing `scheduleReconnect` path. The socket is
      // closed so its eventual onclose cannot schedule a SECOND
      // reconnect on top of the one from the rejection (see the
      // `scheduleReconnect` guard) — `settled` keeps every handler
      // from resolving/rejecting twice.
      const connectTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          // Already closing.
        }
        reject(new Error('WebSocket connection timed out.'));
      }, this.options.connectTimeoutMs);
      ws.onopen = () => {
        clearTimeout(connectTimer);
        // hello is first, carries NO credential.
        this.sendCommand('hello', {
          protocolVersion: PROTOCOL_VERSION,
          clientVersion: CLIENT_VERSION,
          lastServerSeq: this.lastServerSeq,
        });
        this.startHeartbeat();
        this.attachVisibility();
        settled = true;
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(connectTimer);
        if (!settled) {
          settled = true;
          reject(new Error('WebSocket connection failed.'));
        }
      };
      ws.onmessage = (event) => this.handleMessage(event.data);
      ws.onclose = (event) => this.handleClose(event);
    });
  }

  private handleMessage(raw: unknown): void {
    let envelope: WsServerEnvelope;
    try {
      envelope = JSON.parse(String(raw)) as WsServerEnvelope;
    } catch {
      return;
    }
    const type = envelope.type;

    // Direct messages carry no ordering claim.
    if (type === 'welcome') {
      this.setState('connected');
      this.reconnectAttempts = 0;
      this.reconnectDeadlineMs = null;
      this.freshTicketReconnectUsed = false;
      // On a reconnect (or any welcome with a prior seq), re-request the snapshot.
      if (this.lastServerSeq > 0) this.requestSnapshot();
      this.options.onServerMessage?.(envelope);
      return;
    }
    if (type === 'ticket.renewed') {
      // v29 (R8, server-push renewal — CONTRACT: event `ticket.renewed`
      // with payload { ticket: string, expiresAtMs?: number }, sent over
      // the existing authenticated socket shortly before expiry; Kabir
      // implements the server push against this exact contract). Store
      // it as the current ticket with NO HTTP call — the next connect /
      // renew spends it instead of fetching. `expiresAtMs` is honoured
      // when present; when absent the fallback is the real 60 s TTL
      // (`WS_TICKET_TTL_MS`) — a ticket used 61–180 s after mint is
      // expired server-side (4401), so the old 180 s horizon was wrong.
      const payload = envelope.payload as { ticket?: unknown; expiresAtMs?: unknown };
      if (typeof payload?.ticket === 'string' && payload.ticket.length > 0) {
        const expiresAtMs =
          typeof payload.expiresAtMs === 'number' && Number.isFinite(payload.expiresAtMs)
            ? payload.expiresAtMs
            : Date.now() + WS_TICKET_TTL_MS;
        this.pushedTicket = { ticket: payload.ticket, expiresAtMs };
      }
      this.options.onServerMessage?.(envelope);
      return;
    }
    if (type === 'heartbeat.ack') {
      this.missedHeartbeats = 0;
      this.options.onServerMessage?.(envelope);
      return;
    }
    if (type === 'auth.refreshed' || type === 'ticket.renewal-required') {
      if (type === 'ticket.renewal-required') void this.renewTicket();
      this.options.onServerMessage?.(envelope);
      return;
    }
    if (type === 'error') {
      const payload = envelope.payload as WsErrorPayload;
      if (typeof payload?.retryAfterSeconds === 'number') {
        this.lastRetryAfterSeconds = payload.retryAfterSeconds;
      }
      this.options.onError?.(payload);
      this.options.onServerMessage?.(envelope);
      return;
    }

    // Ordering: never apply an event with serverSeq at or below the last
    // applied — except welcome / snapshot / auth messages (handled above).
    if (typeof envelope.serverSeq === 'number') {
      if (type === 'snapshot') {
        // A snapshot is the whole truth: apply even on a rollback.
        // Record its R5 wire key first (fix round M1) — the next
        // `requestSnapshot` / `resync` sends it, so the server can
        // answer `snapshot.unchanged` when nothing moved.
        this.lastServerSeq = envelope.serverSeq;
        this.lastSnapshotKey = buildLastSnapshotKey(envelope.payload as WsSnapshotPayload);
        this.options.onSnapshot(envelope.payload as WsSnapshotPayload);
        this.options.onServerMessage?.(envelope);
        return;
      }
      if (envelope.serverSeq <= this.lastServerSeq) return;
      this.lastServerSeq = envelope.serverSeq;
    }
    this.options.onServerMessage?.(envelope);
  }

  /** Fetch a fresh `renew` ticket and send `auth.refresh` — the only message that ever carries a ticket. */
  private async renewTicket(): Promise<void> {
    // v29 (R8): a server-pushed ticket is spent first — NO HTTP call.
    // Fallback when no push arrived: the existing HTTP renewal (the
    // 60 s TTL is a server constant; the client flow is TTL-agnostic
    // because renewal is driven by the server's renewal warning).
    const pushed = this.takePushedTicket();
    if (pushed) {
      this.sendCommand('auth.refresh', { ticket: pushed.ticket });
      return;
    }
    const session = getSessionForRoom(this.roomId);
    const reconnectToken = session?.reconnectToken;
    if (!reconnectToken) return;
    try {
      const ticket = await fetchWsTicket(
        this.roomId,
        this.playerId,
        reconnectToken,
        'renew',
      );
      this.sendCommand('auth.refresh', { ticket: ticket.ticket });
    } catch {
      // Renewal failure surfaces as a 4401 close from the DO; do nothing here.
    }
  }

  private handleClose(event: CloseEvent): void {
    // A pending reconnect survives this close (see
    // `clearTimersExceptReconnect`): the close's own `scheduleReconnect`
    // below is then a no-op via its guard, instead of a second schedule
    // for the same failure.
    this.clearTimersExceptReconnect();
    this.ws = null;
    if (this.closedByClient) {
      this.setState('closed');
      return;
    }
    // v29 (30 s rule) — fallback deadline: no snapshot has supplied
    // one, so the window runs 30 s from the drop as this client saw
    // it. A snapshot-fed deadline (setter) is never overwritten here.
    if (this.reconnectDeadlineMs === null) {
      this.reconnectDeadlineMs = Date.now() + 30_000;
    }
    const action = WS_CLOSE_CODE_ACTION[event.code];
    switch (action) {
      case 'do-not-reconnect':
        this.setState(
          'closed',
          event.code === 4409
            ? 'Protocol unsupported — upgrade the client.'
            : event.code === 4403
              ? 'Seat removed or revoked.'
              : undefined,
        );
        break;
      case 'fresh-ticket-reconnect-once':
        if (this.freshTicketReconnectUsed) {
          this.setState('closed', 'Ticket invalid — reconnect failed.');
          break;
        }
        this.freshTicketReconnectUsed = true;
        // A malformed hello will not be fixed by a fresh ticket — surface it.
        if (event.code === 4400) {
          this.options.onError?.({
            code: 'VALIDATION_FAILED',
            message: 'Bad request — the server rejected the handshake.',
            retryable: false,
            serverTs: Date.now(),
          });
        }
        this.scheduleReconnect('Ticket invalid — retrying with a fresh ticket.');
        break;
      case 'backoff-after-retry-after':
        this.scheduleReconnect('Rate-limited — backing off.', this.lastRetryAfterSeconds);
        break;
      case 'backoff-reconnect':
      default:
        this.scheduleReconnect();
        break;
    }
  }

  private scheduleReconnect(detail?: string, retryAfterSeconds = 0): void {
    if (this.closedByClient) return;
    // v28 fix round (Diya A3): a reconnect is already pending — a
    // second schedule would overwrite the pending timer (leaking it:
    // the leaked timer still fires a connect later) and double-count
    // the attempt. This races in practice: the connect-timeout
    // rejection schedules a reconnect, and the stuck socket's
    // eventual onclose schedules another via `handleClose`. The
    // pending attempt already covers both; a new schedule starts
    // only once it has fired or been cleared.
    if (this.state === 'reconnecting' && this.reconnectTimer !== null) return;
    // v29 (30 s rule): the return window, not the attempt count, is the
    // budget. While the deadline is in the future, reconnect keeps
    // trying past RECONNECT_MAX_ATTEMPTS — the old cap gave up INSIDE
    // the window. Once the deadline passes, the window is over: enter
    // 'reconnect-failed' with manual Retry, as before. With no deadline
    // known at all, the old max-attempts rule applies unchanged.
    const nowMs = Date.now();
    if (this.reconnectDeadlineMs !== null) {
      if (nowMs >= this.reconnectDeadlineMs) {
        this.reconnectDeadlineMs = null;
        this.setState('reconnect-failed', 'reconnect failed — Retry');
        return;
      }
    } else if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      this.setState('reconnect-failed', 'reconnect failed — Retry');
      return;
    }
    this.setState('reconnecting', detail);
    const attempt = this.reconnectAttempts;
    this.reconnectAttempts += 1;
    const backoff = Math.min(
      RECONNECT_BACKOFF_BASE_MS * 2 ** attempt,
      RECONNECT_BACKOFF_CEILING_MS,
    );
    const jittered = backoff * (0.5 + Math.random() * 0.5);
    const delay = Math.max(jittered, retryAfterSeconds * 1000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // v29: a backoff that outruns the window must not connect past
      // it — the seat is gone by then, and the attempt would only
      // surface a confusing failure after the window closed.
      if (this.reconnectDeadlineMs !== null && Date.now() >= this.reconnectDeadlineMs) {
        this.reconnectDeadlineMs = null;
        this.setState('reconnect-failed', 'reconnect failed — Retry');
        return;
      }
      void this.connectWithFreshTicket().catch(() =>
        this.scheduleReconnect('Reconnect failed — retrying.'),
      );
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.missedHeartbeats = 0;
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.missedHeartbeats += 1;
      if (this.missedHeartbeats > this.options.heartbeatMissedLimit) {
        // Dead socket: close it (1011, 'heartbeat timeout') so the
        // reconnect path re-syncs via snapshot. 1006 is reserved
        // (RFC 6455 §7.4) and must never be sent.
        this.stopHeartbeat();
        try {
          this.ws.close(1011, 'heartbeat timeout');
        } catch {
          // Already closing.
        }
        return;
      }
      this.sendCommand('heartbeat', {});
    }, this.options.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Pause heartbeats (v28, Diya F13): no heartbeat is sent to a dead /
   * ended room, and none while the tab is hidden — a hidden tab's 30 s
   * heartbeat is 2,880 DO requests/day for a seat that is already
   * suspended (the visibility handler reports `player.suspended`
   * on hide, and a suspended seat is exempt from the (4a) ejection).
   * The socket stays OPEN while paused; `resumeHeartbeat` restarts
   * the interval with a fresh missed-count. Safe to call when no
   * heartbeat is running.
   */
  pauseHeartbeat(): void {
    this.stopHeartbeat();
  }

  /** Resume heartbeats after `pauseHeartbeat` — only while connected. */
  resumeHeartbeat(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.startHeartbeat();
  }

  private clearTimers(): void {
    this.stopHeartbeat();
    if (this.leaveTimer !== null) {
      clearTimeout(this.leaveTimer);
      this.leaveTimer = null;
    }
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.snapshotRetryTimer !== null) {
      clearTimeout(this.snapshotRetryTimer);
      this.snapshotRetryTimer = null;
    }
  }

  /**
   * Clear every timer EXCEPT a pending reconnect (v28 fix round, Diya
   * A3 — used by `handleClose` only). A reconnect already scheduled by
   * an earlier failure (e.g. the connect-timeout rejection) stays
   * pending, and `scheduleReconnect`'s guard then ignores the
   * duplicate schedule from this close — one failure, one schedule,
   * one attempt counted. Clearing the pending timer here and
   * re-scheduling below would double-count the attempt and restart
   * the backoff for the same failure. A client-initiated `close()`
   * still uses `clearTimers` (everything goes, no reconnect).
   */
  private clearTimersExceptReconnect(): void {
    this.stopHeartbeat();
    if (this.leaveTimer !== null) {
      clearTimeout(this.leaveTimer);
      this.leaveTimer = null;
    }
    if (this.snapshotRetryTimer !== null) {
      clearTimeout(this.snapshotRetryTimer);
      this.snapshotRetryTimer = null;
    }
  }

  /**
   * Retry a snapshot re-request that was dropped because the socket
   * was not open (v28, Diya F15). At most 2 retries, 2 s apart: the
   * socket usually comes back via the expedited reconnect below, and
   * the `welcome` handler re-requests the snapshot too — this is the
   * backstop for a socket that opens without a welcome snapshot, not
   * a loop.
   */
  private scheduleSnapshotRetry(): void {
    if (this.snapshotRetriesUsed >= 2) return;
    this.snapshotRetriesUsed += 1;
    this.snapshotRetryTimer = setTimeout(() => {
      this.snapshotRetryTimer = null;
      if (this.closedByClient) return;
      if (!this.requestSnapshot()) this.scheduleSnapshotRetry();
    }, 2000);
  }

  /**
   * The return-from-hidden re-sync (v28, Diya F15): the socket may
   * have closed while hidden, in which case the single
   * `requestSnapshot()` in the visibility handler returns false and
   * is dropped with no retry — recovery then depended on the
   * `welcome` handler, only if a (possibly 30 s-backed-off)
   * reconnect succeeded. Instead: when a reconnect is already
   * pending, expedite it now (the user is back; the attempt count is
   * untouched, so the max-attempts guard still applies), and
   * schedule the bounded snapshot retries above.
   */
  private resyncAfterVisible(): void {
    if (this.state === 'reconnecting' && this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      void this.connectWithFreshTicket().catch(() =>
        this.scheduleReconnect('Reconnect failed — retrying.'),
      );
    }
    // v28 fix round (Diya A2): a snapshot retry chain is already
    // pending — two quick hide/show cycles must not stack two
    // concurrent chains, and must not reset the in-flight chain's
    // counter mid-flight (the reset would give the retried snapshot
    // a fresh budget it already spent, and the two timers would
    // double-send the re-request). The pending chain already covers
    // this return; a new one starts only once it has finished.
    if (this.snapshotRetryTimer !== null) return;
    this.snapshotRetriesUsed = 0;
    this.scheduleSnapshotRetry();
  }

  private attachVisibility(): void {
    if (this.visibilityHandler || typeof document === 'undefined') return;
    this.visibilityHandler = () => {
      if (document.hidden) {
        // Best-effort suspension notice; the DO marks the seat suspended.
        this.reportSuspended('tab-hidden');
        // v28 (Diya F13): no heartbeats while hidden — the seat is
        // already suspended, and a hidden tab's heartbeat is 2,880
        // DO requests/day for nothing. (pauseHeartbeat() is the
        // public wrapper for this; the handler calls the timer
        // directly.)
        this.stopHeartbeat();
        if (this.state === 'connected') this.setState('suspended');
      } else {
        // Back: the DO resumes the seat on hello/reconnect; re-request the snapshot.
        if (this.state === 'suspended') this.setState('connected');
        this.resumeHeartbeat();
        // v28 (Diya F15): a dropped re-request must not be the end
        // of the re-sync — retry it (bounded), and expedite a
        // pending reconnect instead of waiting out its backoff.
        if (!this.requestSnapshot()) this.resyncAfterVisible();
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  private detachVisibility(): void {
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }

  private setState(state: WsConnectionState, detail?: string): void {
    this.state = state;
    this.options.onStateChange?.(state, detail);
  }
}
