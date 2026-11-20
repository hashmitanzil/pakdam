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
 * navigates to /play. Demo mode: the demo store polled every 1 s plus
 * watchDemoPhase (F2 — guests auto-navigate to /play when the phase
 * leaves LOBBY). A live room is never silently downgraded to demo.
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
import { Button } from '../../../components/ui/Button';
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

  const socketRef = useRef<PakdamSocket | null>(null);
  const lobbyRef = useRef<LobbyState | null>(null);
  lobbyRef.current = lobby;
  const pushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPushRef = useRef(false);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
          // A snapshot over the socket rescues a lobby whose first HTTP
          // fetch failed — clear any load error so the roster shows.
          setLoadError(null);
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

      {isLive && conn !== 'connected' ? (
        <p className="mt-3 text-[13px] text-[#F59E0B]" role="status">
          Not connected — your readiness was not sent. Wait for the reconnect, then tap again.
          {conn === 'reconnect-failed' ? (
            <button
              type="button"
              onClick={retryConnection}
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
            setSettingsOpen(true);
          }}
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
            onRemove={(targetId) => {
              const target = lobby.players.find((p) => p.playerId === targetId);
              if (target) removePlayer(targetId, target.displayName);
            }}
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
