/**
 * `useRoomState` — one hook for the play / catch / results screens.
 *
 * Live mode (a Worker URL is set): first paint from
 * `GET /v1/rooms/:id`, then a `PakdamSocket` — the snapshot is the whole
 * truth; most events just trigger a fresh snapshot. Pings, radio and voice
 * signals are handled from the socket directly because snapshots never
 * carry them. Confirmed catches are session-only (the snapshot never
 * carries them either), so the hook keeps the ones it saw arrive.
 *
 * Demo mode (no Worker URL): poll the demo store every 1 s. Demo pings
 * auto-fire and the shrink uses the random-offset draw inside the store —
 * the hook just reads.
 *
 * The two modes are never mixed in one room. The hook never sets phase,
 * roles, timers or ejection locally in live mode — only the server does.
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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
  /** Confirmed / disputed catches this tab saw arrive (session-only). */
  sessionCatches: CatchView[];
  locationStatus: Record<string, 'known' | 'unknown'>;
  /** Delivered pings, kept until the next ping replaces them — never timer-removed. */
  pings: Ping[];
  radioMessages: RadioMessage[];
  announcements: Announcement[];
  /** Live socket (null in demo mode). */
  socket: PakdamSocket | null;
  socketState: WsConnectionState;
  socketError: string | null;
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
}

const IDLE_SAFETY: SafetyState = {
  paused: false,
  pausedBy: null,
  pausedAt: null,
  sosActive: false,
};

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
  const [pings, setPings] = useState<Ping[]>([]);
  const [radioMessages, setRadioMessages] = useState<RadioMessage[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [socketState, setSocketState] = useState<WsConnectionState>('idle');
  const [socketError, setSocketError] = useState<string | null>(null);
  const [demo, setDemo] = useState<DemoRoom | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [socket, setSocket] = useState<PakdamSocket | null>(null);
  const socketRef = useRef<PakdamSocket | null>(null);
  const voiceSignalRef = useRef(options?.onVoiceSignal);
  voiceSignalRef.current = options?.onVoiceSignal;
  const myPlayerIdRef = useRef(myPlayerId);
  myPlayerIdRef.current = myPlayerId;

  const applySnapshot = useCallback((snapshot: WsSnapshotPayload) => {
    setRoom(snapshot.room);
    setPlayers(snapshot.players);
    setPhase(snapshot.phase);
    setSafetyState(snapshot.safetyState);
    setActiveCatches(snapshot.activeCatches);
    setLocationStatus(snapshot.locationStatus);
    setAnnouncements(snapshot.missedAnnouncements);
    setLoading(false);
  }, []);

  const applyDemo = useCallback((next: DemoRoom | null) => {
    if (!next) {
      setError('Game not found on this device.');
      setLoading(false);
      return;
    }
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
        setRoom(state.room);
        setPlayers(state.players);
        setPhase(state.room.phase);
        setLoading(false);
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
        // A reconnect loses earlier pings — they arrive again as fresh `ping` events.
        if (state === 'reconnecting') setPings([]);
        if (state === 'reconnect-failed') {
          setSocketError(detail ?? 'reconnect failed — Retry');
        } else if (state === 'closed') {
          setSocketError(detail ?? null);
        } else {
          setSocketError(null);
        }
      },
      onError: (err: WsErrorPayload) => {
        if (!cancelled) setSocketError(err.message);
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
        const me = players.find((p) => p.playerId === myPlayerIdRef.current);
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
      return socketRef.current?.sendRadio(text, kind) ?? false;
    },
    [mode, players, roomId],
  );

  const myPlayer = players.find((p) => p.playerId === myPlayerId);

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
    pings,
    radioMessages,
    announcements,
    socket,
    socketState,
    socketError,
    demo,
    myPlayerId,
    myPlayer,
    loading,
    error,
    retryConnection,
    refreshDemo,
    sendRadio,
  };
}

/** A LocationFix the client may send (used by the play page's watcher). */
export type { LocationFix };
