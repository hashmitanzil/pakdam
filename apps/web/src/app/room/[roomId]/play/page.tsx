/**
 * Play — the live HUD (SCRAM-SPEC §8, BEHAVIOUR §2).
 *
 * One status strip, the Ola dark map, bottom tabs (Map / Radio / ···),
 * floating PTT mic, and one catch action per role. Role reveal
 * shows once at start (again if an Infection tag flips my role).
 *
 * Live mode: the snapshot is the whole truth; the client never sets phase,
 * roles, timers or ejection. Demo mode: the demo store ticks locally
 * (pings auto-fire, shrink uses the random-offset draw).
 *
 * Location honesty: a fix is SENT whenever it is within the server
 * validity bound (±1000 m) — that stamps `lastFixAt` for liveness, so
 * a poor-but-present GPS never ejects the player for "no location".
 * Gameplay (zone, pings, catch proximity) only ever USES fixes
 * accurate to ±50 m; that gate lives server-side. The outside-zone
 * countdown is display-only in live mode — the server enforces
 * ejection; in demo the page ejects at 0.
 */
'use client';

import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  LOCATION_FRESHNESS_SECONDS,
  MAX_FIX_ACCURACY_METERS,
  OUTSIDE_ZONE_RETURN_SECONDS,
  ZONE_AUTO_CENTRE_MAX_ACCURACY_M,
  type GeoPolygon,
  type LocationFix,
  type MatchPhase,
  type Ping,
  type PlayerView,
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
import { Toggle } from '@/components/ui/Toggle';
import { Button } from '@/components/ui/Button';
import { formatSuspendedLabel, formatOutsideCountdown } from '@/components/match/freshness';
import { formatDurationShort, ageLabelFromTimestamp, haversineMeters } from '@/lib/utils';
import { watchLocation } from '@/lib/geolocation';
import { requestWakeLock } from '@/lib/wake-lock';
import { clearSession } from '@/lib/session-credentials';
import { goHomeAfterRoomDeleted } from '@/lib/room-deleted';
import {
  deleteDemoRoom,
  ejectPlayer,
  getRoom,
  leaveRoom,
  recordPlayerFix,
  resumePlayer,
  safetyPauseDemo,
  safetyResumeDemo,
} from '@/lib/demo-store';
import { VoiceRadio, type PttState, type VoiceSignal } from '@/lib/voice-radio';
import {
  DEFAULT_CUE_SETTINGS,
  cuePingReceived,
  cuePingTone,
  cueTag,
  cueTagTone,
  cueZoneTone,
  cueZoneWarning,
  unlockCueAudio,
  type CueSettings,
} from '@/lib/cues';
import type { PakdamSocket } from '@/lib/websocket';

const TERMINAL: MatchPhase[] = ['COMPLETED', 'CANCELLED', 'ABANDONED', 'EXPIRED'];

/** Stable empty identities — a fresh `[]` / `{}` literal every render
 *  would bust every memo and map effect downstream. */
const EMPTY_POLYGON: GeoPolygon = [];
const EMPTY_POLYGONS: GeoPolygon[] = [];
const EMPTY_FIXES: Record<string, LocationFix> = {};
const EMPTY_TEAMMATES: PlayerView[] = [];

/**
 * B12: return the previous identity when the new value is deeply equal
 * (by JSON — these values are small: a zone boundary, a few no-go
 * polygons, a handful of teammate fixes). Snapshots hand out fresh
 * objects every time, which used to bust every memo downstream even
 * when nothing had changed.
 */
function useStableByJson<T>(value: T): T {
  const ref = useRef<{ json: string; value: T } | null>(null);
  const json = JSON.stringify(value);
  if (ref.current === null || ref.current.json !== json) {
    ref.current = { json, value };
  }
  return ref.current.value;
}

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
    lastSocketError,
    demo,
    hostGraceEndsAtMs,
    myPlayerId,
    myPlayer,
    loading,
    error,
    roomDeleted,
    retryConnection,
    refreshDemo,
    sendRadio,
    leave,
  } = state;

  const [tab, setTab] = useState<BottomTabId>('map');
  const [nowMs, setNowMs] = useState(() => Date.now());
  // B11: the 1 s clock above is for the countdown TEXT only
  // (StatusStrip). The map and the dots get a coarse 5 s clock, so a
  // tick does not rebuild map overlays or dot labels every second.
  const mapNowMs = useMemo(() => Math.floor(nowMs / 5000) * 5000, [nowMs]);
  const [myFix, setMyFix] = useState<LocationFix | null>(null);
  const [fixNotice, setFixNotice] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reveal, setReveal] = useState<'hunter' | 'runner' | null>(null);
  // Bumped when the role-reveal overlay dismisses — PlayMap resizes
  // explicitly then, so a canvas measured while covered never stays blank.
  const [mapResizeNonce, setMapResizeNonce] = useState(0);
  // A6: optimistic pause / end-round — the tap shows at once, the
  // server snapshot reconciles; a failed send rolls back (see below).
  const [pausedOverride, setPausedOverride] = useState<boolean | null>(null);
  const [outsideSecondsLeft, setOutsideSecondsLeft] = useState<number | null>(null);
  const [radioUnread, setRadioUnread] = useState(0);
  const [leaveArmed, setLeaveArmed] = useState(false);
  // NOTE (founder decision, v18): hold-to-reveal is removed entirely —
  // no 'Hold to reveal your position' button, no hold timer, no
  // sendReveal. The role-reveal overlay (`reveal` state below) is a
  // different feature and stays. Pings are unchanged.

  // Voice radio state (live only — demo has no signalling channel).
  const [voiceRadio, setVoiceRadio] = useState<VoiceRadio | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<VoiceRadioStatus>('off');
  const [voiceDetail, setVoiceDetail] = useState<string | undefined>(undefined);
  const [pttState, setPttState] = useState<PttState>('idle');
  const [muted, setMuted] = useState(false);

  // Haptics + cue sounds (separate from the voice-radio mute above).
  // Vibration is Android-only by feature detection (see lib/cues.ts);
  // cue sounds are off by default. Persisted per device.
  const [cueSettings, setCueSettings] = useState<CueSettings>(() => {
    if (typeof window === 'undefined') return DEFAULT_CUE_SETTINGS;
    try {
      return {
        hapticsEnabled:
          window.localStorage.getItem('pakdam-cues-haptics') !== 'off',
        soundsEnabled:
          window.localStorage.getItem('pakdam-cues-sounds') === 'on',
      };
    } catch {
      return DEFAULT_CUE_SETTINGS;
    }
  });
  const setCueSetting = useCallback((patch: Partial<CueSettings>) => {
    unlockCueAudio();
    setCueSettings((prev) => {
      const next = { ...prev, ...patch };
      try {
        window.localStorage.setItem(
          'pakdam-cues-haptics',
          next.hapticsEnabled ? 'on' : 'off',
        );
        window.localStorage.setItem(
          'pakdam-cues-sounds',
          next.soundsEnabled ? 'on' : 'off',
        );
      } catch {
        // Storage is best-effort.
      }
      return next;
    });
  }, []);

  const myRole = myPlayer?.matchRole ?? null;
  const myTeam = myPlayer?.team ?? null;
  const isHost = myPlayer?.isHost ?? false;
  const isHunter = myRole === 'hunter';
  const isRunner = myRole === 'runner';
  const socketRef = useRef<PakdamSocket | null>(null);
  const myFixRef = useRef<LocationFix | null>(null);
  // Last fix actually shown on screen — the display throttle below.
  const lastShownFixRef = useRef<{ fix: LocationFix; atMs: number } | null>(null);
  // B20: when the current outside-zone spell started (ms epoch) — the
  // countdown is computed from the wall clock, never accumulated.
  const outsideSinceRef = useRef<number | null>(null);
  // Wall-clock time of the last outside-zone tick — the poor-GPS freeze
  // slides the spell start by the ELAPSED time, not a flat 1 s per
  // tick, so a throttled/backgrounded tick cannot under-count.
  const lastOutsideTickMsRef = useRef<number | null>(null);
  const outsideEjectedRef = useRef(false);
  // Missing-fix ejection guard (demo only) — see the (4a) block below.
  const missingFixEjectedRef = useRef(false);
  const seenRadioRef = useRef(0);

  // A6: an optimistic pause/resume stands only until the server
  // snapshot agrees with it — then it is the truth, not an override.
  useEffect(() => {
    if (pausedOverride !== null && safetyState.paused === pausedOverride) {
      setPausedOverride(null);
    }
  }, [pausedOverride, safetyState.paused]);
  // (d) A server rejection of a pause/resume (including a 429) arrives
  // only as an error envelope — without this, a non-host tapping
  // "Resume the match" (or any rejected pause) would flip their client
  // to live while the match stays paused server-side, indefinitely.
  // The override clears and the server's reason is shown. Tied to the
  // pending safety action by receipt time so an unrelated error never
  // clears a pause the player is waiting on.
  const pendingSafetyAtMsRef = useRef<number | null>(null);
  useEffect(() => {
    if (!lastSocketError || pausedOverride === null) return;
    const at = pendingSafetyAtMsRef.current;
    if (at !== null && lastSocketError.atMs >= at && lastSocketError.atMs - at < 15_000) {
      pendingSafetyAtMsRef.current = null;
      setPausedOverride(null);
      setNotice(lastSocketError.message);
    }
  }, [lastSocketError, pausedOverride]);

  // B10: the map is kept mounted (hidden) across tabs, but a canvas
  // hidden with display:none reports zero size — resize explicitly
  // when the map tab comes back so it paints correctly.
  useEffect(() => {
    if (tab === 'map') setMapResizeNonce((n) => n + 1);
  }, [tab]);

  // Stable derived identities, defined early: the outside-zone effect
  // below depends on the boundary, not on the whole room object (fresh
  // per snapshot), and a fresh `[]` fallback each render would bust
  // every memo downstream. B12: deep-compared, so the identity holds
  // when the data did not actually change.
  const zoneBoundary = useStableByJson(room?.config.zone.boundary ?? EMPTY_POLYGON);
  const noGoAreas = useStableByJson(room?.config.noGoAreas ?? EMPTY_POLYGONS);
  const stableTeammateFixes = useStableByJson(teammateFixes);

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

  // Role reveal, once per role (an Infection flip shows it again).
  useEffect(() => {
    if (!myRole) return;
    if (phase !== 'HEAD_START' && phase !== 'ACTIVE' && phase !== 'SAFETY_PAUSED') return;
    const shown = window.sessionStorage.getItem(`pakdam.role-reveal.${roomId}`);
    if (shown !== myRole) setReveal(myRole);
  }, [myRole, phase, roomId]);

  const dismissReveal = useCallback(() => {
    if (reveal) {
      window.sessionStorage.setItem(`pakdam.role-reveal.${roomId}`, reveal);
    }
    setReveal(null);
    // The reveal covered the map at game start — resize it explicitly
    // now that it is uncovered.
    setMapResizeNonce((n) => n + 1);
  }, [reveal, roomId]);

  // Room deleted (founder decision, 2026-11-21): the host cancelled
  // and the room is gone — every player still in it goes home with the
  // one plain message. Declared BEFORE the terminal effect below, and
  // the terminal effect bails out when this fires, so a host cancel
  // never flashes the results screen on the way home.
  useEffect(() => {
    if (!roomDeleted) return;
    goHomeAfterRoomDeleted(router, roomId);
  }, [roomDeleted, roomId, router]);

  // Terminal phase → results. Back to lobby if the match never started.
  // Bails out when the room was deleted: a host cancel deletes the
  // room, so the players go home with the one plain message — never to
  // results.
  useEffect(() => {
    if (roomDeleted || !room) return;
    if (TERMINAL.includes(room.phase)) {
      router.replace(`/room/${roomId}/results`);
    } else if (room.phase === 'LOBBY') {
      router.replace(`/room/${roomId}`);
    }
  }, [room, roomDeleted, roomId, router]);

  // Location watch — foreground only. B1 (v18 fix round): liveness is
  // decoupled from usability — a fix is SENT whenever it is within the
  // server validity bound (±1000 m, MAX_FIX_ACCURACY_METERS), so a
  // poor-but-present GPS still stamps `lastFixAt` and the player is
  // not ejected for "no location". Only fixes accurate to ±50 m are
  // USABLE for gameplay (zone, pings, catch proximity) — that gate
  // lives server-side. The notice copy says exactly that: a poor fix
  // IS sent (to stay connected) but is too rough for the game to use.
  // The outside-zone freeze below reads `myFixRef` (every fix,
  // sendable or not) and is untouched by this change.
  useEffect(() => {
    if (!myPlayerId) return;
    const handle = watchLocation(
      (fix) => {
        myFixRef.current = fix;
        // Display throttle: the dot only needs to move when the fix
        // actually moved (≥ 5 m) or 5 s passed — before this, EVERY raw
        // GPS fix re-rendered the whole page and rebuilt the map
        // overlays, up to ~1×/s even standing still. Sending to the
        // server still happens per fix below; only the display waits.
        const lastShown = lastShownFixRef.current;
        const movedM = lastShown ? haversineMeters(lastShown.fix, fix) : Infinity;
        if (movedM >= 5 || !lastShown || fix.timestampMs - lastShown.atMs >= 5000) {
          lastShownFixRef.current = { fix, atMs: fix.timestampMs };
          setMyFix(fix);
        }
        if (fix.accuracyMeters <= MAX_FIX_ACCURACY_METERS) {
          if (mode === 'live') {
            socketRef.current?.sendLocationUpdate(fix);
          } else {
            const current = getRoom(roomId);
            if (current) recordPlayerFix(current, myPlayerId, fix);
          }
          if (fix.accuracyMeters > ZONE_AUTO_CENTRE_MAX_ACCURACY_M) {
            setFixNotice(
              'GPS is rough here — your location was sent to stay connected, but it is too rough for the game to use.',
            );
          } else {
            setFixNotice(null);
          }
        } else {
          // Unreachable in practice — `validateFix` already rejects
          // fixes worse than ±1000 m before they reach this callback —
          // kept as defence in depth.
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
  // B20: computed from the wall clock (Date.now() - outsideSinceMs),
  // never accumulated with a flat += 1000 per tick — a throttled or
  // delayed tick used to over-count, and the state was set on every
  // tick even when the displayed second had not changed.
  useEffect(() => {
    const now = Date.now();
    // Elapsed wall-clock since the last tick — the poor-GPS freeze
    // below slides the spell start by exactly this, so a throttled or
    // backgrounded tick freezes the full time that passed, not 1 s.
    const lastTick = lastOutsideTickMsRef.current;
    const elapsedMs = lastTick === null ? 1000 : Math.max(now - lastTick, 0);
    lastOutsideTickMsRef.current = now;
    if (phase !== 'ACTIVE' && phase !== 'HEAD_START') {
      // F4: freeze the spell instead of resetting it — slide the spell
      // start forward by the elapsed time, so the countdown (and its
      // entry cue) resumes where the pause began instead of restarting
      // at 30 and buzzing a second entry for the same spell.
      if (outsideSinceRef.current !== null) {
        outsideSinceRef.current += elapsedMs;
      }
      lastOutsideTickMsRef.current = now;
      outsideEjectedRef.current = false;
      missingFixEjectedRef.current = false;
      return;
    }
    // (4a) Missing-fix ejection — demo only (live is server-enforced by
    // the alarm tick). v18: no fix at all for ≥ 30 s ejects, the same
    // 30 s as out-of-zone. Baseline is max(last fix, match start), so a
    // player who never reported is ejected 30 s after the match starts,
    // not instantly. "Last fix" is ANY fix this tab has seen — including
    // a poor one the watcher never sent (myFixRef updates on every fix
    // callback, sendable or not) plus the store's lastFixAt — so a
    // poor-but-present fix NEVER ejects here; it only freezes the
    // countdown below. This runs BEFORE the stale-fix freeze: the old
    // code froze on a missing fix forever and never ejected. A safety
    // pause never ejects — this effect already returns early unless the
    // phase is HEAD_START or ACTIVE.
    if (mode === 'demo') {
      const startedAtMs = room?.startedAt ? Date.parse(room.startedAt) : null;
      if (startedAtMs !== null && !missingFixEjectedRef.current) {
        const lastFixMs = myPlayer?.lastFixAt ? Date.parse(myPlayer.lastFixAt) : null;
        const lastSeenMs = Math.max(
          myFixRef.current?.timestampMs ?? Number.NEGATIVE_INFINITY,
          lastFixMs ?? Number.NEGATIVE_INFINITY,
          startedAtMs,
        );
        if (now - lastSeenMs >= LOCATION_FRESHNESS_SECONDS * 1000) {
          missingFixEjectedRef.current = true;
          const current = getRoom(roomId);
          if (current) {
            ejectPlayer(current, myPlayerId);
            refreshDemo();
          }
          setNotice('You were ejected — no location for 30 s.');
          return;
        }
      }
    }
    const fix = myFixRef.current;
    const boundary = zoneBoundary;
    if (!fix || boundary.length < 3) return;
    if (isPointInZone(fix, boundary)) {
      outsideSinceRef.current = null;
      lastOutsideTickMsRef.current = null;
      outsideEjectedRef.current = false;
      missingFixEjectedRef.current = false;
      if (outsideSecondsLeft !== null) setOutsideSecondsLeft(null);
      return;
    }
    // (l-ii) A fix older than ~10 s is missing, not outside: the GPS
    // stream stopped (tunnel, permission revoked, backgrounded
    // watcher) and the countdown must freeze on minutes-old data,
    // never keep decrementing — in demo it used to eject at 0.
    if (now - fix.timestampMs > 10_000) return;
    // (l-i) The spell starts on the FIRST outside tick, BEFORE the
    // poor-GPS branch: if the first outside fix is the poor one, the
    // old code returned before ever setting outsideSinceRef, so the
    // banner could never appear. The banner shows 0:30 from this tick.
    if (outsideSinceRef.current === null) outsideSinceRef.current = now;
    // Poor GPS freezes the countdown — the spell's start slides
    // forward by the ELAPSED wall-clock time (l-iii), not a flat
    // 1 s per tick, so a throttled/backgrounded tick cannot under-count
    // the freeze. Falls through to the countdown below, so the banner
    // renders at 0:30 while frozen.
    if (fix.accuracyMeters > ZONE_AUTO_CENTRE_MAX_ACCURACY_M) {
      outsideSinceRef.current += elapsedMs;
    }
    const left = Math.min(
      OUTSIDE_ZONE_RETURN_SECONDS,
      Math.max(
        0,
        OUTSIDE_ZONE_RETURN_SECONDS -
          Math.floor((now - outsideSinceRef.current) / 1000),
      ),
    );
    // Only setState when the displayed second actually changes.
    setOutsideSecondsLeft((prev) => (prev === left ? prev : left));
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
  }, [nowMs, phase, zoneBoundary, mode, roomId, myPlayerId]);

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
  // A6: the displayed pause / phase is the optimistic override while
  // one stands, the server truth otherwise.
  const effectivePaused = pausedOverride ?? safetyState.paused;
  const displayPhase = phase;
  const activePlayers = useMemo(
    () => players.filter((p) => p.leftAt === null),
    [players],
  );
  // Effective Hunter count (Balance ON reads the balance table from the
  // roster; Balance OFF honours the host's stepper) — never the raw
  // `config.hunterCount`, which the server does not draw while Balance
  // is ON. The HUD "runners left" and the role-reveal text use this.
  // Memoized: trivial math, but it must not re-run on every clock tick.
  const hunterCount = useMemo(
    () => (room ? effectiveHunterCount(room.config, activePlayers.length) : 0),
    [room, activePlayers.length],
  );
  const runnersTotal = useMemo(
    () => Math.max(0, activePlayers.length - hunterCount),
    [activePlayers.length, hunterCount],
  );
  const caughtIds = useMemo(
    () =>
      new Set(
        sessionCatches
          .filter((c) => c.state === 'confirmed')
          .map((c) => c.runnerPlayerId),
      ),
    [sessionCatches],
  );
  // Roster + tagger lookups, built once per roster/catch set — the old
  // code ran `players.find` / `sessionCatches.find` per player per
  // render (O(n·m)) in the list and the dots below.
  const playerById = useMemo(
    () => new Map(players.map((p) => [p.playerId, p])),
    [players],
  );
  const taggerByRunnerId = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of sessionCatches) {
      if (c.state === 'confirmed') m.set(c.runnerPlayerId, c.hunterPlayerId);
    }
    return m;
  }, [sessionCatches]);
  // Players list (More sheet): every player still in the room, with
  // Alive / Tagged status. "Tagged" reuses the same settled-catch source
  // as `caughtIds` above and the results page's "[hunter] tagged
  // [runner]" list — a confirmed catch against the player, with the
  // tagger's name resolved from the same roster. No new tag source.
  // Works in both modes: live `sessionCatches` come from the snapshot's
  // `decidedCatches`, demo ones from the demo store's catches.
  const playerStatuses = useMemo(
    () =>
      activePlayers.map((p) => {
        const hunterId = taggerByRunnerId.get(p.playerId);
        return {
          player: p,
          taggerName:
            hunterId === undefined
              ? null
              : (playerById.get(hunterId)?.displayName ?? 'a Hunter'),
        };
      }),
    [activePlayers, taggerByRunnerId, playerById],
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
  // applies.) Radio stays available — it is communication, not a playing
  // action.
  const amCaught = isRunner && myPlayerId !== null && caughtIds.has(myPlayerId);
  const isSpectator = spectateParam || amCaught;

  const startedAtMs = room?.startedAt ? new Date(room.startedAt).getTime() : null;
  const zoneRadiusM = useMemo(
    () => (zoneBoundary.length >= 3 ? zoneDiameterMeters(zoneBoundary) / 2 : null),
    [zoneBoundary],
  );

  const lastPingAtMs = useMemo(() => {
    if (mode === 'demo' && demo) {
      const values: number[] = Object.values(demo.lastPingAtMs);
      return values.length > 0 ? Math.min(...values) : null;
    }
    if (pings.length === 0) return null;
    return Math.min(...pings.map((p) => new Date(p.createdAt).getTime()));
  }, [mode, demo, pings]);

  // The ping clock starts at ACTIVE (head start end), never at match
  // start — the first ping is due one interval after the head start ends.
  const nextPingAtMs = useMemo(
    () =>
      startedAtMs === null || !room
        ? null
        : engineNextPingAtMs(
            lastPingAtMs,
            startedAtMs,
            room.config.pingIntervalSeconds,
            startedAtMs + room.config.headStartSeconds * 1000,
          ),
    [startedAtMs, room, lastPingAtMs],
  );
  const nextShrinkAtMs = useMemo(
    () =>
      startedAtMs === null || !room
        ? null
        : engineNextShrinkAtMs(
            startedAtMs,
            room.config.durationSeconds,
            room.config.zoneShrinkIntervalSeconds,
            room.config.zoneShrinkEnabled,
            effectivePaused && safetyState.pausedAt
              ? new Date(safetyState.pausedAt).getTime()
              : nowMs,
          ),
    [startedAtMs, room, effectivePaused, safetyState.pausedAt, nowMs],
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

  // --- Haptics + audio cues (lib/cues.ts) ---------------------------------
  // Ping received: cue once per new ping identity (keyed by pingId, so
  // the 1 s clock tick and re-renders never re-fire it). A ping
  // addressed to Hunters is about a Runner, and vice versa.
  //
  // F1: the first visible snapshot is SEEDED, never cued — mounting
  // with live pings already on screen, an Infection flip (the other
  // side's pings become visible), or flipping to spectate (ALL pings
  // become visible) must not buzz a burst. The seed re-runs whenever
  // the visibility scope changes (role / spectator), keyed by
  // pingScopeKey below. createdAt is defence-in-depth on top: only
  // pings created after the last priming cue. Dedup is by pingId, NOT
  // by subject — the next scheduled ping for the same subject is a
  // genuinely new pingId and must still cue. The seen-set is a ref, so
  // it survives socket reconnects (the page stays mounted; the server
  // never re-sends delivered pings, so the client must keep its own
  // shown-ping state — Kabir-verified: pingIds are never re-minted).
  // F3: the set is capped (oldest out first) so it cannot grow
  // without bound over a long game.
  const seenPingIdsRef = useRef<Set<string>>(new Set());
  const pingCuePrimedRef = useRef(false);
  const pingCueBaselineRef = useRef(0);
  const pingScopeRef = useRef<string | null>(null);
  const pingScopeKey = isSpectator ? 'spectator' : (myPingRole ?? 'none');
  const cueSettingsRef = useRef(cueSettings);
  cueSettingsRef.current = cueSettings;
  useEffect(() => {
    const seen = seenPingIdsRef.current;
    const scopeChanged =
      pingScopeRef.current !== null && pingScopeRef.current !== pingScopeKey;
    if (!pingCuePrimedRef.current || scopeChanged) {
      // First snapshot, or a role/spectator transition: seed silently.
      for (const ping of visiblePings) seen.add(ping.pingId);
      pingCueBaselineRef.current = Math.max(
        pingCueBaselineRef.current,
        ...visiblePings.map((p) => new Date(p.createdAt).getTime()),
      );
      pingScopeRef.current = pingScopeKey;
      pingCuePrimedRef.current = true;
    } else {
      for (const ping of visiblePings) {
        if (seen.has(ping.pingId)) continue;
        seen.add(ping.pingId);
        // Defence-in-depth: a ping created before the last priming
        // (late delivery, scope change) never cues.
        if (new Date(ping.createdAt).getTime() < pingCueBaselineRef.current) {
          continue;
        }
        const kind = ping.recipientRole === 'hunters' ? 'runner' : 'hunter';
        const settings = cueSettingsRef.current;
        cuePingReceived(settings);
        cuePingTone(kind, settings);
      }
    }
    // F3: cap the seen-set at 200 (a 3-hour game holds ~100) —
    // oldest entries out first (Sets iterate in insertion order).
    while (seen.size > 200) {
      const oldest = seen.values().next().value;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }
  }, [visiblePings, pingScopeKey]);
  // Zone warning: cue ONCE on entry (null → value) and once at ≤ 10 s —
  // never on every 1 s tick. Resets when back inside the zone.
  const prevOutsideRef = useRef<number | null>(null);
  const zoneLowWarnedRef = useRef(false);
  // F5: the entry cue waits out a 2 s re-entry grace — a GPS fix
  // oscillating in/out must not buzz on every re-entry. The timer
  // lives in a ref (not effect cleanup) so later countdown ticks do
  // not cancel it; going back inside, or spectating, cancels it.
  const zoneEntryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const prev = prevOutsideRef.current;
    prevOutsideRef.current = outsideSecondsLeft;
    // F4: a spectator is out of the game — no zone-warning buzzes for
    // a match they can no longer play.
    if (outsideSecondsLeft === null || isSpectator) {
      zoneLowWarnedRef.current = false;
      if (zoneEntryTimerRef.current !== null) {
        clearTimeout(zoneEntryTimerRef.current);
        zoneEntryTimerRef.current = null;
      }
      return;
    }
    const settings = cueSettingsRef.current;
    if (prev === null) {
      if (zoneEntryTimerRef.current !== null) {
        clearTimeout(zoneEntryTimerRef.current);
      }
      zoneEntryTimerRef.current = setTimeout(() => {
        zoneEntryTimerRef.current = null;
        // Still outside (prevOutsideRef is only a value while outside)
        // — buzz once for this spell.
        if (prevOutsideRef.current !== null) {
          const s = cueSettingsRef.current;
          cueZoneWarning(s);
          cueZoneTone(s);
        }
      }, 2000);
      return;
    }
    if (outsideSecondsLeft <= 10 && !zoneLowWarnedRef.current) {
      zoneLowWarnedRef.current = true;
      cueZoneWarning(settings);
      cueZoneTone(settings);
    }
  }, [outsideSecondsLeft, isSpectator]);
  // Clear a pending entry-cue timer on unmount.
  useEffect(
    () => () => {
      if (zoneEntryTimerRef.current !== null) {
        clearTimeout(zoneEntryTimerRef.current);
      }
    },
    [],
  );
  // Tag: cue on the false → true transition of amCaught only.
  // F2: prevCaughtRef starts as null (unprimed) — mounting with
  // amCaught already true (refresh after being tagged, back from
  // results/catch, direct play URL while caught) primes it silently
  // instead of buzzing a tag that never just happened.
  const prevCaughtRef = useRef<boolean | null>(null);
  useEffect(() => {
    const was = prevCaughtRef.current;
    prevCaughtRef.current = amCaught;
    if (was === null) return;
    if (amCaught && !was) {
      const settings = cueSettingsRef.current;
      cueTag(settings);
      cueTagTone(settings);
    }
  }, [amCaught]);
  // Resume the cue-audio context on the first tap anywhere (iOS
  // autoplay policy) so the first cue tone is not blocked.
  useEffect(() => {
    const unlock = () => unlockCueAudio();
    window.addEventListener('pointerdown', unlock, { once: true });
    return () => window.removeEventListener('pointerdown', unlock);
  }, []);

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
              : ageLabelFromTimestamp(myLastFixMs, mapNowMs),
        suspended: myPlayer?.connectionState === 'suspended',
      });
      // Live teammates — never when I am caught (a tagged Runner loses
      // the live teammate view) and never while spectating.
      if (!amCaught) {
        for (const teammateId of teammateIds) {
          const p = playerById.get(teammateId);
          if (!p || p.leftAt !== null) continue;
          const lastFixMs = p.lastFixAt ? new Date(p.lastFixAt).getTime() : null;
          out.push({
            playerId: p.playerId,
            displayName: p.displayName,
            tone: 'teammate',
            label:
              lastFixMs === null
                ? 'Location never reported'
                : ageLabelFromTimestamp(lastFixMs, mapNowMs),
            suspended: p.connectionState === 'suspended',
          });
        }
      }
    }
    for (const ping of visiblePings) {
      const subject = playerById.get(ping.subjectPlayerId);
      if (!subject) continue;
      out.push({
        playerId: `ping-${ping.pingId}`,
        displayName: subject.displayName,
        tone: ping.recipientRole === 'hunters' ? 'ping-runner' : 'ping-hunter',
        // Demo pings are simulated (fired by the local store, not the
        // server) — labelled so, wherever they are shown.
        label:
          ageLabelFromTimestamp(new Date(ping.createdAt).getTime(), mapNowMs) +
          (mode === 'demo' ? ' · (simulated)' : ''),
      });
    }
    return out;
  }, [playerById, myPlayer, myPlayerId, teammateIds, visiblePings, mapNowMs, amCaught, isSpectator, mode]);

  const myLastFixMs = myPlayer?.lastFixAt ? new Date(myPlayer.lastFixAt).getTime() : null;
  const isSuspended = myPlayer?.connectionState === 'suspended';
  // v24 (D1): host-reconnect grace — the host is suspended and the
  // server/demo says the grace is running, so the room is hostless
  // until the host returns or the grace expires and the crown moves.
  // Host-only controls (End the round, Resume the match) are gated on
  // `isHost` from the snapshot, so no connected player can reach them
  // while this holds. The suspended host themself never sees this line
  // (they ARE the host); their own suspended banner shows instead.
  const hostPlayer = players.find((p) => p.playerId === room?.hostPlayerId);
  const hostGraceActive =
    (hostGraceEndsAtMs ?? null) !== null &&
    hostPlayer?.connectionState === 'suspended' &&
    hostPlayer.playerId !== myPlayerId;

  const teammates = useMemo(
    () =>
      mode === 'demo'
        ? players.filter((p) => p.team === myTeam && p.playerId !== myPlayerId && p.leftAt === null)
        : EMPTY_TEAMMATES,
    [mode, players, myTeam, myPlayerId],
  );
  const channelLine = useMemo(
    () =>
      `${myTeam === 'hunters' ? 'Hunters' : 'Runners'} channel · ${
        mode === 'demo' ? teammates.length : (voiceRadio?.connectedPeers.length ?? 0)
      } on air`,
    [myTeam, mode, teammates.length, voiceRadio],
  );
  const canSendRadio =
    myTeam === 'hunters' ? room?.config.huntersCanTalk !== false : true;
  const radioNotices = useMemo(
    () =>
      phase === 'HEAD_START' && room
        ? [
            `just now · Runners have a ${formatDurationShort(room.config.headStartSeconds)} head start. Hold tight.`,
          ]
        : [],
    [phase, room],
  );
  // Who paused the match — up here with the other memos, never after
  // the early returns below (hooks must run on every render).
  const pausedByName = useMemo(
    () =>
      safetyState.pausedBy
        ? (playerById.get(safetyState.pausedBy)?.displayName ?? null)
        : null,
    [safetyState.pausedBy, playerById],
  );

  // -- Safety actions ---------------------------------------------------------
  // A6: pause / resume show at once (local override) and reconcile on
  // the next snapshot; a failed send rolls straight back and says so.
  // Stable callbacks (useCallback): an inline handler is a new function
  // every render, which re-renders every memoized child that receives it
  // — and a tap landing mid-render waits for that render to finish.
  const handlePause = useCallback(() => {
    if (mode === 'live') {
      if (!socketRef.current?.safetyPause()) {
        setNotice('Not connected — pause was not sent. Wait for the reconnect, then tap again.');
        return;
      }
      pendingSafetyAtMsRef.current = Date.now();
      setPausedOverride(true);
    } else {
      const current = getRoom(roomId);
      if (current) {
        safetyPauseDemo(current, myPlayerId);
        refreshDemo();
      }
    }
  }, [mode, roomId, myPlayerId, refreshDemo]);
  const handleResume = useCallback(() => {
    if (mode === 'live') {
      if (!socketRef.current?.safetyResume()) {
        setNotice('Not connected — resume was not sent. Wait for the reconnect, then tap again.');
        return;
      }
      pendingSafetyAtMsRef.current = Date.now();
      setPausedOverride(false);
    } else {
      const current = getRoom(roomId);
      if (current) {
        safetyResumeDemo(current);
        refreshDemo();
      }
    }
  }, [mode, roomId, refreshDemo]);
  const handleLeave = useCallback(() => {
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
  }, [leaveArmed, mode, roomId, myPlayerId, leave, router]);
  const handleEndRound = useCallback(() => {
    if (!isHost) return;
    // Host cancel (founder decision, 2026-11-21): the round ends AND
    // the room is deleted — every player goes home with the one plain
    // message, never to results. The cancelling host goes home on the
    // accepted call; every other player follows via `room.deleted` /
    // a 404 (see the roomDeleted effect above). There is no optimistic
    // phase override any more: the old one flashed COMPLETED and the
    // terminal effect then routed to results before the deletion
    // landed. A failed call stays on the match and says so.
    if (mode === 'live') {
      void endLiveMatch(roomId)
        .then(() => goHomeAfterRoomDeleted(router, roomId))
        .catch(() => {
          setNotice('Could not end the round — check your connection and try again.');
        });
      return;
    }
    deleteDemoRoom(roomId);
    refreshDemo();
    goHomeAfterRoomDeleted(router, roomId);
  }, [isHost, mode, roomId, refreshDemo, router]);
  const handleEndRoundFromSheet = useCallback(() => {
    setTab('map');
    handleEndRound();
  }, [handleEndRound]);
  const handleResumeSharing = useCallback(() => {
    if (mode !== 'demo') return;
    const current = getRoom(roomId);
    if (!current) return;
    resumePlayer(current, myPlayerId);
    const fix = myFixRef.current;
    if (fix) recordPlayerFix(current, myPlayerId, fix);
    refreshDemo();
  }, [mode, roomId, myPlayerId, refreshDemo]);
  // Stable tab / navigation callbacks — inline arrows here re-rendered
  // the memoized tab bar and buttons on every clock tick.
  const handleTabChange = useCallback((next: BottomTabId) => setTab(next), []);
  const closeMoreSheet = useCallback(() => setTab('map'), []);
  const goCatchQr = useCallback(
    () => router.push(`/room/${roomId}/catch?scan=1`),
    [router, roomId],
  );
  const goCatch = useCallback(() => router.push(`/room/${roomId}/catch`), [router, roomId]);
  const handleToggleMute = useCallback(() => {
    const next = !muted;
    voiceRadio?.setMuted(next);
    setMuted(next);
  }, [muted, voiceRadio]);
  const handleEnableVoice = useCallback(() => {
    // B18: returns the real promise so the radio tab can show
    // "Enabling…" while getUserMedia resolves.
    return voiceRadio?.enable() ?? Promise.resolve(false);
  }, [voiceRadio]);
  const handleSendRadio = useCallback(
    (text: string, kind?: 'quick' | 'text') => sendRadio(text, kind),
    [sendRadio],
  );

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

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col gap-3 px-4 pb-24 pt-3">
      <StatusStrip
        phase={displayPhase}
        config={room.config}
        startedAt={room.startedAt}
        endsAt={room.endsAt}
        paused={effectivePaused}
        pausedAt={safetyState.pausedAt}
        runnersLeft={runnersLeft}
        runnersTotal={runnersTotal}
        nextPingAtMs={nextPingAtMs}
        nextShrinkAtMs={nextShrinkAtMs}
        zoneRadiusM={zoneRadiusM}
        nowMs={nowMs}
        isRunner={isRunner}
      />

      {hostGraceActive ? (
        <p className="rounded-2xl border border-[#26262B] bg-[#141416] p-3 text-[13px] text-[#F59E0B]" role="status">
          Waiting for the host to reconnect…
        </p>
      ) : null}

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

      {/* B10: the map stays MOUNTED across tabs and is only hidden
          with CSS — Map → Radio → Map used to tear the whole map down
          (style fetch + ~1 MB chunk + tiles + fitBounds from scratch).
          A resize fires when the tab comes back (see the tab effect). */}
      <div className={`relative h-[420px] shrink-0 ${tab === 'map' ? '' : 'hidden'}`}>
        <PlayMap
          zoneBoundary={zoneBoundary}
          pings={visiblePings}
          noGoAreas={noGoAreas}
          myFix={myFix}
          // Teammates' live positions (green dots). A spectator sees no
          // live dots, so nothing is passed while spectating.
          teammateFixes={isSpectator ? EMPTY_FIXES : stableTeammateFixes}
          nowMs={mapNowMs}
          resizeNonce={mapResizeNonce}
        />
        <PlayerDots dots={dots} />
        <div className="absolute bottom-3 right-3 z-10 flex flex-col items-center gap-3">
          <PTTButton
            radio={mode === 'live' ? voiceRadio : null}
            pttState={pttState}
            size="large"
            disabled={!canSendRadio}
          />
        </div>
      </div>

      {/* B10: the radio tab stays mounted too — switching tabs used to
          unmount RadioStrip and drop the in-progress draft. */}
      <div className={`min-h-[420px] flex-1 ${tab === 'radio' ? '' : 'hidden'}`}>
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
          muted={muted}
          onToggleMute={handleToggleMute}
          onEnableVoice={handleEnableVoice}
          onSendRadio={handleSendRadio}
        />
      </div>

      {tab === 'map' && isHunter && !isSpectator ? (
        <Button variant="primary" onClick={goCatchQr}>
          Tag a runner
        </Button>
      ) : null}
      {tab === 'map' && isRunner && !isSpectator ? (
        <Button variant="primary" onClick={goCatch}>
          Got Tagged
        </Button>
      ) : null}
      {tab === 'map' && !isHunter && !isRunner ? (
        <p className="text-center text-[13px] text-[#A1A1AA]">
          Roles are drawn at the head start.
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
        onChange={handleTabChange}
      />

      <Sheet open={tab === 'more'} onClose={closeMoreSheet} title="More">
        <div className="flex flex-col gap-4">
          {/* Host only: end the round early (POST …/lifecycle, host-only).
              Host cancel deletes the room (founder decision, 2026-11-21),
              so every player goes home with the one plain message —
              never to results. A match that ends on its own (time up /
              all caught) still goes to results via the terminal effect. */}
          {isHost && (displayPhase === 'HEAD_START' || displayPhase === 'ACTIVE' || displayPhase === 'SAFETY_PAUSED') ? (
            <button
              type="button"
              onClick={handleEndRoundFromSheet}
              className="self-start text-[15px] font-semibold text-[#EF4444]"
            >
              End the round
            </button>
          ) : null}
          {/* Players — the complete roster still in the room, each with
              an Alive / Tagged status. Tagged names its tagger, from the
              same confirmed-catch data as the results page. */}
          <div className="rounded-2xl border border-[#26262B] bg-[#141416] p-4">
            <p className="text-[15px] font-bold text-white">
              Players · {playerStatuses.length}
            </p>
            <ul className="mt-3 flex flex-col gap-3">
              {playerStatuses.map(({ player, taggerName }) => (
                <li
                  key={player.playerId}
                  className="flex items-start justify-between gap-3"
                >
                  <span className="min-w-0 truncate text-[15px] font-semibold text-white">
                    {player.displayName}
                    {player.playerId === myPlayerId ? ' (you)' : ''}
                  </span>
                  {taggerName ? (
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      <span className="rounded-full bg-[#EF4444] px-2 py-0.5 text-[12px] font-bold text-white">
                        Tagged
                      </span>
                      <span className="text-[12px] text-[#A1A1AA]">
                        Tagged by {taggerName}
                      </span>
                    </span>
                  ) : (
                    <span className="shrink-0 rounded-full bg-[#22C55E] px-2 py-0.5 text-[12px] font-bold text-black">
                      Alive
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
          {/* Sound & vibration — haptics + cue tones. Separate state
              from the voice-radio mute: this mutes only cue sounds. */}
          <div className="rounded-2xl border border-[#26262B] bg-[#141416] p-4">
            <p className="text-[15px] font-bold text-white">Sound &amp; vibration</p>
            <div className="mt-3 flex items-center justify-between gap-3">
              <div>
                <p className="text-[15px] font-semibold text-white">
                  Vibration (Android only)
                </p>
                <p className="text-[13px] text-[#A1A1AA]">
                  Buzz on pings, zone warnings and tags. Silent on devices
                  without vibration support.
                </p>
              </div>
              <Toggle
                checked={cueSettings.hapticsEnabled}
                onChange={(checked) => setCueSetting({ hapticsEnabled: checked })}
                label="Vibration (Android only)"
              />
            </div>
            <div className="mt-3 flex items-center justify-between gap-3">
              <div>
                <p className="text-[15px] font-semibold text-white">Cue sounds</p>
                <p className="text-[13px] text-[#A1A1AA]">
                  Short tones for pings, zone warnings and tags. Off by
                  default. This does not mute voice radio.
                </p>
              </div>
              <Toggle
                checked={cueSettings.soundsEnabled}
                onChange={(checked) => setCueSetting({ soundsEnabled: checked })}
                label="Cue sounds"
              />
            </div>
          </div>
          <SafetyControls
            phase={displayPhase}
            paused={effectivePaused}
            pausedByName={pausedByName}
            pausedFrom={demo?.pausedFrom ?? null}
            canPause={displayPhase === 'HEAD_START' || displayPhase === 'ACTIVE' || displayPhase === 'SAFETY_PAUSED'}
            isHost={isHost}
            onPause={handlePause}
            onResume={handleResume}
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
