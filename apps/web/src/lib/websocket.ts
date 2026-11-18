/**
 * PakdamSocket — production WebSocket client (17 §3, v2.1 FROZEN contract).
 *
 * Flow: ticketProvider() calls POST /v1/rooms/:id/ws-ticket over HTTPS
 * with the REST credential, then the ticket travels ONLY in the handshake
 * query string: wss://<api-host>/v1/rooms/{roomId}/ws?ticket=<ticket>.
 * The `hello` message carries NO credential — only protocolVersion,
 * clientVersion and lastServerSeq. The ONLY message that carries a ticket
 * is `auth.refresh` (renewal, after `ticket.renewal-required`).
 *
 * Reconnect: 1001/1006/1011/4400/4413 reconnect with exponential backoff +
 * jitter (max attempts OPEN — see options.maxReconnectAttempts); 4401
 * fetches a fresh ticket first, then reconnects once; 1000/4403/4409 never
 * auto-reconnect. On reconnect the client sends snapshot.request with
 * lastServerSeq and applies the snapshot as the whole truth — stale
 * commands are never replayed and events with serverSeq <= last applied
 * are dropped. Commands sent while disconnected are discarded, never
 * queued (no offline backfill).
 *
 * Every outbound message carries a commandId + idempotencyKey
 * (crypto.randomUUID, 17 §3.6). Heartbeat: the client sends `heartbeat`
 * only when an explicit heartbeatIntervalMs is configured — the server
 * never sends `heartbeat` (client→server only); it replies
 * `heartbeat.ack`. Interval and missed-heartbeat limit are OPEN
 * calibration. Ticket values are never logged.
 *
 * Demo mode does not use this client (see demo-store.ts).
 *
 * LIVE MODE (Worker transport, 2026-11-17): the app runs on the local
 * demo store by default. Set `NEXT_PUBLIC_WORKER_URL` (see
 * `.env.example`) to the deployed Worker URL (e.g.
 * `https://pakdam.<subdomain>.workers.dev`) and build the socket with
 * `createLivePakdamSocket()` — it wires the ticket provider to
 * `fetchWsTicket()` with the seat's reconnect credential, so the socket
 * talks to the real Worker + Durable Object instead of the demo loop.
 * `live-client.ts` wraps this (`openLiveSocket`) and the create/join
 * pages use that client; the room pages open the socket directly with
 * `createLivePakdamSocket()` and their own per-page adapters
 * (live-room REST helpers live in ./live-room-client.ts). Without the
 * env var the client stays on the local loop; nothing here fakes a live
 * connection. What still needs a live
 * deployment to verify: the Worker deployed (`wrangler deploy`), the
 * env var set at web build/deploy time, a real room created over
 * HTTPS, and a ticket + WS handshake against that deployment (see
 * docs/DEPLOYMENT-RUNBOOK.md §8).
 *
 * Contract check (2026-11-17, vs workers/src/index.ts + http.ts):
 * no mismatch found. Ticket endpoint, body `{ playerId,
 * reconnectToken }`, no Authorization header, ticket only in the
 * handshake query string, `hello` carries no credential, and
 * `auth.refresh` is the only ticket-carrying message all match the
 * Worker. Reconnect (max 5, exponential backoff + jitter; 4401 =
 * fresh ticket once; 1000/4403/4409 = never) matches 17 §3.4/§3.5.
 */
import type {
  LocationFix, WsClientMessage, WsServerMessage, WsSnapshotPayload,
} from '@pakdam/shared';

/** OPEN calibration placeholders (17 §7). These defaults are local
 *  fallbacks only — every one must be replaced by a measured value before
 *  the external pilot, recorded with its evidence. */
export const PAKDAM_SOCKET_OPEN_DEFAULTS = {
  /** Max reconnect attempts before surfacing "reconnect failed — Retry". */
  maxReconnectAttempts: 5,
  /** Base delay for exponential backoff (ms); doubled per attempt. */
  reconnectBaseDelayMs: 1000,
  /** Backoff ceiling (ms). */
  reconnectMaxDelayMs: 30000,
  /** Missed heartbeat.acks before the seat is treated as stale. */
  missedHeartbeatLimit: 3,
} as const;

export type PakdamSocketState =
  | 'idle' | 'connecting' | 'connected' | 'suspended'
  | 'reconnecting' | 'reconnect-failed' | 'closed';

export interface PakdamSocketCallbacks {
  onMessage?: (msg: WsServerMessage) => void;
  onSnapshot?: (snapshot: WsSnapshotPayload, meta: { rolledBack: boolean }) => void;
  onStateChange?: (state: PakdamSocketState, detail?: string) => void;
}

export interface PakdamSocketOptions {
  playerId?: string;
  clientVersion?: string;
  /** OPEN — max reconnect attempts before 'reconnect-failed'. */
  maxReconnectAttempts?: number;
  /** OPEN — backoff base delay (ms). */
  reconnectBaseDelayMs?: number;
  /** OPEN — backoff ceiling (ms). */
  reconnectMaxDelayMs?: number;
  /** OPEN — heartbeat interval (ms). Only used when configured; unset
   *  means no client heartbeat timer. The server never asks for
   *  heartbeats — it only replies `heartbeat.ack` to ours. */
  heartbeatIntervalMs?: number;
  /** OPEN — missed acks before the seat is treated as stale. */
  missedHeartbeatLimit?: number;
  /** Injectable socket factory (tests inject a mock WebSocket). */
  webSocketFactory?: (url: string) => WsLike;
}

/** Minimal socket surface — real WebSocket and test mocks both satisfy it. */
export interface WsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type TicketProvider = (purpose?: 'connect' | 'renew') => Promise<string>;

export class PakdamSocket {
  private ws: WsLike | null = null;
  private roomId: string | null = null;
  private playerId: string | null = null;
  private callbacks: PakdamSocketCallbacks = {};
  private state: PakdamSocketState = 'idle';
  private clientSeq = 0;
  private lastServerSeq = 0;
  private reconnectAttempts = 0;
  private triedFreshTicketFor4401 = false;
  private manualClose = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private missedHeartbeats = 0;
  private lastRetryAfterSeconds: number | null = null;
  private visibilityHandler: (() => void) | null = null;
  private apiUrl: string;
  private ticketProvider: TicketProvider;
  private options: PakdamSocketOptions;

  // No parameter properties (`constructor(private apiUrl, …)`) — Node's
  // strip-only mode cannot parse them, and the source-run suites
  // (websocket-reconnect, live-client) load this file directly.
  constructor(
    apiUrl: string,
    ticketProvider: TicketProvider,
    options: PakdamSocketOptions = {},
  ) {
    this.apiUrl = apiUrl;
    this.ticketProvider = ticketProvider;
    this.options = options;
  }

  /** Open the socket for a room. Ticket is fetched via ticketProvider
   *  (HTTPS) and placed ONLY in the handshake query string. */
  async connect(roomId: string, callbacks: PakdamSocketCallbacks & { playerId?: string }): Promise<void> {
    this.roomId = roomId;
    this.playerId = callbacks.playerId ?? this.options.playerId ?? null;
    this.callbacks = callbacks;
    this.manualClose = false;
    this.reconnectAttempts = 0;
    this.triedFreshTicketFor4401 = false;
    this.setState('connecting');
    this.attachVisibilityListener();
    const ticket = await this.ticketProvider();
    this.openSocket(ticket);
  }

  /** Manual reconnect after a 'reconnect-failed' state ("Retry"). */
  async retry(): Promise<void> {
    if (!this.roomId || this.state === 'connected' || this.state === 'connecting') return;
    this.reconnectAttempts = 0;
    this.triedFreshTicketFor4401 = false;
    this.manualClose = false;
    this.setState('connecting');
    const ticket = await this.ticketProvider();
    this.openSocket(ticket);
  }

  close(code = 1000, reason = 'client close'): void {
    this.manualClose = true;
    this.clearTimers();
    this.detachVisibilityListener();
    this.ws?.close(code, reason);
    this.ws = null;
    this.setState('closed');
  }

  getState(): PakdamSocketState { return this.state; }
  getLastServerSeq(): number { return this.lastServerSeq; }
  getMissedHeartbeats(): number { return this.missedHeartbeats; }

  /** Send a typed command. Returns false (command discarded, never
   *  queued) when the socket is not connected — no offline backfill. */
  sendCommand<T extends WsClientMessage['type']>(
    type: T, payload: Extract<WsClientMessage, { type: T }>['payload'],
  ): boolean {
    if (!this.ws || this.state !== 'connected' || !this.roomId || !this.playerId) return false;
    const idempotencyKey = globalThis.crypto.randomUUID();
    const msg = {
      v: 1, type, commandId: idempotencyKey, idempotencyKey,
      roomId: this.roomId, playerId: this.playerId,
      clientSeq: ++this.clientSeq, clientTs: Date.now(), payload,
    };
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  sendLocationUpdate(fix: LocationFix): boolean {
    return this.sendCommand('location.update', { fix });
  }
  /** Confirm a catch. The frozen WS type for catch.confirm carries
   *  `{catchId, qrToken, manualConfirm?, resolution?}`
   *  (packages/shared/src/types.ts); the DO also accepts the Runner's
   *  manual confirm (`manualConfirm: true`, no token — GL-04). The
   *  payload is sent through sendCommand with no cast — the shared
   *  type checks it (cast removed 2026-11-17, Worker H). */
  sendCatchConfirm(catchId: string, opts: { qrToken?: string; manualConfirm?: boolean }): boolean {
    const payload = {
      catchId,
      qrToken: opts.qrToken ?? '',
      ...(opts.manualConfirm ? { manualConfirm: true, resolution: 'manual-confirm' as const } : {}),
    };
    return this.sendCommand('catch.confirm', payload);
  }
  sendHeartbeat(): boolean {
    return this.sendCommand('heartbeat', {});
  }
  /** Voice radio (D-M1) — send ONE signalling payload to ONE teammate
   *  over the existing game socket. This carries SDP/ICE only, never
   *  audio: the voice itself flows peer to peer over WebRTC. The DO
   *  enforces team-only delivery and rejects anything else, so a
   *  failed send (false = socket not connected) just means voice is
   *  unavailable — text radio still works. */
  sendVoiceSignal(
    toPlayerId: string,
    signal: { kind: 'join' | 'leave' | 'offer' | 'answer' | 'ice'; sdp?: string; candidate?: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null } },
  ): boolean {
    return this.sendCommand('voice.signal', { toPlayerId, ...signal });
  }
  /** Team Radio TEXT (D-M7) — send one text / quick message to my
   *  team over the live socket. The DO relays it to the sender's
   *  team only (lobby: the whole lobby) and stamps the sender's
   *  display name — the text here is the only client claim, capped
   *  at 140 chars by the DO. Returns false (discarded, never queued)
   *  when the socket is not connected. */
  sendRadioMessage(text: string, kind: 'quick' | 'text' = 'text'): boolean {
    return this.sendCommand('radio.send', { text, kind });
  }
  requestSnapshot(): boolean {
    return this.sendCommand('snapshot.request', { lastServerSeq: this.lastServerSeq });
  }
  requestResync(): boolean {
    return this.sendCommand('resync.request', { lastServerSeq: this.lastServerSeq });
  }
  /** Best-effort suspension notice (17 §3.7 stage 2). */
  sendSuspensionNotice(reason: 'tab-hidden' | 'screen-locked' | 'network-lost' = 'tab-hidden'): boolean {
    return this.sendCommand('player.suspended', { reason });
  }

  /** Called on document visibilitychange hidden. Public so tests and the
   *  app can drive it without a DOM. */
  handleVisibilityHidden(): void {
    if (this.state === 'connected') this.sendSuspensionNotice('tab-hidden');
    if (this.state === 'connected' || this.state === 'suspended') this.setState('suspended');
  }
  /** Called on document visibilitychange visible: request a fresh snapshot. */
  handleVisibilityVisible(): void {
    if (this.state === 'suspended') this.setState('connected');
    if (this.state === 'connected') this.requestSnapshot();
  }

  // --- internals ---

  private wsBase(): string {
    return this.apiUrl.replace(/^http/, 'ws');
  }

  private openSocket(ticket: string): void {
    if (!this.roomId) return;
    // Ticket ONLY in the query string (17 §3.1). Never logged.
    const url = `${this.wsBase()}/v1/rooms/${this.roomId}/ws?ticket=${encodeURIComponent(ticket)}`;
    const factory = this.options.webSocketFactory ?? ((u: string): WsLike =>
      new WebSocket(u) as unknown as WsLike);
    this.ws = factory(url);
    this.ws.onopen = () => this.onOpen();
    this.ws.onmessage = (ev) => this.onMessage(ev);
    this.ws.onclose = (ev) => void this.onClose(ev.code);
    this.ws.onerror = () => { /* close follows; handled in onClose */ };
  }

  private onOpen(): void {
    // hello carries NO credential (17 §3.1 rule 4).
    const hello = {
      v: 1, type: 'hello' as const,
      commandId: globalThis.crypto.randomUUID(),
      roomId: this.roomId, playerId: this.playerId,
      clientSeq: ++this.clientSeq, clientTs: Date.now(),
      payload: {
        protocolVersion: 1 as const,
        clientVersion: this.options.clientVersion ?? 'pakdam-web/0.1.0',
        lastServerSeq: this.lastServerSeq,
      },
    };
    this.ws?.send(JSON.stringify(hello));
  }

  private onMessage(ev: { data: unknown }): void {
    let msg: WsServerMessage;
    try {
      msg = JSON.parse(String(ev.data)) as WsServerMessage;
    } catch {
      return; // ignore malformed frames; the server never sends them
    }
    if (msg.v !== 1 || typeof msg.type !== 'string') return;

    // Ordering: never apply an event with serverSeq <= last applied
    // (except welcome/snapshot/auth, which carry no ordering claim of
    // their own — a snapshot is the whole truth, see below).
    const seq = (msg as { serverSeq?: unknown }).serverSeq;
    const msgType: string = msg.type;
    if (typeof seq === 'number' && msgType !== 'snapshot' && msgType !== 'welcome'
      && msgType !== 'auth.refreshed' && msgType !== 'ticket.renewal-required') {
      if (seq <= this.lastServerSeq) return; // stale event — drop
      this.lastServerSeq = seq;
    }

    switch (msgType) {
      case 'welcome': {
        this.setState('connected');
        if (typeof seq === 'number') this.lastServerSeq = Math.max(this.lastServerSeq, seq);
        // Reconnect (17 §3.5): ask for a fresh snapshot with lastServerSeq.
        if (this.reconnectAttempts > 0 || this.lastServerSeq > 0) this.requestSnapshot();
        if (this.options.heartbeatIntervalMs !== undefined) this.startHeartbeat();
        break;
      }
      case 'snapshot': {
        const snap = (msg as Extract<WsServerMessage, { type: 'snapshot' }>).payload;
        const rolledBack = snap.serverSeq < this.lastServerSeq;
        this.lastServerSeq = snap.serverSeq;
        this.callbacks.onSnapshot?.(snap, { rolledBack });
        break;
      }
      case 'ticket.renewal-required': {
        // Renewal (17 §3.2): fetch a fresh RENEW ticket over HTTPS,
        // then send auth.refresh — the ONLY message that carries a
        // ticket. SEC-11: a 'renew' ticket can never open a socket;
        // the DO redeems it itself on this socket.
        void this.ticketProvider('renew')
          .then((ticket) => this.sendCommand('auth.refresh', { ticket }))
          .catch(() => { /* server closes after the renewal grace; reconnect handles it */ });
        break;
      }
      case 'heartbeat.ack': {
        this.missedHeartbeats = 0;
        break;
      }
      case 'error': {
        const err = (msg as Extract<WsServerMessage, { type: 'error' }>).payload;
        if (typeof err.retryAfterSeconds === 'number') this.lastRetryAfterSeconds = err.retryAfterSeconds;
        break;
      }
      default:
        break;
    }
    this.callbacks.onMessage?.(msg);
  }

  private async onClose(code: number): Promise<void> {
    this.ws = null;
    this.clearHeartbeat();
    if (this.manualClose) { this.setState('closed'); return; }
    const maxAttempts = this.options.maxReconnectAttempts
      ?? PAKDAM_SOCKET_OPEN_DEFAULTS.maxReconnectAttempts;
    if (code === 1000 || code === 4403 || code === 4409) {
      // Normal closure, forbidden, protocol unsupported: do NOT reconnect.
      this.setState('closed', code === 4409 ? 'protocol unsupported — upgrade the client' : undefined);
      return;
    }
    if (code === 4401) {
      // Ticket invalid/reused/expired: fetch a fresh ticket, reconnect once.
      if (!this.triedFreshTicketFor4401) {
        this.triedFreshTicketFor4401 = true;
        this.setState('reconnecting', 'fetching a fresh ticket');
        try {
          const ticket = await this.ticketProvider();
          if (this.manualClose) return;
          this.openSocket(ticket);
        } catch {
          this.failReconnect();
        }
      } else {
        this.setState('closed', 'ticket invalid — reconnect failed');
      }
      return;
    }
    // 1001 / 1006 / 1011 / 4400 / 4413: backoff reconnect (17 §3.4/§3.5).
    if (this.reconnectAttempts >= maxAttempts) { this.failReconnect(); return; }
    this.setState('reconnecting');
    const delay = this.backoffDelay(code);
    this.reconnectTimer = setTimeout(() => void this.doReconnect(), delay);
  }

  private backoffDelay(code: number): number {
    const base = this.options.reconnectBaseDelayMs
      ?? PAKDAM_SOCKET_OPEN_DEFAULTS.reconnectBaseDelayMs;
    const max = this.options.reconnectMaxDelayMs
      ?? PAKDAM_SOCKET_OPEN_DEFAULTS.reconnectMaxDelayMs;
    const exp = Math.min(max, base * 2 ** this.reconnectAttempts);
    // 4413 (rate-limited): never reconnect before the server's retryAfter.
    const floor = code === 4413 && this.lastRetryAfterSeconds !== null
      ? this.lastRetryAfterSeconds * 1000 : 0;
    const jittered = exp * (0.5 + Math.random() * 0.5); // full-ish jitter
    return Math.max(floor, jittered);
  }

  private async doReconnect(): Promise<void> {
    this.reconnectTimer = null;
    if (this.manualClose || !this.roomId) return;
    this.reconnectAttempts++;
    try {
      const ticket = await this.ticketProvider();
      if (this.manualClose) return;
      this.openSocket(ticket);
    } catch {
      // Ticket fetch failed: count as a failed attempt and keep backing off.
      const maxAttempts = this.options.maxReconnectAttempts
        ?? PAKDAM_SOCKET_OPEN_DEFAULTS.maxReconnectAttempts;
      if (this.reconnectAttempts >= maxAttempts) { this.failReconnect(); return; }
      this.setState('reconnecting');
      this.reconnectTimer = setTimeout(() => void this.doReconnect(), this.backoffDelay(1006));
    }
  }

  private failReconnect(): void {
    this.setState('reconnect-failed', 'reconnect failed — Retry');
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    const interval = this.options.heartbeatIntervalMs;
    // OPEN interval: no timer unless an interval was configured.
    if (interval === undefined) return;
    const limit = this.options.missedHeartbeatLimit
      ?? PAKDAM_SOCKET_OPEN_DEFAULTS.missedHeartbeatLimit;
    this.heartbeatTimer = setInterval(() => {
      if (this.state !== 'connected') return;
      // One tick without an ack since the last tick = one missed heartbeat.
      // A heartbeat.ack resets the counter to 0.
      this.missedHeartbeats++;
      if (this.missedHeartbeats >= limit) {
        // Stale (17 §3.7 stage 1): stop heartbeating on a dead socket;
        // the close/reconnect path re-syncs via snapshot.
        this.clearHeartbeat();
        this.ws?.close(1006, 'heartbeat timeout');
        return;
      }
      this.sendHeartbeat();
    }, interval);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  private clearTimers(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.clearHeartbeat();
  }

  private setState(state: PakdamSocketState, detail?: string): void {
    this.state = state;
    this.callbacks.onStateChange?.(state, detail);
  }

  private attachVisibilityListener(): void {
    if (typeof document === 'undefined' || this.visibilityHandler) return;
    this.visibilityHandler = () => {
      if (document.visibilityState === 'hidden') this.handleVisibilityHidden();
      else this.handleVisibilityVisible();
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  private detachVisibilityListener(): void {
    if (typeof document === 'undefined' || !this.visibilityHandler) return;
    document.removeEventListener('visibilitychange', this.visibilityHandler);
    this.visibilityHandler = null;
  }
}

/** Fetch a fresh single-use WS ticket over HTTPS (17 §2.5).
 *  The Worker contract (workers/src/http.ts `ticketBody`, validated by
 *  the DO's `verify-reconnect` op) is
 *  `{ playerId, reconnectToken, purpose? }` — the raw reconnect
 *  credential the seat received at create/join, sent in the POST body
 *  over HTTPS. There is NO `Authorization` header: the Worker does
 *  not read one, and putting the raw credential in a header is a leak
 *  vector (it lands in logs/proxies). `purpose` is 'connect' (default
 *  — opens a new socket) or 'renew' (SEC-11: a fresh ticket for
 *  `auth.refresh` on an EXISTING socket; a renew ticket can never
 *  open a socket, and the DO redeems it itself). The ticket value is
 *  returned to the caller only — never logged, never stored beyond
 *  the single handshake. */
export async function fetchWsTicket(
  apiUrl: string, roomId: string, playerId: string, reconnectToken: string,
  purpose: 'connect' | 'renew' = 'connect',
): Promise<string> {
  const r = await fetch(`${apiUrl}/v1/rooms/${roomId}/ws-ticket`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId, reconnectToken, purpose }),
  });
  if (!r.ok) throw new Error('Could not get a connection ticket');
  const j = await r.json() as { data?: { ticket?: string }; ticket?: string };
  const ticket = j.data?.ticket ?? j.ticket;
  if (!ticket) throw new Error('Could not get a connection ticket');
  return ticket;
}

/** The deployed Worker base URL for live transport, from the build-time
 *  env var (see `.env.example`). Returns null when unset — the app
 *  then stays on the local demo loop. Never falls back to a guessed
 *  URL: a wrong default would silently point the game at a stranger's
 *  Worker. Trailing slashes are stripped so callers can append paths. */
export function getWorkerUrl(): string | null {
  const raw = typeof process !== 'undefined'
    ? process.env?.NEXT_PUBLIC_WORKER_URL : undefined;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : null;
}

/** True only when a Worker URL is configured — the single switch
 *  between the local demo loop (default) and the live Worker transport. */
export function isLiveTransportEnabled(): boolean {
  return getWorkerUrl() !== null;
}

export interface LiveSocketConfig {
  roomId: string;
  playerId: string;
  /** Raw reconnect credential for this seat (received at create/join,
   *  kept by the app — never logged, never put in a URL). */
  reconnectToken: string;
  clientVersion?: string;
  options?: PakdamSocketOptions;
}

/** Build a PakdamSocket wired to the deployed Worker: the ticket
 *  provider fetches a fresh single-use ticket over HTTPS with the
 *  seat's reconnect credential, and the socket handshakes at
 *  `wss://<worker>/v1/rooms/{roomId}/ws?ticket=<ticket>`. Returns null
 *  when no Worker URL is configured (caller keeps the demo loop).
 *  The caller still owns the seat credential and the room lifecycle
 *  (create/join over HTTPS first); this only builds the transport. */
export function createLivePakdamSocket(
  config: LiveSocketConfig,
): PakdamSocket | null {
  const apiUrl = getWorkerUrl();
  if (!apiUrl) return null;
  const ticketProvider: TicketProvider = (purpose: 'connect' | 'renew' = 'connect') =>
    fetchWsTicket(apiUrl, config.roomId, config.playerId, config.reconnectToken, purpose);
  return new PakdamSocket(apiUrl, ticketProvider, {
    playerId: config.playerId,
    clientVersion: config.clientVersion,
    ...config.options,
  });
}

// Live-room REST client lives in
// ./live-room-client.ts (split out 2026-11-17 — see its header).