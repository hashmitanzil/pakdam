'use client';
import { use, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { getRoom, setPhase, leaveRoom, hostCheckin, recordPlayerSuspension, resumePlayer, recordPlayerFix, recordZoneExit, currentPlayerId, confirmCatch, ejectPlayer } from '@/lib/demo-store';
import { getCurrentFix, watchForegroundLocation, type ForegroundFix } from '@/lib/geolocation';
import { requestWakeLock } from '@/lib/wake-lock';
import { CALIBRATION_OPEN, OUTSIDE_ZONE_RETURN_SECONDS, ZONE_AUTO_CENTRE_MAX_ACCURACY_M } from '@pakdam/shared';
import type { CatchEvent, CatchView, LocationFix, Ping, Player, PlayerView, RadioMessage, WsServerMessage, WsSnapshotPayload } from '@pakdam/shared';
import { createLivePakdamSocket, getWorkerUrl, type PakdamSocket, type PakdamSocketState } from '@/lib/websocket';
import { getSessionForRoom, type PakdamSession } from '@/lib/session-credentials';
import { SOS_COPY, describeMode, isOutsideZoneEjectionDue } from '@pakdam/engine';
import SafetyControls from '@/components/match/SafetyControls';
import ModeZonePanel, { teamAssignmentLabel } from '@/components/match/ModeZonePanel';
import NextZonePanel from '@/components/match/NextZonePanel';
import CompassRadar, { HotColdReadout } from '@/components/match/CompassRadar';
import { PlayerFreshnessRow, RoleToolbar, SilenceBanner } from '@/components/match/RoleToolbar';
import { bearingBetween, bearingWord, currentZoneBoundary, formatClock, formatDistance, haversineMeters, lastReportedLabel, lastUpdatedLabel, nextShrinkPhase, pingAgeLabel, pointInPolygon, polygonCentroid, zoneDiameterMeters, zoneSizeLabel } from '@/components/match/freshness';
import HudBar from '@/components/hud/HudBar';
import OutsideZoneBanner from '@/components/hud/OutsideZoneBanner';
import PlayerDots, { type DotEntry } from '@/components/hud/PlayerDots';
import BottomTabs, { type PlayView } from '@/components/hud/BottomTabs';
import CatchPanel from '@/components/catch/CatchPanel';
import TeamRadio from '@/components/radio/TeamRadio';
import type { VoiceSignalIn } from '@/lib/voice-radio';
import type { DemoRoom } from '@/lib/demo-store';
const MapView = dynamic(() => import('@/components/map/MapView'), { ssr: false });

/** Silence interval is calibration OPEN — the app uses 60 s and says so.
 *  It is a prompt to check the phone, never an accusation. */
const SILENCE_AFTER_MS = 60_000;

const PHASE_LABELS: Record<string, string> = {
  HEAD_START: 'Head start — Runners hiding',
  ACTIVE: 'Active — hunt on',
  SAFETY_PAUSED: 'Paused — safety pause',
  RESOLVING: 'Resolving — checking the result',
  COMPLETED: 'Finished',
  CANCELLED: 'Cancelled',
  ABANDONED: 'Abandoned',
};

interface SimPing { distanceMeters: number; bearingDegrees: number; areaLabel: string; reportedAt: string; centreLat: number; centreLng: number; radiusMeters: number }

/** ---- LIVE TRANSPORT (canonical store, lib/session-credentials.ts) ----
 *  The live seat lives in the single sessionStorage key
 *  'pakdam.session.v1', written by the create/join flow with
 *  saveLiveSession and read back here with getSessionForRoom(roomId).
 *  A demo session for this room, or a live session without a
 *  reconnect token, is not a live seat. The raw reconnect token is
 *  never logged, never put in a URL, and only leaves the browser
 *  inside fetchWsTicket's HTTPS POST body (see lib/websocket.ts).
 *  Until a seat exists, live mode shows "seat missing — go back to
 *  the lobby and rejoin" and NEVER falls back to the demo store:
 *  live and demo state are never mixed.
 *
 *  Live mode is on exactly when NEXT_PUBLIC_WORKER_URL is set
 *  (getWorkerUrl() !== null). Demo mode is ONLY the fallback when
 *  the URL is unset, and the page says so on screen.
 *
 *  Server-judgement gaps, stated plainly (frozen WS contract,
 *  17 §3.3, packages/shared/src/types.ts):
 *  - There is NO dedicated outside-zone / ejection WS event. The
 *    server judges from the location.update fixes it receives; this
 *    page NEVER ejects locally in live mode. Ejection is observed
 *    only when the server says so: snapshot PlayerView.ejectedAt
 *    (or a player.removed event, which triggers a snapshot refresh).
 *    The 30 s countdown on this screen is a DISPLAY driven by my
 *    own fix vs the server zone — the server enforces at 0.
 *  - A snapshot carries NO pings (17 §3.3: no pending pings ever).
 *    Pings arrive only as 'ping' events after connect; a reconnect
 *    loses earlier pings. ping.expired removes one ping.
 *  - The next zone is server-decided (random offset, NOT
 *    concentric): it arrives as 'zone.update' and through the
 *    snapshot room config's shrinkPhases. This page never invents
 *    a next zone, and never centres/moves a zone from a client fix.
 *  - Head start in live mode is counted from room.startedAt (the
 *    snapshot has no separate headStartStartedAt); the server owns
 *    the HEAD_START → ACTIVE transition — this page never advances
 *    the phase itself in live mode. */
/** Map a server snapshot onto the DemoRoom shape the render below
 *  already reads — the SOURCE stays live (snapshot only), this is
 *  just a shape adapter so live and demo render through one UI.
 *  reconnectTokenHash is never sent by the server (17 §3.3) and is
 *  never needed here, so it is an empty string, never a real value.
 *  checkins/events have no live source on this page (the lobby owns
 *  the event log), so they are empty in live mode. */
function snapshotToDemoRoom(snap: WsSnapshotPayload): DemoRoom {
  return {
    room: snap.room,
    players: snap.players.map((p: PlayerView): Player => ({ ...p, reconnectTokenHash: '' })),
    catches: snap.activeCatches.map((c: CatchView): CatchEvent => ({ ...c, qrTokenHash: null })),
    checkins: [],
    events: [],
    headStartStartedAt: snap.room.startedAt,
    // No live source: the snapshot carries no paused-from phase
    // (DemoRoom doc: null = not paused) and no per-catch QR expiry
    // (demo-store falls back to requestedAt + TTL when absent).
    pausedFrom: null,
    catchExpiresAtMs: {},
  };
}
/** A server ping as the radar / map / latest-ping line read it.
 *  Distance/bearing are computed from MY fix to the ping area's
 *  centre — the server sends a coarse area, never a distance. A
 *  sector ping has no centre: it shows as text only, never as a
 *  map area or a radar bearing. */
interface LivePingView { distanceMeters: number | null; bearingDegrees: number | null; areaLabel: string; reportedAt: string; centreLat: number | null; centreLng: number | null; radiusMeters: number | null }
function livePingToView(p: Ping, fix: ForegroundFix | null): LivePingView {
  if ('sector' in p.uncertainty) {
    return { distanceMeters: null, bearingDegrees: null, areaLabel: `Approximate ping area — ${p.uncertainty.sector} (server ping)`, reportedAt: p.createdAt, centreLat: null, centreLng: null, radiusMeters: null };
  }
  const c = p.uncertainty.centre;
  const dist = fix ? Math.round(haversineMeters(fix.lat, fix.lng, c.lat, c.lng)) : null;
  const bearing = fix ? Math.round(bearingBetween(fix.lat, fix.lng, c.lat, c.lng)) : null;
  return {
    distanceMeters: dist,
    bearingDegrees: bearing,
    areaLabel: `Approximate ping area${dist !== null ? `, ~${dist} m${bearing !== null ? ` ${bearingWord(bearing)}` : ''}` : ''} (server ping)`,
    reportedAt: p.createdAt,
    centreLat: c.lat,
    centreLng: c.lng,
    radiusMeters: p.uncertainty.radiusMeters,
  };
}

/** Live game screen — Pakdam's own floating HUD, Map ⇄ Radar ⇄ Radio
 *  bottom tabs, named coarse dots, mode-aware catch panel,
 *  hold-to-reveal in the More sheet. The match logic underneath is
 *  unchanged: server end time only, coarse ping areas only (never
 *  exact pins), two-step catches, safety always visible,
 *  foreground-only PWA honesty.
 *
 *  LIVE vs DEMO: when NEXT_PUBLIC_WORKER_URL is set, every timer,
 *  role, ping, zone and roster row comes from server snapshots /
 *  server events over the live socket (createLivePakdamSocket), and
 *  the demo store is not read or written at all. When the URL is
 *  unset, the page runs on the local demo store and says "Demo
 *  mode" on screen. The two sources are never mixed. */
export default function PlayPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = use(params);
  const router = useRouter();
  // Live mode is a build-time switch, stable for the whole session.
  const liveMode = getWorkerUrl() !== null;
  // Canonical live seat only: a demo session for this room, or a
  // live session without a reconnect token, is not a live seat.
  const storedSession = liveMode ? getSessionForRoom(roomId) : null;
  const liveCred: PakdamSession | null = storedSession?.mode === 'live' && storedSession.reconnectToken
    ? storedSession : null;
  const [dr, setDr] = useState<DemoRoom | null>(null);
  const [loadError, setLoadError] = useState('');
  const [fix, setFix] = useState<ForegroundFix | null>(null);
  const [locError, setLocError] = useState('');
  const [paused, setPaused] = useState(false);
  const [sosSent, setSosSent] = useState(false);
  const [simulated, setSimulated] = useState(false);
  const [offline, setOffline] = useState(false);
  const [view, setView] = useState<PlayView>('map');
  const [simPings, setSimPings] = useState<SimPing[]>([]);
  // The latest ping is what the radar and the "latest ping" line show.
  const simPing = simPings.length > 0 ? simPings[simPings.length - 1] : null;
  const [safeCheckin, setSafeCheckin] = useState('');
  const [signalMsg, setSignalMsg] = useState('');
  const [revealDone, setRevealDone] = useState(false);
  const [roleRevealed, setRoleRevealed] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState('');
  // --- Live-only state (unused in demo mode) ---
  const [liveSnap, setLiveSnap] = useState<WsSnapshotPayload | null>(null);
  const [livePings, setLivePings] = useState<Ping[]>([]);
  const [socketState, setSocketState] = useState<PakdamSocketState>('idle');
  const [socketDetail, setSocketDetail] = useState('');
  const [liveError, setLiveError] = useState('');
  const [liveActionMsg, setLiveActionMsg] = useState('');
  const [coarseSendNote, setCoarseSendNote] = useState('');
  const socketRef = useRef<PakdamSocket | null>(null);
  // Voice radio (D-M1): latest incoming `voice.signal`, forwarded to
  // TeamRadio. The nonce makes each delivery unique (ICE bursts send
  // many signals; TeamRadio consumes each exactly once).
  const [incomingVoiceSignal, setIncomingVoiceSignal] = useState<(VoiceSignalIn & { nonce: number }) | null>(null);
  const voiceNonceRef = useRef(0);
  // Team Radio TEXT (D-M7): live messages relayed by the DO, oldest
  // first, capped at 50. Ephemeral — nothing here is backfilled.
  const [liveRadio, setLiveRadio] = useState<RadioMessage[]>([]);
  const lastSentFixRef = useRef<{ lat: number; lng: number; accuracyMeters: number; at: string } | null>(null);
  // Focus follows the role reveal: the "Tap to find out" button
  // unmounts when the role appears, which would otherwise drop
  // keyboard focus to the top of the page. Focus lands on the
  // revealed-role status instead.
  const roleStatusRef = useRef<HTMLParagraphElement>(null);
  const prevRevealedRef = useRef(roleRevealed);
  useEffect(() => {
    if (roleRevealed && !prevRevealedRef.current) roleStatusRef.current?.focus();
    prevRevealedRef.current = roleRevealed;
  }, [roleRevealed]);
  const [lastSentAt, setLastSentAt] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const lastFixAtRef = useRef<string | null>(null);
  // Outside-zone clock, accumulated only while the fix is trustworthy
  // (see countdownPaused below): seconds already counted stay counted
  // when accuracy goes poor, but no new seconds accrue until it
  // recovers. A reload resets the accumulation — the countdown is a
  // live fairness clock, not a stored penalty. In LIVE mode this
  // clock is a DISPLAY only: the server enforces the ejection.
  const outsideAccumMsRef = useRef(0);
  const outsideSegmentStartRef = useRef<number | null>(null);
  // Head-start fallback start (legacy rooms with no stored
  // headStartStartedAt): when this screen first saw HEAD_START.
  const headStartFallbackRef = useRef<number | null>(null);
  const wasInsideRef = useRef<boolean | null>(null);
  const zoneExitSentRef = useRef(false);
  const ejectedRef = useRef(false);
  // In live mode my identity is the seat credential; in demo mode it
  // is the per-tab demo player id. Never the other mode's id.
  const me = liveMode ? liveCred?.playerId ?? null : currentPlayerId();
  const myPlayer = dr?.players.find((p) => p.playerId === me);

  useEffect(() => {
    if (!liveMode) {
      try { setDr(getRoom(roomId)); } catch { setLoadError('Could not load the match — try again.'); }
    }
    const id = setInterval(() => { if (!liveMode) setDr(getRoom(roomId)); setNow(Date.now()); }, 1000);
    const stop = watchForegroundLocation((f) => { setFix(f); lastFixAtRef.current = f.at; }, setLocError);
    let release: { release: () => void } | null = null;
    void requestWakeLock().then((r) => { release = r; });
    // Suspension resume (triage 2026-11-17): reopening the PWA brings a
    // suspended player back to connected — on mount (a reopen/reload)
    // and whenever the tab becomes visible again after being hidden.
    // Without this, the catch page's "they must reopen the PWA first"
    // could never be satisfied. resumePlayer is a no-op unless the
    // player is actually suspended, so a fresh mount changes nothing.
    // DEMO ONLY: in live mode the socket owns suspension (it sends
    // player.suspended on hide and requests a snapshot on show).
    if (!liveMode && me) resumePlayer(roomId, me);
    const onVis = () => {
      if (liveMode) return; // socket's own visibility listener owns this
      if (document.hidden && me) recordPlayerSuspension(roomId, me);
      else if (!document.hidden && me) { if (resumePlayer(roomId, me)) setDr(getRoom(roomId)); }
    };
    const onOnline = () => setOffline(false);
    const onOffline = () => setOffline(true);
    setOffline(typeof navigator !== 'undefined' && !navigator.onLine);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => { clearInterval(id); stop(); release?.release(); document.removeEventListener('visibilitychange', onVis); window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); };
  }, [roomId, liveMode]);

  // --- LIVE SOCKET (live mode only) ---
  useEffect(() => {
    if (!liveMode) return;
    if (!liveCred) { setLiveError('Live match needs your seat — no reconnect credential was found for this room in this tab. Go back to the lobby and rejoin with the room code.'); return; }
    const reconnectToken = liveCred.reconnectToken;
    if (!reconnectToken) { setLiveError('Live match needs your seat — no reconnect credential was found for this room in this tab. Go back to the lobby and rejoin with the room code.'); return; }
    let cancelled = false;
    const socket = createLivePakdamSocket({ roomId, playerId: liveCred.playerId, reconnectToken });
    if (!socket) { setLiveError('Live transport is configured but the socket could not be built.'); return; }
    socketRef.current = socket;
    void socket.connect(roomId, {
      playerId: liveCred.playerId,
      onSnapshot: (snap) => { if (cancelled) return; setLiveSnap(snap); setDr(snapshotToDemoRoom(snap)); },
      onMessage: (msg: WsServerMessage) => {
        if (cancelled) return;
        switch (msg.type) {
          case 'snapshot':
          case 'welcome':
            break; // snapshot is handled by onSnapshot; welcome carries no state
          case 'ping': {
            const ping = (msg as Extract<WsServerMessage, { type: 'ping' }>).payload.ping;
            // Server pings STAY until the next ping (founder rule) —
            // appended here, replaced on screen by the latest; removed
            // only by ping.expired or a fresh snapshot cycle.
            setLivePings((prev) => prev.some((p) => p.pingId === ping.pingId) ? prev : [...prev, ping]);
            break;
          }
          case 'ping.expired': {
            const pingId = (msg as Extract<WsServerMessage, { type: 'ping.expired' }>).payload.pingId;
            setLivePings((prev) => prev.filter((p) => p.pingId !== pingId));
            break;
          }
          case 'zone.update': {
            // Server-decided next zone (random offset, NOT concentric).
            const zone = (msg as Extract<WsServerMessage, { type: 'zone.update' }>).payload.zone;
            setDr((prev) => prev ? { ...prev, room: { ...prev.room, config: { ...prev.room.config, zone } } } : prev);
            break;
          }
          case 'sos.raised': {
            if ((msg as Extract<WsServerMessage, { type: 'sos.raised' }>).payload.byPlayerId === liveCred.playerId) setSosSent(true);
            void socket.requestSnapshot();
            break;
          }
          case 'voice.signal': {
            // Voice signalling (D-M1): TeamRadio owns it — forward the
            // payload, do NOT request a snapshot (an ICE burst would
            // otherwise re-fetch the whole room state dozens of times).
            const payload = (msg as Extract<WsServerMessage, { type: 'voice.signal' }>).payload;
            voiceNonceRef.current += 1;
            setIncomingVoiceSignal({ ...payload, nonce: voiceNonceRef.current });
            break;
          }
          case 'radio': {
            // Team Radio text (D-M7): a teammate's message, relayed
            // by the DO team-only. Append (deduped by messageId),
            // keep the last 50, do NOT request a snapshot — radio is
            // ephemeral and the snapshot carries no radio history.
            const incoming = (msg as Extract<WsServerMessage, { type: 'radio' }>).payload.radio;
            setLiveRadio((prev) => prev.some((m) => m.messageId === incoming.messageId)
              ? prev : [...prev, incoming].slice(-50));
            break;
          }
          case 'error': {
            const err = (msg as Extract<WsServerMessage, { type: 'error' }>).payload;
            setLiveError(err.message || 'The server reported an error.');
            break;
          }
          default:
            // room.state, player.*, catch.*, safety.*, announcement,
            // signal, match.*, host.transferred: partial events — the
            // snapshot is the whole truth, so re-fetch it instead of
            // merging partial state by hand.
            void socket.requestSnapshot();
            break;
        }
      },
      onStateChange: (state, detail) => {
        if (cancelled) return;
        setSocketState(state);
        setSocketDetail(detail ?? '');
        if (state === 'connected') setLiveError('');
        if (state === 'reconnect-failed') setLiveError(detail ?? 'Connection lost — reconnect failed. Tap Retry to try again.');
        if (state === 'closed' && detail) setLiveError(detail);
      },
    }).catch(() => {
      if (!cancelled) { setSocketState('closed'); setLiveError('Could not get a connection ticket — your seat credential may have expired. Go back to the lobby and rejoin with the room code.'); }
    });
    return () => { cancelled = true; socket.close(); socketRef.current = null; };
  }, [roomId, liveMode]);

  const retryLive = () => {
    setLiveError('');
    setSocketDetail('');
    void socketRef.current?.retry().catch(() => setLiveError('Could not get a connection ticket — go back to the lobby and rejoin with the room code.'));
  };

  /** Send one fix over the live socket. GPS ±50 m rule (founder,
   *  ZONE_AUTO_CENTRE_MAX_ACCURACY_M): a fix worse than ±50 m is
   *  NEVER sent — coarse fixes never move the zone (the zone comes
   *  only from the server) and never feed the server's outside-zone
   *  judgement. A simulated fix is never sent either. Returns false
   *  (command discarded, never queued) when not connected. */
  const sendLiveFix = (f: ForegroundFix): boolean => {
    if (simulated) return false;
    if (f.accuracyMeters > ZONE_AUTO_CENTRE_MAX_ACCURACY_M) {
      setCoarseSendNote(`GPS is ±${Math.round(f.accuracyMeters)} m — too coarse to send (needs ±${ZONE_AUTO_CENTRE_MAX_ACCURACY_M} m or better). Move to open sky; nothing was sent.`);
      return false;
    }
    if (!me) return false;
    const sent = socketRef.current?.sendLocationUpdate({
      playerId: me, roomId, lat: f.lat, lng: f.lng,
      accuracyMeters: f.accuracyMeters, capturedAt: f.at,
      receivedAt: new Date().toISOString(), quality: f.quality,
    }) ?? false;
    if (sent) {
      setCoarseSendNote('');
      lastSentFixRef.current = { lat: f.lat, lng: f.lng, accuracyMeters: f.accuracyMeters, at: f.at };
      setLastSentAt(new Date().toISOString());
    }
    return sent;
  };

  // Live location sharing: every fresh watcher fix that meets the
  // ±50 m rule is sent over the socket. Fixes are de-duplicated by
  // their own timestamp — the same fix is never sent twice.
  useEffect(() => {
    if (!liveMode || !fix || simulated) return;
    if (socketState !== 'connected') return;
    const last = lastSentFixRef.current;
    if (last && last.at === fix.at) return;
    sendLiveFix(fix);
  }, [fix, liveMode, socketState, simulated]);

  // Head start lasts exactly the configured headStartSeconds,
  // counted from when the room entered HEAD_START (stored in the demo
  // store, so a reload or a second tab does not restart it). A legacy
  // room with no stored start falls back to when this screen first
  // saw HEAD_START. Zero head start flips to ACTIVE at once.
  const headStartStartMs = dr?.headStartStartedAt
    ? new Date(dr.headStartStartedAt).getTime()
    : headStartFallbackRef.current;
  const headStartRemainingSeconds = dr?.room.phase === 'HEAD_START' && headStartStartMs != null
    ? Math.max(0, dr.room.config.headStartSeconds - Math.floor((now - headStartStartMs) / 1000))
    : null;
  useEffect(() => {
    if (dr?.room.phase === 'HEAD_START' && !dr.headStartStartedAt && headStartFallbackRef.current === null) {
      headStartFallbackRef.current = Date.now();
    }
  }, [dr?.room.phase, dr?.headStartStartedAt]);
  // DEMO ONLY: in live mode the server owns HEAD_START → ACTIVE.
  useEffect(() => {
    if (liveMode) return;
    if (dr?.room.phase === 'HEAD_START' && headStartRemainingSeconds === 0) setPhase(roomId, 'ACTIVE');
  }, [dr?.room.phase, headStartRemainingSeconds, roomId, liveMode]);
  useEffect(() => { if (dr?.room.phase === 'COMPLETED') router.push(`/room/${roomId}/results`); }, [dr?.room.phase, roomId, router]);

  // Outside-zone clock (my OWN fix vs the zone boundary — computed here
  // from values this screen already holds). The founder rule (2026-11-17):
  // 30 seconds outside → a return countdown on my screen, then EJECTION
  // at 0. The countdown is shown by OutsideZoneBanner; the ejection is
  // ENFORCED here — when the countdown runs out, this screen ejects me
  // through the demo store (ejectPlayer), which marks me ejected, out
  // of play, and shown as ejected in the roster and results. The clock
  // starts when my fix first reports outside and resets when I am back
  // inside or my fix goes away. No zone (playZoneEnabled off) means no
  // inside/outside at all — insideZone stays null. Computed before the
  // early returns so the effects below are unconditional.
  // LIVE MODE: the countdown above is a DISPLAY only. The server
  // judges from the fixes it receives (location.update IS the alert
  // — no separate zone-exit message exists) and enforces the
  // ejection; this page never ejects locally in live mode.
  const zoneOn = dr?.room.config.playZoneEnabled !== false;
  // The zone in force RIGHT NOW: the latest shrink phase whose time
  // has passed, else the base boundary. The map, the HUD size text,
  // the way-back guide and this outside-zone check all read this one
  // boundary — never the original boundary once a shrink has taken
  // effect — so they can never disagree about which zone is live.
  const currentBoundary = dr ? currentZoneBoundary(dr.room.config.zone, dr.room.startedAt, now) : [];
  const insideZone = dr && fix && zoneOn && currentBoundary.length >= 3
    ? pointInPolygon(fix.lat, fix.lng, currentBoundary) : null;
  // Coarse-fix rule (founder decision, 2026-11-17 — see DECISIONS.md):
  // the outside-zone countdown only runs on a trustworthy fix. When
  // the live fix is worse than the good accuracy tier (±10 m), the
  // countdown PAUSES — seconds already counted stay counted, no new
  // seconds accrue, and the banner says so plainly. It resumes when
  // accuracy recovers. A fix with no accuracy reported at all (some
  // browsers omit it) is not judged — the countdown runs, as before.
  const countdownPaused = insideZone === false && fix !== null &&
    Number.isFinite(fix.accuracyMeters) && fix.accuracyMeters > CALIBRATION_OPEN.accuracyGoodMaxM;
  useEffect(() => {
    if (insideZone === false && !countdownPaused) {
      if (outsideSegmentStartRef.current === null) outsideSegmentStartRef.current = Date.now();
    } else {
      if (outsideSegmentStartRef.current !== null) {
        outsideAccumMsRef.current += Date.now() - outsideSegmentStartRef.current;
        outsideSegmentStartRef.current = null;
      }
      if (insideZone !== false) outsideAccumMsRef.current = 0;
    }
  }, [insideZone, countdownPaused]);
  // Device-side zone-exit alert (founder rule, 2026-11-17 — location is
  // DEFAULT, no custom cadence): my phone checks locally whether my fix
  // is inside the zone — no location is sent for the check itself. Only
  // on crossing outside do I send exactly ONE alert (recordZoneExit in
  // this demo; one location.update in production), which is what starts
  // the 30-second return countdown on the server (first-seen-outside).
  // The flag resets when I am back inside, so the next crossing alerts
  // again. A player whose first fix is already outside gets no alert
  // (there was no crossing) — the countdown and ejection above still
  // enforce on their own screen, and the host sees the ejection event.
  // DEMO ONLY: in live mode every qualifying fix is already sent over
  // the socket (see the live location effect), so the crossing fix
  // itself is the server's first-seen-outside — no extra alert.
  useEffect(() => {
    if (liveMode) return;
    if (insideZone === true) { wasInsideRef.current = true; zoneExitSentRef.current = false; }
    else if (insideZone === false && wasInsideRef.current === true && !zoneExitSentRef.current && me) {
      zoneExitSentRef.current = true;
      recordZoneExit(roomId, me);
      setDr(getRoom(roomId));
    }
  }, [insideZone, me, roomId, liveMode]);
  const outsideSeconds = insideZone === false
    ? Math.floor((outsideAccumMsRef.current + (outsideSegmentStartRef.current !== null ? now - outsideSegmentStartRef.current : 0)) / 1000)
    : null;
  // Ejection at 0: only while the match is running (HEAD_START or
  // ACTIVE — never while paused, never in the lobby), only once per
  // page session, and only if I am not already ejected. The ejection
  // is enforced on my own device from my own fix — in production the
  // server enforces it from the fixes it receives; the demo has no
  // server, so my own screen is the enforcer and says so.
  // DEMO ONLY: in live mode the server enforces; ejection arrives
  // via the snapshot (myPlayer.ejectedAt) and the banner below.
  useEffect(() => {
    if (liveMode) return;
    if (
      insideZone === false && outsideSeconds !== null &&
      isOutsideZoneEjectionDue(outsideSeconds, OUTSIDE_ZONE_RETURN_SECONDS) &&
      me && !ejectedRef.current &&
      (dr?.room.phase === 'HEAD_START' || dr?.room.phase === 'ACTIVE') &&
      !dr?.players.find((p) => p.playerId === me)?.ejectedAt
    ) {
      ejectedRef.current = true;
      ejectPlayer(roomId, me);
      setDr(getRoom(roomId));
    }
  }, [insideZone, outsideSeconds, me, dr?.room.phase, dr?.players, roomId, liveMode]);

  // --- Live early returns (before the demo ones): live mode never
  // reads the demo store, so a missing seat or a dead socket shows
  // a live error, never demo data. ---
  if (liveMode && !liveCred) {
    return (
      <div>
        <h1>Match — live</h1>
        <p role="alert"><strong>Your live seat is missing.</strong> This tab has no reconnect credential for this room, so it cannot join the live match. Go back to the lobby and rejoin with the room code — do not use a demo room for a live game.</p>
        <p><a className="btn" href={`/room/${roomId}`}>Back to the lobby</a> <a className="btn btn-secondary" href="/">Home</a></p>
      </div>
    );
  }
  if (liveMode && liveError && !dr) {
    return (
      <div>
        <h1>Match — live</h1>
        <p role="alert">{liveError}</p>
        <p>Connection: {socketState}{socketDetail ? ` — ${socketDetail}` : ''}.</p>
        <p><button className="btn" onClick={retryLive}>Retry connection</button> <a className="btn btn-secondary" href={`/room/${roomId}`}>Back to the lobby</a></p>
      </div>
    );
  }
  if (liveMode && !dr) {
    return (
      <div aria-busy="true">
        <h1>Connecting to the live match…</h1>
        <div className="skeleton skeleton-lg" aria-hidden="true" />
        <div className="skeleton" style={{ width: '70%' }} aria-hidden="true" />
        <div className="skeleton" style={{ width: '45%' }} aria-hidden="true" />
        <p role="status">Connection: {socketState}{socketDetail ? ` — ${socketDetail}` : ''}. The timer appears only once the server snapshot arrives — never a client-guessed timer.</p>
        {socketState === 'reconnect-failed' ? <p><button className="btn" onClick={retryLive}>Retry connection</button></p> : null}
      </div>
    );
  }
  if (loadError) return <div><h1>Match</h1><p role="alert">{loadError}</p><p><button className="btn" onClick={() => { setLoadError(''); setDr(getRoom(roomId)); }}>Retry</button></p></div>;
  if (!dr) return <div aria-busy="true"><h1>Loading match…</h1><div className="skeleton skeleton-lg" aria-hidden="true" /><div className="skeleton" style={{ width: '70%' }} aria-hidden="true" /><div className="skeleton" style={{ width: '45%' }} aria-hidden="true" /><p>The timer appears only once the server snapshot arrives — never a client-guessed timer.</p></div>;

  const runners = dr.players.filter((p) => p.matchRole === 'runner');
  const hunters = dr.players.filter((p) => p.matchRole === 'hunter');
  const freeRunners = runners.filter((r) => !r.ejectedAt && !dr.catches.some((c) => c.state === 'confirmed' && c.runnerPlayerId === r.playerId));
  const myRole = myPlayer?.matchRole ?? null;
  // Next ping: in live mode, counted from the LAST server ping
  // received (server-driven); before the first ping, from the match
  // start on the same schedule as the demo. Demo mode keeps the
  // startedAt schedule. No pings configured → null.
  const lastLivePing = liveMode && livePings.length > 0 ? livePings[livePings.length - 1] : undefined;
  const lastLivePingAtMs = lastLivePing ? new Date(lastLivePing.createdAt).getTime() : null;
  const nextPingIn = dr.room.config.pingIntervalSeconds > 0
    ? lastLivePingAtMs !== null
      ? Math.max(0, dr.room.config.pingIntervalSeconds - Math.floor((now - lastLivePingAtMs) / 1000))
      : dr.room.config.pingIntervalSeconds - (dr.room.startedAt ? Math.floor((now - new Date(dr.room.startedAt).getTime()) / 1000) % dr.room.config.pingIntervalSeconds : 0)
    : null;
  const lastFixMs = fix ? new Date(fix.at).getTime() : null;
  const ownSilent = lastFixMs !== null && now - lastFixMs > SILENCE_AFTER_MS;
  const shrink = nextShrinkPhase(dr.room.config.zone, dr.room.startedAt, now);
  // The NEXT zone preview is the boundary of the next shrink phase
  // (from the stored phases, which are SIZE PLACEHOLDERS ONLY — the
  // server draws the real, randomly offset zone per shrink, at the
  // moment the shrink fires) — never shrinkPhases[0], which is the
  // FIRST phase even after later phases have taken effect. The preview
  // shows the planned size, never the final zone.
  const nextZone = shrink?.boundary ?? null;
  // Live check-in: the frozen WS contract has no check-in command, so
  // a check-in travels as an announcement (server broadcasts it as
  // 'announcement'). If the server restricts announcements, it
  // replies with an error, which surfaces in the live banner.
  const sendLiveCheckin = (text: string): boolean => {
    const ok = socketRef.current?.sendCommand('announcement.send', { text }) ?? false;
    if (!ok) setLiveActionMsg('Not connected — check-in not sent. Wait for the connection and try again.');
    return ok;
  };
  const doPause = () => {
    if (liveMode) {
      const pausing = dr.room.phase !== 'SAFETY_PAUSED';
      const ok = socketRef.current?.sendCommand(pausing ? 'safety.pause' : 'safety.resume', pausing ? { reason: null } : {}) ?? false;
      setLiveActionMsg(ok ? (pausing ? 'Safety pause requested — the server pauses the match clock for everyone.' : 'Resume requested — the server restarts the match clock.') : 'Not connected — pause request not sent. Wait for the connection and try again.');
      return;
    }
    const next = !paused; setPaused(next); setPhase(roomId, next ? 'SAFETY_PAUSED' : 'ACTIVE');
  };
  const doSos = () => {
    if (!window.confirm(SOS_COPY)) return;
    if (liveMode) {
      const ok = socketRef.current?.sendCommand('safety.sos', { reason: null }) ?? false;
      if (ok) setSosSent(true);
      else setLiveActionMsg('Not connected — SOS not sent. Wait for the connection and try again.');
      return;
    }
    setSosSent(true);
  };
  const startSim = () => {
    // Simulated location is a test aid only, and the simulated fix goes at
    // the CURRENT zone's centre, so the player starts inside the zone
    // they are playing in — never a hardcoded city spot. No zone (no
    // centre) means no simulated fix either: the zone stays un-centred
    // rather than falling back to any default place.
    const centre = polygonCentroid(currentBoundary.length >= 3 ? currentBoundary : dr.room.config.zone.boundary);
    if (!centre) { setLocError('No play zone to place a simulated location in.'); return; }
    const lat = centre.lat; const lng = centre.lng;
    setSimulated(true); setFix({ lat, lng, accuracyMeters: 12, quality: 'good', at: new Date().toISOString() });
  };
  const simulatePing = () => {
    // A coarse ping area around the CURRENT zone's centre,
    // labelled as simulated. No real opponent coordinates exist in
    // this local store. The centre used to be a hardcoded city spot
    // — a zone anywhere else drew its pings in the wrong place. The
    // offset is bounded to a quarter of the zone's size across, so
    // the area stays inside the zone it belongs to. Each simulated
    // ping gets a slightly different centre so that, with Show ping
    // history on, earlier areas are visibly distinct instead of
    // stacked on one spot. Founder decision (2026-11-17): a ping
    // stays until the next ping replaces it — the list only grows
    // here; the history toggle decides what the map shows.
    const boundary = currentBoundary.length >= 3 ? currentBoundary : dr.room.config.zone.boundary;
    const centre = polygonCentroid(boundary);
    // No zone centre means no ping area either — never a default place.
    if (!centre) return;
    const acrossM = zoneDiameterMeters(boundary) ?? 1000;
    const jitterM = (Math.random() - 0.5) * (acrossM / 2);
    const jitterAngle = Math.random() * 2 * Math.PI;
    const centreLat0 = centre.lat; const centreLng0 = centre.lng;
    const centreLat = centreLat0 + (jitterM * Math.cos(jitterAngle)) / 111320;
    const centreLng = centreLng0 + (jitterM * Math.sin(jitterAngle)) / (111320 * Math.cos((centreLat0 * Math.PI) / 180));
    const dist = 180 + Math.floor(Math.random() * 220);
    const bearing = Math.floor(Math.random() * 360);
    setSimPings((prev) => [...prev, { distanceMeters: dist, bearingDegrees: bearing, areaLabel: `Approximate ping area, ~${dist} m ${bearingWord(bearing)} (simulated)`, reportedAt: new Date().toISOString(), centreLat, centreLng, radiusMeters: 150 }]);
  };
  const safe = () => {
    if (!myPlayer) return;
    if (liveMode) {
      if (sendLiveCheckin(`${myPlayer.displayName} checked in: I'm safe`)) setSafeCheckin('✓ I’m safe — check-in sent to the server.');
      return;
    }
    hostCheckin(roomId, `${myPlayer.displayName} checked in: I'm safe`);
    setSafeCheckin('✓ I’m safe — check-in recorded in the room event log.');
  };
  /** Manual "Refresh my location" (founder rule, 2026-11-17 — a small
   *  extra on top of the default location sharing): re-send the
   *  latest known fix immediately. Useful after moving a lot or if
   *  GPS was stale. Fix-round change (2026-11-17, authorised): the
   *  refresh reuses the active watcher's latest fix — or the
   *  simulated fix on this screen — instead of taking a fresh
   *  one-shot, because a fresh one-shot never resolves while the
   *  play page's high-accuracy watcher is pending (proven under
   *  Playwright's static geolocation mock; on a real phone the
   *  watcher's fix is the freshest available). Only when this
   *  screen holds no fix at all does it fall back to a fresh
   *  one-shot. In this demo the "send" records the timestamp only
   *  (recordPlayerFix — no coordinates stored); in production the same
   *  tap sends the fix through PakdamSocket.sendLocationUpdate. The
   *  status says "latest fix", not "fresh fix", because the fix is
   *  the latest the watcher delivered — its own timestamp is kept,
   *  and the send time is what "Last updated" shows.
   *  LIVE MODE: the send goes over the socket and is subject to the
   *  same ±50 m rule as the automatic sends — a coarser fix is not
   *  sent, and the note says so. */
  const refreshLocation = () => {
    setRefreshMsg('');
    const sendFix = (f: ForegroundFix) => {
      setFix(f); lastFixAtRef.current = f.at;
      if (liveMode) {
        // Force a re-send even if this fix was already sent.
        lastSentFixRef.current = null;
        if (sendLiveFix(f)) setRefreshMsg('Location refreshed — latest fix sent to the server.');
        else if (!simulated && f.accuracyMeters > ZONE_AUTO_CENTRE_MAX_ACCURACY_M) setRefreshMsg('');
        return;
      }
      if (me) { recordPlayerFix(roomId, me); setDr(getRoom(roomId)); }
      setLastSentAt(new Date().toISOString());
      setRefreshMsg('Location refreshed — latest fix sent.');
    };
    if (fix) { sendFix(fix); return; }
    void getCurrentFix().then(sendFix).catch((msg) => setLocError(typeof msg === 'string' ? msg : 'Location unavailable — check GPS and try again.'));
  };
  /** Hold-to-reveal (D-M6): share a coarse 150 m area with the whole
   *  room over the live `reveal.send` channel — any seat may reveal,
   *  it is a safety feature, not a host power. The old code sent it
   *  as an announcement (`sendLiveCheckin` → `announcement.send`),
   *  which the server rejects for non-hosts (FORBIDDEN), while still
   *  marking the reveal done — the player was told "Position shared"
   *  when nothing was shared. `reveal.send` carries my current fix;
   *  the server validates it like a location.update and broadcasts
   *  a coarse 150 m area (same radius as a ping) — never an exact
   *  pin. `revealDone` is set ONLY when the send actually went out;
   *  a failed send leaves the button armed and says so in the live
   *  action line. A simulated fix is never revealed: it is a test
   *  aid at the zone centre, not where the player is. The watcher's
   *  latest fix is used (a fresh one-shot never resolves while the
   *  high-accuracy watcher is pending — see refreshLocation); only
   *  when this screen holds no fix at all does it fall back to a
   *  fresh one-shot. */
  const reveal = () => {
    if (liveMode) {
      if (!myPlayer || !me) {
        setLiveActionMsg('Your coarse area was not shared — no live seat for this room. Go back to the lobby and rejoin.');
        return;
      }
      if (simulated) {
        setLiveActionMsg('Your coarse area was not shared — the simulated location is a test aid, not where you are. Turn it off and hold again with real GPS.');
        return;
      }
      const sendRevealFix = (f: ForegroundFix): void => {
        const revealFix: LocationFix = {
          playerId: me, roomId, lat: f.lat, lng: f.lng,
          accuracyMeters: f.accuracyMeters, capturedAt: f.at,
          receivedAt: new Date().toISOString(), quality: f.quality,
        };
        const ok = socketRef.current?.sendCommand('reveal.send', { fix: revealFix }) ?? false;
        if (ok) {
          setLiveActionMsg('');
          setRevealDone(true);
        } else {
          setLiveActionMsg('Not connected — your coarse area was not shared. Wait for the connection and hold again.');
        }
      };
      if (fix) { sendRevealFix(fix); return; }
      void getCurrentFix().then(sendRevealFix).catch(() => setLiveActionMsg('Could not get your location — check GPS and hold again. Your coarse area was not shared.'));
      return;
    }
    if (myPlayer) hostCheckin(roomId, `${myPlayer.displayName} shared a coarse 150 m area with everyone in the game (hold-to-reveal)`);
    setRevealDone(true);
  };
  const doLeave = () => {
    if (!window.confirm('Leave the game? You will be out of this match — you can rejoin the lobby with the room code, but your role and progress in this match are gone.')) return;
    if (liveMode) {
      socketRef.current?.sendCommand('leave', { reason: null });
      socketRef.current?.close(1000, 'player left');
      router.push('/');
      return;
    }
    if (me) leaveRoom(roomId, me);
    router.push('/');
  };

  // Named coarse dots: Hunters see Runners (names + freshness ages,
  // never positions); Runners see only their fellow Runners — Runners
  // never see Hunter positions. In Infection a turned Runner
  // already shows as a Hunter in the roster, so the dots follow the
  // live roles. Ejected players are out — they get no dot.
  const dotEntries: DotEntry[] = (myRole === 'hunter' ? runners : runners.filter((r) => r.playerId !== me)).filter((r) => !r.ejectedAt).map((r) => ({
    playerId: r.playerId,
    displayName: r.displayName,
    role: 'runner',
    reportedAt: r.lastFixAt,
    connectionState: r.connectionState,
  }));
  const dotTitle = myRole === 'hunter' ? 'Runners — last reported' : 'Your fellow Runners — last reported';
  const radioScope = myRole === 'hunter' ? 'hunters' : myRole === 'runner' ? 'runners' : 'lobby';
  // Voice radio (D-M1): teammates are the players on my team (same
  // `team`, still in the game). The DO enforces the same rule on the
  // signalling path, so a wrong list here can never leak voice to the
  // other team — the server would reject the signal. No team yet
  // (lobby) or demo mode: no voice transport, text radio only.
  const voiceTeammates = myPlayer?.team
    ? (dr?.players ?? []).filter((p) => p.team === myPlayer.team && p.playerId !== me && !p.leftAt && !p.ejectedAt)
      .map((p) => ({ playerId: p.playerId, displayName: p.displayName }))
    : [];
  /** My open catch claim as Hunter (if any) — the QR scan button goes
   *  straight to it with the scanner open. */
  const myOpenClaim = dr.catches.find((c) => c.hunterPlayerId === me && (c.state === 'requested' || c.state === 'awaiting-confirmation'));
  const scanHref = myOpenClaim
    ? `/room/${roomId}/catch?runner=${myOpenClaim.runnerPlayerId}&scan=1`
    : `/room/${roomId}/catch`;
  const playZoneOn = dr.room.config.playZoneEnabled !== false;
  const showPingHistory = dr.room.config.showPingHistory ?? false;
  // Founder decision (2026-11-17): a ping stays on the hunter's map
  // until the next ping replaces it — never removed on a timer. History
  // OFF → only the latest ping area shows. History ON → earlier ping
  // areas stay visible too, dimmer (stale) with their ages counting up.
  // LIVE: server pings (coarse areas from 'ping' events). DEMO: the
  // simulated ping list. Sector pings have no centre and never draw
  // a map area — they show as text in the radar / latest-ping line.
  const livePingViews = liveMode ? livePings.map((p) => livePingToView(p, fix)) : [];
  const latestPing = liveMode
    ? (livePingViews.length > 0 ? livePingViews[livePingViews.length - 1] : null)
    : simPing;
  const pingAreasForMap = liveMode
    ? (showPingHistory ? livePingViews : livePingViews.slice(-1))
        .filter((p): p is LivePingView & { centreLat: number; centreLng: number; radiusMeters: number } => p.centreLat !== null && p.centreLng !== null && p.radiusMeters !== null)
        .map((p, i, arr) => ({
          name: i === arr.length - 1 ? 'Nearest ping area' : 'Earlier ping area',
          lat: p.centreLat, lng: p.centreLng, radiusMeters: p.radiusMeters, reportedAt: p.reportedAt,
          stale: i !== arr.length - 1,
        }))
    : (showPingHistory ? simPings : simPings.slice(-1)).map((p, i, arr) => ({
        name: i === arr.length - 1 ? 'Nearest ping area' : 'Earlier ping area',
        lat: p.centreLat, lng: p.centreLng, radiusMeters: p.radiusMeters, reportedAt: p.reportedAt,
        stale: i !== arr.length - 1,
      }));
  // SOS is live when I sent one, or when the server says one is
  // active (snapshot safetyState). A safety pause stops the match
  // clock — the server owns the clock in live mode.
  const sosActive = sosSent || (liveMode && liveSnap?.safetyState.sosActive === true);

  return (
    <div>
      {liveMode ? (
        <div className="banner" role="status">
          <strong>LIVE — connected to the Pakdam server.</strong> Timers, pings, zone and roles come from the server, not this device.
          {' '}Connection: {socketState}{socketDetail ? ` — ${socketDetail}` : ''}
          {socketState === 'reconnect-failed' ? <> <button type="button" className="btn btn-secondary" onClick={retryLive}>Retry connection</button></> : null}
        </div>
      ) : (
        <div className="banner" role="status"><strong>Demo mode — no server configured.</strong> This match runs on the demo store on this device only (NEXT_PUBLIC_WORKER_URL is unset). Nothing here reaches a server or another player.</div>
      )}
      {liveMode && liveError ? (
        <div className="banner" role="alert"><strong>Live error.</strong> {liveError} <button type="button" className="btn btn-secondary" onClick={() => setLiveError('')}>Dismiss</button></div>
      ) : null}
      <HudBar
        nowMs={now}
        endsAt={dr.room.endsAt}
        phase={dr.room.phase}
        phaseLabel={PHASE_LABELS[dr.room.phase] ?? dr.room.phase}
        nextPingInSeconds={dr.room.phase === 'ACTIVE' ? nextPingIn : null}
        zoneSizeText={playZoneOn ? zoneSizeLabel(currentBoundary) : 'No zone — classic hide and seek'}
        shrinkInSeconds={playZoneOn ? (shrink?.inSeconds ?? null) : null}
        shrinkLabel={playZoneOn ? (shrink ? `shrink ${shrink.phaseIndex + 1} of ${shrink.totalPhases}` : null) : 'No zone in this game'}
        runnersFree={freeRunners.length}
        runnersTotal={runners.length}
        modeLabel={describeMode(dr.room.config.mode).label}
        teamAssignmentLabel={teamAssignmentLabel(dr.room.config.teamAssignment)}
        paused={paused || dr.room.phase === 'SAFETY_PAUSED'}
        onSos={doSos}
        onPause={doPause}
      />
      {playZoneOn ? (
        <OutsideZoneBanner
          insideZone={insideZone}
          outsideSeconds={outsideSeconds}
          hasFix={fix !== null}
          countdownPaused={countdownPaused}
          accuracyMeters={fix?.accuracyMeters ?? null}
        />
      ) : (
        <div className="banner" role="status"><strong>No play zone in this game.</strong> Classic hide and seek — no boundary, no pings, no outside-zone rule. Hunters find Runners by looking.</div>
      )}
      {liveMode && playZoneOn && insideZone === false ? (
        <p className="small" role="status">Live mode: the 30-second countdown above is shown from your fix against the server zone. The server judges the ejection — this screen never ejects you on its own.</p>
      ) : null}
      {myPlayer?.ejectedAt ? (
        <div className="banner" role="alert" style={{ fontSize: 18 }}>
          <strong style={{ fontSize: 20 }}>You were ejected from this game.</strong>
          <p style={{ margin: '6px 0 0' }}>You stayed outside the play zone for {OUTSIDE_ZONE_RETURN_SECONDS} seconds. You are out of play — the roster and results show you as ejected. If you think this is wrong, tell the host in person; the host resolves disputes.</p>
        </div>
      ) : null}

      {offline ? <div className="banner" role="status"><strong>You are offline — reconnecting…</strong> {liveMode ? 'The live connection reconnects when the network returns. Anything you tried to send while offline was discarded, not queued.' : 'Changes will sync when you reconnect. Locations below are shown with their last-reported times, never as live.'}</div> : null}
      {dr.room.phase === 'HEAD_START' ? <div className="banner" role="status"><strong>Head start.</strong> Runners are hiding. Hunters start shortly and receive no live Runner locations during the head start.{headStartRemainingSeconds !== null ? ` Hunt starts in ${formatClock(headStartRemainingSeconds)} — the configured head start is ${formatClock(dr.room.config.headStartSeconds)}.` : ''}</div> : null}
      {dr.room.phase === 'HEAD_START' ? (
        <div className="card" aria-label="Head start — what to do now">
          <h2 style={{ marginTop: 0 }}>Head start — what to do now</h2>
          {myRole === 'runner' ? (
            <ol style={{ margin: 0, paddingLeft: 20 }}>
              <li><strong>Scatter and hide.</strong> Move away from the start — Hunters cannot see you yet.</li>
              <li><strong>Stay inside the play zone</strong> (red boundary on the map). Outside it, a 30-second countdown starts — get back inside before it ends, or you are ejected from the game.</li>
              <li><strong>Keep the app open and your screen on.</strong> Your location stops sharing if the phone locks.</li>
              <li>When the hunt starts, Hunters see only a rough area where you were — never where you are now.</li>
            </ol>
          ) : myRole === 'hunter' ? (
            <ol style={{ margin: 0, paddingLeft: 20 }}>
              <li><strong>Wait where you are.</strong> Runners are scattering — you get no locations yet.</li>
              <li><strong>Check the map and the zone</strong> (red boundary). Plan which edge to cover first.</li>
              <li>When the hunt starts, follow the coarse ping areas — a rough area, never an exact pin.</li>
              <li>A catch only counts in person: tag the Runner, they show their QR, and you scan it to complete the tag.</li>
            </ol>
          ) : (
            <p style={{ margin: 0 }}>Roles are being assigned — your head-start steps appear here once you have a role.</p>
          )}
        </div>
      ) : null}
      {dr.room.phase === 'SAFETY_PAUSED' || paused ? <div className="banner" role="status"><strong>Game paused.</strong> Competitive timers and actions are stopped. Resume when it is safe.</div> : null}
      <SilenceBanner players={dr.players} />
      {ownSilent ? (
        <div className="banner" role="alert"><strong>Location stopped — check your phone / reopen the app.</strong> Your location has not updated for over a minute. This is a prompt, not an accusation — the app may have been backgrounded or your phone may have locked. Reopen the app and keep your screen on to resume sharing. (Silence interval: calibration OPEN — currently 60 s.)</div>
      ) : null}
      {locError ? <p role="alert">{locError}</p> : null}
      {coarseSendNote ? <p role="status">{coarseSendNote}</p> : null}
      {!fix && !locError ? <p role="status" className="banner"><strong>Finding your location…</strong> The map and the zone appear once your phone reports a location. If this takes a while, check that location is turned on for this browser.</p> : null}

      <h1>Match — Room {dr.room.roomCode}</h1>
      <p>You are: <strong>{roleRevealed ? (myRole ?? '—') : 'hidden — tap below to reveal'}</strong> {myPlayer?.isHost ? '(host)' : ''} · Location: {fix ? `${fix.quality} (±${fix.accuracyMeters} m) · ${lastUpdatedLabel(fix.at)}` : 'unknown — location never reported'} · GPS is supporting evidence only, never proof.{liveMode && fix ? ` ${fix.accuracyMeters <= ZONE_AUTO_CENTRE_MAX_ACCURACY_M ? 'This fix meets the ±50 m rule and is shared with the server.' : 'This fix is coarser than ±50 m and is NOT shared with the server.'}` : ''}</p>
      {myRole && !roleRevealed ? (
        <div className="card" aria-label="Your role is hidden" style={{ textAlign: 'center', padding: '24px 16px' }}>
          <h2 style={{ marginTop: 0 }}>No peeking <span aria-hidden="true">👀</span></h2>
          <p>Your role is hidden. Everyone finds out at the same time — tap when you are ready.</p>
          <p><button type="button" className="btn btn-lg" onClick={() => setRoleRevealed(true)}>Tap to find out your role</button></p>
        </div>
      ) : myRole ? (
        <p role="status" ref={roleStatusRef} tabIndex={-1}><strong>You are {myRole === 'hunter' ? '◆ a Hunter' : '▲ a Runner'}.</strong> {myRole === 'hunter' ? 'Follow the coarse ping areas and tag Runners in person.' : 'Hide, stay inside the zone, and outlast the clock.'}</p>
      ) : null}
      {!liveMode && !fix && !simulated ? <p><button className="btn btn-secondary" onClick={startSim}>Use simulated location</button> <span className="small">Use this if GPS is unavailable in this browser. Simulated locations are labelled and never used as catch proof.</span></p> : null}
      {simulated ? <p><span className="tag">SIMULATED LOCATION</span></p> : null}
      {!liveMode && myPlayer?.connectionState === 'suspended' ? <p role="status"><strong>Suspended — location unknown.</strong> {lastReportedLabel(myPlayer.lastFixAt)} Reopen the app to resume sharing. <button type="button" className="btn btn-secondary" onClick={() => { if (me) { resumePlayer(roomId, me); setDr(getRoom(roomId)); } }}>Resume sharing</button></p> : null}
      {liveMode && myPlayer?.connectionState === 'suspended' ? <p role="status"><strong>Suspended — location unknown.</strong> {lastReportedLabel(myPlayer.lastFixAt)} Reopen the app to resume sharing — the server marks you connected again when a fresh fix arrives.</p> : null}

      <BottomTabs
        view={view}
        onView={setView}
        paused={paused || dr.room.phase === 'SAFETY_PAUSED'}
        onPause={doPause}
        onSos={doSos}
        onSafe={safe}
        onLeave={doLeave}
        onReveal={reveal}
        revealDone={revealDone}
      />
      <a href="#role-tools" className="skip-link">Skip map — go to role tools</a>
      {view === 'map' ? (
        <>
          <MapView
            lat={fix?.lat ?? null} lng={fix?.lng ?? null} accuracyM={fix?.accuracyMeters ?? null} label="You (uncertainty area)"
            zoneBoundary={currentBoundary} nextZoneBoundary={nextZone ?? undefined}
            pingAreas={pingAreasForMap}
            pingHistoryOn={showPingHistory}
          />
          {playZoneOn ? (
            <NextZonePanel zone={{ ...dr.room.config.zone, boundary: currentBoundary }} startedAt={dr.room.startedAt} fix={fix ? { lat: fix.lat, lng: fix.lng } : null} />
          ) : (
            <p className="small">No play zone in this game — no next-zone preview. The map above shows only your own position and ping areas.</p>
          )}
          <ModeZonePanel
            mode={dr.room.config.mode}
            teamAssignment={dr.room.config.teamAssignment}
            selectedHunterNames={dr.room.config.selectedHunterIds.map((id) => dr.players.find((p) => p.playerId === id)?.displayName ?? 'Unknown player')}
            hunters={hunters}
            runners={runners}
            caughtRunnerIds={dr.catches.filter((c) => c.state === 'confirmed').map((c) => c.runnerPlayerId)}
            turnedHunterIds={dr.catches.filter((c) => c.state === 'confirmed').map((c) => c.runnerPlayerId)}
            insideZone={insideZone}
            outsideSeconds={outsideSeconds}
            countdownPaused={countdownPaused}
            hasFix={fix !== null}
            zoneEnabled={playZoneOn}
          />
          <PlayerDots entries={dotEntries} title={dotTitle} emptyText="No Runners to show yet — roles are assigned when the match starts." />
        </>
      ) : view === 'radar' ? (
        <>
          <CompassRadar
            distanceMeters={latestPing?.distanceMeters ?? null}
            bearingDegrees={latestPing?.bearingDegrees ?? null}
            bearingWordLabel={latestPing && latestPing.bearingDegrees !== null ? bearingWord(latestPing.bearingDegrees) : ''}
            reportedAt={latestPing?.reportedAt ?? null}
            areaLabel={latestPing?.areaLabel ?? 'No ping area yet'}
          />
          {myRole === 'hunter' ? (
            <>
              <HotColdReadout distanceMeters={latestPing?.distanceMeters ?? null} reportedAt={latestPing?.reportedAt ?? null} />
              {!liveMode ? (
                <p><button type="button" className="btn btn-secondary" onClick={simulatePing}>Simulate a scheduled ping</button> <span className="small">Pings arrive from the server on schedule. This button creates a clearly labelled coarse area — never an exact pin. Hot/cold tiers are coarse and their thresholds are calibration OPEN.</span></p>
              ) : (
                <p className="small">Pings arrive from the server on schedule — a ping stays until the next ping replaces it, with its age shown.</p>
              )}
            </>
          ) : (
            <p className="small">Radar is your compass + hot/cold readout. Runners never see Hunter positions — only the zone and the way-back guide on the Map tab.</p>
          )}
          <PlayerDots entries={dotEntries} title={dotTitle} emptyText="No Runners to show yet — roles are assigned when the match starts." />
        </>
      ) : (
        <>
          <TeamRadio
            roomId={roomId}
            scope={radioScope}
            meName={myPlayer?.displayName ?? null}
            huntersCanTalk={dr.room.config.huntersCanTalk ?? true}
            liveText={liveMode ? {
              messages: liveRadio,
              connected: socketState === 'connected',
              send: (text, kind) => socketRef.current?.sendRadioMessage(text, kind) ?? false,
            } : undefined}
            voice={liveMode && myPlayer?.team && me ? {
              myPlayerId: me,
              teammates: voiceTeammates,
              sendSignal: (toPlayerId, signal) => socketRef.current?.sendVoiceSignal(toPlayerId, signal) ?? false,
              incomingSignal: incomingVoiceSignal,
            } : undefined}
          />
        </>
      )}

      <div id="role-tools">
        <RoleToolbar
          role={myRole} isHost={!!myPlayer?.isHost}
          onCatch={() => router.push(`/room/${roomId}/catch`)}
          onSafeCheckin={safe}
          onSignal={(s) => setSignalMsg(`Signal “${s}” tapped.`)}
        />
      </div>
      {signalMsg ? <p role="status">{signalMsg}</p> : null}
      {safeCheckin ? <p role="status">{safeCheckin}</p> : null}
      {liveActionMsg ? <p role="status">{liveActionMsg}</p> : null}

      {/* Bottom thumb zone: ONE primary action per role/state. An ejected
          player is out — no role action, just Leave. */}
      <div className="thumb-zone">
        {myPlayer?.ejectedAt ? (
          <button type="button" className="btn btn-secondary" onClick={doLeave}>You are out — Leave the game</button>
        ) : myRole === 'hunter' ? (
          <>
            <button type="button" className="btn" onClick={() => router.push(`/room/${roomId}/catch`)}>Catch — pick a Runner</button>
            <button type="button" className="btn btn-secondary" onClick={() => router.push(scanHref)} aria-label="Scan a Runner's QR code to start a tag">📷 Scan QR</button>
          </>
        ) : myRole === 'runner' ? (
          <>
            <button type="button" className="btn" onClick={safe}>I’m safe — check in</button>
            <button type="button" className="btn btn-secondary" onClick={refreshLocation} aria-label="Refresh my location — send one fresh location fix now">↻ Refresh my location</button>
          </>
        ) : (
          <button type="button" className="btn" disabled>Waiting for your role…</button>
        )}
      </div>
      {refreshMsg ? <p role="status">{refreshMsg}{lastSentAt ? ` ${lastUpdatedLabel(lastSentAt)}.` : ''}</p> : null}

      <div className="card">
        <h2>Runners — approximate areas only</h2>
        {runners.length === 0 ? <p>No Runners yet — roles are assigned when the match starts.</p> : (
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {runners.map((r) => (
              <PlayerFreshnessRow
                key={r.playerId} player={r}
                showCatchLink={myRole === 'hunter' && !r.ejectedAt && r.connectionState !== 'suspended' ? <a href={`/room/${roomId}/catch?runner=${r.playerId}`}>Catch</a> : undefined}
              />
            ))}
          </ul>
        )}
        <p className="small">Hunters see Runners only as scheduled pings (coarse area) in production. Exact locations are never shown. A catch needs the Runner’s QR scan — or their manual confirm if your camera can’t scan. Hunters: {hunters.map((h) => h.displayName).join(', ') || 'none yet'}.</p>
        {myRole === 'hunter' && latestPing ? <p className="small">Latest ping: {pingAgeLabel(latestPing.reportedAt)}{liveMode ? ' — server ping' : ' (simulated)'}{latestPing.distanceMeters !== null ? ` — nearest ping area roughly ${formatDistance(latestPing.distanceMeters)}${latestPing.bearingDegrees !== null ? ` ${bearingWord(latestPing.bearingDegrees)}` : ''} of you` : ''}{!liveMode && simPing && fix ? `, ${Math.round(haversineMeters(fix.lat, fix.lng, simPing.centreLat, simPing.centreLng))} m to the area centre` : ''}.</p> : null}
      </div>

      <CatchPanel
        mode={dr.room.config.mode}
        catches={dr.catches}
        players={dr.players}
        meId={me}
        isHost={!!myPlayer?.isHost}
        roomId={roomId}
        onConfirmCatch={(catchId) => {
          if (liveMode) {
            // Live: a catch is confirmed on the Catch screen with the
            // Runner's QR scan (catch.confirm carries the QR token) —
            // this screen has no token, so it cannot confirm here.
            setLiveActionMsg('Catch confirmations happen on the Catch screen with the Runner’s QR code — open Catch to complete it. This screen cannot confirm a catch without the QR scan.');
            return;
          }
          // Demo: host-review of a DISPUTED catch (demo-store enforces
          // host-only + disputed-only). It throws only if the claim
          // changed underneath us — refresh either way so the panel
          // shows the true state.
          try { confirmCatch(roomId, catchId, 'host-review', me ?? undefined); } catch { /* refreshed below */ }
          setDr(getRoom(roomId));
        }}
      />

      {myPlayer?.isHost ? <p><button className="btn btn-secondary" onClick={() => {
        if (liveMode) {
          if (sendLiveCheckin('Mid-match — all players accounted for')) setLiveActionMsg('Host check-in sent to the server.');
          return;
        }
        hostCheckin(roomId, 'Mid-match — all players accounted for'); setDr(getRoom(roomId));
      }}>Host check-in: mid-match — confirm all players accounted for</button></p> : null}
      <p className="small">Ping interval in this room: {dr.room.config.pingIntervalSeconds === 0 ? 'no pings' : `${dr.room.config.pingIntervalSeconds} s (calibration OPEN)`}. Catch-token lifetime: {CALIBRATION_OPEN.catchTokenTtlSeconds} s (calibration OPEN). Next ping in {dr.room.phase === 'ACTIVE' && nextPingIn !== null ? formatClock(nextPingIn) : '—'}.{playZoneOn ? ` Outside-zone rule: ${OUTSIDE_ZONE_RETURN_SECONDS} seconds to get back inside, or you are ejected from the game.${liveMode ? ' The countdown is shown here; the server enforces the ejection.' : ' The countdown and the ejection are enforced — when the countdown reaches 0 you are ejected.'}` : ' No play zone in this game — no outside-zone rule.'} Location is shared by default while the round is running (foreground only, founder decision 2026-11-17 — no custom cadence); the Refresh button re-sends your latest fix immediately.{liveMode ? ' Live: only fixes accurate to ±50 m or better are sent.' : ''}</p>
      <SafetyControls
        paused={paused}
        onPause={doPause}
        onSos={doSos}
        onSafe={safe}
        onLeave={doLeave}
      />
      {sosActive ? <div className="banner" role="alert"><strong>SOS sent to your host.</strong> SOS shares your current position with the host and pauses the match for everyone. Pakdam is NOT an emergency service. If you are in danger, call your local emergency number.</div> : null}
      <p><a href={`/room/${roomId}/results`}>See results</a></p>
    </div>
  );
}
