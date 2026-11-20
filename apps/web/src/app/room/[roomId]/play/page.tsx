/**
 * Play — the live HUD (SCRAM-SPEC §8, BEHAVIOUR §2).
 *
 * One status strip, the Ola dark map, bottom tabs (Map / Radio / ···),
 * floating PTT mic + SOS, and one catch action per role. Role reveal
 * shows once at start (again if an Infection tag flips my role).
 *
 * Live mode: the snapshot is the whole truth; the client never sets phase,
 * roles, timers or ejection. Demo mode: the demo store ticks locally
 * (pings auto-fire, shrink uses the random-offset draw).
 *
 * Location honesty: only fixes accurate to ±50 m are ever sent. The
 * outside-zone countdown is display-only in live mode — the server
 * enforces ejection; in demo the page ejects at 0.
 */
'use client';

import { use, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  OUTSIDE_ZONE_RETURN_SECONDS,
  ZONE_AUTO_CENTRE_MAX_ACCURACY_M,
  type GeoPolygon,
  type LocationFix,
  type MatchPhase,
  type Ping,
  type VoiceRadioStatus,
} from '@pakdam/shared';
import {
  isPointInZone,
  nextPingAtMs as engineNextPingAtMs,
  nextShrinkAtMs as engineNextShrinkAtMs,
  zoneDiameterMeters,
} from '@pakdam/engine';
import { useRoomState } from '@/components/match/useRoomState';
import { StatusStrip } from '@/components/hud/StatusStrip';
import { PlayerDots, type PlayerDot } from '@/components/hud/PlayerDots';
import { PlayMap } from '@/components/hud/PlayMap';
import { effectiveHunterCount } from '@/components/host-setup/draft';
import { endLiveMatch } from '@/lib/live-client';
import { RadioStrip } from '@/components/radio/RadioStrip';
import { PTTButton } from '@/components/radio/PTTButton';
import { SafetyControls } from '@/components/match/SafetyControls';
import { BottomTabs, type BottomTabId } from '@/components/ui/BottomTabs';
import { Sheet } from '@/components/ui/Sheet';
import { Button } from '@/components/ui/Button';
import { formatSuspendedLabel, formatOutsideCountdown } from '@/components/match/freshness';
import { formatDurationShort, ageLabelFromTimestamp } from '@/lib/utils';
import { watchLocation, isFixSendableToServer } from '@/lib/geolocation';
import { requestWakeLock } from '@/lib/wake-lock';
import { clearSession } from '@/lib/session-credentials';
import {
  ejectPlayer,
  endDemoMatch,
  getRoom,
  hostCheckin,
  leaveRoom,
  recordPlayerFix,
  resumePlayer,
  safetyPauseDemo,
  safetyResumeDemo,
  sosDemo,
} from '@/lib/demo-store';
import { VoiceRadio, type PttState, type VoiceSignal } from '@/lib/voice-radio';
import type { PakdamSocket } from '@/lib/websocket';

const TERMINAL: MatchPhase[] = ['COMPLETED', 'CANCELLED', 'ABANDONED', 'EXPIRED'];

export default function PlayPage({
  params,
  searchParams,
}: {
  params: Promise<{ roomId: string }>;
  searchParams: Promise<{ spectate?: string }>;
}) {
  const { roomId } = use(params);
  const spectateParam = use(searchParams)?.spectate === '1';
  const router = useRouter();

  const voiceRadioRef = useRef<VoiceRadio | null>(null);
  const state = useRoomState(roomId, {
    onVoiceSignal: (signal: VoiceSignal) => {
      void voiceRadioRef.current?.handleSignal(signal);
    },
  });
  const {
    session,
    mode,
    room,
    players,
    phase,
    safetyState,
    sessionCatches,
    teammateIds,
    teammateFixes,
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
    reveals,
    sendReveal,
    leave,
  } = state;

  /**
   * `nextZonePreview` (P1-18: the DO's `zone.preview`, 30 s before a
   * shrink) has not landed in the hook yet — read it through a defensive
   * cast so this page compiles and picks it up the moment it does.
   * `reveals` / `sendReveal` / `leave` are already on the hook and are
   * destructured above.
   */
  const hookExtras = state as unknown as {
    nextZonePreview?: {
      boundary: GeoPolygon;
      firesAtMs: number;
      shrinkIndex: number;
    } | null;
  };
  const nextZonePreview = hookExtras.nextZonePreview ?? null;

  const [tab, setTab] = useState<BottomTabId>('map');
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [myFix, setMyFix] = useState<LocationFix | null>(null);
  const [fixNotice, setFixNotice] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reveal, setReveal] = useState<'hunter' | 'runner' | null>(null);
  // Bumped when the role-reveal overlay dismisses — PlayMap resizes
  // explicitly then, so a canvas measured while covered never stays blank.
  const [mapResizeNonce, setMapResizeNonce] = useState(0);
  const [outsideSecondsLeft, setOutsideSecondsLeft] = useState<number | null>(null);
  const [radioUnread, setRadioUnread] = useState(0);
  const [leaveArmed, setLeaveArmed] = useState(false);
  const [sosSent, setSosSent] = useState(false);
  // Hold-to-reveal (P1-19): press-and-hold ~1 s, then sendReveal fires.
  const [revealHolding, setRevealHolding] = useState(false);
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Voice radio state (live only — demo has no signalling channel).
  const [voiceRadio, setVoiceRadio] = useState<VoiceRadio | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<VoiceRadioStatus>('off');
  const [voiceDetail, setVoiceDetail] = useState<string | undefined>(undefined);
  const [pttState, setPttState] = useState<PttState>('idle');
  const [burstSeconds, setBurstSeconds] = useState(0);
  const [muted, setMuted] = useState(false);

  const myRole = myPlayer?.matchRole ?? null;
  const myTeam = myPlayer?.team ?? null;
  const isHost = myPlayer?.isHost ?? false;
  const isHunter = myRole === 'hunter';
  const isRunner = myRole === 'runner';
  const socketRef = useRef<PakdamSocket | null>(null);
  const myFixRef = useRef<LocationFix | null>(null);
  const outsideAccumRef = useRef(0);
  const outsideEjectedRef = useRef(false);
  const seenRadioRef = useRef(0);

  useEffect(() => {
    socketRef.current = socket;
  }, [socket]);

  useEffect(() => {
    myFixRef.current = myFix;
  }, [myFix]);

  // 1 s clock for countdowns.
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Wake lock while playing (best-effort, never a guarantee).
  // `requestWakeLock()` resolves to a handle — the effect must await it
  // before releasing (the old code called `.release()` on the Promise).
  useEffect(() => {
    let released = false;
    let handle: Awaited<ReturnType<typeof requestWakeLock>> | null = null;
    void requestWakeLock().then((h) => {
      if (released) void h.release();
      else handle = h;
    });
    return () => {
      released = true;
      if (handle) void handle.release();
    };
  }, []);

  // A hold-to-reveal timer must never fire after unmount.
  useEffect(
    () => () => {
      if (revealTimerRef.current) clearTimeout(revealTimerRef.current);
    },
    [],
  );

  // Role reveal, once per role (an Infection flip shows it again).
  useEffect(() => {
    if (!myRole) return;
    if (phase !== 'HEAD_START' && phase !== 'ACTIVE' && phase !== 'SAFETY_PAUSED') return;
    const shown = window.sessionStorage.getItem(`pakdam.role-reveal.${roomId}`);
    if (shown !== myRole) setReveal(myRole);
  }, [myRole, phase, roomId]);

  const dismissReveal = () => {
    if (reveal) {
      window.sessionStorage.setItem(`pakdam.role-reveal.${roomId}`, reveal);
    }
    setReveal(null);
    // The reveal covered the map at game start — resize it explicitly
    // now that it is uncovered.
    setMapResizeNonce((n) => n + 1);
  };

  // Terminal phase → results. Back to lobby if the match never started.
  useEffect(() => {
    if (!room) return;
    if (TERMINAL.includes(room.phase)) {
      router.replace(`/room/${roomId}/results`);
    } else if (room.phase === 'LOBBY') {
      router.replace(`/room/${roomId}`);
    }
  }, [room, roomId, router]);

  // Location watch — foreground only; only ±50 m fixes are ever sent.
  useEffect(() => {
    if (!myPlayerId) return;
    const handle = watchLocation(
      (fix) => {
        myFixRef.current = fix;
        setMyFix(fix);
        if (isFixSendableToServer(fix)) {
          if (mode === 'live') {
            socketRef.current?.sendLocationUpdate(fix);
          } else {
            const current = getRoom(roomId);
            if (current) recordPlayerFix(current, myPlayerId, fix);
          }
          setFixNotice(null);
        } else {
          setFixNotice('GPS is too rough here — your fix was not sent.');
        }
      },
      (err) => {
        if (err.kind === 'permission-denied') {
          setFixNotice('Location is off — allow it in your browser settings.');
        }
      },
    );
    return () => handle?.stop();
    // The watcher is created once per seat/mode.
  }, [roomId, myPlayerId, mode]);

  // Outside-zone countdown (display; demo enforces at 0, live is server-enforced).
  useEffect(() => {
    if (phase !== 'ACTIVE' && phase !== 'HEAD_START') {
      outsideAccumRef.current = 0;
      outsideEjectedRef.current = false;
      if (outsideSecondsLeft !== null) setOutsideSecondsLeft(null);
      return;
    }
    const fix = myFixRef.current;
    const boundary = room?.config.zone.boundary ?? [];
    if (!fix || boundary.length < 3) return;
    if (isPointInZone(fix, boundary)) {
      outsideAccumRef.current = 0;
      outsideEjectedRef.current = false;
      if (outsideSecondsLeft !== null) setOutsideSecondsLeft(null);
      return;
    }
    // Poor GPS freezes the countdown — seconds already counted stay.
    if (fix.accuracyMeters <= ZONE_AUTO_CENTRE_MAX_ACCURACY_M) {
      outsideAccumRef.current += 1000;
    }
    const left = Math.max(
      0,
      OUTSIDE_ZONE_RETURN_SECONDS - Math.floor(outsideAccumRef.current / 1000),
    );
    setOutsideSecondsLeft(left);
    if (left <= 0 && !outsideEjectedRef.current) {
      outsideEjectedRef.current = true;
      if (mode === 'demo') {
        const current = getRoom(roomId);
        if (current) {
          ejectPlayer(current, myPlayerId);
          refreshDemo();
        }
        setNotice('You were ejected — you left the zone.');
      }
    }
    // Runs on every clock tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nowMs, phase, room, mode, roomId, myPlayerId]);

  // Voice radio (live only). The DO rejects cross-team signals, and role
  // secrecy hides other seats' teams — so we signal every other active
  // seat and let the DO filter; connected peers are necessarily teammates.
  useEffect(() => {
    if (mode !== 'live' || !socket || !myPlayerId || voiceRadioRef.current) return;
    const radio = new VoiceRadio({
      myPlayerId,
      teammateIds: [],
      sendSignal: (signal) =>
        socketRef.current?.sendVoiceSignal(signal.toPlayerId, signal.kind, signal.sdp, signal.candidate) ?? false,
      onStatusChange: (status, detail) => {
        setVoiceStatus(status);
        setVoiceDetail(detail);
      },
      onPttChange: (next) => setPttState(next),
      onTalkingChange: () => undefined,
    });
    voiceRadioRef.current = radio;
    setVoiceRadio(radio);
    return () => {
      radio.disable();
      voiceRadioRef.current = null;
      setVoiceRadio(null);
    };
    // One radio per live seat.
  }, [mode, socket, myPlayerId]);

  // Keep the teammate list fresh (all other active seats; the DO filters by team).
  useEffect(() => {
    const radio = voiceRadioRef.current;
    if (!radio) return;
    radio.setTeammates(
      players.filter((p) => p.playerId !== myPlayerId && p.leftAt === null).map((p) => p.playerId),
    );
  }, [players, myPlayerId]);

  // Burst elapsed while talking.
  useEffect(() => {
    if (pttState !== 'talking') {
      setBurstSeconds(0);
      return;
    }
    const timer = window.setInterval(() => {
      setBurstSeconds(voiceRadioRef.current?.burstElapsedSeconds() ?? 0);
    }, 250);
    return () => window.clearInterval(timer);
  }, [pttState]);

  // Radio unread badge.
  useEffect(() => {
    if (tab === 'radio') {
      seenRadioRef.current = radioMessages.length;
      setRadioUnread(0);
    } else {
      setRadioUnread(Math.max(0, radioMessages.length - seenRadioRef.current));
    }
  }, [radioMessages.length, tab]);

  // -- Derived values ---------------------------------------------------------
  const activePlayers = useMemo(
    () => players.filter((p) => p.leftAt === null),
    [players],
  );
  // Effective Hunter count (Balance ON reads the balance table from the
  // roster; Balance OFF honours the host's stepper) — never the raw
  // `config.hunterCount`, which the server does not draw while Balance
  // is ON. The HUD "runners left" and the role-reveal text use this.
  const hunterCount = room ? effectiveHunterCount(room.config, activePlayers.length) : 0;
  const runnersTotal = Math.max(0, activePlayers.length - hunterCount);
  const caughtIds = useMemo(
    () =>
      new Set(
        sessionCatches
          .filter((c) => c.state === 'confirmed')
          .map((c) => c.runnerPlayerId),
      ),
    [sessionCatches],
  );
  // Ejected Runners only subtract in demo (live role secrecy hides who is a Runner).
  const ejectedRunnerCount =
    mode === 'demo'
      ? activePlayers.filter((p) => p.ejectedAt !== null && p.matchRole === 'runner').length
      : 0;
  const runnersLeft = Math.max(0, runnersTotal - caughtIds.size - ejectedRunnerCount);

  // Spectator mode: a Classic Runner who has been tagged is out and can
  // only watch. Triggered by the catch page's "Spectate match" (?spectate=1)
  // or by the confirmed catch itself, so a tagged Runner can never act
  // again even if they reach the play page another way. (Infection flips a
  // tagged Runner to Hunter, so `isRunner` is false there and this never
  // applies.) Radio and SOS stay available — they are safety/communication,
  // not playing actions.
  const amCaught = isRunner && myPlayerId !== null && caughtIds.has(myPlayerId);
  const isSpectator = spectateParam || amCaught;

  const startedAtMs = room?.startedAt ? new Date(room.startedAt).getTime() : null;
  const zoneBoundary = room?.config.zone.boundary ?? [];
  const zoneRadiusM =
    zoneBoundary.length >= 3 ? zoneDiameterMeters(zoneBoundary) / 2 : null;

  const lastPingAtMs = useMemo(() => {
    if (mode === 'demo' && demo) {
      const values: number[] = Object.values(demo.lastPingAtMs);
      return values.length > 0 ? Math.min(...values) : null;
    }
    if (pings.length === 0) return null;
    return Math.min(...pings.map((p) => new Date(p.createdAt).getTime()));
  }, [mode, demo, pings]);

  const nextPingAtMs =
    startedAtMs === null || !room
      ? null
      : engineNextPingAtMs(lastPingAtMs, startedAtMs, room.config.pingIntervalSeconds);
  const nextShrinkAtMs =
    startedAtMs === null || !room
      ? null
      : engineNextShrinkAtMs(
          startedAtMs,
          room.config.durationSeconds,
          room.config.zoneShrinkIntervalSeconds,
          room.config.zoneShrinkEnabled,
          safetyState.paused && safetyState.pausedAt
            ? new Date(safetyState.pausedAt).getTime()
            : nowMs,
        );

  // Pings are mutual and role-scoped: the server only delivers pings
  // addressed to my role (Runner pings to Hunters, Hunter pings to
  // Runners), and the client filters by recipientRole too — so in demo
  // mode, where the local store holds every ping, each side still only
  // sees the opposing team. No role yet (roles not drawn) = no pings.
  // Spectators are the exception: a spectating (caught) Runner sees BOTH
  // teams, but only via pings — never live dots.
  const myPingRole: 'hunters' | 'runners' | null = isHunter
    ? 'hunters'
    : isRunner
      ? 'runners'
      : null;
  const visiblePings: Ping[] = useMemo(
    () =>
      isSpectator
        ? pings
        : myPingRole === null
          ? []
          : pings.filter((p) => p.recipientRole === myPingRole),
    [pings, myPingRole, isSpectator],
  );

  // Dots: teammates LIVE (runners see fellow runners, hunters see fellow
  // hunters — the server sends only my own team's fixes, never an
  // opponent's), opponents ping-only and mutual. A caught Runner loses
  // the live teammate view entirely, and a spectator sees ping dots only
  // (both teams), no live dots for anyone. Ping dots are coloured by the
  // SUBJECT's team: green for a Runner subject, red for a Hunter subject
  // (a ping addressed to Hunters is about a Runner, and vice versa).
  const dots: PlayerDot[] = useMemo(() => {
    const out: PlayerDot[] = [];
    if (!isSpectator) {
      const myLastFixMs = myPlayer?.lastFixAt ? new Date(myPlayer.lastFixAt).getTime() : null;
      out.push({
        playerId: myPlayerId,
        displayName: 'YOU',
        tone: 'me',
        label:
          myPlayer?.connectionState === 'suspended'
            ? 'Suspended'
            : myLastFixMs === null
              ? 'Location never reported'
              : ageLabelFromTimestamp(myLastFixMs, nowMs),
        suspended: myPlayer?.connectionState === 'suspended',
      });
      // Live teammates — never when I am caught (a tagged Runner loses
      // the live teammate view) and never while spectating.
      if (!amCaught) {
        for (const teammateId of teammateIds) {
          const p = players.find((pl) => pl.playerId === teammateId);
          if (!p || p.leftAt !== null) continue;
          const lastFixMs = p.lastFixAt ? new Date(p.lastFixAt).getTime() : null;
          out.push({
            playerId: p.playerId,
            displayName: p.displayName,
            tone: 'teammate',
            label:
              lastFixMs === null
                ? 'Location never reported'
                : ageLabelFromTimestamp(lastFixMs, nowMs),
            suspended: p.connectionState === 'suspended',
          });
        }
      }
    }
    for (const ping of visiblePings) {
      const subject = players.find((p) => p.playerId === ping.subjectPlayerId);
      if (!subject) continue;
      out.push({
        playerId: `ping-${ping.pingId}`,
        displayName: subject.displayName,
        tone: ping.recipientRole === 'hunters' ? 'ping-runner' : 'ping-hunter',
        // Demo pings are simulated (fired by the local store, not the
        // server) — labelled so, wherever they are shown.
        label:
          ageLabelFromTimestamp(new Date(ping.createdAt).getTime(), nowMs) +
          (mode === 'demo' ? ' · (simulated)' : ''),
      });
    }
    return out;
  }, [players, myPlayer, myPlayerId, teammateIds, visiblePings, nowMs, amCaught, isSpectator, mode]);

  const myLastFixMs = myPlayer?.lastFixAt ? new Date(myPlayer.lastFixAt).getTime() : null;
  const isSuspended = myPlayer?.connectionState === 'suspended';

  const teammates = useMemo(
    () =>
      mode === 'demo'
        ? players.filter((p) => p.team === myTeam && p.playerId !== myPlayerId && p.leftAt === null)
        : [],
    [mode, players, myTeam, myPlayerId],
  );
  const channelLine = `${myTeam === 'hunters' ? 'Hunters' : 'Runners'} channel · ${
    mode === 'demo' ? teammates.length : (voiceRadio?.connectedPeers.length ?? 0)
  } on air`;
  const canSendRadio =
    myTeam === 'hunters' ? room?.config.huntersCanTalk !== false : true;
  const radioNotices =
    phase === 'HEAD_START' && room
      ? [
          `just now · Runners have a ${formatDurationShort(room.config.headStartSeconds)} head start. Hold tight.`,
        ]
      : [];

  // -- Safety actions ---------------------------------------------------------
  const handleSos = () => {
    if (mode === 'live') {
      if (socketRef.current?.safetySos()) setSosSent(true);
      else setNotice('Not connected — SOS was not sent. Wait for the reconnect, then tap again.');
    } else {
      const current = getRoom(roomId);
      if (current) {
        sosDemo(current, myPlayerId);
        refreshDemo();
        setSosSent(true);
      }
    }
  };
  const handlePause = () => {
    if (mode === 'live') {
      if (!socketRef.current?.safetyPause()) {
        setNotice('Not connected — pause was not sent. Wait for the reconnect, then tap again.');
      }
    } else {
      const current = getRoom(roomId);
      if (current) {
        safetyPauseDemo(current, myPlayerId);
        refreshDemo();
      }
    }
  };
  const handleResume = () => {
    if (mode === 'live') {
      if (!socketRef.current?.safetyResume()) {
        setNotice('Not connected — resume was not sent. Wait for the reconnect, then tap again.');
      }
    } else {
      const current = getRoom(roomId);
      if (current) {
        safetyResumeDemo(current);
        refreshDemo();
      }
    }
  };
  const handleAnnounceSafe = () => {
    if (mode === 'live') {
      // Failure feedback, like SOS / pause / resume: a silent no-send
      // leaves the player thinking the host was told.
      if (!socketRef.current?.sendCheckIn()) {
        setNotice('Not connected — "I\'m safe" was not sent. Wait for the reconnect, then tap again.');
      }
    } else {
      const current = getRoom(roomId);
      if (current) {
        hostCheckin(current, myPlayerId, "I'm safe");
        refreshDemo();
      }
    }
  };
  const handleLeave = () => {
    if (!leaveArmed) {
      setLeaveArmed(true);
      return;
    }
    if (mode === 'live') {
      // P0-1: the hook's `leave()` sends `leave` then closes. Plain
      // `close()` no longer leaves — never call it here.
      leave();
    } else {
      const current = getRoom(roomId);
      if (current) leaveRoom(current, myPlayerId);
    }
    clearSession(roomId);
    router.push('/');
  };
  const handleEndRound = () => {
    if (!isHost) return;
    if (mode === 'live') {
      void endLiveMatch(roomId).catch(() => {
        setNotice('Could not end the round — check your connection and try again.');
      });
      return;
    }
    const current = getRoom(roomId);
    if (current) {
      endDemoMatch(current);
      refreshDemo();
    }
  };
  // Hold-to-reveal (P1-19): press-and-hold ~1 s, then the reveal is sent.
  // Releasing early cancels — a tap never reveals by accident. The hook
  // sends my current fix (live only); a false return means no fresh fix
  // or no connection, and the player is told so.
  const startRevealHold = () => {
    if (revealTimerRef.current) return;
    setRevealHolding(true);
    revealTimerRef.current = setTimeout(() => {
      revealTimerRef.current = null;
      setRevealHolding(false);
      const sent = sendReveal(myFixRef.current ?? undefined);
      setNotice(
        sent
          ? 'Reveal sent — your position is shared briefly.'
          : 'Reveal was not sent — make sure your location is on, then hold again.',
      );
    }, 1000);
  };
  const cancelRevealHold = () => {
    if (revealTimerRef.current) {
      clearTimeout(revealTimerRef.current);
      revealTimerRef.current = null;
    }
    setRevealHolding(false);
  };
  const handleResumeSharing = () => {
    if (mode !== 'demo') return;
    const current = getRoom(roomId);
    if (!current) return;
    resumePlayer(current, myPlayerId);
    const fix = myFixRef.current;
    if (fix) recordPlayerFix(current, myPlayerId, fix);
    refreshDemo();
  };

  // -- Loading / no-seat ------------------------------------------------------
  if (loading) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col gap-3 px-4 pt-3">
        <p className="py-10 text-center text-[15px] text-[#A1A1AA]">Loading match…</p>
      </main>
    );
  }
  if (error || !session || !room) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col gap-3 px-4 pt-3">
        <p className="py-6 text-center text-[15px] text-white">
          {error ?? 'No live seat saved on this device for this room.'}
        </p>
        {/* A transient first-paint GET failure must not dead-end the
            screen — Retry re-requests the snapshot (P1-23). */}
        <Button variant="primary" onClick={retryConnection}>
          Retry
        </Button>
        <Button variant="outline" onClick={() => router.push('/')}>
          Go home
        </Button>
      </main>
    );
  }

  const pausedByName = safetyState.pausedBy
    ? (players.find((p) => p.playerId === safetyState.pausedBy)?.displayName ?? null)
    : null;
  const sosByName =
    mode === 'demo' && demo?.sosByPlayerId
      ? (players.find((p) => p.playerId === demo.sosByPlayerId)?.displayName ?? null)
      : null;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col gap-3 px-4 pb-24 pt-3">
      <StatusStrip
        phase={phase}
        config={room.config}
        startedAt={room.startedAt}
        endsAt={room.endsAt}
        paused={safetyState.paused}
        pausedAt={safetyState.pausedAt}
        runnersLeft={runnersLeft}
        runnersTotal={runnersTotal}
        nextPingAtMs={nextPingAtMs}
        nextShrinkAtMs={nextShrinkAtMs}
        zoneRadiusM={zoneRadiusM}
        nowMs={nowMs}
        isRunner={isRunner}
      />

      {isSpectator ? (
        <div className="rounded-2xl border border-[#26262B] bg-[#141416] p-3">
          <p className="text-[14px] font-semibold text-white">You&apos;re out — spectating the match.</p>
          <p className="mt-1 text-[13px] text-[#A1A1AA]">
            You can watch the map, but you can&apos;t tag or be tagged.
          </p>
        </div>
      ) : null}

      {isSuspended ? (
        <div className="rounded-2xl border border-[#F59E0B] bg-[#141416] p-3">
          <p className="text-[14px] font-semibold text-white">
            {formatSuspendedLabel(myLastFixMs, nowMs)}
          </p>
          <p className="mt-1 text-[13px] text-[#A1A1AA]">
            {mode === 'live'
              ? 'The server marks you connected again when a fresh fix arrives.'
              : 'Your location is unknown until a fresh fix arrives.'}
          </p>
          {mode === 'demo' ? (
            <button
              type="button"
              onClick={handleResumeSharing}
              className="mt-2 text-[15px] font-semibold text-[#EF4444]"
            >
              Resume sharing
            </button>
          ) : null}
        </div>
      ) : null}

      {outsideSecondsLeft !== null ? (
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-[#EF4444] bg-[#141416] p-3">
          <p className="text-[14px] font-bold text-[#EF4444]">
            OUTSIDE ZONE — Return in {formatOutsideCountdown(outsideSecondsLeft)} or ejected
          </p>
          <span className="rounded-full bg-[#F59E0B] px-2 py-0.5 text-[12px] font-bold text-black">
            30s
          </span>
        </div>
      ) : null}

      {fixNotice ? (
        <p className="rounded-2xl border border-[#26262B] bg-[#141416] p-3 text-[13px] text-[#A1A1AA]">
          {fixNotice}
        </p>
      ) : null}
      {notice ? (
        <p className="rounded-2xl border border-[#26262B] bg-[#141416] p-3 text-[13px] text-[#A1A1AA]">
          {notice}
        </p>
      ) : null}

      {mode === 'live' && socketState === 'reconnect-failed' ? (
        <div className="rounded-2xl border border-[#26262B] bg-[#141416] p-3">
          <p className="text-[14px] text-white">
            {socketError ?? 'Not connected — the match will resume when the connection returns.'}
          </p>
          <button
            type="button"
            onClick={retryConnection}
            className="mt-2 text-[15px] font-semibold text-[#EF4444]"
          >
            Retry
          </button>
        </div>
      ) : null}
      {mode === 'live' && socketState !== 'connected' && socketState !== 'reconnect-failed' && socketError ? (
        <p className="rounded-2xl border border-[#26262B] bg-[#141416] p-3 text-[13px] text-[#A1A1AA]">
          {socketError}
        </p>
      ) : null}

      {tab === 'map' ? (
        // Definite height (420 px), NOT min-h + flex-1: the play map's
        // container used to be `h-full` against a flex item whose height
        // came only from min-h/flex distribution, so MapLibre could
        // initialise against a zero-height canvas on a real phone and
        // stay blank. The setup map works because its container has an
        // explicit fixed height (280 px) — the play map now does too.
        <div className="relative h-[420px] shrink-0">
          <PlayMap
            zoneBoundary={zoneBoundary}
            // Next-zone preview (P1-18): the DO's `zone.preview`, 30 s
            // before the shrink — dashed ring + "Next zone in MM:SS".
            // Null outside the preview window; the next zone is never guessed.
            nextZoneBoundary={nextZonePreview?.boundary ?? null}
            nextZoneFiresAtMs={nextZonePreview?.firesAtMs ?? null}
            pings={visiblePings}
            noGoAreas={room.config.noGoAreas}
            myFix={myFix}
            // Teammates' live positions (green dots). A spectator sees no
            // live dots, so nothing is passed while spectating.
            teammateFixes={isSpectator ? {} : teammateFixes}
            reveals={reveals}
            nowMs={nowMs}
            resizeNonce={mapResizeNonce}
          />
          <PlayerDots dots={dots} />
          <div className="absolute bottom-3 right-3 z-10 flex flex-col items-center gap-3">
            <button
              type="button"
              aria-label="SOS — alerts the host"
              onClick={handleSos}
              className="flex h-11 w-11 items-center justify-center rounded-full border-2 border-[#EF4444] bg-[#141416]/90 text-[13px] font-bold text-[#EF4444]"
            >
              SOS
            </button>
            <PTTButton
              radio={mode === 'live' ? voiceRadio : null}
              pttState={pttState}
              burstSeconds={burstSeconds}
              size="large"
              disabled={!canSendRadio}
            />
          </div>
        </div>
      ) : null}

      {tab === 'radio' ? (
        <div className="min-h-[420px] flex-1">
          <RadioStrip
            team={myTeam}
            channelLine={channelLine}
            messages={radioMessages}
            notices={radioNotices}
            myPlayerId={myPlayerId}
            canSend={canSendRadio}
            voiceRadio={mode === 'live' ? voiceRadio : null}
            voiceStatus={voiceStatus}
            voiceDetail={voiceDetail}
            voiceSummary={voiceRadio?.connectionSummary ?? ''}
            pttState={pttState}
            burstSeconds={burstSeconds}
            muted={muted}
            onToggleMute={() => {
              const next = !muted;
              voiceRadio?.setMuted(next);
              setMuted(next);
            }}
            onEnableVoice={() => {
              void voiceRadio?.enable();
            }}
            onSendRadio={(text, kind) => sendRadio(text, kind)}
          />
        </div>
      ) : null}

      {tab === 'map' && isHunter && !isSpectator ? (
        <Button variant="primary" onClick={() => router.push(`/room/${roomId}/catch?scan=1`)}>
          CATCH BY QR
        </Button>
      ) : null}
      {tab === 'map' && isRunner && !isSpectator ? (
        <Button variant="primary" onClick={() => router.push(`/room/${roomId}/catch`)}>
          Got Tagged
        </Button>
      ) : null}
      {tab === 'map' && !isHunter && !isRunner ? (
        <p className="text-center text-[13px] text-[#A1A1AA]">
          Roles are drawn at the head start.
        </p>
      ) : null}

      {/* Hold-to-reveal (P1-19): press-and-hold ~1 s to share your
          position with everyone. Releasing early cancels — a tap never
          reveals by accident. Live only: the hook's sendReveal has no
          demo path (it returns false there), so the button stays hidden
          in demo instead of always failing. */}
      {tab === 'map' && mode === 'live' && myRole && !isSpectator ? (
        <button
          type="button"
          aria-label="Hold to reveal your position"
          onPointerDown={startRevealHold}
          onPointerUp={cancelRevealHold}
          onPointerLeave={cancelRevealHold}
          onPointerCancel={cancelRevealHold}
          onContextMenu={(e) => e.preventDefault()}
          className={`flex h-12 w-full select-none items-center justify-center rounded-[14px] border text-[15px] font-bold text-white transition-colors ${
            revealHolding ? 'border-[#F59E0B] bg-[#F59E0B]/30' : 'border-[#26262B] bg-[#141416]'
          }`}
        >
          {revealHolding ? 'Keep holding to reveal…' : 'Hold to reveal your position'}
        </button>
      ) : null}

      {/* Incoming reveals: someone shared their position — amber ring on
          the map, named here. Expired reveals drop off on their own. */}
      {tab === 'map' &&
      reveals.filter((r) => r.expiresAtMs > nowMs).length > 0 ? (
        <p className="text-center text-[13px] text-[#F59E0B]">
          {reveals
            .filter((r) => r.expiresAtMs > nowMs)
            .map((r) => r.displayName)
            .join(', ')}{' '}
          revealed their position
        </p>
      ) : null}

      {announcements.length > 0 && tab === 'map' ? (
        <p className="text-center text-[13px] text-[#A1A1AA]">
          {announcements[announcements.length - 1]?.text}
        </p>
      ) : null}

      <BottomTabs
        active={tab}
        radioUnread={radioUnread}
        onChange={(next) => setTab(next)}
      />

      <Sheet open={tab === 'more'} onClose={() => setTab('map')} title="More">
        <div className="flex flex-col gap-4">
          {/* Host only: end the round early (POST …/lifecycle, host-only).
              The match completes with the mode-aware outcome and the play
              screen redirects to results. */}
          {isHost && (phase === 'HEAD_START' || phase === 'ACTIVE' || phase === 'SAFETY_PAUSED') ? (
            <button
              type="button"
              onClick={() => {
                setTab('map');
                handleEndRound();
              }}
              className="self-start text-[15px] font-semibold text-[#EF4444]"
            >
              End the round
            </button>
          ) : null}
          <SafetyControls
            phase={phase}
            paused={safetyState.paused}
            pausedByName={pausedByName}
            pausedFrom={demo?.pausedFrom ?? null}
            sosActive={safetyState.sosActive}
            sosByName={sosByName}
            isHost={isHost}
            sosIsMine={sosSent && safetyState.sosActive}
            isDemo={mode === 'demo'}
            canPause={phase === 'HEAD_START' || phase === 'ACTIVE' || phase === 'SAFETY_PAUSED'}
            onSos={handleSos}
            onPause={handlePause}
            onResume={handleResume}
            onAnnounceSafe={handleAnnounceSafe}
          />
          <button
            type="button"
            onClick={handleLeave}
            className="self-start text-[15px] font-semibold text-[#EF4444]"
          >
            {leaveArmed ? 'Tap again to leave' : 'Leave game'}
          </button>
        </div>
      </Sheet>

      {/* Role reveal — once at start, full-screen flash (SCRAM-SPEC §8a):
          red for hunters, green for runners. */}
      {reveal && room ? (
        <div
          className={`fixed inset-0 z-50 flex flex-col px-6 pb-[env(safe-area-inset-bottom,0px)] pt-[env(safe-area-inset-top,0px)] text-white ${
            reveal === 'runner' ? 'bg-[#22C55E]' : 'bg-[#EF4444]'
          }`}
        >
          <div className="flex items-center justify-between pt-4">
            <p className="text-[17px] font-bold tracking-wide">PAKDAM</p>
            <span className="rounded-full border border-white/60 px-3 py-1 text-[13px] font-semibold">
              {room.roomCode} · Round 1
            </span>
          </div>
          <div className="flex flex-1 flex-col justify-center gap-4">
            <span className="self-start rounded-full bg-white px-4 py-1.5 text-[14px] font-bold text-black">
              Your role · {reveal === 'hunter' ? 'Hunter' : 'Runner'}
            </span>
            <h1 className="pakdam-display text-[64px]">
              {reveal === 'hunter' ? 'You\u2019re it.' : 'Stay hidden.'}
            </h1>
            <p className="max-w-[320px] text-[17px] leading-snug">
              {reveal === 'hunter'
                ? `Find and tag all ${runnersTotal} runners in ${formatDurationShort(room.config.durationSeconds)}. They get a ${formatDurationShort(room.config.headStartSeconds)} head start.`
                : 'Outlast the clock. Hunters see you only when you ping.'}
            </p>
            {teammates.length > 0 ? (
              <p className="text-[14px] text-white/85">
                {reveal === 'hunter' ? 'Hunting with ' : 'Hiding with '}
                {teammates.map((t) => t.displayName).join(', ')}
              </p>
            ) : null}
            <p className="text-[13px] text-white/70">
              Keep the app open — alerts arrive while you&apos;re playing. There are no push notifications when the app is closed.
            </p>
          </div>
          <button
            type="button"
            onClick={dismissReveal}
            className="flex h-14 w-full items-center justify-center rounded-[14px] bg-white px-4 text-[17px] font-bold text-black active:bg-[#E5E5E5]"
          >
            Let&apos;s go
          </button>
        </div>
      ) : null}
    </main>
  );
}
