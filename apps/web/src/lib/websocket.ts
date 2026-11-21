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
 *   (1 s base, doubling, 30 s ceiling, jitter ×0.5–1.0, max 5 attempts,
 *   then "reconnect failed — Retry").
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
  private lastRetryAfterSeconds = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private leaveTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private missedHeartbeats = 0;
  private freshTicketReconnectUsed = false;
  private closedByClient = false;
  private visibilityHandler: (() => void) | null = null;
  private readonly options: Required<
    Pick<PakdamSocketOptions, 'heartbeatIntervalMs' | 'heartbeatMissedLimit'>
  > &
    PakdamSocketOptions;

  constructor(options: PakdamSocketOptions) {
    this.roomId = options.roomId;
    this.playerId = options.playerId;
    this.options = {
      ...options,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
      heartbeatMissedLimit: options.heartbeatMissedLimit ?? HEARTBEAT_MISSED_LIMIT,
    };
  }

  get connectionState(): WsConnectionState {
    return this.state;
  }

  get lastAppliedServerSeq(): number {
    return this.lastServerSeq;
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
    this.freshTicketReconnectUsed = false;
    this.closedByClient = false;
    await this.connect();
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

  requestSnapshot(): boolean {
    return this.sendCommand('snapshot.request', { lastServerSeq: this.lastServerSeq });
  }

  resync(): boolean {
    return this.sendCommand('resync.request', { lastServerSeq: this.lastServerSeq });
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
    const ticket = await fetchWsTicket(
      this.roomId,
      this.playerId,
      reconnectToken,
      'connect',
    );
    const wsUrl = `${workerUrl.replace(/^http/, 'ws')}/v1/rooms/${this.roomId}/ws?ticket=${encodeURIComponent(ticket.ticket)}`;
    await this.openSocket(wsUrl);
  }

  private openSocket(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      let settled = false;
      ws.onopen = () => {
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
      this.freshTicketReconnectUsed = false;
      // On a reconnect (or any welcome with a prior seq), re-request the snapshot.
      if (this.lastServerSeq > 0) this.requestSnapshot();
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
        this.lastServerSeq = envelope.serverSeq;
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
    this.clearTimers();
    this.ws = null;
    if (this.closedByClient) {
      this.setState('closed');
      return;
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
    if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
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
  }

  private attachVisibility(): void {
    if (this.visibilityHandler || typeof document === 'undefined') return;
    this.visibilityHandler = () => {
      if (document.hidden) {
        // Best-effort suspension notice; the DO marks the seat suspended.
        this.reportSuspended('tab-hidden');
        if (this.state === 'connected') this.setState('suspended');
      } else {
        // Back: the DO resumes the seat on hello/reconnect; re-request the snapshot.
        if (this.state === 'suspended') this.setState('connected');
        this.requestSnapshot();
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
