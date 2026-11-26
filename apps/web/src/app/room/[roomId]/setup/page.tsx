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
import { liveErrorMessage, LiveHttpError } from '../../../../lib/live-client';
import { goHomeAfterRoomDeleted } from '../../../../lib/room-deleted';
import {
  fetchLiveRoomState,
  snapshotToLiveRoomState,
  updateLiveRoomConfig,
} from '../../../../lib/live-room-client';
import {
  demoRoomChangeKey,
  getRoom,
  pollDemoRoom,
  updateRoomConfig,
} from '../../../../lib/demo-store';
import {
  getOrRestoreSessionForRoom,
  type PakdamSession,
} from '../../../../lib/session-credentials';
import { clearRejoinToken, refreshRejoinToken } from '../../../../lib/rejoin-token';
import { buildSnapshotKey } from '../../../../lib/snapshot-key';
import { canZoneAutoCentreOn, getCurrentFix, watchLocation } from '../../../../lib/geolocation';
import { distanceMeters, formatDistance, haversineMeters } from '../../../../lib/utils';
import { prefetchMapAssets } from '../../../../components/map/maplibre';
import { circlePolygon } from '@pakdam/engine';
import { Button } from '../../../../components/ui/Button';
import { Stepper } from '../../../../components/ui/Stepper';
import { PlayAreaMap, type ZoneDraft } from '../../../../components/host-setup/PlayAreaMap';
import { HouseRulesPresets, RulesControls, TeamControls, TimingControls } from '../../../../components/host-setup/SetupControls';
import {
  applyHousePreset,
  loadCustomPreset,
  saveCustomPreset,
  type HousePreset,
} from '../../../../lib/house-rules';
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
  // v31 fix round (F3): my seat was removed — the state fetch refused
  // it with 403 `SEAT_REMOVED`. The mirror dies with the seat and the
  // removal screen below renders instead of the generic dead-end.
  const [seatRemoved, setSeatRemoved] = useState(false);
  /** Bumped by Retry — re-runs the seat/state load (P1-23). */
  const [loadNonce, setLoadNonce] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [gpsNote, setGpsNote] = useState<string | null>(null);
  // Scope C item 5: the host's saved Custom preset (this device) + the
  // one-line confirmation shown right after a save.
  const [savedCustom, setSavedCustom] = useState<HousePreset | null>(() => loadCustomPreset());
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
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
  // A7: the latest config awaiting its debounced push, for flushing.
  const pendingConfigRef = useRef<RoomConfig | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gpsAttemptedRef = useRef(false);
  const navigatedRef = useRef(false);
  // B14: identical-skip refs for the demo poll / live snapshots.
  const lastDemoKeyRef = useRef<string | null>(null);
  const lastSnapshotKeyRef = useRef<string | null>(null);
  // B15: last fix actually shown on screen — the GPS display throttle.
  const lastShownFixRef = useRef<{ fix: { lat: number; lng: number }; atMs: number } | null>(null);

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

  // Room deleted (founder decision, 2026-11-21): the host cancelled and
  // the room is gone — home with the one plain message, once. Setup is
  // host-only, so this fires on a reload/reopen after the room was
  // deleted, or on the `room.deleted` event / a socket close that
  // probes 404.
  const deletedRef = useRef(false);
  const goHomeDeleted = useCallback(() => {
    if (deletedRef.current) return;
    deletedRef.current = true;
    goHomeAfterRoomDeleted(router, roomId);
  }, [roomId, router]);

  // v31 fix round (F3/F4): my own seat's state in any live state
  // arrival decides the mirror's fate — `leftAt` set = the seat was
  // removed while this tab was away, so the mirror dies at once and
  // "Rejoin your game" is never offered for a dead seat; a still-live
  // seat's 12 h clock refreshes on the successful resume instead.
  // Live only — demo seats have no mirror. Called from the
  // first-paint fetch and the socket snapshot in the load effect
  // below. The banner renders from `myLeftAt`.
  const noteLiveSeatState = useCallback(
    (players: PlayerView[], playerId: string): void => {
      const seat = players.find((p) => p.playerId === playerId);
      if (!seat) return;
      if (seat.leftAt !== null) clearRejoinToken(roomId);
      else if (seat.ejectedAt === null) refreshRejoinToken(roomId);
    },
    [roomId],
  );

  const isLive = session?.mode === 'live';
  const me = lobby?.players.find((p) => p.playerId === session?.playerId);
  // v31 fix round (F3): my seat removed while this tab was away —
  // the banner below renders from this; the mirror dies in
  // `noteLiveSeatState` on every live state arrival.
  const myLeftAt = me?.leftAt ?? null;
  const isHost = me?.isHost ?? session?.isHost ?? false;
  const config = lobby?.room.config ?? null;
  const activePlayers = (lobby?.players ?? []).filter((p) => p.leftAt === null);
  // Final size is always Auto (~42% of the start radius, 0.75³ after 3 shrinks) — no manual control.
  const finalRadius = config
    ? autoFinalRadiusMeters(
        zone?.radiusMeters ?? boundaryRadiusMeters(config.zone.boundary),
      )
    : null;

  // B21: warm the map chunk + Ola style at idle — the setup map is
  // the first thing on this screen, so prefetch on mount.
  useEffect(() => {
    prefetchMapAssets();
  }, []);

  // A7: roll the visible config back to the server's saved truth.
  const rollbackConfig = useCallback((): void => {
    if (session?.mode !== 'live') {
      const saved = getRoom(roomId);
      if (saved) setLobby({ room: saved.room, players: saved.players });
      return;
    }
    const currentSession = session;
    if (!currentSession) return;
    void fetchLiveRoomState(roomId, currentSession.playerId, currentSession.reconnectToken ?? '')
      .then((state) => setLobby({ room: state.room, players: state.players }))
      .catch(() => undefined);
  }, [roomId, session]);

  // A7: flush the pending debounced config push right now (CREATE
  // LOBBY, unmount) instead of letting the 500 ms timer fire after
  // the user has moved on. Returns false when the save failed (the UI
  // is already rolled back by then).
  const flushConfigPush = useCallback(async (): Promise<boolean> => {
    if (pushTimerRef.current) {
      clearTimeout(pushTimerRef.current);
      pushTimerRef.current = null;
    }
    const pending = pendingConfigRef.current;
    if (!pendingPushRef.current || !pending) return true;
    pendingConfigRef.current = null;
    try {
      await updateLiveRoomConfig(roomId, pending);
      pendingPushRef.current = false;
      return true;
    } catch (err: unknown) {
      pendingPushRef.current = false;
      showNotice(
        err instanceof Error && 'status' in err
          ? liveErrorMessage((err as { status: number }).status)
          : 'Settings were not saved — try again.',
      );
      rollbackConfig();
      return false;
    }
  }, [roomId, rollbackConfig, showNotice]);

  // A7: never leave a pending push behind on unmount (best-effort).
  useEffect(
    () => () => {
      if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
      if (pendingPushRef.current && pendingConfigRef.current) {
        const pending = pendingConfigRef.current;
        pendingPushRef.current = false;
        void updateLiveRoomConfig(roomId, pending).catch(() => undefined);
      }
    },
    // Runs once, on unmount, with the refs as they stand then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // -- Load the seat, then live state / socket or demo polling. -----------
  useEffect(() => {
    // v31 (Fix 1 — same defect as the lobby page): a discarded tab
    // comes back with no sessionStorage, and this effect used to read
    // sessionStorage only — a live seat with a stored rejoin token
    // read as "no seat". Restore from the rejoin mirror first, so a
    // reload after a tab discard resumes the live setup instead of
    // the "No live seat saved on this device" dead-end — and so Retry
    // (which re-runs this load) can actually succeed.
    const found = getOrRestoreSessionForRoom(roomId);
    setSession(found);
    if (!found) return;
    if (found.mode === 'live') {
      let cancelled = false;
      void fetchLiveRoomState(roomId, found.playerId, found.reconnectToken ?? '')
        .then((state) => {
          if (cancelled) return;
          setLobby({ room: state.room, players: state.players });
          noteLiveSeatState(state.players, found.playerId);
          if (state.room.phase !== 'LOBBY') goPlay();
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          // 404 = the room is gone (host cancelled, server deleted it):
          // a reload/reopen after deletion lands home with the one plain
          // message, not on a stale setup screen or an error screen.
          if (err instanceof LiveHttpError && err.status === 404) {
            goHomeDeleted();
            return;
          }
          // v31 fix round (F3): 403 `SEAT_REMOVED` = my seat left the
          // room — the mirror dies with the seat and the removal screen
          // renders, never the generic "Game not found or ended.". A
          // bare 403 (bad token, no code) keeps the old error.
          if (
            err instanceof LiveHttpError &&
            err.status === 403 &&
            err.code === 'SEAT_REMOVED'
          ) {
            clearRejoinToken(roomId);
            setSeatRemoved(true);
            return;
          }
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
          // B14 (v29 R1, fix round M1): identical-skip — the key is
          // `version:serverSeq:maxLastFixAtMs:epochMs`, so a
          // DO-eviction restore can never collide with the cached
          // key. Same key = same server state; a re-delivered
          // snapshot changes nothing.
          const key = buildSnapshotKey(snapshot);
          if (key === lastSnapshotKeyRef.current) return;
          lastSnapshotKeyRef.current = key;
          const state = snapshotToLiveRoomState(snapshot);
          noteLiveSeatState(state.players, found.playerId);
          // Don't let a stale server echo clobber a config push in flight.
          if (pendingPushRef.current && lobbyRef.current) {
            setLobby({ room: { ...state.room, config: lobbyRef.current.room.config }, players: state.players });
          } else {
            setLobby({ room: state.room, players: state.players });
          }
        },
        onServerMessage: (envelope) => {
          // `room.deleted` — the host cancelled and the server deleted
          // the room. Not in the frozen @pakdam/shared catalogue, so it
          // is matched on the raw string (see useRoomState for the same
          // handling on the play / catch / results pages).
          if ((envelope.type as string) === 'room.deleted') {
            goHomeDeleted();
          }
        },
        onStateChange: (state) => {
          // A server-side close (or an exhausted reconnect) can mean the
          // room was deleted out from under this client — the socket dies
          // with the room, and no `room.deleted` event may arrive first.
          // Probe the state fetch on every close: 404 = deleted (home
          // with the one plain message); anything else keeps the old
          // behaviour.
          if ((state === 'closed' || state === 'reconnect-failed') && !cancelled) {
            void fetchLiveRoomState(roomId, found.playerId, found.reconnectToken ?? '')
              .then(() => undefined)
              .catch((err: unknown) => {
                if (cancelled) return;
                if (err instanceof LiveHttpError && err.status === 404) goHomeDeleted();
                // v31 fix round (F3): the seat is out — mirror dies,
                // removal screen (a removed seat never probes again).
                else if (
                  err instanceof LiveHttpError &&
                  err.status === 403 &&
                  err.code === 'SEAT_REMOVED'
                ) {
                  clearRejoinToken(roomId);
                  setSeatRemoved(true);
                }
              });
          }
        },
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
    // Demo: ONE 1 s timer (B14) — the poll AND the phase watch used to
    // be two separate 1 s timers. The poll skips identical states via
    // the cheap change key, so an idle setup stops re-rendering.
    const demo = getRoom(roomId);
    if (demo) {
      lastDemoKeyRef.current = demoRoomChangeKey(demo);
      setLobby({ room: demo.room, players: demo.players });
    } else {
      // A session for this room means the room existed when this seat
      // was created — a missing room after a reload/reopen is a
      // deletion (host cancel), so home with the one plain message,
      // not an error screen.
      goHomeDeleted();
    }
    const timer = setInterval(() => {
      const current = pollDemoRoom(roomId);
      if (!current) {
        // A setup that was alive and is now gone was deleted (the host
        // cancelled in another tab) — home with the one plain message.
        // A setup never seen alive keeps the first-paint error above.
        if (lobbyRef.current) goHomeDeleted();
        return;
      }
      if (current.room.phase !== 'LOBBY') {
        goPlay();
        return;
      }
      const key = demoRoomChangeKey(current);
      if (key === lastDemoKeyRef.current) return;
      lastDemoKeyRef.current = key;
      setLobby({ room: current.room, players: current.players });
    }, 1000);
    return () => {
      clearInterval(timer);
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

  // -- Config edits (host only). Normalised so a 'selected' team
  //    carries only picks the host actually made ('random' carries
  //    none, a changed count or assignment clears the pick) — the
  //    exact count is enforced by the start gate, never auto-filled
  //    here. An earlier version filled the pick up to the effective
  //    count with the first roster rows, so turning Random OFF
  //    pre-picked hunters the host never chose and the roster read
  //    "2 of 2 Hunters picked" before a single tap (host-setup:150/:168).
  const normaliseConfig = useCallback(
    (next: RoomConfig): RoomConfig => {
      if (next.teamAssignment === 'random') {
        return { ...next, selectedHunterIds: [] };
      }
      // The pick count is the EFFECTIVE Hunter count (balance table when
      // Balance is ON), never the raw stepper value — the server draws the
      // effective count, so asking for `config.hunterCount` picks here
      // would block the start when the two disagree. Trim only: drop
      // picks that left the roster or exceed the effective count, and
      // NEVER fill — a short pick is the hand-pick state (the host taps
      // roster rows to fill it) and the start gate blocks until it is
      // complete.
      const count = effectiveHunterCount(next, activePlayers.length);
      const activeIds = activePlayers.map((p) => p.playerId);
      const kept = next.selectedHunterIds.filter((id) => activeIds.includes(id));
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
            // One call, whole config: `updateRoomConfig` persists the
            // full config AND clears the pick on the change, so the
            // roster starts at 0 of N. The old path called
            // `setTeamAssignment` (which writes only teamAssignment +
            // picks, never `randomDraw`) and then `setSelectedHunters`
            // (which demands exactly `hunterCount` picks) — so the
            // stored `randomDraw` stayed true and the 1 s poll
            // reverted the Random toggle/hint, and a short pick threw
            // and rolled the whole change back. The validator now
            // allows a 'selected' config with 0 picks (transient
            // hand-pick state; the start gate enforces the count).
            updateRoomConfig(demo, next);
          } else if (next.hunterCount !== prev.hunterCount) {
            // `updateRoomConfig` clears the pick on a hunter-count
            // change — the host re-picks from 0. Do NOT restore the
            // normalised pick here: it is short by construction now
            // (trim-only, no fill) and `setSelectedHunters` demands
            // exactly `hunterCount`, so the restore threw and rolled
            // the stepper change back.
            updateRoomConfig(demo, next);
          } else {
            updateRoomConfig(demo, next);
          }
          // B25: ONE setLobby per config tap — the optimistic setLobby
          // above already shows the saved value, so no re-read +
          // second setLobby on success. Only a failed save rolls back.
        } catch (err) {
          showNotice(err instanceof Error ? err.message : 'Setup not accepted.');
          rollbackConfig();
        }
        return;
      }
      // Live: debounce pushes while the host drags steppers.
      pendingPushRef.current = true;
      pendingConfigRef.current = next;
      if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
      pushTimerRef.current = setTimeout(() => {
        pushTimerRef.current = null;
        void updateLiveRoomConfig(roomId, next)
          .catch((err: unknown) => {
            // A7: the screen must not keep showing a value the server
            // rejected — roll back to the saved config, then say so.
            rollbackConfig();
            showNotice(
              err instanceof Error && 'status' in err
                ? liveErrorMessage((err as { status: number }).status)
                : 'Settings were not saved — try again.',
            );
          })
          .finally(() => {
            pendingPushRef.current = false;
            pendingConfigRef.current = null;
          });
      }, 500);
    },
    [config, isLive, normaliseConfig, roomId, rollbackConfig, showNotice],
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
  //    B15: the dot only moves when the fix actually moved (≥ 5 m) or
  //    5 s passed — the same display gate as the play page — instead of
  //    re-rendering (and re-drawing the map) on every raw GPS fix.
  useEffect(() => {
    const handle = watchLocation(
      (fix) => {
        const lastShown = lastShownFixRef.current;
        const movedM = lastShown
          ? haversineMeters(lastShown.fix, { lat: fix.lat, lng: fix.lng })
          : Infinity;
        if (movedM >= 5 || !lastShown || fix.timestampMs - lastShown.atMs >= 5000) {
          lastShownFixRef.current = {
            fix: { lat: fix.lat, lng: fix.lng },
            atMs: fix.timestampMs,
          };
          setUserLocation({ lat: fix.lat, lng: fix.lng });
        }
      },
      (err) => {
        if (err.kind === 'permission-denied') setGpsNote(err.message);
      },
    );
    return () => handle?.stop();
  }, []);

  // -- Zone draft handlers (map + inline controls). ----------------------
  // Stable (B14): PlayAreaMap is memoised — a fresh onZoneChange every
  // render would bust it on every poll tick.
  const onZoneChange = useCallback(
    (draft: ZoneDraft): void => {
      setZone(draft);
      // Always push: a Draw with < 3 corners clears the server zone to an
      // empty boundary (see applyZoneToConfig) instead of leaving the old
      // circle active while the host draws.
      applyZoneToConfig(draft);
    },
    [applyZoneToConfig],
  );

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

  const onLocate = useCallback((): void => {
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
  }, [userLocation, showNotice]);

  // A7: CREATE LOBBY flushes any debounced config push first, so the
  // lobby opens on the saved config — a failed save stops here with
  // the rollback already applied, instead of navigating on stale data.
  const handleCreateLobby = useCallback((): void => {
    void flushConfigPush().then((flushed) => {
      if (flushed) goLobby();
    });
  }, [flushConfigPush, goLobby]);

  // Scope C item 7: CREATE LOBBY states its own blocker — a drawn zone
  // with fewer than 3 corners is not a zone yet, so the lobby must not
  // open on an empty boundary. A circle is always set; zone OFF needs
  // no zone at all.
  const zoneReady =
    config?.playZoneEnabled === false ||
    zone === null ||
    zone.shape === 'circle' ||
    zone.drawPoints.length >= 3;
  const createBlockedReason = zoneReady
    ? null
    : 'Place at least 3 corners — the zone is not set yet.';

  // Scope C item 5: apply a house-rules preset — timing via the config
  // (the shrink interval follows the round length, as the stepper does)
  // and the zone size via the draft when the zone is a circle. A drawn
  // zone keeps its shape; the preset never rewrites it.
  const applyPreset = useCallback(
    (preset: HousePreset): void => {
      if (!config) return;
      setSaveNotice(null);
      const presetConfig = applyHousePreset(config, preset);
      if (zone && zone.shape === 'circle') {
        // ONE config write: the preset timing + the new zone boundary
        // together. Two writes would race — the zone write reads the
        // pre-preset config from the lobby ref and would drop the
        // preset timing.
        const draft: ZoneDraft = {
          centre: zone.centre,
          radiusMeters: preset.zoneRadiusMeters,
          shape: 'circle',
          drawPoints: [],
        };
        setZone(draft);
        applyConfig({
          ...presetConfig,
          zone: { ...presetConfig.zone, boundary: circleBoundary(draft.centre, draft.radiusMeters) },
          zoneShape: 'circle',
          finalSizePercent: null,
        });
      } else {
        applyConfig(presetConfig);
      }
    },
    [config, zone, applyConfig],
  );

  // Scope C item 5: save the current settings as the Custom preset on
  // this device, so the host can pick them again next time.
  const saveCurrentAsCustom = useCallback((): void => {
    if (!config) return;
    const radius =
      zone && zone.shape === 'circle'
        ? zone.radiusMeters
        : config.zone.boundary.length >= 3
          ? boundaryRadiusMeters(config.zone.boundary)
          : 500;
    const preset = {
      durationSeconds: config.durationSeconds,
      headStartSeconds: config.headStartSeconds,
      pingIntervalSeconds: config.pingIntervalSeconds,
      zoneRadiusMeters: radius,
      zoneShrinkEnabled: config.zoneShrinkEnabled,
    };
    saveCustomPreset(preset);
    setSavedCustom(loadCustomPreset());
    setSaveNotice('Saved — pick Custom next time.');
  }, [config, zone]);

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
  // v31 fix round (F3): my seat was removed — the state fetch refused
  // it with 403 `SEAT_REMOVED`. No Retry: a removed seat can never
  // reload, and the mirror is already dead — home, to join a new game.
  if (seatRemoved) {
    return (
      <main className="mx-auto w-full max-w-[560px] px-4 pb-6 pt-6">
        <p className="text-[15px] font-semibold text-white">You were removed from the game.</p>
        <p className="mt-2 text-[14px] text-[#A1A1AA]">
          The host removed you from this game. The game goes on without you — you can join a new
          game from home.
        </p>
        <div className="mt-4 flex flex-col gap-3">
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
      {/* v31 fix round (F3): removed by the host while this tab was
          away — the seat is gone, so the game goes on without you. */}
      {myLeftAt ? (
        <div className="mt-3 rounded-[16px] border border-[#26262B] bg-[#141416] p-4" role="status">
          <p className="text-[15px] font-bold text-white">You were removed from the game.</p>
          <p className="mt-1 text-[13px] text-[#A1A1AA]">
            The host removed you from this game. The game goes on without you — you can join a
            new game from home.
          </p>
        </div>
      ) : null}

      <div className="mt-4 flex flex-col gap-3">
        {config.playZoneEnabled !== false && zone ? (
          <section
            aria-label="Play zone"
            className="rounded-[16px] border border-[#26262B] bg-[#141416] p-4"
          >
            <p className="pakdam-label">Play area</p>
            <p className="mt-1 text-[13px] text-[#A1A1AA]">
              The host draws the zone. Everyone plays inside it.
            </p>
            <div
              className="mt-3 grid grid-cols-2 gap-1 rounded-[14px] bg-[#1E1E22] p-1"
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
            <p className="mt-2 text-[13px] text-[#A1A1AA]">
              Circle: one round zone. Draw: your own shape, placed corner by corner.
            </p>

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
        ) : // Zone OFF: no map and no zone controls. The one-line
          // explanation lives under the Play zone toggle in
          // RulesControls (shared with the lobby Settings sheet) —
          // rendering it here too put the identical sentence on the
          // screen twice, so `getByText` matched two elements and the
          // host-setup:138 assertion strict-violated.
          null}

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
          <HouseRulesPresets
            config={config}
            zoneRadiusMeters={zone.shape === 'circle' ? zone.radiusMeters : null}
            savedCustom={savedCustom}
            isHost
            onApplyPreset={applyPreset}
            onSaveCustom={saveCurrentAsCustom}
            saveNotice={saveNotice}
          />
        </div>

        <div className="rounded-[16px] border border-[#26262B] bg-[#141416] p-4">
          <TimingControls
            config={config}
            activePlayerCount={activePlayers.length}
            isHost
            onChange={applyConfig}
          />
        </div>

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
        {createBlockedReason ? (
          <Button
            variant="blocked"
            onClick={() => showNotice(createBlockedReason)}
          >
            PLACE AT LEAST 3 CORNERS
          </Button>
        ) : (
          <Button variant="primary" onClick={handleCreateLobby}>
            CREATE LOBBY
          </Button>
        )}
      </div>
    </main>
  );
}
