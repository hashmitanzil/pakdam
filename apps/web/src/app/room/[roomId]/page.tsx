'use client';
import { use, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getRoom, setPhase, toggleReady, hostCheckin, currentPlayerId, clearCurrentPlayerId, leaveRoom, setTeamAssignment, setSelectedHunters, updateRoomConfig } from '@/lib/demo-store';
import { draftFromConfig, roomSummaryStrip } from '@/components/host-setup/draft';
import Roster from '@/components/lobby/Roster';
import ReadinessChecklist from '@/components/lobby/ReadinessChecklist';
import LobbySafety, { type LobbyPause } from '@/components/lobby/LobbySafety';
import ReportBlockSheet from '@/components/lobby/ReportBlockSheet';
import HostSettingsSheet from '@/components/host-setup/HostSettingsSheet';
import { fileReport, type ReportReason } from '@/components/lobby/report-block';
import TeamRadio from '@/components/radio/TeamRadio';
import styles from '@/components/lobby/lobby.module.css';
import type { DemoRoom } from '@/lib/demo-store';
import { createLivePakdamSocket, getWorkerUrl, isLiveTransportEnabled } from '@/lib/websocket';
import { clearSession, getSessionForRoom, saveLiveSession, type PakdamSession } from '@/lib/session-credentials';
import { fetchHostToken, regenerateLiveRoomCode, removeLivePlayer, updateLiveRoomConfig } from '@/lib/live-room-client';
import type { PakdamSocket, PakdamSocketState } from '@/lib/websocket';
import type { LocationFix, Player, PlayerView, RadioMessage, Room, RoomConfig, WsServerMessage, WsSnapshotPayload } from '@pakdam/shared';
import { generateRoomCode } from '@pakdam/shared';

/** Lobby — redesigned 2026-11-17.
 *  No venue/area name anywhere on this screen: the game starts from the
 *  host's location, not from a name. One clear primary action (I'm ready /
 *  Start game), roster with ready states, readiness checklist, safety
 *  strip (SOS / pause / hold-to-reveal), lobby radio, host controls.
 *
 *  TWO MODES, never mixed (Worker 2, live wiring 2026-11-17):
 *  - DEMO (default): the local demo store, labelled on screen. Exactly
 *    the behaviour this page had before — same handlers, same storage.
 *  - LIVE (only when NEXT_PUBLIC_WORKER_URL is set): the roster, ready
 *    states, phase and config come from the Worker + Durable Object
 *    over HTTPS + WebSocket (lib/websocket.ts `createLivePakdamSocket`).
 *    Snapshots are the whole truth; roster events re-request one.
 *    Demo state is never read or written in live mode.
 *
 *  LIVE SESSION (canonical store, lib/session-credentials.ts):
 *  the live create/join flow saves the seat with saveLiveSession
 *  under the single sessionStorage key 'pakdam.session.v1' — this
 *  page reads it back with getSessionForRoom(roomId) and drops it
 *  with clearSession() on leave. One tab = one seat (sessionStorage,
 *  like the demo's per-tab player id — one tab cannot steal another
 *  tab's seat). A demo session for this room, or a live session
 *  without a reconnect token, is not a live seat. The raw token is
 *  never logged, never put in a URL, and only ever sent in POST
 *  bodies over HTTPS (ticket + start) — the WS handshake carries a
 *  single-use ticket instead.
 *
 *  WHAT IS LIVE, and what is NOT (the live server has no endpoint for
 *  it — the UI says so in plain language instead of faking it):
 *  - LIVE: player list + readiness (snapshot), ready toggle
 *    (ready.set + briefing.confirm), host check-in (announcement.send
 *    — host-only on the server, which is exactly the seat that checks
 *    in), leave (leave), safety pause/resume/SOS (safety.*), Start
 *    (POST /v1/rooms/:id/start with {playerId, hostToken} — host
 *    authority is proved by the stored HOST token, never by display
 *    name or the reconnect token), and the transition to play on
 *    server `match.started` / a snapshot whose phase left LOBBY.
 *  - LIVE (host controls, D-M2/D-M4/D-M5/D-M6): changing settings
 *    from the lobby (POST /v1/rooms/:id/config, host token, LOBBY
 *    only — the HostSettingsSheet opens in live mode too, and Hunter
 *    picks / Balance / Random / Hunter count change through it and
 *    the Teams picker below), removing a player (POST
 *    /v1/rooms/:id/remove-player, host token — the server broadcasts
 *    player.removed and every lobby re-renders from a fresh
 *    snapshot), regenerating the room code (POST
 *    /v1/rooms/:id/regenerate-code, host token — the old code stops
 *    working at once), and hold-to-reveal (WS `reveal.send` with
 *    this device's current fix — the DO validates it and broadcasts
 *    a coarse 150 m `reveal` area to every socket).
 *  - NOT LIVE YET: lobby radio is demo-only localStorage, so it is
 *    hidden in live mode. The warning acknowledgement tick-box is
 *    kept on this device in live mode: `announcement.send` is
 *    host-only, so a guest has no server channel for it, and the
 *    server's briefing record is briefing.confirm (sent when the
 *    player taps "I'm ready").
 *
 *  Demo-only local helpers below (removePlayer, appendRoomEvent) read and
 *  write the demo store's localStorage record directly, because the demo
 *  store has no remove-player or generic event API — demo-store.ts is
 *  owned by another worker and is not edited here. Production must use
 *  the real API/WS events (player.removed, safety.*, announcement). */

const DEMO_KEY = 'pakdam.demo.rooms.v1';
const PAUSE_KEY = (roomId: string) => `pakdam.lobby-pause.${roomId}`;

function loadAll(): Record<string, DemoRoom> {
  try {
    return JSON.parse(localStorage.getItem(DEMO_KEY) ?? '{}') as Record<string, DemoRoom>;
  } catch {
    return {};
  }
}

function removePlayerLocal(roomId: string, playerId: string, displayName: string): boolean {
  const all = loadAll();
  const dr = all[roomId];
  if (!dr) return false;
  if (dr.players.some((p) => p.playerId === playerId && p.isHost)) return false;
  dr.players = dr.players.filter((p) => p.playerId !== playerId);
  dr.events.push({ at: new Date().toISOString(), text: `${displayName} was removed from the lobby by the host` });
  localStorage.setItem(DEMO_KEY, JSON.stringify(all));
  return true;
}

function appendRoomEvent(roomId: string, text: string): void {
  const all = loadAll();
  const dr = all[roomId];
  if (!dr) return;
  dr.events.push({ at: new Date().toISOString(), text });
  localStorage.setItem(DEMO_KEY, JSON.stringify(all));
}

function socketStateLabel(state: PakdamSocketState): string {
  switch (state) {
    case 'connecting': return 'connecting…';
    case 'connected': return 'connected';
    case 'suspended': return 'paused while this tab is hidden';
    case 'reconnecting': return 'reconnecting…';
    case 'reconnect-failed': return 'reconnect failed';
    case 'closed': return 'connection closed';
    default: return state;
  }
}

export default function LobbyPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = use(params);
  const router = useRouter();
  const [mode, setMode] = useState<'live' | 'demo' | null>(null);
  // --- demo state (demo mode only) ---
  const [dr, setDr] = useState<DemoRoom | null>(null);
  const [loadError, setLoadError] = useState('');
  const [pause, setPause] = useState<LobbyPause>(null);
  // --- live state (live mode only) ---
  const [snap, setSnap] = useState<WsSnapshotPayload | null>(null);
  const [liveSession, setLiveSession] = useState<PakdamSession | null>(null);
  const [liveError, setLiveError] = useState('');
  const [liveNotice, setLiveNotice] = useState('');
  const [socketState, setSocketState] = useState<PakdamSocketState>('idle');
  const [socketDetail, setSocketDetail] = useState('');
  const [liveEvents, setLiveEvents] = useState<{ at: string; text: string }[]>([]);
  // Team Radio TEXT (D-M7, live lobby): messages relayed by the DO
  // to the whole lobby (no teams yet), oldest first, capped at 50.
  const [liveRadio, setLiveRadio] = useState<RadioMessage[]>([]);
  const [liveCheckins, setLiveCheckins] = useState<string[]>([]);
  const [liveRetry, setLiveRetry] = useState(0);
  const socketRef = useRef<PakdamSocket | null>(null);
  const wentToPlayRef = useRef(false);
  // The socket callbacks close over the effect's first render, so they
  // read the roster through this ref instead of stale state.
  const snapRef = useRef<WsSnapshotPayload | null>(null);
  useEffect(() => { snapRef.current = snap; }, [snap]);
  // --- shared UI state ---
  const [offline, setOffline] = useState(false);
  const [copied, setCopied] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [teamError, setTeamError] = useState('');
  const [startError, setStartError] = useState('');
  // Live-start in-flight guard (double-tap): the ref flips synchronously
  // so a second tap before the re-render is still dropped; the state
  // only drives the "Starting…" label. Reset on every failure path.
  const startingLiveRef = useRef(false);
  const [startingLive, setStartingLive] = useState(false);
  const [reportTarget, setReportTarget] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [shareNote, setShareNote] = useState('');
  // Regenerate-code in flight (double-tap guard — the server would
  // mint a second code, so the button answers "Changing…" instead).
  const [codeBusy, setCodeBusy] = useState(false);

  const workerUrl = getWorkerUrl();

  // Decide the mode once, from the build-time env var. Live is never
  // guessed: without NEXT_PUBLIC_WORKER_URL the page is demo, labelled.
  useEffect(() => {
    setMode(isLiveTransportEnabled() ? 'live' : 'demo');
  }, []);

  const goToPlay = () => {
    if (wentToPlayRef.current) return;
    wentToPlayRef.current = true;
    router.push(`/room/${roomId}/play`);
  };

  const appendLiveEvent = (text: string) => {
    setLiveEvents((prev) => [...prev, { at: new Date().toISOString(), text }]);
  };

  // --- demo load (demo mode only) ---
  useEffect(() => {
    if (mode !== 'demo') return;
    try {
      setDr(getRoom(roomId));
      try {
        setPause(JSON.parse(localStorage.getItem(PAUSE_KEY(roomId)) ?? 'null') as LobbyPause);
      } catch {
        setPause(null);
      }
    } catch {
      setLoadError('Could not load the lobby — try again.');
    }
    const id = setInterval(() => { setDr(getRoom(roomId)); }, 1000);
    return () => { clearInterval(id); };
  }, [mode, roomId]);

  // Online/offline banner — both modes.
  useEffect(() => {
    const onOnline = () => setOffline(false);
    const onOffline = () => setOffline(true);
    setOffline(typeof navigator !== 'undefined' && !navigator.onLine);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); };
  }, []);

  // --- live connect (live mode only) ---
  // 1. Load the saved seat (playerId + reconnect token). No seat on
  //    this device = no live lobby: never fall back to the demo store
  //    for a live room, and never invent a seat.
  // 2. GET the room once over HTTPS (AuthorisedSnapshot: room + roster).
  //    It renders the lobby before the socket lands; the WS snapshot
  //    then replaces it as the whole truth.
  // 3. Open the socket (ticket fetched over HTTPS with the reconnect
  //    token; the ticket travels only in the handshake query string).
  useEffect(() => {
    if (mode !== 'live') return;
    let cancelled = false;
    const url = getWorkerUrl();
    if (!url) {
      setLiveError('Live mode was expected but no Worker URL is configured — the app was built without NEXT_PUBLIC_WORKER_URL.');
      return;
    }
    const session = getSessionForRoom(roomId);
    if (!session || session.mode !== 'live' || !session.reconnectToken) {
      setLiveError('NO_SEAT');
      return;
    }
    const reconnectToken = session.reconnectToken;
    setLiveSession(session);
    setLiveError('');
    setLiveNotice('');
    const socket = createLivePakdamSocket({
      roomId, playerId: session.playerId, reconnectToken,
    });
    if (!socket) {
      setLiveError('Could not build the live connection — no Worker URL is configured.');
      return;
    }
    socketRef.current = socket;
    // FIX 2026-11-18: the Worker requires the seat's reconnect token
    // (Authorization: Bearer) for GET room state — playerId alone
    // 400s ("reconnectToken is required"), and the lobby showed
    // "Could not reach the live server" for every room. The token
    // helper (fetchLiveRoomState) already does this; this raw fetch
    // bypassed it. Proven live: same GET with the Bearer token → 200.
    void fetch(`${url}/v1/rooms/${roomId}?playerId=${encodeURIComponent(session.playerId)}`, {
      headers: { Authorization: `Bearer ${reconnectToken}` },
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 404 ? 'NOT_FOUND' : `HTTP_${r.status}`);
        const j = await r.json() as { room: Room; players: PlayerView[]; version: number };
        if (cancelled) return;
        // Initial view only — safety state, catches and seq are unknown
        // until the socket snapshot arrives; the banner says connecting.
        setSnap({
          room: j.room, players: j.players, phase: j.room.phase, version: j.version,
          serverSeq: 0, locationStatus: {}, activeCatches: [],
          safetyState: { paused: false, pausedBy: null, pausedAt: null, sosActive: false },
          missedAnnouncements: [],
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLiveError(err instanceof Error && err.message === 'NOT_FOUND'
          ? 'This room was not found, or this device is not a player in it. Check the room code and rejoin.'
          : 'Could not reach the live server — check your connection and try again.');
      });
    void socket.connect(roomId, {
      playerId: session.playerId,
      onSnapshot: (s) => {
        if (cancelled) return;
        setSnap(s);
        // The server is the authority on phase: any snapshot past the
        // lobby means the match started (or ended) — go to play.
        if (s.phase !== 'LOBBY') goToPlay();
      },
      onMessage: (msg: WsServerMessage) => {
        if (cancelled) return;
        const nameOf = (id: string | null): string =>
          snapRef.current?.players.find((p) => p.playerId === id)?.displayName
          ?? (id === session.playerId ? 'you' : 'a player');
        switch (msg.type) {
          case 'match.started':
            goToPlay();
            break;
          case 'room.state':
            // Roster-affecting change (ready, briefing, leave…): the
            // room.state message carries no roster, so re-request the
            // snapshot — the whole truth — instead of patching locally.
            if (msg.payload.phase !== 'LOBBY') goToPlay();
            else socket.requestSnapshot();
            break;
          case 'player.joined':
            appendLiveEvent(`${msg.payload.player.displayName} joined`);
            socket.requestSnapshot();
            break;
          case 'player.left':
            appendLiveEvent(`${msg.payload.player.displayName} left`);
            socket.requestSnapshot();
            break;
          case 'player.removed':
            appendLiveEvent(`${msg.payload.player.displayName} was removed from the lobby by the host`);
            socket.requestSnapshot();
            break;
          case 'reveal': {
            // D-M6: a player shared their position with the whole room
            // over the live reveal channel — the event log is this
            // lobby's receipt (the play map draws the coarse area).
            const byId = msg.payload.reveal.byPlayerId;
            appendLiveEvent(`${byId === session.playerId ? 'You' : nameOf(byId)} shared their position with everyone in the game — see the marked area`);
            break;
          }
          case 'player.suspended':
          case 'player.resumed':
            socket.requestSnapshot();
            break;
          case 'host.transferred':
            appendLiveEvent(`Host transferred to ${nameOf(msg.payload.newHostPlayerId)}`);
            socket.requestSnapshot();
            break;
          case 'announcement': {
            const a = msg.payload.announcement;
            appendLiveEvent(a.text);
            if (a.text.startsWith('Host check-in:')) {
              setLiveCheckins((prev) => [...prev, `${a.sentAt} — ${a.text}`]);
            }
            break;
          }
          case 'radio': {
            // Team Radio text (D-M7): a lobby message, relayed by the
            // DO to the whole lobby. Append (deduped by messageId),
            // keep the last 50. No snapshot refresh — radio is
            // ephemeral and the snapshot carries no radio history.
            const incoming = (msg as Extract<WsServerMessage, { type: 'radio' }>).payload.radio;
            setLiveRadio((prev) => prev.some((m) => m.messageId === incoming.messageId)
              ? prev : [...prev, incoming].slice(-50));
            break;
          }
          case 'safety.paused':
            appendLiveEvent(`Safety pause — ${nameOf(msg.payload.byPlayerId)} paused the start`);
            socket.requestSnapshot();
            break;
          case 'safety.resumed':
            appendLiveEvent('Safety pause lifted — the game can start again');
            socket.requestSnapshot();
            break;
          case 'sos.raised':
            appendLiveEvent(`SOS raised by ${nameOf(msg.payload.byPlayerId)} — host notified`);
            break;
          case 'error':
            setLiveNotice(msg.payload.message || 'The server refused that action.');
            break;
          default:
            break;
        }
      },
      onStateChange: (st, detail) => {
        if (cancelled) return;
        setSocketState(st);
        setSocketDetail(detail ?? '');
        if (st === 'connected') setLiveNotice('');
      },
    }).catch(() => {
      if (cancelled) return;
      setLiveError('Could not connect to the live room — check the Worker URL and your connection, then try again.');
    });
    return () => {
      cancelled = true;
      socket.close();
      socketRef.current = null;
    };
  }, [mode, roomId, liveRetry]);

  // Keep the host's in-progress Hunter picks in step with the saved picks (demo only).
  const savedPick = dr?.room.config.selectedHunterIds.join(',') ?? '';
  useEffect(() => {
    const cur = getRoom(roomId);
    if (cur) setPicked(cur.room.config.selectedHunterIds);
  }, [roomId, savedPick]);

  // Live: the same, from the server snapshot — a config change (from
  // this tab or another host action) re-syncs the pick checkboxes,
  // and a Hunter-count change clears the pick server-side, so the
  // local pick must follow the snapshot, not the stale local list.
  const liveSavedPick = snap?.room.config.selectedHunterIds.join(',') ?? '';
  useEffect(() => {
    if (mode === 'live' && snap) setPicked(snap.room.config.selectedHunterIds);
  }, [mode, liveSavedPick]);

  // --- derived view: one shape for the JSX, from demo or live ---
  // PlayerView carries every field the lobby reads; the reconnect-token
  // hash is never sent by the server and never read here.
  const room: Room | null = mode === 'live' ? snap?.room ?? null : dr?.room ?? null;
  const players: Player[] = mode === 'live'
    ? ((snap?.players ?? []) as Player[])
    : dr?.players ?? [];
  const checkins: string[] = mode === 'live' ? liveCheckins : dr?.checkins ?? [];
  const events: { at: string; text: string }[] = mode === 'live' ? liveEvents : dr?.events ?? [];
  const me = mode === 'live' ? liveSession?.playerId ?? null : currentPlayerId();
  const isHost = room !== null && room.hostPlayerId === me;
  const mePlayer = players.find((p) => p.playerId === me) ?? null;
  // Selected teams: the host must have picked exactly hunterCount Hunters
  // before the game can start (Random needs no pick).
  const teamsReady = room !== null
    && (room.config.teamAssignment === 'random' || room.config.selectedHunterIds.length === room.config.hunterCount);
  // Minimum to start is 3 players (host + two guests). The room's
  // maxPlayers range (3–30) is the room size, not the start minimum.
  // Live matches the server's rule (active seats only — leavers don't
  // block the start); demo keeps its existing all-seats rule.
  const MIN_PLAYERS = 3;
  const activePlayers = players.filter((p) => !p.leftAt);
  const canStart = room !== null && teamsReady && (mode === 'live'
    ? activePlayers.length >= MIN_PLAYERS && activePlayers.every((p) => p.isReady)
    : players.length >= MIN_PLAYERS && players.every((p) => p.isReady));
  const notReady = (mode === 'live' ? activePlayers : players).filter((p) => !p.isReady);
  const readyCount = players.filter((p) => p.isReady).length;
  const livePause: LobbyPause = mode === 'live' && snap?.safetyState.paused
    ? {
      by: snap.safetyState.pausedBy ?? '',
      byName: players.find((p) => p.playerId === snap.safetyState.pausedBy)?.displayName ?? 'the host',
      at: snap.safetyState.pausedAt ?? new Date().toISOString(),
    }
    : null;
  const pauseActive = mode === 'live' ? livePause !== null : pause !== null;
  const inviteLink = room !== null && typeof window !== 'undefined'
    ? `${window.location.origin}/join/${room.roomCode}` : room !== null ? `/join/${room.roomCode}` : '';

  // --- early returns ---
  if (mode === null) return <div aria-busy="true"><h1>Loading lobby…</h1><div className="skeleton skeleton-lg" aria-hidden="true" /><p>Players appear here once loaded.</p></div>;
  if (mode === 'demo') {
    if (loadError) return <div><h1>Lobby</h1><p role="alert">{loadError}</p><p><button className="btn" onClick={() => { setLoadError(''); setDr(getRoom(roomId)); }}>Retry</button></p></div>;
    if (!dr) return <div aria-busy="true"><h1>Loading lobby…</h1><div className="skeleton skeleton-lg" aria-hidden="true" /><div className="skeleton" style={{ width: '70%' }} aria-hidden="true" /><div className="skeleton" style={{ width: '45%' }} aria-hidden="true" /><p>Players appear here once loaded.</p></div>;
  }
  if (mode === 'live') {
    if (liveError === 'NO_SEAT') {
      return (
        <div>
          <h1>Lobby</h1>
          <p role="alert">No live seat saved on this device for this room.</p>
          <p className="small">Live rooms save their seat (and its reconnect token) on the device that created or joined them. This tab has none for this room — go home and rejoin with the room code; demo rooms on this device are separate and are not this room.</p>
          <p><button className="btn" onClick={() => router.push('/')}>Go home</button></p>
        </div>
      );
    }
    if (liveError) {
      return (
        <div>
          <h1>Lobby</h1>
          <p role="alert">{liveError}</p>
          <p><button className="btn" onClick={() => { setLiveError(''); setLiveRetry((n) => n + 1); }}>Retry</button></p>
          <p><button className="btn btn-secondary" onClick={() => router.push('/')}>Go home</button></p>
        </div>
      );
    }
    if (!snap) return <div aria-busy="true"><h1>Connecting to the live room…</h1><div className="skeleton skeleton-lg" aria-hidden="true" /><p>Players appear here once the server answers.</p></div>;
  }
  if (!room) return <div aria-busy="true"><h1>Loading lobby…</h1><div className="skeleton skeleton-lg" aria-hidden="true" /><p>Players appear here once loaded.</p></div>;

  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(`${label} copied ✓`);
    } catch {
      setCopied(`Copy didn’t work in this browser — long-press the ${label.toLowerCase()} to copy it.`);
    }
    window.setTimeout(() => setCopied(''), 3000);
  };

  const shareCode = async () => {
    // Live: the invite link would open the demo join page, not this live
    // room (live join is not wired yet) — share the code only.
    const text = mode === 'live'
      ? `Join my Pakdam game — room code ${room.roomCode}. (Live join link coming soon — join with the code once it lands.)`
      : `Join my Pakdam game — room code ${room.roomCode}. ${inviteLink}`;
    const nav = navigator as Navigator & { share?: (data: { title?: string; text?: string; url?: string }) => Promise<void> };
    if (nav.share) {
      try {
        await nav.share(mode === 'live' ? { title: 'Join my Pakdam game', text } : { title: 'Join my Pakdam game', text, url: inviteLink });
        setShareNote('Shared — the invite went out from your phone’s share sheet.');
        return;
      } catch {
        // Share cancelled or unavailable: fall through to copy.
      }
    }
    if (mode === 'live') {
      await copyText(room.roomCode, 'Room code');
      setShareNote('Sharing is not available in this browser, so the room code was copied instead.');
    } else {
      await copyText(inviteLink, 'Invite link');
      setShareNote('Sharing is not available in this browser, so the invite link was copied instead.');
    }
  };

  // --- demo handlers (demo mode only) ---
  const handleReportFiledDemo = (report: { subjectName: string; reason: ReportReason; detail: string; blocked: boolean }) => {
    fileReport({
      reporterName: mePlayer?.displayName ?? null,
      subjectName: report.subjectName,
      roomCode: room.roomCode,
      reason: report.reason,
      detail: report.detail,
    });
    appendRoomEvent(roomId, `Report filed about ${report.subjectName} (${report.reason}) — host to review${report.blocked ? '; reporter also blocked them on their device' : ''}`);
    setDr(getRoom(roomId));
  };

  const handlePauseChangeDemo = (next: LobbyPause) => {
    setPause(next);
    if (next) {
      localStorage.setItem(PAUSE_KEY(roomId), JSON.stringify(next));
      appendRoomEvent(roomId, `Safety pause — ${next.byName} paused the start`);
    } else {
      localStorage.removeItem(PAUSE_KEY(roomId));
      appendRoomEvent(roomId, 'Safety pause lifted — the game can start again');
    }
    setDr(getRoom(roomId));
  };

  const handleRemove = (playerId: string, displayName: string) => {
    // Roster already confirmed before calling (its own confirm dialog).
    if (mode === 'live') { void removePlayerLive(playerId, displayName); return; }
    if (!window.confirm(`Remove ${displayName} from the lobby? They can rejoin with the room code.`)) return;
    if (removePlayerLocal(roomId, playerId, displayName)) setDr(getRoom(roomId));
  };

  /** Host token for host-only HTTPS actions (config, remove, code,
   *  start). The token stored at create (liveSession.hostToken) is
   *  used first; a host seat without one mints a fresh token with
   *  its reconnect token (POST /host/token) and stores it. NEVER the
   *  reconnect token itself, never a display name — the server
   *  rejects both with 403. */
  const getHostTokenLive = async (): Promise<string> => {
    const stored = liveSession?.hostToken;
    if (stored) return stored;
    if (!liveSession?.reconnectToken || !workerUrl) {
      throw new Error('No host credential saved on this device — rejoin as the host to get one.');
    }
    const token = await fetchHostToken(workerUrl, roomId, liveSession.playerId, liveSession.reconnectToken);
    setLiveSession(saveLiveSession({ ...liveSession, hostToken: token }));
    return token;
  };

  /** D-M5 (live): host removes a lobby player. The server marks the
   *  seat left and broadcasts player.removed to every socket, and
   *  this tab re-requests the snapshot — the roster updates for
   *  everyone, including the removed player's tab. The removed
   *  player can rejoin with the room code. */
  const removePlayerLive = async (playerId: string, displayName: string) => {
    if (!liveSession || !workerUrl) return;
    try {
      const hostToken = await getHostTokenLive();
      await removeLivePlayer(workerUrl, roomId, liveSession.playerId, hostToken, playerId);
      setLiveNotice(`${displayName} was removed from the lobby. They can rejoin with the room code.`);
      socketRef.current?.requestSnapshot();
    } catch (err) {
      setLiveNotice(err instanceof Error ? err.message : 'Could not remove that player.');
    }
  };

  /** D-M4 (live): save the HostSettingsSheet draft to the live
   *  server. The DO re-validates the full config and enforces
   *  host-only + LOBBY-only; changing the Hunter count or the team
   *  assignment clears the host-picked Hunters server-side, and the
   *  snapshot below carries the cleared pick back to this tab. */
  const saveSettingsLive = async (next: RoomConfig) => {
    if (!liveSession || !workerUrl) return;
    try {
      const hostToken = await getHostTokenLive();
      const updated = await updateLiveRoomConfig(workerUrl, roomId, liveSession.playerId, hostToken, next);
      setSnap((prev) => (prev ? { ...prev, room: updated } : prev));
      setSettingsError('');
      setSettingsOpen(false);
      setLiveNotice('Settings saved — the new rules apply to everyone in this lobby.');
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : 'Could not save settings');
    }
  };

  /** D-M4 (live): flip Random ↔ host-picked Hunters. Same endpoint
   *  as the settings sheet (a full-config save with one field
   *  changed); the server clears the pick on the flip. */
  const switchTeamAssignmentLive = async () => {
    if (!liveSession || !workerUrl || !room) return;
    try {
      const hostToken = await getHostTokenLive();
      const updated = await updateLiveRoomConfig(workerUrl, roomId, liveSession.playerId, hostToken, {
        ...room.config,
        teamAssignment: room.config.teamAssignment === 'random' ? 'selected' : 'random',
      });
      setSnap((prev) => (prev ? { ...prev, room: updated } : prev));
      setTeamError('');
    } catch (err) {
      setTeamError(err instanceof Error ? err.message : 'Could not switch team setup');
    }
  };

  /** D-M4 (live): save the host-picked Hunters. Same endpoint, full
   *  config with selectedHunterIds set — the server refuses a pick
   *  whose length is not the Hunter count (409), so the length is
   *  checked here first with the plain-words answer. */
  const savePickedLive = async () => {
    if (!room) return;
    if (picked.length !== room.config.hunterCount) {
      setTeamError(`Pick exactly ${room.config.hunterCount} Hunter(s) — you have picked ${picked.length}. Tick or untick a player first.`);
      return;
    }
    if (!liveSession || !workerUrl) return;
    try {
      const hostToken = await getHostTokenLive();
      const updated = await updateLiveRoomConfig(workerUrl, roomId, liveSession.playerId, hostToken, {
        ...room.config, selectedHunterIds: picked,
      });
      setSnap((prev) => (prev ? { ...prev, room: updated } : prev));
      setTeamError('');
    } catch (err) {
      setTeamError(err instanceof Error ? err.message : 'Could not save Hunters');
    }
  };

  /** D-M2: change the room code (host only). Live: the server
   *  generates the fresh code, registers it, swaps it in and
   *  unregisters the old one — the old code stops working at once
   *  and the new code is the one to share. This tab's session and
   *  snapshot are updated to the new code, and the broadcast
   *  room.state (reason 'code-regenerated') updates every other
   *  lobby tab. Demo: the same rule, local only — a fresh crypto
   *  code replaces the old one, which then resolves to nothing. */
  const regenerateCode = async () => {
    if (!isHost || codeBusy) return;
    if (!window.confirm('Change the room code? The old code stops working at once — anyone still joining must use the new code. Players already in the lobby stay in.')) return;
    if (mode === 'live') {
      if (!liveSession || !workerUrl) return;
      setCodeBusy(true);
      try {
        const hostToken = await getHostTokenLive();
        const { roomCode: newCode } = await regenerateLiveRoomCode(workerUrl, roomId, liveSession.playerId, hostToken);
        setLiveSession(saveLiveSession({ ...liveSession, hostToken, roomCode: newCode }));
        setSnap((prev) => (prev ? { ...prev, room: { ...prev.room, roomCode: newCode } } : prev));
        setLiveNotice(`Room code changed to ${newCode} — the old code no longer works. Share the new code.`);
      } catch (err) {
        setLiveNotice(err instanceof Error ? err.message : 'Could not change the room code.');
      } finally {
        setCodeBusy(false);
      }
      return;
    }
    const all = loadAll();
    const current = all[roomId];
    if (!current) return;
    let next = generateRoomCode();
    while (next === current.room.roomCode) next = generateRoomCode();
    current.room.roomCode = next;
    current.room.version += 1;
    current.events.push({ at: new Date().toISOString(), text: 'Room code changed — the old code no longer works' });
    localStorage.setItem(DEMO_KEY, JSON.stringify(all));
    setDr(getRoom(roomId));
    setCopied(`New room code ${next} — the old code no longer works`);
    window.setTimeout(() => setCopied(''), 3000);
  };

  const togglePick = (playerId: string) => {
    if (picked.includes(playerId)) { setPicked(picked.filter((id) => id !== playerId)); setTeamError(''); return; }
    if (picked.length >= room.config.hunterCount) { setTeamError(`Pick exactly ${room.config.hunterCount} Hunter(s) — uncheck one first.`); return; }
    setPicked([...picked, playerId]); setTeamError('');
  };

  const startGame = () => {
    // Never a silent disabled button (same rule as CREATE LOBBY): a
    // tap always answers in plain language — who is not ready, what
    // is missing — or starts the game.
    if (pause) { setStartError('The game is paused for safety — resume the safety pause above before starting.'); return; }
    if (!canStart) {
      const reasons: string[] = [];
      if (players.length < MIN_PLAYERS) reasons.push(`need at least ${MIN_PLAYERS} players — share the room code above`);
      if (notReady.length > 0) reasons.push(`waiting for: ${notReady.map((p) => p.displayName).join(', ')}`);
      if (!teamsReady) reasons.push(`pick ${room.config.hunterCount} Hunter(s) in Teams below first`);
      setStartError(`Cannot start yet — ${reasons.join('; ')}.`);
      return;
    }
    try {
      setPhase(roomId, 'READY_CHECK');
      setPhase(roomId, 'COUNTDOWN');
      setPhase(roomId, 'HEAD_START');
      router.push(`/room/${roomId}/play`);
    } catch (err) { setStartError(err instanceof Error ? err.message : 'Could not start the game'); }
  };

  // --- live handlers (live mode only) ---
  const toggleReadyLive = () => {
    const socket = socketRef.current;
    if (!socket || !mePlayer) return;
    const next = !mePlayer.isReady;
    if (!socket.sendCommand('ready.set', { isReady: next })) {
      setLiveNotice('Not connected — your readiness was not sent. Wait for the reconnect, then tap again.');
      return;
    }
    // Tapping "I'm ready" also confirms the briefing (the server keeps
    // the two separately: ready.set only flips isReady).
    if (next && !mePlayer.briefingConfirmed) socket.sendCommand('briefing.confirm', {});
    setLiveNotice('');
  };

  const hostCheckinLive = () => {
    const socket = socketRef.current;
    if (!socket) return;
    // No dedicated host-checkin endpoint exists: the check-in rides on
    // announcement.send, which is host-only on the server and broadcast
    // to the room — the lobby lists it under Host check-ins on echo.
    if (!socket.sendCommand('announcement.send', { text: 'Host check-in: lobby — all players accounted for' })) {
      setLiveNotice('Not connected — the check-in was not sent. Wait for the reconnect, then try again.');
    }
  };

  const acknowledgeLive = (note: string) => {
    // The warning tick-box has no server channel for a guest
    // (announcement.send is host-only). The host's acknowledgement is
    // announced to the room; a guest's stays on their device, and the
    // checklist says so. The server's briefing record is
    // briefing.confirm, sent with "I'm ready".
    if (isHost) socketRef.current?.sendCommand('announcement.send', { text: note });
  };

  const leaveLive = () => {
    // Best-effort leave over the socket, then drop the saved seat: the
    // stored token belongs to the seat just left, and rejoining issues
    // a fresh one. The server also marks the seat disconnected when
    // the socket closes, so leaving works even if the send above fails.
    socketRef.current?.sendCommand('leave', { reason: 'left from the lobby' });
    clearSession();
    router.push('/');
  };

  // Leave room, from the header (wireframe 05-lobby: "Lobby LEAVE").
  // Same confirm + seat handling as the old button below "I'm ready".
  const handleLeave = () => {
    if (mode === 'live') {
      if (!window.confirm('Leave this room? You will leave the lobby — you can rejoin with the room code once live join is wired.')) return;
      leaveLive();
      return;
    }
    if (!window.confirm('Leave this room? You will leave the lobby — you can rejoin with the room code.')) return;
    if (!mePlayer) return;
    leaveRoom(roomId, mePlayer.playerId);
    clearCurrentPlayerId();
    router.push('/');
  };

  const handlePauseChangeLive = (next: LobbyPause) => {
    const socket = socketRef.current;
    if (!socket) return;
    if (next) socket.sendCommand('safety.pause', { reason: null });
    else socket.sendCommand('safety.resume', {});
  };

  const sosLive = () => {
    socketRef.current?.sendCommand('safety.sos', { reason: null });
  };

  const revealLive = () => {
    // D-M6: the live reveal channel. The 2 s hold already happened
    // in LobbySafety; now get this device's current position and
    // send it as `reveal.send` — the DO validates the fix and
    // broadcasts a coarse 150 m `reveal` area to EVERY socket, so
    // all players see it (this lobby logs it; the play map draws
    // the area). No fix, no socket, no claim: any failure sets a
    // plain notice and shares nothing. Any seat may reveal — this
    // is a safety feature, not a host power — so there is no isHost
    // gate here.
    const socket = socketRef.current;
    if (!socket || !mePlayer) {
      setLiveNotice('Not connected — your position was not shared. Wait for the reconnect, then hold again.');
      return;
    }
    if (!('geolocation' in navigator)) {
      setLiveNotice('This device could not share a position — no location is available. No position was shared.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const fix: LocationFix = {
          playerId: mePlayer.playerId, roomId,
          lat: pos.coords.latitude, lng: pos.coords.longitude,
          accuracyMeters: Math.max(1, Math.round(pos.coords.accuracy)),
          capturedAt: new Date(pos.timestamp).toISOString(),
          receivedAt: new Date().toISOString(),
          // Client-side tier only — the server re-decides the quality
          // from its own GPS validation before anything is broadcast.
          quality: pos.coords.accuracy <= 50 ? 'good' : pos.coords.accuracy <= 150 ? 'fair' : 'poor',
        };
        if (!socket.sendCommand('reveal.send', { fix })) {
          setLiveNotice('Not connected — your position was not shared. Wait for the reconnect, then hold again.');
          return;
        }
        appendLiveEvent(`${mePlayer.displayName} shared their position with everyone in the game (hold-to-reveal)`);
        setLiveNotice('');
      },
      () => {
        setLiveNotice('Could not get your location — check location permission and hold again. No position was shared.');
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
    );
  };

  const handleReportFiledLive = (report: { subjectName: string; reason: ReportReason; detail: string; blocked: boolean }) => {
    // Filing the report is device-local (fileReport) in both modes;
    // live has no report endpoint, so the room-log line is a
    // session-only note, not a server event.
    fileReport({
      reporterName: mePlayer?.displayName ?? null,
      subjectName: report.subjectName,
      roomCode: room.roomCode,
      reason: report.reason,
      detail: report.detail,
    });
    appendLiveEvent(`Report filed about ${report.subjectName} (${report.reason}) — host to review${report.blocked ? '; reporter also blocked them on their device' : ''}`);
  };

  const startGameLive = async () => {
    if (!liveSession || !liveSession.reconnectToken || !workerUrl) return;
    if (startingLiveRef.current) return;
    if (pauseActive) { setStartError('The game is paused for safety — resume the safety pause above before starting.'); return; }
    if (!canStart) {
      const reasons: string[] = [];
      if (activePlayers.length < MIN_PLAYERS) reasons.push(`need at least ${MIN_PLAYERS} players — share the room code above`);
      if (notReady.length > 0) reasons.push(`waiting for: ${notReady.map((p) => p.displayName).join(', ')}`);
      if (!teamsReady) reasons.push(`Hunter setup is incomplete — see Teams above`);
      setStartError(`Cannot start yet — ${reasons.join('; ')}.`);
      return;
    }
    setStartError('');
    startingLiveRef.current = true;
    setStartingLive(true);
    try {
      // Host proof is the HOST token (Worker 5, SEC-06): /start
      // requires { playerId, hostToken } — the reconnect token proves
      // the seat, not host authority, and the server 400s it.
      let hostToken: string;
      try {
        hostToken = await getHostTokenLive();
      } catch {
        setStartError('No host credential saved on this device — rejoin as the host to get one.');
        startingLiveRef.current = false;
        setStartingLive(false);
        return;
      }
      const r = await fetch(`${workerUrl}/v1/rooms/${roomId}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: liveSession.playerId, hostToken }),
      });
      if (!r.ok) {
        const text = (await r.text().catch(() => '')).trim();
        setStartError(r.status === 403
          ? 'Only the host can start the game.'
          : r.status === 409
            ? `The server refused to start: ${text || 'the room is not ready'}.`
            : `Could not start the game (${r.status}) — try again.`);
        startingLiveRef.current = false;
        setStartingLive(false);
        return;
      }
      // The server also broadcasts match.started; goToPlay is guarded
      // so a double signal still navigates once.
      goToPlay();
    } catch {
      setStartError('Could not reach the live server — check your connection and try again.');
      startingLiveRef.current = false;
      setStartingLive(false);
    }
  };

  return (
    <div>
      <div className={styles.hero}>
        <span className={styles.heroSpacer} aria-hidden="true" />
        <h1>Lobby</h1>
        {mePlayer ? (
          <button type="button" className="btn btn-secondary" onClick={handleLeave}>Leave room</button>
        ) : (
          <span className={styles.heroSpacer} aria-hidden="true" />
        )}
      </div>

      {mode === 'live' ? (
        <div className="banner" role="status">
          <strong>Live lobby</strong>{socketState === 'connected' ? ' · Connected' : ` · ${socketStateLabel(socketState)}${socketDetail ? ` — ${socketDetail}` : ''}.`}
          {socketState === 'reconnect-failed' ? (
            <> <button type="button" className="btn btn-secondary" onClick={() => void socketRef.current?.retry()}>Retry connection</button></>
          ) : null}
        </div>
      ) : (
        <div className="banner" role="status"><strong>Demo lobby</strong> — stored only on this device.</div>
      )}
      {liveNotice ? <div className="banner" role="status">{liveNotice}</div> : null}

      <div className={styles.codeHero}>
        <div className={styles.codeLabel}>Room code</div>
        <div className={styles.codeValue} aria-label={`Room code ${room.roomCode.split('').join(' ')}`}>{room.roomCode}</div>
        <div className={styles.codeActions}>
          <button type="button" onClick={() => void copyText(room.roomCode, 'Room code')}>Copy code</button>
          <button type="button" onClick={() => void shareCode()}>Share code</button>
          {isHost ? <button type="button" onClick={() => setSettingsOpen(true)}>Settings</button> : null}
          {isHost ? <button type="button" aria-disabled={codeBusy} onClick={() => void regenerateCode()}>{codeBusy ? 'Changing…' : 'Change code'}</button> : null}
          {mode === 'demo' ? <button type="button" onClick={() => void copyText(inviteLink, 'Invite link')}>Copy invite link</button> : null}
        </div>
        {copied ? <p className={styles.copiedNote} role="status">{copied}</p> : null}
        {shareNote && !copied ? <p className={styles.copiedNote} role="status">{shareNote}</p> : null}
        {mode === 'live' ? (
          <p className={styles.copiedNote}>Share the code — no account needed to join.</p>
        ) : (
          <p className={styles.copiedNote}>Share the code or the link — no account needed to join.</p>
        )}
      </div>

      {/* Compact summary strip — one line from the room's real
          settings, via roomSummaryStrip (the same builder the setup
          form uses: "500m zone · 1 hunter · 30s pulse · 10m").
          Tapping it opens the Game Settings sheet for the host; a
          guest tapping it is told only the host can change the
          settings. It re-renders from room.config, so saving in the
          sheet updates the strip live. */}
      <button
        type="button"
        className={styles.summaryStripButton}
        onClick={() => {
          if (isHost) { setSettingsOpen(true); return; }
          setCopied('Only the host can change the game settings.');
          window.setTimeout(() => setCopied(''), 3000);
        }}
        aria-label={`Game settings: ${roomSummaryStrip(draftFromConfig(room.config))}. ${isHost ? 'Tap to open game settings.' : 'Only the host can change the settings.'}`}
      >
        {roomSummaryStrip(draftFromConfig(room.config))}
      </button>

      {/* Start gate — the lobby cannot start until 3+ players are in. */}
      {players.length < MIN_PLAYERS ? (
        <div className={styles.needPlayers} role="status">
          <strong>NEED 3+ PLAYERS TO START</strong>
          <p>
            {players.length} of at least {MIN_PLAYERS} players in. Share the code above — the game starts once
            everyone here is ready.
          </p>
        </div>
      ) : !canStart ? (
        <div className={styles.needPlayers} role="status">
          <strong>Waiting for everyone to be ready</strong>
          <p>
            {players.length} players in · {readyCount} ready. The host starts the game once every player has
            tapped “I’m ready”{!teamsReady ? ` and picked ${room.config.hunterCount} Hunter(s)` : ''}.
          </p>
        </div>
      ) : (
        <div className={`${styles.needPlayers} ${styles.needPlayersReady}`} role="status">
          <strong>✓ Ready to start</strong>
          <p>Everyone is ready — the host can start the game.</p>
        </div>
      )}

      <section className="card" aria-label="Players">
        <h2 className={styles.sectionTitle}>Players ({players.length}/{room.config.maxPlayers})</h2>
        <p className={styles.sectionSub}>
          {readyCount} of {players.length} ready.
        </p>
        {players.length === 0 ? <p>No players yet — share the invite link or room code.</p> : (
          <Roster players={players} meId={me} isHost={isHost} onRemove={isHost ? handleRemove : undefined} onReport={(_playerId, displayName) => setReportTarget(displayName)} />
        )}
      </section>

      {offline ? <div className="banner" role="status"><strong>You are offline — reconnecting…</strong> The roster below is last-known, shown with last-seen times, never as live.</div> : null}

      <section className="card" aria-label="Role preview">
        <h2 className={styles.sectionTitle}>Your role is decided when the game starts</h2>
        <p className={styles.sectionSub}>Hunter: follow rough pings, scan the Runner’s QR to catch.</p>
        <p className={styles.sectionSub}>Runner: hide, outlast the clock — nothing exact is ever shared.</p>
      </section>

      <ReadinessChecklist
        players={players}
        meId={me}
        roomId={roomId}
        mode={mode === 'live' ? 'live' : 'demo'}
        onAcknowledgeLive={mode === 'live' ? acknowledgeLive : undefined}
      />

      {mePlayer ? (
        <div className={styles.primaryAction}>
          <button
            className="btn"
            type="button"
            onClick={() => {
              if (mode === 'live') toggleReadyLive();
              else { toggleReady(roomId, mePlayer.playerId); setDr(getRoom(roomId)); }
            }}
            aria-pressed={mePlayer.isReady}
          >
            {mePlayer.isReady ? '✓ I’m ready — tap to change' : 'I’m ready'}
          </button>
          <p className={`small ${styles.center}`}>{mePlayer.isReady ? 'You are ready. The host starts the game when everyone is ready.' : 'Tap when you have read the rules and run your checks.'}</p>
          {/* Leave / switch player (founder bug, 2026-11-17): the lobby
              had no way to leave or change seats, and joining as a
              second player in the same browser stole the first
              player's identity. Identity is per-tab now (sessionStorage),
              so another tab joining cannot take this tab's seat; these
              buttons let THIS tab leave or switch seats on purpose.
              Leaving keeps your seat listed as left — rejoin with the
              same display name to come back, host powers included. */}
          {mode === 'demo' ? (
            <p style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
              <button type="button" className="btn btn-secondary" onClick={() => { if (!window.confirm('Switch player? This tab will leave its current seat — you can rejoin with the room code.')) return; clearCurrentPlayerId(); router.push(`/join/${room.roomCode}`); }}>Switch player</button>
            </p>
          ) : null}
        </div>
      ) : mode === 'live' && snap ? (
        <div className={styles.primaryAction}>
          <p role="alert">Your seat is not in this room’s roster — the server does not list this device as a player. Rejoin with the room code.</p>
        </div>
      ) : null}

      <LobbySafety
        meId={me}
        meName={mePlayer?.displayName ?? null}
        isHost={isHost}
        pause={mode === 'live' ? livePause : pause}
        onPauseChange={mode === 'live' ? handlePauseChangeLive : handlePauseChangeDemo}
        onSos={() => {
          if (mode === 'live') {
            sosLive();
            if (mePlayer) appendLiveEvent(`SOS raised by ${mePlayer.displayName} — host notified`);
          } else {
            if (mePlayer) appendRoomEvent(roomId, `SOS raised by ${mePlayer.displayName} — host notified`);
            setDr(getRoom(roomId));
          }
        }}
        onReveal={() => {
          if (mode === 'live') revealLive();
          else {
            if (mePlayer) appendRoomEvent(roomId, `${mePlayer.displayName} shared their position with everyone in the game (hold-to-reveal)`);
            setDr(getRoom(roomId));
          }
        }}
      />

      <TeamRadio
        roomId={roomId}
        scope="lobby"
        meName={mePlayer?.displayName ?? null}
        liveText={mode === 'live' ? {
          messages: liveRadio,
          connected: socketState === 'connected',
          send: (text, kind) => socketRef.current?.sendRadioMessage(text, kind) ?? false,
        } : undefined}
      />

      {isHost ? (
        <div className="card">
          <h2>Host controls</h2>
          {mode === 'live' ? (
            <div>
              <h3>Teams — who is a Hunter?</h3>
              <p className="small">
                {room.config.teamAssignment === 'random'
                  ? 'Random: Hunters are picked when the game starts.'
                  : `Selected: pick exactly ${room.config.hunterCount} Hunter(s) below, then save.`}
              </p>
              <p><button type="button" className="btn btn-secondary" onClick={() => void switchTeamAssignmentLive()}>Switch to {room.config.teamAssignment === 'random' ? 'host-picked Hunters' : 'Random'}</button></p>
              {room.config.teamAssignment === 'selected' ? (
                <>
                  {players.map((p) => (
                    <p key={p.playerId}><label><input type="checkbox" checked={picked.includes(p.playerId)} onChange={() => togglePick(p.playerId)} /> {p.displayName}{p.isHost ? ' (host)' : ''}</label></p>
                  ))}
                  {/* Never disabled: a tap always answers — how many
                      Hunters are picked and how many are needed — or
                      saves. A disabled Save gave no feedback at all. */}
                  <p><button type="button" className="btn btn-secondary" aria-disabled={picked.length !== room.config.hunterCount} onClick={() => void savePickedLive()}>Save Hunters ({picked.length}/{room.config.hunterCount})</button></p>
                  <p className="small">Saved Hunters: {room.config.selectedHunterIds.length ? room.config.selectedHunterIds.map((id) => players.find((p) => p.playerId === id)?.displayName ?? id).join(', ') : 'none yet'}</p>
                  {teamError ? <p role="alert">{teamError}</p> : null}
                </>
              ) : null}
              {room.config.teamAssignment === 'selected' && room.config.selectedHunterIds.length !== room.config.hunterCount ? (
                <p role="alert">This room needs the host to pick exactly {room.config.hunterCount} Hunter(s) before it can start — pick them above and save.</p>
              ) : null}
            </div>
          ) : room.phase === 'LOBBY' ? (
            <div>
              <h3>Teams — who is a Hunter?</h3>
              <p className="small">{room.config.teamAssignment === 'random' ? 'Random: Hunters are picked when the game starts.' : `Selected: pick exactly ${room.config.hunterCount} Hunter(s) below, then save.`}</p>
              <p><button type="button" className="btn btn-secondary" onClick={() => { setTeamAssignment(roomId, room.config.teamAssignment === 'random' ? 'selected' : 'random'); setTeamError(''); setDr(getRoom(roomId)); }}>Switch to {room.config.teamAssignment === 'random' ? 'host-picked Hunters' : 'Random'}</button></p>
              {room.config.teamAssignment === 'selected' ? (
                <>
                  {players.map((p) => (
                    <p key={p.playerId}><label><input type="checkbox" checked={picked.includes(p.playerId)} onChange={() => togglePick(p.playerId)} /> {p.displayName}{p.isHost ? ' (host)' : ''}</label></p>
                  ))}
                  {/* Never disabled: a tap always answers — how many
                      Hunters are picked and how many are needed — or
                      saves. A disabled Save gave no feedback at all. */}
                  <p><button type="button" className="btn btn-secondary" aria-disabled={picked.length !== room.config.hunterCount} onClick={() => { if (picked.length !== room.config.hunterCount) { setTeamError(`Pick exactly ${room.config.hunterCount} Hunter(s) — you have picked ${picked.length}. Tick or untick a player first.`); return; } try { setSelectedHunters(roomId, picked); setTeamError(''); setDr(getRoom(roomId)); } catch (err) { setTeamError(err instanceof Error ? err.message : 'Could not save Hunters'); } }}>Save Hunters ({picked.length}/{room.config.hunterCount})</button></p>
                  <p className="small">Saved Hunters: {room.config.selectedHunterIds.length ? room.config.selectedHunterIds.map((id) => players.find((p) => p.playerId === id)?.displayName ?? id).join(', ') : 'none yet'}</p>
                  {teamError ? <p role="alert">{teamError}</p> : null}
                </>
              ) : null}
            </div>
          ) : null}
          {/* Never disabled: a tap always answers in plain language
              (see startGame) or starts the game. */}
          <p><button className="btn" aria-disabled={!canStart || pauseActive || startingLive} onClick={mode === 'live' ? () => void startGameLive() : startGame}>{mode === 'live' && startingLive ? 'Starting…' : 'Start game'}</button></p>
          {startError ? <p role="alert">{startError}</p> : null}
          {mode === 'live' ? (
            <>
              {!canStart ? <p className="small">Need at least {MIN_PLAYERS} players, and everyone ready. {notReady.length > 0 ? `Waiting for: ${notReady.map((p) => p.displayName).join(', ')}.` : ''} {!teamsReady ? ' Hunter setup is incomplete — see Teams above.' : ''} The server also refuses to start until every player still in the room is ready.</p> : null}
              {pauseActive ? <p className="small">Start is held by a safety pause. Resume it in the safety panel above to start.</p> : null}
            </>
          ) : (
            <>
              {!canStart ? <p className="small">Need at least {MIN_PLAYERS} players, and everyone ready. {notReady.length > 0 ? `Waiting for: ${notReady.map((p) => p.displayName).join(', ')}.` : ''} {!teamsReady ? `Pick ${room.config.hunterCount} Hunter(s) in Teams above first.` : ''} The host may start without a player who is not ready, once the minimum is met — use “I’m ready” above for yourself first.</p> : null}
              {pause ? <p className="small">Start is held by a safety pause. Resume it in the safety panel above to start.</p> : null}
            </>
          )}
          <p><button className="btn btn-secondary" onClick={() => { if (mode === 'live') hostCheckinLive(); else { hostCheckin(roomId, 'Lobby — all players accounted for'); setDr(getRoom(roomId)); } }}>Host check-in: lobby</button></p>
          {checkins.length === 0 ? null : (
            <>
              <h3>Host check-ins</h3>
              <ul>{checkins.map((c, i) => <li key={i}>{c}</li>)}</ul>
            </>
          )}
        </div>
      ) : null}

      {events.length === 0 ? null : (
        <section className="card" aria-label="Room events">
          <h2 className={styles.sectionTitle}>What has happened</h2>
          {mode === 'live' ? <p className="small">Only events received while this tab was connected are shown — the server keeps the full log.</p> : null}
          <ul className={styles.eventList}>
            {events.map((e, i) => (
              <li key={i}><span className={styles.eventTime}>{new Date(e.at).toLocaleTimeString()}</span> — {e.text}</li>
            ))}
          </ul>
        </section>
      )}

      {reportTarget ? (
        <ReportBlockSheet
          subjectName={reportTarget}
          reporterName={mePlayer?.displayName ?? null}
          roomCode={room.roomCode}
          onClose={() => setReportTarget(null)}
          onFiled={mode === 'live' ? handleReportFiledLive : handleReportFiledDemo}
        />
      ) : null}
      {settingsOpen && isHost ? (
        <HostSettingsSheet
          open={settingsOpen}
          config={room.config}
          onDone={(next) => {
            if (mode === 'live') { void saveSettingsLive(next); return; }
            try {
              updateRoomConfig(roomId, next);
              setSettingsError('');
              setSettingsOpen(false);
              setDr(getRoom(roomId));
            } catch (err) {
              setSettingsError(err instanceof Error ? err.message : 'Could not save settings');
            }
          }}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
      {settingsError ? <p role="alert">{settingsError}</p> : null}
    </div>
  );
}
