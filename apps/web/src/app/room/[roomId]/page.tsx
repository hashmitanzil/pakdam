'use client';

/**
 * Lobby-is-setup (SCRAM-SPEC §5 + §7) — ONE screen.
 *
 * Room created on entry (by the mode page / join pages); the map, mode,
 * rules, zone, teams, roster, readiness and start all live here.
 * Order on screen: map (zone) → mode → rules → teams → code → summary
 * strip → roster → I'm ready → pinned start gate. The room code sits
 * with the players, not on top — the create screen leads with the map,
 * and the code is shown once the lobby is created (on entry here).
 *
 * Live mode (Worker URL set): first paint via GET state, then the
 * PakdamSocket snapshot is the whole truth; the phase leaving LOBBY
 * navigates to /play. Demo mode: the demo store polled every 1 s plus
 * watchDemoPhase (F2 — guests auto-navigate to /play when the phase
 * leaves LOBBY). A live room is never silently downgraded to demo.
 *
 * Start gate (server + client agree): active seats ≥ 3 AND every active
 * seat ready AND teams set. A blocked Start always says why in one
 * line — never a silent disabled button.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import type { PlayerView, Room, RoomConfig } from '@pakdam/shared';
import { PakdamSocket } from '../../../lib/websocket';
import type { WsSnapshotPayload } from '../../../lib/websocket';
import { liveErrorMessage } from '../../../lib/live-client';
import {
  canStartLiveMatch,
  fetchLiveRoomState,
  regenerateLiveRoomCode,
  removeLivePlayer,
  snapshotToLiveRoomState,
  startLiveMatch,
  updateLiveRoomConfig,
} from '../../../lib/live-room-client';
import {
  canStartDemoMatch,
  getRoom,
  leaveRoom,
  pollDemoRoom,
  setSelectedHunters,
  setTeamAssignment,
  startDemoMatch,
  toggleReady,
  updateRoomConfig,
  watchDemoPhase,
} from '../../../lib/demo-store';
import {
  clearSession,
  getSessionForRoom,
  type PakdamSession,
} from '../../../lib/session-credentials';
import { canZoneAutoCentreOn, getCurrentFix, watchLocation } from '../../../lib/geolocation';
import { distanceMeters, formatDistance } from '../../../lib/utils';
import { circlePolygon } from '@pakdam/engine';
import { Button } from '../../../components/ui/Button';
import { Stepper } from '../../../components/ui/Stepper';
import { RoomCodeCard } from '../../../components/lobby/RoomCodeCard';
import { Roster } from '../../../components/lobby/Roster';
import { ReadinessProbe } from '../../../components/lobby/ReadinessProbe';
import { HostSettingsSheet } from '../../../components/lobby/HostSettingsSheet';
import { PlayAreaMap, type ZoneDraft } from '../../../components/host-setup/PlayAreaMap';
import { RulesControls, TeamControls } from '../../../components/host-setup/SetupControls';
import { effectiveHunterCount, formatRoomSummary } from '../../../components/host-setup/draft';
import {
  autoFinalRadiusMeters,
  boundaryCentre,
  boundaryRadiusMeters,
  circleBoundary,
  drawPointsToBoundary,
  drawSizeRangeLabel,
  DRAW_MAX_POINTS,
  type GeoPoint,
} from '../../../components/host-setup/drawPoints';

interface LobbyState {
  room: Room;
  players: PlayerView[];
}

interface ZoneState {
  centre: GeoPoint;
  radiusMeters: number;
  shape: 'circle' | 'draw';
  drawPoints: GeoPoint[];
}

const RANCHI_DEFAULT: GeoPoint = { lat: 23.36, lng: 85.33 };

function zoneFromConfig(config: RoomConfig): ZoneState {
  return {
    centre: boundaryCentre(config.zone.boundary),
    radiusMeters: boundaryRadiusMeters(config.zone.boundary),
    shape: config.zoneShape ?? 'circle',
    drawPoints: config.zoneShape === 'draw' ? [...config.zone.boundary] : [],
  };
}

function isDefaultCentre(centre: GeoPoint): boolean {
  return distanceMeters(centre, RANCHI_DEFAULT) < 50;
}

export default function LobbyPage() {
  const router = useRouter();
  const params = useParams();
  const roomId = typeof params.roomId === 'string' ? params.roomId : '';

  const [session, setSession] = useState<PakdamSession | null | undefined>(undefined);
  const [lobby, setLobby] = useState<LobbyState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [conn, setConn] = useState<string>('connecting');
  const [notice, setNotice] = useState<string | null>(null);
  const [gpsNote, setGpsNote] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [zone, setZone] = useState<ZoneState | null>(null);
  const [userLocation, setUserLocation] = useState<GeoPoint | null>(null);
  const [locateNonce, setLocateNonce] = useState(0);
  const [locating, setLocating] = useState(false);

  const socketRef = useRef<PakdamSocket | null>(null);
  const lobbyRef = useRef<LobbyState | null>(null);
  lobbyRef.current = lobby;
  const zoneRef = useRef<ZoneState | null>(null);
  zoneRef.current = zone;
  const pushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPushRef = useRef(false);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gpsAttemptedRef = useRef(false);
  const rulesRef = useRef<HTMLDivElement | null>(null);
  const navigatedRef = useRef(false);

  const showNotice = useCallback((message: string): void => {
    setNotice(message);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(null), 6000);
  }, []);

  const goPlay = useCallback(() => {
    if (navigatedRef.current) return;
    navigatedRef.current = true;
    router.push(`/room/${roomId}/play`);
  }, [roomId, router]);

  const isLive = session?.mode === 'live';
  const me = lobby?.players.find((p) => p.playerId === session?.playerId);
  const isHost = me?.isHost ?? session?.isHost ?? false;
  const config = lobby?.room.config ?? null;
  const activePlayers = (lobby?.players ?? []).filter((p) => p.leftAt === null);
  // Final size is always Auto (~25% of the start radius) — no manual control.
  const finalRadius = config
    ? autoFinalRadiusMeters(
        zone?.radiusMeters ?? boundaryRadiusMeters(config.zone.boundary),
      )
    : null;

  // -- Load the seat, then live state / socket or demo polling (F2). ------
  useEffect(() => {
    const found = getSessionForRoom(roomId);
    setSession(found);
    if (!found) return;
    if (found.mode === 'live') {
      let cancelled = false;
      void fetchLiveRoomState(roomId, found.playerId, found.reconnectToken ?? '')
        .then((state) => {
          if (cancelled) return;
          setLobby({ room: state.room, players: state.players });
          if (state.room.phase !== 'LOBBY') goPlay();
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setLoadError(err instanceof Error ? err.message : 'Game not found or ended.');
        });
      const socket = new PakdamSocket({
        roomId,
        playerId: found.playerId,
        onSnapshot: (snapshot: WsSnapshotPayload) => {
          if (cancelled) return;
          if (snapshot.room.phase !== 'LOBBY') {
            goPlay();
            return;
          }
          const state = snapshotToLiveRoomState(snapshot);
          // Don't let a stale server echo clobber a config push in flight.
          if (pendingPushRef.current && lobbyRef.current) {
            setLobby({ room: { ...state.room, config: lobbyRef.current.room.config }, players: state.players });
          } else {
            setLobby({ room: state.room, players: state.players });
          }
        },
        onStateChange: (state) => setConn(state),
        onError: (error) => showNotice(error.message),
      });
      socketRef.current = socket;
      void socket.connect();
      return () => {
        cancelled = true;
        socket.close();
        socketRef.current = null;
      };
    }
    // Demo: 1 s poll + F2 phase watch (guest auto-navigates to /play).
    const demo = getRoom(roomId);
    if (demo) setLobby({ room: demo.room, players: demo.players });
    else setLoadError('Game not found or ended.');
    const timer = setInterval(() => {
      const current = pollDemoRoom(roomId);
      if (current) setLobby({ room: current.room, players: current.players });
    }, 1000);
    const watch = watchDemoPhase(roomId, () => goPlay());
    return () => {
      clearInterval(timer);
      watch.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  // -- Zone state: initialise once from the room config; guests follow
  //    the server config on every version change. -----------------------
  useEffect(() => {
    if (lobby && !zone) setZone(zoneFromConfig(lobby.room.config));
  }, [lobby, zone]);
  useEffect(() => {
    if (lobby && !isHost) setZone(zoneFromConfig(lobby.room.config));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lobby?.room.version]);

  // -- Config edits (host only). Normalised so a 'selected' team always
  //    carries exactly hunterCount picks (the config validator requires
  //    it) and 'random' carries none. -----------------------------------
  const normaliseConfig = useCallback(
    (next: RoomConfig): RoomConfig => {
      if (next.teamAssignment === 'random') {
        return { ...next, selectedHunterIds: [] };
      }
      // The pick count is the EFFECTIVE Hunter count (balance table when
      // Balance is ON), never the raw stepper value — the server draws the
      // effective count, so asking for `config.hunterCount` picks here
      // would block the start when the two disagree.
      const count = effectiveHunterCount(next, activePlayers.length);
      const activeIds = activePlayers.map((p) => p.playerId);
      const kept = next.selectedHunterIds.filter((id) => activeIds.includes(id));
      for (const id of activeIds) {
        if (kept.length >= count) break;
        if (!kept.includes(id)) kept.push(id);
      }
      return { ...next, selectedHunterIds: kept.slice(0, count) };
    },
    [activePlayers],
  );

  const applyConfig = useCallback(
    (nextRaw: RoomConfig): void => {
      const current = lobbyRef.current;
      if (!current || !config) return;
      const next = normaliseConfig(nextRaw);
      setLobby({ ...current, room: { ...current.room, config: next } });
      if (!isLive) {
        try {
          const demo = getRoom(roomId);
          if (!demo) return;
          const prev = demo.room.config;
          if (next.teamAssignment !== prev.teamAssignment) {
            setTeamAssignment(demo, next.teamAssignment);
            if (next.teamAssignment === 'selected') {
              setSelectedHunters(getRoom(roomId) ?? demo, next.selectedHunterIds);
            }
          } else if (next.hunterCount !== prev.hunterCount) {
            updateRoomConfig(demo, next);
            if (next.teamAssignment === 'selected') {
              // updateRoomConfig clears the pick on a hunter-count
              // change — restore the normalised pick right after.
              setSelectedHunters(getRoom(roomId) ?? demo, next.selectedHunterIds);
            }
          } else {
            updateRoomConfig(demo, next);
          }
          const saved = getRoom(roomId);
          if (saved) setLobby({ room: saved.room, players: saved.players });
        } catch (err) {
          showNotice(err instanceof Error ? err.message : 'Setup not accepted.');
          const saved = getRoom(roomId);
          if (saved) setLobby({ room: saved.room, players: saved.players });
        }
        return;
      }
      // Live: debounce pushes while the host drags sliders.
      pendingPushRef.current = true;
      if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
      pushTimerRef.current = setTimeout(() => {
        void updateLiveRoomConfig(roomId, next)
          .catch((err: unknown) => {
            showNotice(
              err instanceof Error && 'status' in err
                ? liveErrorMessage((err as { status: number }).status)
                : 'Settings were not saved — try again.',
            );
          })
          .finally(() => {
            pendingPushRef.current = false;
          });
      }, 500);
    },
    [config, isLive, normaliseConfig, roomId, showNotice],
  );
  const applyConfigRef = useRef(applyConfig);
  applyConfigRef.current = applyConfig;

  const applyZoneToConfig = useCallback(
    (draft: ZoneDraft): void => {
      const current = lobbyRef.current;
      if (!current) return;
      const boundary =
        draft.shape === 'draw'
          ? drawPointsToBoundary(draft.drawPoints)
          : circleBoundary(draft.centre, draft.radiusMeters);
      if (boundary.length < 3) return;
      applyConfig({
        ...current.room.config,
        zone: { ...current.room.config.zone, boundary },
        zoneShape: draft.shape,
        // Final size is always Auto — normalise any fixed value away.
        finalSizePercent: null,
      });
    },
    [applyConfig],
  );
  const applyZoneToConfigRef = useRef(applyZoneToConfig);
  applyZoneToConfigRef.current = applyZoneToConfig;

  // -- GPS: centre the zone on the host's fix (≤ ±50 m only) when the
  //    zone is still the Ranchi default. --------------------------------
  useEffect(() => {
    if (!lobby || !isHost || gpsAttemptedRef.current) return;
    gpsAttemptedRef.current = true;
    if (!isDefaultCentre(zoneRef.current?.centre ?? RANCHI_DEFAULT)) return;
    void getCurrentFix()
      .then((fix) => {
        if (!canZoneAutoCentreOn(fix)) {
          setGpsNote('GPS is too rough here — tap the map to place the zone.');
          return;
        }
        if (!isDefaultCentre(zoneRef.current?.centre ?? RANCHI_DEFAULT)) return;
        const draft: ZoneDraft = {
          centre: { lat: fix.lat, lng: fix.lng },
          radiusMeters: zoneRef.current?.radiusMeters ?? 500,
          shape: 'circle',
          drawPoints: [],
        };
        setUserLocation({ lat: fix.lat, lng: fix.lng });
        setZone(draft);
        applyZoneToConfigRef.current(draft);
      })
      .catch((err: unknown) => {
        setGpsNote(
          err instanceof Error
            ? err.message
            : 'GPS is too rough here — tap the map to place the zone.',
        );
      });
  }, [lobby, isHost]);

  // -- Live location dot: foreground watch, updates the orange dot on the
  //    map. Starts once on mount; stops on unmount. Only permission-denied
  //    is surfaced; transient errors are swallowed by the watch.
  useEffect(() => {
    const handle = watchLocation(
      (fix) => setUserLocation({ lat: fix.lat, lng: fix.lng }),
      (err) => {
        if (err.kind === 'permission-denied') setGpsNote(err.message);
      },
    );
    return () => handle?.stop();
  }, []);

  // -- Zone draft handlers (map + inline controls). ----------------------
  const onZoneChange = (draft: ZoneDraft): void => {
    setZone(draft);
    if (draft.shape === 'circle' || draft.drawPoints.length >= 3) {
      applyZoneToConfig(draft);
    }
  };

  // -- Inline zone controls (Circle | Draw lives on the lobby, no editor).
  const switchShape = (next: 'circle' | 'draw'): void => {
    if (!zone) return;
    if (!isHost) {
      showNotice('Only the host can change the game settings.');
      return;
    }
    if (next === zone.shape) return;
    if (next === 'draw') {
      // Keep the same centre/size: sample the circle as corners.
      const draft: ZoneDraft = {
        centre: zone.centre,
        radiusMeters: zone.radiusMeters,
        shape: 'draw',
        drawPoints: circlePolygon(zone.centre, zone.radiusMeters, 6),
      };
      setZone(draft);
      applyZoneToConfig(draft);
    } else {
      const boundary = drawPointsToBoundary(zone.drawPoints);
      const draft: ZoneDraft = {
        centre: boundary.length >= 3 ? boundaryCentre(boundary) : zone.centre,
        radiusMeters:
          boundary.length >= 3
            ? boundaryRadiusMeters(boundary)
            : zone.radiusMeters,
        shape: 'circle',
        drawPoints: [],
      };
      setZone(draft);
      applyZoneToConfig(draft);
    }
  };

  const setRadius = (value: number): void => {
    if (!zone) return;
    const radius = Math.max(100, value);
    const draft: ZoneDraft = {
      centre: zone.centre,
      radiusMeters: radius,
      shape: 'circle',
      drawPoints: [],
    };
    setZone(draft);
    applyZoneToConfig(draft);
  };

  const onCornersChange = (next: number): void => {
    if (!zone || zone.shape !== 'draw') return;
    if (next > zone.drawPoints.length) {
      showNotice('Tap the map to place a corner.');
    } else if (next < zone.drawPoints.length) {
      onZoneChange({ ...zone, drawPoints: zone.drawPoints.slice(0, -1) });
    }
  };

  const undoDraw = (): void => {
    if (!zone || zone.shape !== 'draw' || zone.drawPoints.length === 0) return;
    onZoneChange({ ...zone, drawPoints: zone.drawPoints.slice(0, -1) });
  };

  const startAgainDraw = (): void => {
    if (!zone || zone.shape !== 'draw') return;
    onZoneChange({ ...zone, drawPoints: [] });
  };

  const onLocate = (): void => {
    if (userLocation) {
      // Already have a fix — just re-centre the map on it.
      setLocateNonce((n) => n + 1);
      return;
    }
    setLocating(true);
    void getCurrentFix()
      .then((fix) => {
        setUserLocation({ lat: fix.lat, lng: fix.lng });
        setLocateNonce((n) => n + 1);
      })
      .catch((err: unknown) => {
        showNotice(
          err instanceof Error ? err.message : 'Could not get your location.',
        );
      })
      .finally(() => setLocating(false));
  };

  // -- Readiness (one tap = ready + briefing confirmed). -----------------
  const toggleMyReady = (): void => {
    if (!me || !session) return;
    if (!isLive) {
      try {
        const demo = getRoom(roomId);
        if (!demo) return;
        toggleReady(demo, me.playerId);
        const saved = getRoom(roomId);
        if (saved) setLobby({ room: saved.room, players: saved.players });
      } catch (err) {
        showNotice(err instanceof Error ? err.message : 'Could not send readiness.');
      }
      return;
    }
    const socket = socketRef.current;
    if (!socket || socket.connectionState !== 'connected') {
      showNotice('Not connected — your readiness was not sent. Wait for the reconnect, then tap again.');
      return;
    }
    if (!socket.setReady(!me.isReady)) {
      showNotice('Not connected — your readiness was not sent. Wait for the reconnect, then tap again.');
    }
  };

  // -- Start gate. --------------------------------------------------------
  const gate = (() => {
    if (!config) return { canStart: false, reason: 'Loading lobby…' };
    if (!isLive) {
      const demo = getRoom(roomId);
      return demo
        ? canStartDemoMatch(demo)
        : { canStart: false, reason: 'Game not found or ended.' };
    }
    return canStartLiveMatch(
      activePlayers,
      config.teamAssignment,
      config.selectedHunterIds,
      effectiveHunterCount(config, activePlayers.length),
    );
  })();

  const start = async (): Promise<void> => {
    if (starting) return;
    if (!isHost) {
      showNotice('Only the host can start the game.');
      return;
    }
    if (!gate.canStart) {
      showNotice(gate.reason ?? 'Cannot start yet.');
      return;
    }
    setStarting(true);
    try {
      if (!isLive) {
        const demo = getRoom(roomId);
        if (!demo) throw new Error('Game not found or ended.');
        startDemoMatch(demo);
        goPlay();
      } else {
        const result = await startLiveMatch(roomId);
        if (result.phase && result.phase !== 'LOBBY') goPlay();
      }
    } catch (err) {
      showNotice(err instanceof Error ? err.message : 'Could not start — try again.');
      setStarting(false);
    }
  };

  const leave = (): void => {
    if (!window.confirm('Leave this room? You can rejoin with the room code.')) return;
    if (isLive) {
      socketRef.current?.close('left from the lobby');
    } else {
      const demo = getRoom(roomId);
      if (demo && session) leaveRoom(demo, session.playerId);
    }
    clearSession(roomId);
    router.push('/');
  };

  const removePlayer = (targetPlayerId: string, displayName: string): void => {
    if (!window.confirm(`Remove ${displayName} from the lobby? They can rejoin with the room code.`)) return;
    if (!isLive) {
      const demo = getRoom(roomId);
      if (!demo) return;
      leaveRoom(demo, targetPlayerId);
      const saved = getRoom(roomId);
      if (saved) setLobby({ room: saved.room, players: saved.players });
      return;
    }
    void removeLivePlayer(roomId, targetPlayerId)
      .then(() => socketRef.current?.requestSnapshot())
      .catch((err: unknown) => {
        showNotice(err instanceof Error ? err.message : 'Could not remove that player.');
      });
  };

  const changeCode = (): void => {
    if (!isLive) return;
    void regenerateLiveRoomCode(roomId)
      .then((data) => {
        setLobby((prev) =>
          prev ? { ...prev, room: { ...prev.room, roomCode: data.roomCode } } : prev,
        );
        showNotice('New code issued — the old code no longer works.');
      })
      .catch((err: unknown) => {
        showNotice(err instanceof Error ? err.message : 'Could not change the code.');
      });
  };

  const toggleHunter = (playerId: string): void => {
    if (!config || !isHost) return;
    const selected = [...config.selectedHunterIds];
    const index = selected.indexOf(playerId);
    if (index >= 0) {
      selected.splice(index, 1);
      const replacement = activePlayers.find(
        (p) => !selected.includes(p.playerId) && p.playerId !== playerId,
      );
      if (replacement) selected.push(replacement.playerId);
    } else if (selected.length < effectiveHunterCount(config, activePlayers.length)) {
      selected.push(playerId);
    } else {
      selected[selected.length - 1] = playerId;
    }
    applyConfig({ ...config, selectedHunterIds: selected });
  };

  // -- Render states. ------------------------------------------------------
  if (session === undefined) {
    return (
      <main className="mx-auto w-full max-w-[560px] px-4 pb-6 pt-6">
        <p className="text-[15px] text-[#A1A1AA]">Loading lobby…</p>
      </main>
    );
  }
  if (session === null || loadError) {
    return (
      <main className="mx-auto w-full max-w-[560px] px-4 pb-6 pt-6">
        <p className="text-[15px] text-white">
          {loadError ?? 'No live seat saved on this device for this room.'}
        </p>
        <div className="mt-4">
          <Button variant="primary" onClick={() => router.push('/')}>
            Go home
          </Button>
        </div>
      </main>
    );
  }
  if (!lobby || !config || !zone) {
    return (
      <main className="mx-auto w-full max-w-[560px] px-4 pb-6 pt-6">
        <p className="text-[15px] text-[#A1A1AA]">Loading lobby…</p>
        <div className="mt-4 h-24 animate-pulse rounded-[16px] bg-[#141416]" />
        <div className="mt-3 h-40 animate-pulse rounded-[16px] bg-[#141416]" />
      </main>
    );
  }

  const room = lobby.room;
  const pickingHunters = isHost && config.teamAssignment === 'selected';
  const startLabel =
    activePlayers.length < 3
      ? 'NEED 3+ PLAYERS TO START'
      : 'WAITING FOR EVERYONE TO BE READY';
  const summary = formatRoomSummary(config, activePlayers.length);

  return (
    <main className="mx-auto min-h-dvh w-full max-w-[560px] px-4 pb-6 pt-4">
      <ReadinessProbe />
      <header className="flex items-center">
        <button
          type="button"
          onClick={() => router.push('/')}
          aria-label="Back"
          className="text-[22px] font-bold text-[#EF4444]"
        >
          ‹
        </button>
        <h1 className="flex-1 text-center text-[18px] font-bold text-white">Lobby</h1>
        <button
          type="button"
          onClick={leave}
          className="text-[15px] font-semibold text-[#EF4444]"
        >
          Leave
        </button>
      </header>

      {isLive && conn !== 'connected' ? (
        <p className="mt-3 text-[13px] text-[#F59E0B]" role="status">
          Not connected — your readiness was not sent. Wait for the reconnect, then tap again.
          {conn === 'reconnect-failed' ? (
            <button
              type="button"
              onClick={() => void socketRef.current?.retry()}
              className="ml-2 font-semibold text-[#EF4444]"
            >
              Retry
            </button>
          ) : null}
        </p>
      ) : null}
      {notice ? (
        <p className="mt-3 text-[13px] text-[#F59E0B]" role="status">
          {notice}
        </p>
      ) : null}

      <div className="mt-4 flex flex-col gap-3">
        {config.playZoneEnabled !== false && zone ? (
          <section
            aria-label="Play zone"
            className="rounded-[16px] border border-[#26262B] bg-[#141416] p-4"
          >
            <div
              className="grid grid-cols-2 gap-1 rounded-[14px] bg-[#1E1E22] p-1"
              role="group"
              aria-label="Zone shape"
            >
              {(['circle', 'draw'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={zone.shape === option}
                  disabled={!isHost}
                  onClick={() => switchShape(option)}
                  className={`h-11 rounded-[10px] text-[15px] font-bold capitalize disabled:opacity-40 ${
                    zone.shape === option ? 'bg-[#EF4444] text-white' : 'text-[#A1A1AA]'
                  }`}
                >
                  {option}
                </button>
              ))}
            </div>

            <div className="mt-3">
              <PlayAreaMap
                centre={zone.centre}
                radiusMeters={zone.radiusMeters}
                shape={zone.shape}
                drawPoints={zone.drawPoints}
                finalRadiusMeters={null}
                noGoAreas={config.noGoAreas}
                editable={isHost}
                onZoneChange={onZoneChange}
                userLocation={userLocation}
                locateNonce={locateNonce}
                locating={locating}
                onLocate={onLocate}
                height={280}
              />
            </div>
            {gpsNote ? <p className="mt-2 text-[13px] text-[#A1A1AA]">{gpsNote}</p> : null}

            {zone.shape === 'circle' ? (
              <div className="mt-3">
                <p className="pakdam-label">Zone size</p>
                <Stepper
                  label="Zone size"
                  value={zone.radiusMeters}
                  step={50}
                  min={100}
                  disabled={!isHost}
                  format={(v) => formatDistance(v)}
                  onChange={setRadius}
                />
                <p className="text-[13px] text-[#A1A1AA]">
                  {formatDistance(zone.radiusMeters * 2)} across
                </p>
                <p className="text-[13px] text-[#A1A1AA]">
                  Final size Auto · {formatDistance(finalRadius ?? zone.radiusMeters)}
                </p>
                <p className="mt-2 text-[13px] text-[#A1A1AA]">
                  Drag the map to move the zone. Runners have to stay inside it.
                </p>
              </div>
            ) : (
              <div className="mt-3">
                <p className="pakdam-label">Corners</p>
                <Stepper
                  label="Corners"
                  value={zone.drawPoints.length}
                  step={1}
                  min={0}
                  max={DRAW_MAX_POINTS}
                  disabled={!isHost}
                  format={(v) => String(v)}
                  onChange={onCornersChange}
                />
                <p className="text-[13px] text-[#A1A1AA]">
                  {zone.drawPoints.length > 0
                    ? drawSizeRangeLabel(zone.drawPoints)
                    : 'Tap the map to place corners.'}
                </p>
                <p className="mt-2 text-[13px] text-[#A1A1AA]">
                  Drag a corner to move it, or the middle to move the whole zone.
                </p>
                <div className="mt-1 flex items-center gap-4">
                  <button
                    type="button"
                    onClick={undoDraw}
                    disabled={!isHost || zone.drawPoints.length === 0}
                    className="text-[15px] font-semibold text-[#A1A1AA] disabled:opacity-40"
                  >
                    Undo
                  </button>
                  <button
                    type="button"
                    onClick={startAgainDraw}
                    disabled={!isHost || zone.drawPoints.length === 0}
                    className="text-[15px] font-semibold text-[#EF4444] disabled:opacity-40"
                  >
                    Start again
                  </button>
                </div>
              </div>
            )}
          </section>
        ) : (
          <p className="text-[13px] text-[#A1A1AA]">
            No zone and no pings. Classic hide and seek — hunters get no locations at all.
          </p>
        )}

        <section
          aria-label="Game mode"
          className="rounded-[16px] border border-[#26262B] bg-[#141416] p-4"
        >
          <p className="pakdam-label">Game mode</p>
          <div className="mt-1 flex items-center justify-between gap-3">
            <div>
              <p className="text-[20px] font-bold text-white">
                {config.mode === 'classic' ? 'Classic' : 'Infection'}
              </p>
              <p className="text-[13px] text-[#A1A1AA]">
                {config.mode === 'classic'
                  ? "Tagged? You're out. Watch live."
                  : 'Tagged? You join the Hunters.'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                if (!isHost) {
                  showNotice('Only the host can change the game settings.');
                  return;
                }
                applyConfig({
                  ...config,
                  mode: config.mode === 'classic' ? 'infection' : 'classic',
                });
              }}
              className="shrink-0 text-[15px] font-semibold text-[#EF4444]"
            >
              Change
            </button>
          </div>
        </section>

        <div ref={rulesRef} className="rounded-[16px] border border-[#26262B] bg-[#141416] p-4">
          <RulesControls
            config={config}
            activePlayerCount={activePlayers.length}
            isHost={isHost}
            onChange={applyConfig}
          />
        </div>

        <div className="rounded-[16px] border border-[#26262B] bg-[#141416] p-4">
          <TeamControls
            config={config}
            activePlayerCount={activePlayers.length}
            isHost={isHost}
            onChange={applyConfig}
          />
        </div>

        <RoomCodeCard
          code={room.roomCode}
          isHost={isHost}
          canChangeCode={isLive}
          onOpenSettings={() => {
            if (!isHost) {
              showNotice('Only the host can change the game settings.');
              return;
            }
            setSettingsOpen(true);
          }}
          onChangeCode={changeCode}
          onNotice={showNotice}
        />

        <button
          type="button"
          onClick={() => {
            if (!isHost) {
              showNotice('Only the host can change the game settings.');
              return;
            }
            rulesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }}
          className="flex items-center justify-between rounded-[16px] border border-[#26262B] bg-[#141416] px-4 py-3 text-left"
          aria-label="Game summary"
        >
          <span className="truncate text-[13px] text-[#A1A1AA]">⚙ {summary}</span>
          <span className="text-[18px] text-[#A1A1AA]" aria-hidden>
            ›
          </span>
        </button>

        <section
          aria-label="Players"
          className="rounded-[16px] border border-[#26262B] bg-[#141416] p-4"
        >
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[17px] font-bold text-white">Players</h2>
            <span className="inline-flex h-6 items-center rounded-full border border-[#22C55E] px-2 text-[11px] font-bold uppercase tracking-wide text-[#22C55E]">
              {activePlayers.length} joined
            </span>
          </div>
          <Roster
            players={lobby.players}
            hostPlayerId={room.hostPlayerId}
            myPlayerId={session.playerId}
            isHost={isHost}
            pickingHunters={pickingHunters}
            selectedHunterIds={config.selectedHunterIds}
            hunterCount={effectiveHunterCount(config, activePlayers.length)}
            onToggleHunter={toggleHunter}
            onRemove={(targetId) => {
              const target = lobby.players.find((p) => p.playerId === targetId);
              if (target) removePlayer(targetId, target.displayName);
            }}
          />
        </section>

        <button
          type="button"
          onClick={toggleMyReady}
          className={`inline-flex h-14 w-full items-center justify-center rounded-[14px] text-[17px] font-bold ${
            me?.isReady
              ? 'bg-[#1E1E22] text-[#22C55E]'
              : 'bg-[#EF4444] text-white active:bg-[#DC2626]'
          }`}
        >
          {me?.isReady ? "✓ I'm ready — tap to change" : "I'm ready"}
        </button>
      </div>

      <div className="sticky bottom-0 mt-4 bg-[#0A0A0B] pb-[env(safe-area-inset-bottom,0px)] pt-2">
        {isHost ? (
          gate.canStart ? (
            <Button variant="primary" onClick={() => void start()}>
              {starting ? 'Starting…' : 'START GAME'}
            </Button>
          ) : (
            <Button
              variant="blocked"
              onClick={() => showNotice(gate.reason ?? 'Cannot start yet.')}
            >
              ▶ {startLabel}
            </Button>
          )
        ) : (
          <Button
            variant="blocked"
            onClick={() => showNotice('Only the host can start the game.')}
          >
            WAITING FOR THE HOST TO START
          </Button>
        )}
      </div>

      <HostSettingsSheet
        open={settingsOpen}
        config={config}
        activePlayerCount={activePlayers.length}
        onChange={applyConfig}
        onClose={() => setSettingsOpen(false)}
      />
    </main>
  );
}
