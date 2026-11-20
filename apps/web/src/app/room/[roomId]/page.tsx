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
import type { PlayerView, Room, RoomConfig } from '@pakdam/shared';
import { MIN_PLAYERS } from '@pakdam/shared';
import { PakdamSocket } from '../../../lib/websocket';
import type { WsSnapshotPayload } from '../../../lib/websocket';
import { isFixSendableToServer, watchLocation } from '../../../lib/geolocation';
import {
  canStartLiveMatch,
  fetchLiveRoomState,
  getHostTokenLive,
  regenerateLiveRoomCode,
  removeLivePlayer,
  snapshotToLiveRoomState,
  startLiveMatch,
  updateLiveRoomConfig,
} from '../../../lib/live-room-client';
import {
  canStartDemoMatch,
  demoRoomChangeKey,
  getRoom,
  leaveRoom,
  pollDemoRoom,
  setSelectedHunters,
  setTeamAssignment,
  startDemoMatch,
  toggleReady,
  updateRoomConfig,
} from '../../../lib/demo-store';
import {
  clearSession,
  getSessionForRoom,
  type PakdamSession,
} from '../../../lib/session-credentials';
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  // B8/B9: Leave / Remove confirm state — an in-app Sheet, never a
  // synchronous window.confirm (which blocks the main thread).
  const [confirmState, setConfirmState] = useState<
    | { kind: 'leave' }
    | { kind: 'remove'; playerId: string; displayName: string }
    | null
  >(null);
  // A6: Change code is a round-trip — the button shows it is working
  // instead of sitting dead until the new code lands.
  const [changingCode, setChangingCode] = useState(false);

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
      if (saved) setLobby({ room: saved.room, players: saved.players });
      return;
    }
    const currentSession = session;
    if (!currentSession) return;
    void fetchLiveRoomState(roomId, currentSession.playerId, currentSession.reconnectToken ?? '')
      .then((state) => setLobby({ room: state.room, players: state.players }))
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

  const isLive = session?.mode === 'live';
  const me = lobby?.players.find((p) => p.playerId === session?.playerId);
  const isHost = me?.isHost ?? session?.isHost ?? false;
  const config = lobby?.room.config ?? null;
  const activePlayers = (lobby?.players ?? []).filter((p) => p.leftAt === null);

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
          // B14: identical-skip — same (version, serverSeq) = same
          // server state; a re-delivered snapshot changes nothing.
          const key = `${snapshot.version}:${snapshot.serverSeq}`;
          if (key === lastSnapshotKeyRef.current) return;
          lastSnapshotKeyRef.current = key;
          // A snapshot over the socket rescues a lobby whose first HTTP
          // fetch failed — clear any load error so the roster shows.
          setLoadError(null);
          // The snapshot is the server truth: a pending optimistic
          // ready flip is answered by it (see pendingReadyRef).
          pendingReadyRef.current = null;
          const state = snapshotToLiveRoomState(snapshot);
          // Don't let a stale server echo clobber a config push in flight.
          if (pendingPushRef.current && lobbyRef.current) {
            setLobby({ room: { ...state.room, config: lobbyRef.current.room.config }, players: state.players });
          } else {
            setLobby({ room: state.room, players: state.players });
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
        },
        onStateChange: (state) => {
          setConn(state);
          // (Re)connected — refresh the roster from the server so a
          // reconnect never leaves a stale or empty player list.
          if (state === 'connected') socketRef.current?.requestSnapshot();
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
      setLobby({ room: demo.room, players: demo.players });
    } else setLoadError('Game not found or ended.');
    const timer = setInterval(() => {
      const current = pollDemoRoom(roomId);
      if (!current) return;
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
  }, [roomId]);

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
  // a single POST by the time the host taps it.
  useEffect(() => {
    if (!isLive || !session || !session.isHost || session.hostToken) return;
    if (!session.reconnectToken) return;
    // getHostTokenLive caches the minted token in sessionStorage.
    void getHostTokenLive(roomId).catch(() => undefined);
  }, [roomId, isLive, session]);

  // -- Config edits (host only, via the Settings sheet). Normalised so a
  //    'selected' team always carries exactly hunterCount picks (the
  //    config validator requires it) and 'random' carries none. ----------
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
      void fetchLiveRoomState(roomId, session.playerId, session.reconnectToken ?? '')
        .then((state) => {
          setLobby({ room: state.room, players: state.players });
          if (state.room.phase !== 'LOBBY') goPlay();
        })
        .catch((err: unknown) => {
          showNotice(err instanceof Error ? err.message : 'Could not reload the lobby — try again.');
        });
      void socketRef.current?.retry();
    } else {
      const demo = getRoom(roomId);
      if (demo) setLobby({ room: demo.room, players: demo.players });
    }
  }, [goPlay, roomId, session, showNotice]);

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
      if (saved) setLobby({ room: saved.room, players: saved.players });
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
  // Start button label: "NEED 2+…" only while under the minimum. Once
  // 2 players have joined the label is START GAME — grey (blocked) until
  // the gate passes, red once it does. Tapping the grey button shows the
  // gate reason (who is not ready / what is missing), so the label
  // change does not bypass the readiness + teams gate.
  const startLabel =
    activePlayers.length < MIN_PLAYERS
      ? `NEED ${MIN_PLAYERS}+ PLAYERS TO START`
      : 'START GAME';
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
          />
          {activePlayers.length === 0 ? (
            <p className="mt-3 text-[13px] text-[#A1A1AA]">
              No players showing yet — if this stays empty, your connection
              dropped. Tap Retry above to reload the lobby.
            </p>
          ) : null}
        </section>

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
        title={confirmState?.kind === 'remove' ? 'Remove player?' : 'Leave room?'}
      >
        <div className="flex flex-col gap-4">
          <p className="text-[15px] text-[#A1A1AA]">
            {confirmState?.kind === 'remove'
              ? `Remove ${confirmState.displayName} from the lobby? They can rejoin with the room code.`
              : 'Leave this room? You can rejoin with the room code.'}
          </p>
          <div className="flex gap-2">
            <Button variant="primary" onClick={confirmState?.kind === 'remove' ? confirmRemove : confirmLeave}>
              {confirmState?.kind === 'remove' ? 'Remove' : 'Leave room'}
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
