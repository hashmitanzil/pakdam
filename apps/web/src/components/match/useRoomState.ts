/**
 * `useRoomState` — one hook for the play / catch / results screens.
 *
 * Live mode (a Worker URL is set): first paint from
 * `GET /v1/rooms/:id`, then a `PakdamSocket` — the snapshot is the whole
 * truth; most events just trigger a fresh snapshot. Pings, radio and voice
 * signals are handled from the socket directly because snapshots never
 * carry them. Decided catches (confirmed / disputed) ARE carried in the
 * snapshot (`decidedCatches`), so `applySnapshot` merges them into the
 * session catches — that is what restores the after-tagged screen and
 * auto-spectator state after a reload, when no `catch.*` event will arrive.
 *
 * Demo mode (no Worker URL): poll the demo store every 1 s. Demo pings
 * auto-fire and the shrink uses the random-offset draw inside the store —
 * the hook just reads.
 *
 * The two modes are never mixed in one room. The hook never sets phase,
 * roles, timers or ejection locally in live mode — only the server does.
 */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Announcement,
  CatchView,
  LocationFix,
  MatchPhase,
  Ping,
  PlayerView,
  RadioMessage,
  Room,
  SafetyState,
  WsErrorCode,
  WsErrorPayload,
  WsSnapshotPayload,
  WsConnectionState,
  WsServerEnvelope,
} from '@pakdam/shared';
import { PakdamSocket } from '@/lib/websocket';
import { fetchLiveRoomState } from '@/lib/live-room-client';
import { getSessionForRoom, type PakdamSession } from '@/lib/session-credentials';
import {
  getRoom,
  demoRoomChangeKey,
  pollDemoRoom,
  recordPlayerSuspension,
  resumePlayer,
  type DemoRoom,
} from '@/lib/demo-store';
import type { VoiceSignal } from '@/lib/voice-radio';

export interface UseRoomStateOptions {
  /** Incoming `voice.signal` envelopes, forwarded to the page's VoiceRadio. */
  onVoiceSignal?: (signal: VoiceSignal) => void;
}

export interface RoomStateData {
  /** Live seat for this room (null = no seat saved on this device). */
  session: PakdamSession | null;
  mode: 'live' | 'demo';
  room: Room | null;
  players: PlayerView[];
  phase: MatchPhase;
  safetyState: SafetyState;
  /** Pending catches only (recipient-filtered, from the snapshot / demo). */
  activeCatches: CatchView[];
  /** Confirmed / disputed catches: from live `catch.*` events, and rebuilt from the snapshot's `decidedCatches` on every snapshot (incl. first paint) so they survive a reload. */
  sessionCatches: CatchView[];
  locationStatus: Record<string, 'known' | 'unknown'>;
  /**
   * The viewer's teammates (same team, not left) and their latest live
   * fixes, keyed by playerId — from the snapshot in live mode. Teammates
   * only, never an opponent; empty for a caught Runner (they lose the
   * live teammate view). In demo mode the ids come from the demo room and
   * the fixes are empty (the demo tracks no teammate positions).
   */
  teammateIds: string[];
  teammateFixes: Record<string, LocationFix>;
  /** Delivered pings, kept until the next ping replaces them — never timer-removed. */
  pings: Ping[];
  radioMessages: RadioMessage[];
  announcements: Announcement[];
  /** Live socket (null in demo mode). */
  socket: PakdamSocket | null;
  socketState: WsConnectionState;
  socketError: string | null;
  /**
   * The most recent server error envelope, with its code and receipt
   * time — pages with a pending action (catch confirm, pause/resume)
   * watch this to clear the pending state and show the server's reason
   * instead of wedging. `socketError` (the plain string) stays for the
   * generic banners; this is the structured, per-envelope companion.
   */
  lastSocketError: { code: WsErrorCode; message: string; atMs: number } | null;
  /** Demo room (null in live mode). */
  demo: DemoRoom | null;
  myPlayerId: string;
  myPlayer: PlayerView | undefined;
  loading: boolean;
  error: string | null;
  /** Manual retry after `reconnect-failed` (live) or a fresh poll (demo). */
  retryConnection: () => void;
  /** Re-read the demo store immediately (after a demo mutation). */
  refreshDemo: () => void;
  /** Send a team-radio text (live: over the socket; demo: local only). */
  sendRadio: (text: string, kind?: 'quick' | 'text') => boolean;
  /**
   * Live reveal areas (from `reveal` events): who revealed, where, the
   * radius, and when the display expires. Rendered by the play page.
   */
  reveals: Array<{
    playerId: string;
    displayName: string;
    centre: { lat: number; lng: number };
    radiusMeters: number;
    expiresAtMs: number;
  }>;
  /** Send a reveal of my current position (live only; needs a fresh fix). */
  sendReveal: (fix?: LocationFix) => boolean;
  /** Leave the room: sends `leave` over the socket, then closes it. */
  leave: () => void;
}

const IDLE_SAFETY: SafetyState = {
  paused: false,
  pausedBy: null,
  pausedAt: null,
  sosActive: false,
};

/** Stable empty identities — a fresh `[]` / `{}` literal per snapshot
 *  would bust every memo downstream. */
const EMPTY_STRING_ARRAY: string[] = [];
const EMPTY_FIXES: Record<string, LocationFix> = {};

function toCatchView(
  c: { catchId: string; roomId: string; hunterPlayerId: string; runnerPlayerId: string; state: CatchView['state']; requestedAt: string; confirmedAt: string | null; disputedAt: string | null; resolution: CatchView['resolution']; gpsEvidence: CatchView['gpsEvidence'] },
): CatchView {
  return {
    catchId: c.catchId,
    roomId: c.roomId,
    hunterPlayerId: c.hunterPlayerId,
    runnerPlayerId: c.runnerPlayerId,
    state: c.state,
    requestedAt: c.requestedAt,
    confirmedAt: c.confirmedAt,
    disputedAt: c.disputedAt,
    resolution: c.resolution,
    gpsEvidence: c.gpsEvidence,
  };
}

function demoSafety(demo: DemoRoom): SafetyState {
  return {
    paused: demo.room.phase === 'SAFETY_PAUSED',
    pausedBy: null,
    pausedAt: demo.room.pausedAt,
    sosActive: demo.sosActive,
  };
}

export function useRoomState(roomId: string, options?: UseRoomStateOptions): RoomStateData {
  const [session] = useState<PakdamSession | null>(() => getSessionForRoom(roomId));
  const mode: 'live' | 'demo' = session?.mode ?? 'demo';
  const myPlayerId = session?.playerId ?? '';

  const [room, setRoom] = useState<Room | null>(null);
  const [players, setPlayers] = useState<PlayerView[]>([]);
  const [phase, setPhase] = useState<MatchPhase>('LOBBY');
  const [safetyState, setSafetyState] = useState<SafetyState>(IDLE_SAFETY);
  const [activeCatches, setActiveCatches] = useState<CatchView[]>([]);
  const [sessionCatches, setSessionCatches] = useState<CatchView[]>([]);
  const [locationStatus, setLocationStatus] = useState<Record<string, 'known' | 'unknown'>>({});
  const [teammateIds, setTeammateIds] = useState<string[]>([]);
  const [teammateFixes, setTeammateFixes] = useState<Record<string, LocationFix>>({});
  const [pings, setPings] = useState<Ping[]>([]);
  const [radioMessages, setRadioMessages] = useState<RadioMessage[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [reveals, setReveals] = useState<
    Array<{
      playerId: string;
      displayName: string;
      centre: { lat: number; lng: number };
      radiusMeters: number;
      expiresAtMs: number;
    }>
  >([]);
  const [socketState, setSocketState] = useState<WsConnectionState>('idle');
  const [socketError, setSocketError] = useState<string | null>(null);
  const [lastSocketError, setLastSocketError] = useState<{
    code: WsErrorCode;
    message: string;
    atMs: number;
  } | null>(null);
  const [demo, setDemo] = useState<DemoRoom | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [socket, setSocket] = useState<PakdamSocket | null>(null);
  const socketRef = useRef<PakdamSocket | null>(null);
  // Last applied payloads, by exact content: a re-fetched snapshot (or
  // a demo poll) with byte-identical content changes nothing, so the
  // ~12 setters below — and the full play-page re-render + map overlay
  // rebuild they trigger — are skipped outright. Identical JSON means
  // identical derived state, so skipping can never go stale; any real
  // change produces different JSON and applies normally.
  const lastSnapshotJsonRef = useRef<string | null>(null);
  const lastDemoJsonRef = useRef<string | null>(null);
  // Cheap first gate (B13): (version, serverSeq) of the last applied
  // snapshot — the same pair means the same server state, so the
  // JSON.stringify below is skipped entirely. A different pair falls
  // through to the stringify comparison as before.
  const lastSnapshotKeyRef = useRef<string | null>(null);
  // Cheap first gate for demo polls (B13): see `demoRoomChangeKey`.
  const lastDemoKeyRef = useRef<string | null>(null);
  // Optimistic live radio messages awaiting their server echo (A5):
  // the server mints a NEW messageId, so the echo can only be matched
  // by content + time, never by id.
  const pendingRadioRef = useRef<
    Array<{ messageId: string; playerId: string; text: string; kind: 'quick' | 'text'; sentAtMs: number }>
  >([]);
  // When the last radio message was sent (epoch ms) — an error envelope
  // is tied to that send only while it is recent, so an unrelated error
  // (e.g. a safety 403) never pulls back a radio message.
  const lastRadioSendAtMsRef = useRef<number>(0);
  // Player list for resolving a reveal sender's display name inside the
  // socket callback (created once per room/session, so state would be stale).
  const playersRef = useRef<PlayerView[]>([]);
  playersRef.current = players;
  const voiceSignalRef = useRef(options?.onVoiceSignal);
  voiceSignalRef.current = options?.onVoiceSignal;
  const myPlayerIdRef = useRef(myPlayerId);
  myPlayerIdRef.current = myPlayerId;

  const applySnapshot = useCallback((snapshot: WsSnapshotPayload) => {
    // Cheap gate first (B13): same (version, serverSeq) = same server
    // state — skip the stringify + whole fan-out outright.
    const key = `${snapshot.version}:${snapshot.serverSeq}`;
    if (key === lastSnapshotKeyRef.current) return;
    lastSnapshotKeyRef.current = key;
    // Duplicate snapshot (welcome → re-request, reconnect re-fetch):
    // same content, nothing to apply — skip the whole fan-out.
    const json = JSON.stringify(snapshot);
    if (json === lastSnapshotJsonRef.current) return;
    lastSnapshotJsonRef.current = json;
    setRoom(snapshot.room);
    setPlayers(snapshot.players);
    setPhase(snapshot.phase);
    setSafetyState(snapshot.safetyState);
    setActiveCatches(snapshot.activeCatches);
    setLocationStatus(snapshot.locationStatus);
    // Teammates' live view (teammates only, never an opponent; empty for
    // a caught Runner). `??` tolerates a server that predates these fields.
    setTeammateIds(snapshot.teammateIds ?? EMPTY_STRING_ARRAY);
    setTeammateFixes(snapshot.teammateFixes ?? EMPTY_FIXES);
    // A snapshot rescues a transient first-paint GET failure (P1-23):
    // the error clears as soon as live truth lands.
    setError(null);
    // Missed announcements MERGE into the existing list (P1-22) — a
    // snapshot only carries the ones missed since the last disconnect,
    // so replacing the whole list would drop announcements already shown.
    // Dedupe by announcementId; a later live event replaces, never duplicates.
    const missed = snapshot.missedAnnouncements ?? [];
    if (missed.length > 0) {
      setAnnouncements((prev) => {
        const next = [...prev];
        for (const a of missed) {
          const i = next.findIndex((p) => p.announcementId === a.announcementId);
          if (i >= 0) next[i] = a;
          else next.push(a);
        }
        return next;
      });
    }
    // Decided catches (confirmed / disputed) are carried in the snapshot so
    // the after-tagged screen and auto-spectator state survive a reload:
    // merge them into the session catches (upsert by catchId — a later live
    // event for the same catch replaces the snapshot copy, never duplicates
    // it). `?? []` tolerates a server that predates `decidedCatches`.
    const decided = snapshot.decidedCatches ?? [];
    if (decided.length > 0) {
      setSessionCatches((prev) => {
        const next = [...prev];
        for (const c of decided) {
          const i = next.findIndex((p) => p.catchId === c.catchId);
          if (i >= 0) next[i] = c;
          else next.push(c);
        }
        return next;
      });
      // P1-1: merge the decided catches into activeCatches as well — a
      // disputed catch still needs host resolution, so it stays visible
      // in the host UI. Confirmed catches are NOT pending and stay out.
      const disputed = decided.filter((c) => c.state === 'disputed');
      if (disputed.length > 0) {
        setActiveCatches((prev) => {
          const next = [...prev];
          for (const c of disputed) {
            const i = next.findIndex((p) => p.catchId === c.catchId);
            if (i >= 0) next[i] = c;
            else next.push(c);
          }
          return next;
        });
      }
    }
    setLoading(false);
  }, []);

  const applyDemo = useCallback((next: DemoRoom | null) => {
    if (!next) {
      setError('Game not found on this device.');
      setLoading(false);
      return;
    }
    // The demo poll runs every 1 s and re-parses localStorage, so `next`
    // is a fresh object every time even when nothing changed — without
    // this guard the poll re-rendered the whole play page (and rebuilt
    // the map overlays) every second of an idle game. Cheap key first
    // (B13): an unchanged key skips the stringify outright.
    const demoKey = demoRoomChangeKey(next);
    if (demoKey === lastDemoKeyRef.current) return;
    lastDemoKeyRef.current = demoKey;
    const json = JSON.stringify(next);
    if (json === lastDemoJsonRef.current) return;
    lastDemoJsonRef.current = json;
    setDemo(next);
    setRoom(next.room);
    setPlayers(next.players);
    setPhase(next.room.phase);
    setSafetyState(demoSafety(next));
    const pending = next.catches.filter(
      (c) => c.state === 'requested' || c.state === 'awaiting-confirmation' || c.state === 'disputed',
    );
    setActiveCatches(pending.map(toCatchView));
    setSessionCatches(
      next.catches
        .filter((c) => c.state === 'confirmed' || c.state === 'disputed')
        .map(toCatchView),
    );
    setPings(next.pings);
    // Demo teammates: same team as me, not me, not left. The demo tracks
    // no teammate positions (only the local player's fix is recorded), so
    // the live map markers stay empty in demo — the chips still show via
    // the ids, exactly as before.
    const me = next.players.find((p) => p.playerId === myPlayerIdRef.current);
    const myTeam = me?.team ?? null;
    setTeammateIds(
      myTeam === null
        ? []
        : next.players
            .filter(
              (p) =>
                p.playerId !== myPlayerIdRef.current &&
                p.team === myTeam &&
                p.leftAt === null,
            )
            .map((p) => p.playerId),
    );
    setTeammateFixes(EMPTY_FIXES);
    setLocationStatus(
      Object.fromEntries(
        next.players.map((p) => [
          p.playerId,
          p.connectionState === 'connected' ? 'known' : 'unknown',
        ]),
      ) as Record<string, 'known' | 'unknown'>,
    );
    setAnnouncements(
      next.announcements.map((a, i) => ({
        announcementId: `demo-${i}`,
        roomId: next.room.roomId,
        playerId: a.byPlayerId,
        senderName: next.players.find((p) => p.playerId === a.byPlayerId)?.displayName ?? '',
        text: a.text,
        sentAt: a.sentAt,
      })),
    );
    setLoading(false);
  }, []);

  const refreshDemo = useCallback(() => {
    applyDemo(pollDemoRoom(roomId));
  }, [applyDemo, roomId]);

  // -- Live: first paint + socket -------------------------------------------
  useEffect(() => {
    if (mode !== 'live') return;
    if (!session || !session.reconnectToken) {
      setError('No live seat saved on this device for this room.');
      setLoading(false);
      return;
    }
    let cancelled = false;
    fetchLiveRoomState(roomId, session.playerId, session.reconnectToken)
      .then((state) => {
        if (cancelled) return;
        // First paint IS a full snapshot (room/players/phase plus the
        // decided catches that restore the after-tagged / spectator state),
        // so apply it the same way as a socket snapshot.
        applySnapshot(state);
      })
      .catch(() => {
        if (!cancelled) {
          setError('Could not load the room — check your connection and try again.');
          setLoading(false);
        }
      });

    const socket = new PakdamSocket({
      roomId,
      playerId: session.playerId,
      onSnapshot: (snapshot) => {
        if (!cancelled) applySnapshot(snapshot);
      },
      onServerMessage: (envelope: WsServerEnvelope) => {
        if (cancelled) return;
        const payload = (envelope.payload ?? {}) as Record<string, unknown>;
        switch (envelope.type) {
          case 'ping': {
            const ping = payload['ping'] as Ping | undefined;
            if (!ping) break;
            // A delivered ping stays until the next ping for the same Runner replaces it.
            setPings((prev) => [
              ...prev.filter((p) => p.subjectPlayerId !== ping.subjectPlayerId),
              ping,
            ]);
            break;
          }
          case 'ping.expired': {
            const pingId = payload['pingId'] as string | undefined;
            if (pingId) setPings((prev) => prev.filter((p) => p.pingId !== pingId));
            break;
          }
          case 'radio': {
            const radio = payload['radio'] as RadioMessage | undefined;
            if (!radio) break;
            // A5: the server echo carries a NEW messageId, so an
            // optimistic message is matched by content + time (same
            // sender, same text/kind) and replaced by the server copy —
            // never shown twice. The window is 60 s, not 10 s: a client
            // clock >10 s off the server used to miss the echo entirely
            // and render every message twice. Pending entries older
            // than 60 s expire here too — an echo that late can never
            // match, so the unconfirmed optimistic copy is pulled back
            // rather than lingering as if it had been sent.
            const pending = pendingRadioRef.current;
            const nowMs = Date.now();
            const stale = pending.filter((p) => nowMs - p.sentAtMs > 60_000);
            if (stale.length > 0) {
              const staleIds = new Set(stale.map((p) => p.messageId));
              pendingRadioRef.current = pending.filter((p) => !staleIds.has(p.messageId));
              setRadioMessages((prev) => prev.filter((m) => !staleIds.has(m.messageId)));
            }
            const matchIndex = pendingRadioRef.current.findIndex(
              (p) =>
                p.playerId === radio.playerId &&
                p.text === radio.text &&
                p.kind === radio.kind &&
                Math.abs(Date.parse(radio.sentAt) - p.sentAtMs) < 60_000,
            );
            if (matchIndex >= 0) {
              const optimisticId = pendingRadioRef.current[matchIndex]?.messageId;
              pendingRadioRef.current.splice(matchIndex, 1);
              setRadioMessages((prev) =>
                prev.some((m) => m.messageId === radio.messageId)
                  ? prev
                  : [
                      ...prev.filter((m) => m.messageId !== optimisticId).slice(-49),
                      radio,
                    ],
              );
              break;
            }
            setRadioMessages((prev) =>
              prev.some((m) => m.messageId === radio.messageId)
                ? prev
                : [...prev.slice(-49), radio],
            );
            break;
          }
          case 'voice.signal': {
            voiceSignalRef.current?.(payload as unknown as VoiceSignal);
            break;
          }
          case 'announcement': {
            const announcement = payload['announcement'] as Announcement | undefined;
            if (announcement) setAnnouncements((prev) => [...prev, announcement]);
            break;
          }
          case 'reveal': {
            // P1-19: a teammate's reveal — store it for the play page to
            // render (centre + radius + display expiry). The sender's name
            // is resolved from the roster at receipt time.
            const reveal = payload['reveal'] as
              | { revealId?: string; byPlayerId?: string; centre?: { lat: number; lng: number }; radiusMeters?: number; sentAt?: string }
              | undefined;
            if (!reveal || !reveal.byPlayerId || !reveal.centre) break;
            // Extracted before the setState closure: narrowing does not
            // survive into the updater function.
            const revealerId = reveal.byPlayerId;
            const revealCentre = reveal.centre;
            const revealRadius = reveal.radiusMeters ?? 150;
            const sender =
              playersRef.current.find((p) => p.playerId === revealerId);
            const sentAtMs = reveal.sentAt ? Date.parse(reveal.sentAt) : Date.now();
            setReveals((prev) => [
              // One live reveal per player; expired rings drop out.
              ...prev.filter(
                (r) => r.playerId !== revealerId && Date.now() < r.expiresAtMs,
              ),
              {
                playerId: revealerId,
                displayName: sender?.displayName ?? '',
                centre: { lat: revealCentre.lat, lng: revealCentre.lng },
                radiusMeters: revealRadius,
                // Display TTL (60 s): the server defines no reveal TTL,
                // so the client retires the ring after a minute.
                expiresAtMs: sentAtMs + 60_000,
              },
            ]);
            break;
          }
          case 'catch.requested':
          case 'catch.confirmed':
          case 'catch.disputed':
          case 'catch.expired':
          case 'catch.rejected': {
            const catchView = payload['catch'] as CatchView | undefined;
            if (!catchView) {
              socket.requestSnapshot();
              break;
            }
            if (catchView.state === 'confirmed' || catchView.state === 'disputed') {
              setSessionCatches((prev) =>
                prev.some((c) => c.catchId === catchView.catchId)
                  ? prev.map((c) => (c.catchId === catchView.catchId ? catchView : c))
                  : [...prev, catchView],
              );
            }
            setActiveCatches((prev) => {
              const pending =
                catchView.state === 'requested' || catchView.state === 'awaiting-confirmation' || catchView.state === 'disputed';
              const rest = prev.filter((c) => c.catchId !== catchView.catchId);
              return pending ? [...rest, catchView] : rest;
            });
            break;
          }
          case 'match.completed':
          case 'match.cancelled':
          case 'room.state':
          case 'zone.update':
          case 'safety.paused':
          case 'safety.resumed':
          case 'sos.raised':
          case 'player.joined':
          case 'player.left':
          case 'player.removed':
          case 'player.suspended':
          case 'player.resumed':
          case 'player.visibility':
          case 'host.transferred':
            // The snapshot is the whole truth — re-fetch it.
            socket.requestSnapshot();
            break;
          default:
            break;
        }
      },
      onStateChange: (state, detail) => {
        if (cancelled) return;
        setSocketState(state);
        // Pings are NOT wiped on reconnecting: the existing pings stay
        // until the next interval replaces them — a reconnect must not
        // blank the map. Fresh `ping` events re-deliver what is still live.
        if (state === 'reconnect-failed') {
          setSocketError(detail ?? 'reconnect failed — Retry');
        } else if (state === 'closed') {
          setSocketError(detail ?? null);
        } else {
          setSocketError(null);
        }
      },
      onError: (err: WsErrorPayload) => {
        if (!cancelled) {
          setSocketError(err.message);
          setLastSocketError({ code: err.code, message: err.message, atMs: Date.now() });
          // A5 rollback, by error CODE — not by message-text regex. The
          // old `/radio/i` test missed the two rejections that matter
          // most: the rate limit ("Too many messages — slow down.",
          // RATE_LIMITED) and the caught-spectator block ("You are out
          // — spectating players cannot message the live team.",
          // FORBIDDEN) — both left the optimistic message on screen as
          // delivered when it was never sent. Tied to the last radio
          // send (recent only): an unrelated error never pulls back a
          // radio message. VALIDATION_FAILED covers the remaining radio
          // rejections ("Radio text must be…").
          if (
            (err.code === 'RATE_LIMITED' ||
              err.code === 'FORBIDDEN' ||
              err.code === 'VALIDATION_FAILED') &&
            pendingRadioRef.current.length > 0 &&
            Date.now() - lastRadioSendAtMsRef.current < 10_000
          ) {
            const dropped = new Set(pendingRadioRef.current.map((p) => p.messageId));
            pendingRadioRef.current = [];
            setRadioMessages((prev) => prev.filter((m) => !dropped.has(m.messageId)));
          }
        }
      },
    });
    socketRef.current = socket;
    setSocket(socket);
    void socket.connect();
    return () => {
      cancelled = true;
      socket.close();
      socketRef.current = null;
      setSocket(null);
    };
    // Socket is created once per room/session. applySnapshot is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, mode, session?.playerId]);

  // -- Demo: 1 s poll + suspend/resume on tab visibility --------------------
  useEffect(() => {
    if (mode !== 'demo') return;
    refreshDemo();
    const timer = window.setInterval(refreshDemo, 1000);
    const onVisibility = () => {
      const current = getRoom(roomId);
      if (!current) return;
      if (document.hidden) {
        recordPlayerSuspension(current, myPlayerIdRef.current, 'tab-hidden');
      } else {
        resumePlayer(current, myPlayerIdRef.current);
      }
      refreshDemo();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [mode, roomId, refreshDemo]);

  const retryConnection = useCallback(() => {
    if (mode === 'demo') {
      refreshDemo();
      return;
    }
    setSocketError(null);
    void socketRef.current?.retry();
  }, [mode, refreshDemo]);

  const sendRadio = useCallback(
    (text: string, kind: 'quick' | 'text' = 'text'): boolean => {
      if (mode === 'demo') {
        // Demo radio is local-only: no server, no other tab hears it.
        // The sender name comes from the roster ref, not the `players`
        // state — depending on `players` rebuilt this callback on every
        // snapshot and re-rendered the radio tab with it.
        const me = playersRef.current.find((p) => p.playerId === myPlayerIdRef.current);
        const message: RadioMessage = {
          messageId: crypto.randomUUID(),
          roomId,
          playerId: myPlayerIdRef.current,
          senderName: me?.displayName ?? 'You',
          text,
          kind,
          sentAt: new Date().toISOString(),
        };
        setRadioMessages((prev) => [...prev.slice(-49), message]);
        return true;
      }
      // A5: live radio is optimistic too — the message appears at once
      // (pending), the server echo replaces it by content match (the
      // server mints its own messageId), and a send failure pulls it
      // straight back. The demo branch below already did this locally.
      const me = playersRef.current.find((p) => p.playerId === myPlayerIdRef.current);
      const message: RadioMessage = {
        messageId: crypto.randomUUID(),
        roomId,
        playerId: myPlayerIdRef.current,
        senderName: me?.displayName ?? 'You',
        text,
        kind,
        sentAt: new Date().toISOString(),
      };
      const sent = socketRef.current?.sendRadio(text, kind) ?? false;
      if (!sent) return false;
      lastRadioSendAtMsRef.current = Date.parse(message.sentAt);
      pendingRadioRef.current.push({
        messageId: message.messageId,
        playerId: message.playerId,
        text,
        kind,
        sentAtMs: Date.parse(message.sentAt),
      });
      setRadioMessages((prev) => [...prev.slice(-49), message]);
      return true;
    },
    [mode, roomId],
  );

  const sendReveal = useCallback(
    (fix?: LocationFix): boolean => {
      if (mode === 'demo') return false;
      if (!fix) return false;
      return socketRef.current?.sendReveal(fix) ?? false;
    },
    [mode],
  );

  /** Leave the room (P0-1): the socket sends `leave`, then closes. */
  const leave = useCallback((): void => {
    socketRef.current?.leave();
  }, []);

  const myPlayer = useMemo(
    () => players.find((p) => p.playerId === myPlayerId),
    [players, myPlayerId],
  );

  return {
    session,
    mode,
    room,
    players,
    phase,
    safetyState,
    activeCatches,
    sessionCatches,
    locationStatus,
    teammateIds,
    teammateFixes,
    pings,
    radioMessages,
    announcements,
    reveals,
    socket,
    socketState,
    socketError,
    lastSocketError,
    demo,
    myPlayerId,
    myPlayer,
    loading,
    error,
    retryConnection,
    refreshDemo,
    sendRadio,
    sendReveal,
    leave,
  };
}

/** A LocationFix the client may send (used by the play page's watcher). */
export type { LocationFix };
