'use client';

/**
 * Create lobby (ShadowHunt style) — the host setup screen.
 *
 * The host configures the game here BEFORE the lobby exists for anyone
 * else: map on top (Circle | Draw just above it), mode, rules, teams,
 * and a CREATE LOBBY button pinned at the bottom. NO room code anywhere
 * on this screen — the code appears only on the lobby screen, after the
 * host taps CREATE LOBBY and the app navigates to /room/[roomId].
 *
 * The room itself is created by the mode page before this screen loads,
 * so the host's config edits land on the real room (live via the Worker
 * or demo via the store). Only the host can use this screen — anyone
 * else is sent to the lobby. If the phase leaves LOBBY (the game
 * started), the host goes to /play like everyone else.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import type { PlayerView, Room, RoomConfig } from '@pakdam/shared';
import { METERS_PER_DEG_LAT, metersPerDegreeLng } from '@pakdam/shared';
import { PakdamSocket } from '../../../../lib/websocket';
import type { WsSnapshotPayload } from '../../../../lib/websocket';
import { liveErrorMessage } from '../../../../lib/live-client';
import {
  fetchLiveRoomState,
  snapshotToLiveRoomState,
  updateLiveRoomConfig,
} from '../../../../lib/live-room-client';
import {
  getRoom,
  pollDemoRoom,
  setSelectedHunters,
  setTeamAssignment,
  updateRoomConfig,
  watchDemoPhase,
} from '../../../../lib/demo-store';
import {
  getSessionForRoom,
  type PakdamSession,
} from '../../../../lib/session-credentials';
import { canZoneAutoCentreOn, getCurrentFix, watchLocation } from '../../../../lib/geolocation';
import { distanceMeters, formatDistance } from '../../../../lib/utils';
import { circlePolygon } from '@pakdam/engine';
import { Button } from '../../../../components/ui/Button';
import { Stepper } from '../../../../components/ui/Stepper';
import { PlayAreaMap, type ZoneDraft } from '../../../../components/host-setup/PlayAreaMap';
import { RulesControls, TeamControls } from '../../../../components/host-setup/SetupControls';
import { effectiveHunterCount } from '../../../../components/host-setup/draft';
import {
  autoFinalRadiusMeters,
  autoFinalSizePercent,
  boundaryCentre,
  boundaryRadiusMeters,
  circleBoundary,
  drawPointsToBoundary,
  drawSizeRangeLabel,
  DRAW_MAX_POINTS,
  type GeoPoint,
} from '../../../../components/host-setup/drawPoints';

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

export default function SetupPage() {
  const router = useRouter();
  const params = useParams();
  const roomId = typeof params.roomId === 'string' ? params.roomId : '';

  const [session, setSession] = useState<PakdamSession | null | undefined>(undefined);
  const [lobby, setLobby] = useState<LobbyState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Bumped by Retry — re-runs the seat/state load (P1-23). */
  const [loadNonce, setLoadNonce] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [gpsNote, setGpsNote] = useState<string | null>(null);
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

  const goLobby = useCallback(() => {
    if (navigatedRef.current) return;
    navigatedRef.current = true;
    router.push(`/room/${roomId}`);
  }, [roomId, router]);

  const isLive = session?.mode === 'live';
  const me = lobby?.players.find((p) => p.playerId === session?.playerId);
  const isHost = me?.isHost ?? session?.isHost ?? false;
  const config = lobby?.room.config ?? null;
  const activePlayers = (lobby?.players ?? []).filter((p) => p.leftAt === null);
  // Final size is always Auto (~42% of the start radius, 0.75³ after 3 shrinks) — no manual control.
  const finalRadius = config
    ? autoFinalRadiusMeters(
        zone?.radiusMeters ?? boundaryRadiusMeters(config.zone.boundary),
      )
    : null;

  // -- Load the seat, then live state / socket or demo polling. -----------
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
        onStateChange: () => {},
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
    // Demo: 1 s poll + phase watch (auto-navigate to /play).
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
  }, [roomId, loadNonce]);

  // -- Setup is host-only: anyone else goes to the lobby. ----------------
  useEffect(() => {
    if (!lobby || !session) return;
    const host = lobby.players.find((p) => p.playerId === session.playerId)?.isHost
      ?? session.isHost
      ?? false;
    if (!host) goLobby();
  }, [lobby, session, goLobby]);

  // -- Zone state: initialise once from the room config. ------------------
  useEffect(() => {
    if (lobby && !zone) setZone(zoneFromConfig(lobby.room.config));
  }, [lobby, zone]);

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
      // Live: debounce pushes while the host drags steppers.
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
      // A Draw with < 3 corners is NOT a valid zone — but the config must
      // still reflect the current mode: push an EMPTY boundary (the
      // validator allows it: "not placed yet") instead of silently
      // keeping the old circle as the active zone. The host sees the
      // "Place at least 3 corners" hint until the shape closes.
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
    // Always push: a Draw with < 3 corners clears the server zone to an
    // empty boundary (see applyZoneToConfig) instead of leaving the old
    // circle active while the host draws.
    applyZoneToConfig(draft);
  };

  // -- Inline zone controls (Circle | Draw lives on the create screen).
  const switchShape = (next: 'circle' | 'draw'): void => {
    if (!zone) return;
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
    const target = Math.max(0, Math.min(DRAW_MAX_POINTS, next));
    if (target === zone.drawPoints.length) return;
    if (target < zone.drawPoints.length) {
      // − removes from the end (unchanged).
      onZoneChange({ ...zone, drawPoints: zone.drawPoints.slice(0, target) });
      return;
    }
    // + adds a corner programmatically (it used to only show a notice,
    // so the count could go down to 0 but never back up). The first
    // point lands on the zone centre; later points spread around the
    // centroid at the current radius (golden angle) so they form a rough
    // polygon the host can then drag into shape. Tapping the map still
    // adds a corner at the tapped location.
    const points: GeoPoint[] = [...zone.drawPoints];
    while (points.length < target) {
      if (points.length === 0) {
        points.push({ lat: zone.centre.lat, lng: zone.centre.lng });
      } else {
        const centroid = points.reduce(
          (acc, p) => ({ lat: acc.lat + p.lat / points.length, lng: acc.lng + p.lng / points.length }),
          { lat: 0, lng: 0 },
        );
        const angle = points.length * 2.39996; // golden angle — spreads points
        const dLat = (zone.radiusMeters * Math.sin(angle)) / METERS_PER_DEG_LAT;
        const dLng =
          (zone.radiusMeters * Math.cos(angle)) / metersPerDegreeLng(centroid.lat);
        points.push({ lat: centroid.lat + dLat, lng: centroid.lng + dLng });
      }
    }
    onZoneChange({ ...zone, drawPoints: points });
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

  // -- Render states. ------------------------------------------------------
  if (session === undefined) {
    return (
      <main className="mx-auto w-full max-w-[560px] px-4 pb-6 pt-6">
        <p className="text-[15px] text-[#A1A1AA]">Loading…</p>
      </main>
    );
  }
  if (session === null || loadError) {
    return (
      <main className="mx-auto w-full max-w-[560px] px-4 pb-6 pt-6">
        <p className="text-[15px] text-white">
          {loadError ?? 'No live seat saved on this device for this room.'}
        </p>
        {/* A transient first-paint GET failure must not dead-end the
            screen — Retry re-runs the load (P1-23). */}
        <div className="mt-4 flex flex-col gap-3">
          <Button
            variant="primary"
            onClick={() => {
              setLoadError(null);
              setLoadNonce((n) => n + 1);
            }}
          >
            Retry
          </Button>
          <Button variant="outline" onClick={() => router.push('/')}>
            Go home
          </Button>
        </div>
      </main>
    );
  }
  if (!lobby || !config || !zone) {
    return (
      <main className="mx-auto w-full max-w-[560px] px-4 pb-6 pt-6">
        <p className="text-[15px] text-[#A1A1AA]">Loading…</p>
        <div className="mt-4 h-24 animate-pulse rounded-[16px] bg-[#141416]" />
        <div className="mt-3 h-40 animate-pulse rounded-[16px] bg-[#141416]" />
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-dvh w-full max-w-[560px] px-4 pb-6 pt-4">
      <header className="flex items-center">
        <button
          type="button"
          onClick={() => router.push('/')}
          aria-label="Back"
          className="text-[22px] font-bold text-[#EF4444]"
        >
          ‹
        </button>
        <h1 className="flex-1 text-center text-[18px] font-bold text-white">Create lobby</h1>
        <span className="w-6" aria-hidden />
      </header>

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
                  onClick={() => switchShape(option)}
                  className={`h-11 rounded-[10px] text-[15px] font-bold capitalize ${
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
                editable
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
                  // Step 50 m below 500 m, 100 m above (SCRAM-SPEC §6).
                  step={zone.radiusMeters < 500 ? 50 : 100}
                  min={100}
                  format={(v) => formatDistance(v)}
                  onChange={setRadius}
                />
                <p className="text-[13px] text-[#A1A1AA]">
                  {formatDistance(zone.radiusMeters * 2)} across
                </p>
                <p className="text-[13px] text-[#A1A1AA]">
                  Final size Auto · ~{autoFinalSizePercent()}% (
                  {formatDistance(finalRadius ?? zone.radiusMeters)})
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
                  format={(v) => String(v)}
                  onChange={onCornersChange}
                />
                <p className="text-[13px] text-[#A1A1AA]">
                  {zone.drawPoints.length > 0
                    ? drawSizeRangeLabel(zone.drawPoints)
                    : 'Tap the map to place corners.'}
                </p>
                {zone.drawPoints.length < 3 ? (
                  <p className="mt-1 text-[13px] text-[#F59E0B]">
                    Place at least 3 corners — the zone is not set yet.
                  </p>
                ) : null}
                <p className="mt-2 text-[13px] text-[#A1A1AA]">
                  Drag a corner to move it, or the middle to move the whole zone.
                </p>
                <div className="mt-1 flex items-center gap-4">
                  <button
                    type="button"
                    onClick={undoDraw}
                    disabled={zone.drawPoints.length === 0}
                    className="text-[15px] font-semibold text-[#A1A1AA] disabled:opacity-40"
                  >
                    Undo
                  </button>
                  <button
                    type="button"
                    onClick={startAgainDraw}
                    disabled={zone.drawPoints.length === 0}
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

        <div className="rounded-[16px] border border-[#26262B] bg-[#141416] p-4">
          <RulesControls
            config={config}
            activePlayerCount={activePlayers.length}
            isHost
            onChange={applyConfig}
          />
        </div>

        <div className="rounded-[16px] border border-[#26262B] bg-[#141416] p-4">
          <TeamControls
            config={config}
            activePlayerCount={activePlayers.length}
            isHost
            onChange={applyConfig}
          />
        </div>
      </div>

      <div className="sticky bottom-0 mt-4 bg-[#0A0A0B] pb-[env(safe-area-inset-bottom,0px)] pt-2">
        <Button variant="primary" onClick={goLobby}>
          CREATE LOBBY
        </Button>
      </div>
    </main>
  );
}
