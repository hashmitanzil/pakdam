'use client';

/**
 * Lobby (ShadowHunt style) — the screen AFTER the lobby is created.
 *
 * The host lands here by tapping CREATE LOBBY on the setup screen
 * (/room/[roomId]/setup); joiners land here directly. Order on screen:
 * code card (COPY / SHARE / SETTINGS) → summary strip → roster →
 * I'm ready → pinned start gate. The room code appears ONLY here, never
 * on the create screen. SETTINGS opens the HostSettingsSheet (mode +
 * rules + teams, no map) so the host can customise the game after the
 * lobby exists; the zone itself is edited on the setup screen.
 *
 * Live mode (Worker URL set): first paint via GET state, then the
 * PakdamSocket snapshot is the whole truth; the phase leaving LOBBY
 * navigates to /play. Demo mode: the demo store polled every 1 s (one
 * timer does the poll AND the phase watch — F2 guests auto-navigate to
 * /play when the phase leaves LOBBY). A live room is never silently
 * downgraded to demo.
 *
 * Start gate (server + client agree): active seats ≥ MIN_PLAYERS (2)
 * AND every active seat ready AND teams set AND the Hunter count leaves
 * at least one Runner. A blocked Start always says why in one line —
 * never a silent disabled button.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import type { MatchPhase, PlayerView, Room, RoomConfig } from '@pakdam/shared';
import { TERMINAL_PHASES } from '@pakdam/shared';
import { PakdamSocket } from '../../../lib/websocket';
import type { WsSnapshotPayload } from '../../../lib/websocket';
import { isFixSendableToServer, watchLocation } from '../../../lib/geolocation';
import {
  canStartLiveMatch,
  fetchLiveRoomState,
  getHostTokenLive,
  readHostGraceEndsAtMs,
  regenerateLiveRoomCode,
  removeLivePlayer,
  shortStartBlocker,
  snapshotToLiveRoomState,
  startLiveMatch,
  updateLiveRoomConfig,
} from '../../../lib/live-room-client';
import { endLiveMatch, LiveHttpError } from '../../../lib/live-client';
import { goHomeAfterRoomDeleted } from '../../../lib/room-deleted';
import {
  canStartDemoMatch,
  deleteDemoRoom,
  demoRoomChangeKey,
  getRoom,
  leaveRoom,
  pollDemoRoom,
  recordPlayerSuspension,
  resumePlayer,
  startDemoMatch,
  toggleReady,
  updateRoomConfig,
} from '../../../lib/demo-store';
import {
  clearSession,
  getOrRestoreSessionForRoom,
  type PakdamSession,
} from '../../../lib/session-credentials';
import { clearRejoinToken, refreshRejoinToken } from '../../../lib/rejoin-token';
import { buildSnapshotKey } from '../../../lib/snapshot-key';
import { readReconnectEndsAtMs } from '../../../lib/presence';
import { prefetchMapAssets } from '../../../components/map/maplibre';
import { Button } from '../../../components/ui/Button';
import { Sheet } from '../../../components/ui/Sheet';
import { RoomCodeCard } from '../../../components/lobby/RoomCodeCard';
import { Roster } from '../../../components/lobby/Roster';
import { ReadinessProbe } from '../../../components/lobby/ReadinessProbe';
import { HostSettingsSheet } from '../../../components/lobby/HostSettingsSheet';
import { effectiveHunterCount, formatRoomSummary } from '../../../components/host-setup/draft';

interface LobbyState {
  room: Room;
  players: PlayerView[];
  /**
   * v24 (D1): epoch ms when the disconnected host's 30 s reconnect
   * grace expires, null when no grace is running. Live: from the
   * snapshot (tolerant read); demo: from the demo room. The client
   * never computes the deadline itself.
   */
  hostGraceEndsAtMs: number | null;
}

export default function LobbyPage() {
  const router = useRouter();
  const params = useParams();
  const roomId = typeof params.roomId === 'string' ? params.roomId : '';

  const [session, setSession] = useState<PakdamSession | null | undefined>(undefined);
  const [lobby, setLobby] = useState<LobbyState | null>(null);
  // v29 (A): the lobby clock for the 30 s return countdowns on away
  // seats (passed to Roster). It ticks only while a window is open
  // — see the effect below.
  const [lobbyNowMs, setLobbyNowMs] = useState(() => Date.now());
  const [loadError, setLoadError] = useState<string | null>(null);
  // v31 fix round (F3): my seat was removed — the state fetch refused
  // it with 403 `SEAT_REMOVED`. The mirror dies with the seat and the
  // removal screen below renders instead of the generic dead-end.
  const [seatRemoved, setSeatRemoved] = useState(false);
  const [conn, setConn] = useState<string>('connecting');
  const [notice, setNotice] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  // B8/B9: Leave / Remove confirm state — an in-app Sheet, never a
  // synchronous window.confirm (which blocks the main thread).
  const [confirmState, setConfirmState] = useState<
    | { kind: 'leave' }
    | { kind: 'remove'; playerId: string; displayName: string }
    | { kind: 'cancel-lobby' }
    | null
  >(null);
  // A6: Change code is a round-trip — the button shows it is working
  // instead of sitting dead until the new code lands.
  const [changingCode, setChangingCode] = useState(false);
  // Host cancel is a round-trip too — the confirm button shows it is
  // working instead of sitting dead until the room is deleted.
  const [cancellingLobby, setCancellingLobby] = useState(false);

  const socketRef = useRef<PakdamSocket | null>(null);
  const lobbyRef = useRef<LobbyState | null>(null);
  lobbyRef.current = lobby;
  const pushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPushRef = useRef(false);
  // A7: the latest config awaiting its debounced push, for flushing.
  const pendingConfigRef = useRef<RoomConfig | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigatedRef = useRef(false);
  // (a) The ready value flipped optimistically and awaiting the
  // server's answer — an error envelope while one is pending means
  // the server rejected the flip (e.g. the WS rate limit), so the
  // pill reverts and a fresh snapshot is requested. Cleared by the
  // next snapshot, which is the server truth either way.
  const pendingReadyRef = useRef<{ value: boolean; atMs: number } | null>(null);
  // B14: identical-skip refs for the demo poll / live snapshots.
  const lastDemoKeyRef = useRef<string | null>(null);
  const lastSnapshotKeyRef = useRef<string | null>(null);

  const showNotice = useCallback((message: string): void => {
    setNotice(message);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(null), 6000);
  }, []);

  // A7: roll the visible config back to the server's saved truth. The
  // screen must never keep showing a value the server rejected.
  const rollbackConfig = useCallback((): void => {
    if (session?.mode !== 'live') {
      const saved = getRoom(roomId);
      if (saved) setLobby({ room: saved.room, players: saved.players, hostGraceEndsAtMs: saved.hostGraceEndsAtMs ?? null });
      return;
    }
    const currentSession = session;
    if (!currentSession) return;
    void fetchLiveRoomState(roomId, currentSession.playerId, currentSession.reconnectToken ?? '')
      .then((state) => setLobby({ room: state.room, players: state.players, hostGraceEndsAtMs: readHostGraceEndsAtMs(state) }))
      .catch(() => undefined);
  }, [roomId, session]);

  // A7: flush the pending debounced config push right now (START,
  // sheet close, unmount) instead of letting the 500 ms timer fire
  // after the user has moved on. Returns false when the save failed
  // (the UI is already rolled back by then).
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
        err instanceof Error && err.message
          ? err.message
          : 'Settings were not saved — try again.',
      );
      rollbackConfig();
      return false;
    }
  }, [roomId, rollbackConfig, showNotice]);

  // A7: never leave a pending push behind on unmount (best-effort —
  // the browser may not finish it, but nothing is left queued).
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

  const goPlay = useCallback(() => {
    if (navigatedRef.current) return;
    navigatedRef.current = true;
    router.push(`/room/${roomId}/play`);
  }, [roomId, router]);

  const goResults = useCallback(() => {
    if (navigatedRef.current) return;
    navigatedRef.current = true;
    router.push(`/room/${roomId}/results`);
  }, [roomId, router]);

  // v33 FIX 2: a terminal room is over — a seat returning to the
  // lobby belongs on RESULTS, never on /play: the play page bounces
  // terminal rooms straight back to results, so pushing to /play
  // loops with no way into the lobby. Non-terminal non-lobby phases
  // (a match already LIVE) still go to play.
  const routeFromPhase = useCallback(
    (phase: MatchPhase) => {
      if (TERMINAL_PHASES.includes(phase)) goResults();
      else if (phase !== 'LOBBY') goPlay();
    },
    [goPlay, goResults],
  );

  // Room deleted (founder decision, 2026-11-21): the host cancelled and
  // the room is gone — home with the one plain message, once. Every
  // deletion path on this page (404 fetch, `room.deleted` event, a
  // socket close that probes 404, a demo poll that finds the room gone)
  // funnels through here.
  const deletedRef = useRef(false);
  const goHomeDeleted = useCallback(() => {
    if (deletedRef.current) return;
    deletedRef.current = true;
    goHomeAfterRoomDeleted(router, roomId);
  }, [roomId, router]);

  // v31 fix round (F3/F4): my own seat's state in any live state
  // arrival decides the mirror's fate — `leftAt` set = the seat was
  // removed while this tab was away (discarded / killed), so the
  // mirror dies at once and "Rejoin your game" is never offered for
  // a dead seat; a still-live seat's 12 h clock refreshes on the
  // successful resume instead (the mirror was written only at
  // create/join). Live only — demo seats have no mirror. Called from
  // the first-paint fetch and the socket snapshot in the load effect
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
  const activePlayers = (lobby?.players ?? []).filter(
    // v29 (A): the member count comes from the server snapshot and
    // must DROP when someone is ejected — an ejected seat is no
    // longer a member (the roster below still shows them, labelled
    // "Ejected", from the full `lobby.players` list).
    (p) => p.leftAt === null && p.ejectedAt === null,
  );
  // v24 (D1): host-reconnect grace — the host is suspended and the
  // server/demo says the grace is running, so the room is hostless
  // until the host returns or the grace expires and the crown moves.
  // The suspended host themself never sees this line (they ARE the
  // host); the roster row already shows them as Suspended.
  const hostPlayer = lobby?.players.find((p) => p.playerId === lobby?.room.hostPlayerId);
  const hostGraceActive =
    (lobby?.hostGraceEndsAtMs ?? null) !== null &&
    hostPlayer?.connectionState === 'suspended' &&
    hostPlayer.playerId !== session?.playerId;

  // v29 (A): the 1 s clock for the 30 s return countdowns — it runs
  // ONLY while at least one seat has a return window open, so an
  // idle lobby ticks nothing. The countdown itself is rendered from
  // the server's `reconnectEndsAtMs`, never computed here.
  const anyReconnectWindow = (lobby?.players ?? []).some(
    (p) => readReconnectEndsAtMs(p) !== null,
  );
  useEffect(() => {
    if (!anyReconnectWindow) return;
    const timer = window.setInterval(() => setLobbyNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [anyReconnectWindow]);

  // v29 (R11): prefetch the map assets from the lobby — everyone in
  // the lobby will open the map, and the welcome screen no longer
  // prefetches (play-map readiness is protected here instead).
  // Gated inside `prefetchMapAssets` on data-saver / 2G.
  useEffect(() => {
    prefetchMapAssets();
  }, []);

  // -- Load the seat, then live state / socket or demo polling (F2). ------
  useEffect(() => {
    // v31 (Fix 1 — same defect as the play page): a discarded tab
    // comes back with no sessionStorage, and this effect used to read
    // sessionStorage only — a live seat with a stored rejoin token
    // read as "no seat". Restore from the rejoin mirror first, so a
    // reload after a tab discard resumes the live lobby instead of
    // the "No live seat" dead-end.
    const found = getOrRestoreSessionForRoom(roomId);
    setSession(found);
    if (!found) return;
    if (found.mode === 'live') {
      let cancelled = false;
      void fetchLiveRoomState(roomId, found.playerId, found.reconnectToken ?? '')
        .then((state) => {
          if (cancelled) return;
          setLobby({ room: state.room, players: state.players, hostGraceEndsAtMs: readHostGraceEndsAtMs(state) });
          noteLiveSeatState(state.players, found.playerId);
          routeFromPhase(state.room.phase);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          // 404 = the room is gone (host cancelled, server deleted it):
          // a reload/reopen after deletion lands home with the one plain
          // message, not on a stale lobby or an error screen.
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
            routeFromPhase(snapshot.room.phase);
            return;
          }
          // B14 (v29 R1, fix round M1): identical-skip — the key is
          // `version:serverSeq:maxLastFixAtMs:epochMs`, so a DO-eviction
          // restore can never collide with the cached key. Same key
          // = same server state; a re-delivered snapshot changes
          // nothing.
          const key = buildSnapshotKey(snapshot);
          if (key === lastSnapshotKeyRef.current) return;
          lastSnapshotKeyRef.current = key;
          // A snapshot over the socket rescues a lobby whose first HTTP
          // fetch failed — clear any load error so the roster shows.
          setLoadError(null);
          // The snapshot is the server truth: a pending optimistic
          // ready flip is answered by it (see pendingReadyRef).
          pendingReadyRef.current = null;
          const state = snapshotToLiveRoomState(snapshot);
          noteLiveSeatState(state.players, found.playerId);
          // Don't let a stale server echo clobber a config push in flight.
          if (pendingPushRef.current && lobbyRef.current) {
            setLobby({ room: { ...state.room, config: lobbyRef.current.room.config }, players: state.players, hostGraceEndsAtMs: state.hostGraceEndsAtMs });
          } else {
            setLobby({ room: state.room, players: state.players, hostGraceEndsAtMs: state.hostGraceEndsAtMs });
          }
        },
        onServerMessage: (envelope) => {
          // ROOT CAUSE (roster / ready / start gate): the server only
          // sends a light `room.state` (phase/version/reason) on join,
          // ready.set and phase changes — never a snapshot. The roster
          // and READY pills only move when a snapshot lands, and this
          // page previously had no `onServerMessage` handler at all, so
          // every `room.state` was silently dropped: the host never saw
          // a joiner arrive, readiness never showed, and the start gate
          // kept reading stale data. A `room.state` is the signal to
          // re-sync — pull a fresh snapshot for this seat.
          if (envelope.type === 'room.state') {
            socketRef.current?.requestSnapshot();
          }
          // `host.transferred` also carries a `room.state`, but the
          // snapshot is requested explicitly here too: the new host's
          // controls (start, settings, cancel) must appear WITHOUT a
          // reload, and this page must never depend on a second event
          // to learn who the host is now.
          if (envelope.type === 'host.transferred') {
            socketRef.current?.requestSnapshot();
          }
          // `room.deleted` — the host cancelled and the server deleted
          // the room. Not in the frozen @pakdam/shared catalogue, so it
          // is matched on the raw string (see useRoomState for the same
          // handling on the play / catch / results pages).
          if ((envelope.type as string) === 'room.deleted') {
            goHomeDeleted();
          }
        },
        onStateChange: (state) => {
          setConn(state);
          // (Re)connected — refresh the roster from the server so a
          // reconnect never leaves a stale or empty player list.
          if (state === 'connected') socketRef.current?.requestSnapshot();
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
        onError: (error) => {
          // (a) A send that reached the server but was REJECTED (e.g.
          // WS rate limit 10/min/seat, "Too many messages — slow
          // down.") used to leave the pill flipped until an unrelated
          // snapshot landed. While a ready flip is pending, an error
          // envelope received shortly after the send reverts the pill
          // and re-requests a snapshot. (Recent only: a much later
          // error, e.g. a heartbeat failure, says nothing about a
          // flip the server may already have applied.)
          const pending = pendingReadyRef.current;
          if (pending && Date.now() - pending.atMs < 15_000) {
            pendingReadyRef.current = null;
            const myId = found.playerId;
            setLobby((prev) =>
              prev
                ? {
                    ...prev,
                    players: prev.players.map((p) =>
                      p.playerId === myId ? { ...p, isReady: !pending.value } : p,
                    ),
                  }
                : prev,
            );
            socketRef.current?.requestSnapshot();
          }
          showNotice(error.message);
        },
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
    // the cheap change key, so an idle lobby stops re-rendering.
    const demo = getRoom(roomId);
    if (demo) {
      lastDemoKeyRef.current = demoRoomChangeKey(demo);
      setLobby({ room: demo.room, players: demo.players, hostGraceEndsAtMs: demo.hostGraceEndsAtMs ?? null });
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
        // A lobby that was alive and is now gone was deleted (the host
        // cancelled in another tab) — home with the one plain message.
        // A lobby never seen alive keeps the first-paint error above.
        if (lobbyRef.current) goHomeDeleted();
        return;
      }
      if (current.room.phase !== 'LOBBY') {
        routeFromPhase(current.room.phase);
        return;
      }
      const key = demoRoomChangeKey(current);
      if (key === lastDemoKeyRef.current) return;
      lastDemoKeyRef.current = key;
      setLobby({ room: current.room, players: current.players, hostGraceEndsAtMs: current.hostGraceEndsAtMs ?? null });
    }, 1000);
    return () => {
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  // H1 (v28 fix round): demo suspend/resume on tab visibility. The
  // lobby never mounted useRoomState, so its visibilitychange handler
  // (useRoomState.ts:722-740) never ran here: hideTab() in the lobby
  // suspended nothing — no 'suspended' state, no 30 s host grace, no
  // waiting line, no crown move (host-grace.spec.ts demo tests + the
  // H1 pin in v28-repro-ci-e2e.test.mjs). Live needs no page handler:
  // the PakdamSocket reports `player.suspended` ('tab-hidden') on
  // hide itself (websocket.ts:658-681, attached on open) and the DO
  // resumes the seat on hello/reconnect — the same path the play page
  // uses, and a second page-level report would only duplicate it.
  // Demo has no socket, so tab-hidden IS the disconnect signal
  // (demo-store: recordPlayerSuspension starts the host grace for a
  // suspended host): suspend on hide, resume on return, and refresh
  // the roster at once so the Suspended row / waiting line move
  // without waiting for the 1 s poll.
  useEffect(() => {
    if (isLive || !session) return;
    const playerId = session.playerId;
    const refresh = (): void => {
      const current = getRoom(roomId);
      if (current) {
        setLobby({ room: current.room, players: current.players, hostGraceEndsAtMs: current.hostGraceEndsAtMs ?? null });
      }
    };
    const onVisibility = (): void => {
      const current = getRoom(roomId);
      if (!current) return;
      if (document.hidden) {
        recordPlayerSuspension(current, playerId, 'tab-hidden');
      } else {
        resumePlayer(current, playerId);
      }
      refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [roomId, isLive, session]);

  // -- Lobby fix stream (P1-7): the server start gate requires every
  //    active player to have a fix ≤ 120 s old, and the lobby is the only
  //    place that can supply one — the play page's watcher starts too
  //    late (after start). Stream fixes while live in the lobby, exactly
  //    like the play page does; the server keeps only the latest fix per
  //    seat (30 s TTL) and never persists coordinates. Demo mode skips it.
  useEffect(() => {
    if (!isLive || !session) return;
    const handle = watchLocation((fix) => {
      if (!isFixSendableToServer(fix)) return;
      socketRef.current?.sendLocationUpdate(fix);
    });
    return () => handle?.stop();
    // The watcher is created once per seat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, isLive, session?.playerId]);

  // A2: a host seat saved before join-time minting (or restored
  // without a host token) mints it now, in the background, so START is
  // a single POST by the time the host taps it. Gated on the DERIVED
  // `isHost` (snapshot players), not the saved session: after a host
  // transfer the new host's saved session still says non-host, and
  // their first host action would otherwise pay the mint round-trip.
  // Succession is by join order only — never gated on role or alive
  // state — and neither is this mint.
  useEffect(() => {
    if (!isLive || !session || !isHost || session.hostToken) return;
    if (!session.reconnectToken) return;
    // v24 (D1): only mint once a snapshot has confirmed I am host.
    // Before the first snapshot `isHost` falls back to the saved
    // session flag, and a stale flag (a former host, transferred away)
    // would mint a host token for a seat that is no longer host. The
    // server would reject it, but never asking is cleaner — and a
    // returning host re-mints here the moment their snapshot lands
    // (getHostTokenLive re-reads the stored seat, so a cached token is
    // returned without a network round-trip on later snapshots).
    if (!lobby) return;
    // getHostTokenLive caches the minted token in sessionStorage.
    void getHostTokenLive(roomId).catch(() => undefined);
  }, [roomId, isLive, session, isHost, lobby]);

  // -- Config edits (host only, via the Settings sheet). Normalised so
  //    a 'selected' team carries only picks the host actually made
  //    ('random' carries none, a changed count or assignment clears the
  //    pick) — the exact count is enforced by the start gate, never
  //    auto-filled here. An earlier version filled the pick up to the
  //    effective count with the first roster rows, so turning Random
  //    OFF pre-picked hunters the host never chose and the roster read
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
      // Defense in depth: only the host may change config. The sheet is
      // read-only for a joiner (no-op onChange), and live mode is also
      // server-guarded (403) — but demo mode has no server, so this
      // guard is what keeps a joiner from mutating demo config.
      if (!isHost) return;
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
              err instanceof Error && err.message
                ? err.message
                : 'Settings were not saved — try again.',
            );
          })
          .finally(() => {
            pendingPushRef.current = false;
            pendingConfigRef.current = null;
          });
      }, 500);
    },
    [config, isHost, isLive, normaliseConfig, roomId, rollbackConfig, showNotice],
  );

  // -- Readiness (one tap = ready + briefing confirmed). -----------------
  // Full retry: re-fetch the room state (repopulates the roster) AND
  // reconnect the socket. A socket-only retry cannot fix an empty roster
  // if the state fetch never landed — the founder's lobby showed no
  // players and a stuck "Not connected" banner, so Retry must do both.
  const retryConnection = useCallback((): void => {
    if (!session) return;
    if (session.mode === 'live') {
      // v31 fix round (F5): SERIALISED — the state fetch runs FIRST
      // and the socket retry only runs after it settles. The old code
      // fired the fetch and `socket.retry()` concurrently, so `retry()`
      // reset the deadline / fresh-ticket flag and fetched a new ticket
      // against a room the in-flight 404 probe was about to declare
      // deleted. A 404 goes home with no socket retry at all; any other
      // failure keeps the old recovery (socket retry after the fetch).
      // The socket's own terminal guard (Zara a) refuses `retry()` after
      // a 4404/4403 close as the backstop.
      void fetchLiveRoomState(roomId, session.playerId, session.reconnectToken ?? '')
        .then((state) => {
          setLobby({ room: state.room, players: state.players, hostGraceEndsAtMs: readHostGraceEndsAtMs(state) });
          routeFromPhase(state.room.phase);
          void socketRef.current?.retry();
        })
        .catch((err: unknown) => {
          // 404 = the room is gone (host cancelled, server deleted it).
          if (err instanceof LiveHttpError && err.status === 404) {
            goHomeDeleted();
            return;
          }
          // v31 fix round (F3): the seat is out — mirror dies,
          // removal screen, and no socket retry (it could only fail
          // against the same refusal).
          if (
            err instanceof LiveHttpError &&
            err.status === 403 &&
            err.code === 'SEAT_REMOVED'
          ) {
            clearRejoinToken(roomId);
            setSeatRemoved(true);
            return;
          }
          showNotice(err instanceof Error ? err.message : 'Could not reload the lobby — try again.');
          void socketRef.current?.retry();
        });
    } else {
      const demo = getRoom(roomId);
      if (demo) setLobby({ room: demo.room, players: demo.players, hostGraceEndsAtMs: demo.hostGraceEndsAtMs ?? null });
    }
  }, [routeFromPhase, goHomeDeleted, roomId, session, showNotice]);

  const toggleMyReady = (): void => {
    if (!me || !session) return;
    if (!isLive) {
      try {
        const demo = getRoom(roomId);
        if (!demo) return;
        toggleReady(demo, me.playerId);
        const saved = getRoom(roomId);
        if (saved) setLobby({ room: saved.room, players: saved.players, hostGraceEndsAtMs: saved.hostGraceEndsAtMs ?? null });
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
    // A1: the pill flips the instant it is tapped — the next snapshot
    // reconciles it; a failed send rolls it straight back.
    const nextReady = !me.isReady;
    setLobby((prev) =>
      prev
        ? {
            ...prev,
            players: prev.players.map((p) =>
              p.playerId === me.playerId ? { ...p, isReady: nextReady } : p,
            ),
          }
        : prev,
    );
    if (!socket.setReady(nextReady)) {
      setLobby((prev) =>
        prev
          ? {
              ...prev,
              players: prev.players.map((p) =>
                p.playerId === me.playerId ? { ...p, isReady: me.isReady } : p,
              ),
            }
          : prev,
      );
      showNotice('Not connected — your readiness was not sent. Wait for the reconnect, then tap again.');
      return;
    }
    // Sent — the server's answer is the next snapshot (which clears
    // this) or an error envelope (which reverts the pill, see onError).
    pendingReadyRef.current = { value: nextReady, atMs: Date.now() };
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
        // A7: a config push still inside its 500 ms debounce is
        // flushed first — START must run against the saved config,
        // not the one still sitting in the timer. A failed save
        // aborts the start (the UI is already rolled back).
        const flushed = await flushConfigPush();
        if (!flushed) {
          setStarting(false);
          return;
        }
        const result = await startLiveMatch(roomId);
        if (result.phase && result.phase !== 'LOBBY') goPlay();
      }
    } catch (err) {
      showNotice(err instanceof Error ? err.message : 'Could not start — try again.');
      setStarting(false);
    }
  };

  // B8/B9: Leave / Remove ask in-app (Sheet) — never window.confirm.
  // The sheet opens on tap (instant feedback); the action itself runs
  // only on the sheet's confirm tap.
  const leave = (): void => {
    setConfirmState({ kind: 'leave' });
  };

  // Host-only cancel (founder decision, 2026-11-21): the host cancels
  // the lobby before start and the lobby is deleted. Host-only, with a
  // confirm step — a stray tap must never delete the lobby. Live uses
  // the same lifecycle 'end' call as the play page's "End the round";
  // the server then deletes the room and every other player follows
  // via `room.deleted` / a 404. Demo deletes the local room at once.
  const cancelLobby = (): void => {
    if (!isHost) return;
    setConfirmState({ kind: 'cancel-lobby' });
  };

  const confirmCancelLobby = useCallback((): void => {
    if (cancellingLobby) return;
    setCancellingLobby(true);
    const done = (): void => {
      setCancellingLobby(false);
      setConfirmState(null);
    };
    if (!isLive) {
      deleteDemoRoom(roomId);
      done();
      goHomeDeleted();
      return;
    }
    void endLiveMatch(roomId)
      .then(() => {
        done();
        goHomeDeleted();
      })
      .catch((err: unknown) => {
        done();
        showNotice(
          err instanceof Error ? err.message : 'Could not cancel the lobby — try again.',
        );
      });
  }, [cancellingLobby, isLive, roomId, goHomeDeleted, showNotice]);

  const confirmLeave = useCallback((): void => {
    setConfirmState(null);
    if (isLive) {
      // P0-1: leave the room properly — `leave()` sends `leave`, then
      // closes. A plain `close()` here would only suspend the seat.
      socketRef.current?.leave();
    } else {
      const demo = getRoom(roomId);
      if (demo && session) leaveRoom(demo, session.playerId);
    }
    clearSession(roomId);
    // v29 (A): leaving clears the rejoin token — the seat is gone.
    clearRejoinToken(roomId);
    router.push('/');
  }, [isLive, roomId, session, router]);

  const removePlayer = (targetPlayerId: string, displayName: string): void => {
    setConfirmState({ kind: 'remove', playerId: targetPlayerId, displayName });
  };

  const confirmRemove = useCallback((): void => {
    if (confirmState?.kind !== 'remove') return;
    const targetPlayerId = confirmState.playerId;
    setConfirmState(null);
    if (!isLive) {
      const demo = getRoom(roomId);
      if (!demo) return;
      leaveRoom(demo, targetPlayerId);
      const saved = getRoom(roomId);
      if (saved) setLobby({ room: saved.room, players: saved.players, hostGraceEndsAtMs: saved.hostGraceEndsAtMs ?? null });
      return;
    }
    // A6: the roster drops the player at once; a failed remove puts
    // them straight back and says so.
    const before = lobbyRef.current;
    setLobby((prev) =>
      prev ? { ...prev, players: prev.players.filter((p) => p.playerId !== targetPlayerId) } : prev,
    );
    void removeLivePlayer(roomId, targetPlayerId)
      .then(() => socketRef.current?.requestSnapshot())
      .catch((err: unknown) => {
        if (before) setLobby(before);
        showNotice(err instanceof Error ? err.message : 'Could not remove that player.');
      });
  }, [confirmState, isLive, roomId, showNotice]);

  const changeCode = (): void => {
    if (!isLive) return;
    // A6: the button shows it is working while the round-trip runs.
    setChangingCode(true);
    void regenerateLiveRoomCode(roomId)
      .then((data) => {
        setLobby((prev) =>
          prev ? { ...prev, room: { ...prev.room, roomCode: data.roomCode } } : prev,
        );
        showNotice('New code issued — the old code no longer works.');
      })
      .catch((err: unknown) => {
        showNotice(err instanceof Error ? err.message : 'Could not change the code.');
      })
      .finally(() => setChangingCode(false));
  };

  // Stable callbacks (B14): the memoised lobby children must not get
  // a new handler — and a new render reason — on every poll tick.
  const toggleHunter = useCallback(
    (playerId: string): void => {
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
    },
    [config, isHost, activePlayers, applyConfig],
  );

  const handleRemovePlayer = useCallback(
    (targetId: string): void => {
      const target = lobbyRef.current?.players.find((p) => p.playerId === targetId);
      if (target) removePlayer(targetId, target.displayName);
    },
    // removePlayer is a plain function recreated per render; the ref
    // lookup keeps this callback stable regardless.
    [],
  );

  const openSettings = useCallback((): void => {
    if (!isHost) {
      showNotice('Only the host can change the game settings.');
      return;
    }
    setSettingsOpen(true);
  }, [isHost, showNotice]);

  const openSummarySettings = useCallback((): void => {
    // Both roles open the sheet: the host edits, a joiner sees the
    // same settings read-only (HostSettingsSheet handles it).
    setSettingsOpen(true);
  }, []);

  const closeSettings = useCallback((): void => {
    setSettingsOpen(false);
    // A7: flush any debounced push when the sheet closes — the host
    // has finished editing, so the save must not wait out the timer.
    void flushConfigPush();
  }, [flushConfigPush]);

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
        {/* Scope D item 10: a transient first-paint failure must not
            dead-end here — Retry re-runs the load (the setup page
            already had one; this branch did not). No Retry when there
            is no seat at all: nothing can reload then. */}
        <div className="mt-4 flex flex-col gap-3">
          {session !== null ? (
            <Button variant="primary" onClick={retryConnection}>
              Retry
            </Button>
          ) : null}
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
        <div className="mt-4">
          <Button variant="primary" onClick={() => router.push('/')}>
            Go home
          </Button>
        </div>
      </main>
    );
  }
  if (!lobby || !config) {
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
  // Scope C item 7: the blocked Start button states its own blocker —
  // not just "NEED 2+…" under the minimum, but "WAITING FOR PLAYERS"
  // / "PICK HUNTERS FIRST" / "TOO MANY HUNTERS" for the other gates.
  // The full reason (who is not ready) still shows on tap.
  const startLabel = shortStartBlocker(gate.reason, activePlayers.length);
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

      {isLive && conn === 'reconnect-failed' ? (
        <p className="mt-3 text-[13px] text-[#F59E0B]" role="status">
          Not connected — your readiness was not sent. Wait for the reconnect, then tap again.
          <button
            type="button"
            onClick={retryConnection}
            className="ml-2 font-semibold text-[#EF4444]"
          >
            Retry
          </button>
        </p>
      ) : null}
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
        <RoomCodeCard
          code={room.roomCode}
          isHost={isHost}
          canChangeCode={isLive}
          changingCode={changingCode}
          onOpenSettings={openSettings}
          onChangeCode={changeCode}
          onNotice={showNotice}
        />

        <button
          type="button"
          onClick={openSummarySettings}
          className="flex items-center justify-between rounded-[16px] border border-[#26262B] bg-[#141416] px-4 py-3 text-left"
          aria-label="Game summary — open settings"
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
            onRemove={handleRemovePlayer}
            nowMs={lobbyNowMs}
          />
          {activePlayers.length === 0 ? (
            <p className="mt-3 text-[13px] text-[#A1A1AA]">
              No players showing yet — if this stays empty, your connection
              dropped. Tap Retry above to reload the lobby.
            </p>
          ) : null}
        </section>

        {/* v24 (D1): host-reconnect grace — the host is suspended
            and may be back within 30 s, so the room is hostless until
            they return or the grace expires and the crown moves. The
            roster row already shows the host as Suspended; this line
            says what that means for the room. No countdown is shown —
            the deadline is the server's, and the client never
            computes it. */}
        {hostGraceActive ? (
          <p
            className="text-[13px] text-[#F59E0B]"
            role="status"
          >
            Waiting for the host to reconnect…
          </p>
        ) : null}

        {/* Host only: cancel the lobby (founder decision, 2026-11-21).
            Opens the confirm sheet below — a stray tap never deletes
            the lobby. Joiners never see this control. */}
        {isHost ? (
          <button
            type="button"
            onClick={cancelLobby}
            className="self-start text-[15px] font-semibold text-[#EF4444]"
          >
            Cancel lobby
          </button>
        ) : null}

        <button
          type="button"
          onClick={toggleMyReady}
          className={`inline-flex h-14 w-full items-center justify-center rounded-[14px] text-[17px] font-bold active:scale-95 ${
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
        isHost={isHost}
        onChange={applyConfig}
        onClose={closeSettings}
      />

      {/* Leave / Remove confirmation (B8/B9) — in-app Sheet, never a
          blocking window.confirm. */}
      <Sheet
        open={confirmState !== null}
        onClose={() => setConfirmState(null)}
        title={
          confirmState?.kind === 'remove'
            ? 'Remove player?'
            : confirmState?.kind === 'cancel-lobby'
              ? 'Cancel lobby?'
              : 'Leave room?'
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-[15px] text-[#A1A1AA]">
            {confirmState?.kind === 'remove'
              ? `Remove ${confirmState.displayName} from the lobby? They can rejoin with the room code.`
              : confirmState?.kind === 'cancel-lobby'
                ? 'Cancel this lobby? The lobby will be deleted and every player goes back home.'
                : 'Leave this room? You can rejoin with the room code.'}
          </p>
          <div className="flex gap-2">
            <Button
              variant="primary"
              onClick={
                confirmState?.kind === 'remove'
                  ? confirmRemove
                  : confirmState?.kind === 'cancel-lobby'
                    ? confirmCancelLobby
                    : confirmLeave
              }
              disabled={cancellingLobby}
            >
              {confirmState?.kind === 'remove'
                ? 'Remove'
                : confirmState?.kind === 'cancel-lobby'
                  ? cancellingLobby
                    ? 'Cancelling…'
                    : 'Cancel lobby'
                  : 'Leave room'}
            </Button>
            <Button variant="outline" onClick={() => setConfirmState(null)}>
              Cancel
            </Button>
          </div>
        </div>
      </Sheet>
    </main>
  );
}
