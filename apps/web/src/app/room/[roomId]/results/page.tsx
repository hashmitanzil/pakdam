'use client';
import { use, useEffect, useRef, useState } from 'react';
import { getRoom, currentPlayerId, setCurrentPlayerId, leaveRoom } from '@/lib/demo-store';
import { createLivePakdamSocket, getWorkerUrl, type PakdamSocket, type PakdamSocketState } from '@/lib/websocket';
import AllSafeCheck from '@/components/match/AllSafeCheck';
import RoundCard from '@/components/match/RoundCard';
import TrailCard from '@/components/hud/TrailCard';
import { pingAgeLabel } from '@/components/match/freshness';
import { describeMode, modeTurnsRunner } from '@pakdam/engine';
import { teamAssignmentLabel } from '@/components/match/ModeZonePanel';
import type { DemoRoom } from '@/lib/demo-store';
import type { Player, PlayerView, Room, WsSnapshotPayload } from '@pakdam/shared';

/** --- LIVE ADAPTER (local to this file) ---
 *  `lib/live-client.ts` and `lib/session-credentials.ts` do not exist
 *  yet, so this page defines the minimal seat lookup it needs and
 *  nothing more — no new lib files were created. Same contract as the
 *  catch page: the create/join wiring must store
 *    sessionStorage.setItem(`pakdam.seat:${roomId}`,
 *      JSON.stringify({ playerId, reconnectToken }))
 *  The raw reconnect token is never logged, never put in a URL, and
 *  lives only in this tab's sessionStorage.
 *
 *  LIVE SOURCE: `GET {NEXT_PUBLIC_WORKER_URL}/v1/rooms/{roomId}?playerId=…`
 *  (the Worker's `get-state` route → the DO's `get-state` op →
 *  `authorisedSnapshot`: { room, players, version }). That REST fetch
 *  is the primary post-match source — it works even after the match
 *  ended and the socket closed. The live socket is opened too, so a
 *  snapshot arriving while the match is still completing updates the
 *  page; either source feeds the same view.
 *
 *  LIVE LIMITS (server snapshot rules, 17 §3.3): the snapshot carries
 *  NO confirmed-catch list, NO per-Hunter tag counts, NO event
 *  timeline, and NO disputed catches — so Most tags, First catch, the
 *  recap timeline and disputed counts are NOT shown live, and the page
 *  says so instead of inventing them. What IS authoritative live:
 *  `room.result` (outcome, caughtRunnerIds, survivingRunnerIds,
 *  durationSeconds) and each player's `ejectedAt`. Other players'
 *  match roles are hidden by the server (role secrecy), so caught /
 *  survivor membership comes from `room.result` only, never from
 *  roles. A clean sweep cannot be confirmed live when any player was
 *  ejected, because an ejected player may have been a Runner — the
 *  page says that instead of guessing.
 *
 *  PLAY AGAIN (live): POST {NEXT_PUBLIC_WORKER_URL}/v1/rooms with
 *  { displayName, kind: 'guest', config, ageGatePassed: true } —
 *  the previous room's config is reused, so the new game has the same
 *  rules. Success (201) returns { roomId, roomCode, hostPlayerId,
 *  reconnectToken }; the seat is saved under `pakdam.seat:<roomId>`
 *  and the player goes to the new room's lobby. This is a NEW room,
 *  not a rematch — one-tap rematch is P1 (HNT-031). */
interface LiveSeat { playerId: string; reconnectToken: string }
const seatKey = (roomId: string): string => `pakdam.seat:${roomId}`;
function readLiveSeat(roomId: string): LiveSeat | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    const raw = sessionStorage.getItem(seatKey(roomId));
    if (!raw) return null;
    const j = JSON.parse(raw) as Partial<LiveSeat>;
    if (typeof j.playerId === 'string' && typeof j.reconnectToken === 'string') {
      return { playerId: j.playerId, reconnectToken: j.reconnectToken };
    }
    return null;
  } catch { return null; }
}
function saveLiveSeat(roomId: string, seat: LiveSeat): void {
  sessionStorage.setItem(seatKey(roomId), JSON.stringify(seat));
}
interface LiveStateResponse { room: Room; players: PlayerView[]; version: number }
async function fetchLiveState(apiUrl: string, roomId: string, playerId: string): Promise<LiveStateResponse> {
  const r = await fetch(`${apiUrl}/v1/rooms/${roomId}?playerId=${encodeURIComponent(playerId)}`);
  if (!r.ok) {
    if (r.status === 404) throw new Error('The live room was not found, or this device is not a player in it (404).');
    throw new Error(`Live results are unavailable (${r.status}) — check your connection and try again.`);
  }
  return r.json() as Promise<LiveStateResponse>;
}

/** Results recap (23 §10, 24 S07): outcome, timeline of non-sensitive
 *  events, standout awards computed from the data, end-of-round reveal,
 *  all-safe check, Leave / Back to home / Create a new game.
 *  NO rematch button — HNT-031 is P1. No route history is kept or shown.
 *  Location data is deleted at match end — the recap shows moments and
 *  counts only, never positions or trails. */
export default function ResultsPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = use(params);
  const [dr, setDr] = useState<DemoRoom | null>(null);
  const [loadError, setLoadError] = useState('');
  const [offline, setOffline] = useState(false);
  // --- live state (used only when NEXT_PUBLIC_WORKER_URL is set) ---
  const [liveMode, setLiveMode] = useState<boolean | null>(null);
  const [seat, setSeat] = useState<LiveSeat | null>(null);
  const [liveRoom, setLiveRoom] = useState<Room | null>(null);
  const [livePlayers, setLivePlayers] = useState<PlayerView[]>([]);
  const [liveError, setLiveError] = useState('');
  const [conn, setConn] = useState<PakdamSocketState>('idle');
  const [connDetail, setConnDetail] = useState('');
  const [creating, setCreating] = useState(false);
  const [actionMsg, setActionMsg] = useState('');
  const socketRef = useRef<PakdamSocket | null>(null);

  // Decide the mode once: Worker URL set → live only, never the demo
  // store; unset → demo only. The two are never mixed.
  useEffect(() => {
    const live = getWorkerUrl() !== null;
    setLiveMode(live);
    setOffline(typeof navigator !== 'undefined' && !navigator.onLine);
    if (live) {
      const s = readLiveSeat(roomId);
      setSeat(s);
      if (!s) {
        // No seat credential: the REST state fetch needs a playerId
        // that is a seat in this room. The demo player id is not a
        // live seat, so fall back to it only to attempt the fetch —
        // a 404 then says plainly the device is not a player here.
        const fallback = currentPlayerId();
        if (!fallback) setLiveError('This room is live, but this device has no seat for it — the reconnect credential was not saved when you joined. Rejoin the room from the invite link.');
      }
    }
  }, [roomId]);

  // Demo load — demo mode only.
  useEffect(() => {
    if (liveMode !== false) return;
    try { setDr(getRoom(roomId)); } catch { setLoadError('Could not load results — try again.'); }
  }, [roomId, liveMode]);

  // Live: REST state first (authoritative even after the socket
  // closed at match end), then the socket for live updates.
  const playerIdForFetch = seat?.playerId ?? currentPlayerId();
  useEffect(() => {
    if (liveMode !== true || !playerIdForFetch) return;
    const apiUrl = getWorkerUrl();
    if (!apiUrl) return;
    let cancelled = false;
    void fetchLiveState(apiUrl, roomId, playerIdForFetch)
      .then((s) => { if (!cancelled) { setLiveRoom(s.room); setLivePlayers(s.players); setLiveError(''); } })
      .catch((e: unknown) => { if (!cancelled) setLiveError(e instanceof Error ? e.message : 'Live results are unavailable.'); });
    return () => { cancelled = true; };
  }, [roomId, liveMode, playerIdForFetch]);

  useEffect(() => {
    if (liveMode !== true || !seat) return;
    const socket = createLivePakdamSocket({ roomId, playerId: seat.playerId, reconnectToken: seat.reconnectToken });
    if (!socket) return;
    socketRef.current = socket;
    void socket.connect(roomId, {
      playerId: seat.playerId,
      onSnapshot: (s: WsSnapshotPayload) => { setLiveRoom(s.room); setLivePlayers(s.players); setLiveError(''); },
      onMessage: (m) => {
        if (m.type === 'match.completed' || m.type === 'match.cancelled' || m.type === 'room.state') socket.requestSnapshot();
        if (m.type === 'error') setActionMsg(`Server: ${(m.payload as { message?: string }).message ?? 'the server rejected the last action.'}`);
      },
      onStateChange: (state, detail) => { setConn(state); setConnDetail(detail ?? ''); },
    }).catch(() => {
      // The REST fetch above already carries the results; a failed
      // socket only means no live updates, so this is a note, not a
      // blocking error.
      setConnDetail('live updates unavailable — results below are from the last server snapshot');
    });
    return () => { socket.close(); socketRef.current = null; };
  }, [roomId, liveMode, seat]);

  const me = liveMode ? seat?.playerId ?? currentPlayerId() : currentPlayerId();

  if (liveMode === null) return <div aria-busy="true"><h1>Reconciling the match…</h1><div className="skeleton skeleton-lg" aria-hidden="true" /><p>Results skeleton — the outcome appears once the match state loads.</p></div>;
  if (liveMode && liveError && !liveRoom) return <div><h1>Results</h1><p role="alert">{liveError}</p><p><button className="btn" onClick={() => window.location.reload()}>Retry</button></p><p><a className="btn btn-secondary" href="/">Back to home</a></p></div>;
  if (liveMode && !liveRoom) return <div aria-busy="true"><h1>Reconciling the match…</h1><div className="skeleton skeleton-lg" aria-hidden="true" /><p>Live room — fetching the final state from the server.</p></div>;
  if (!liveMode && loadError) return <div><h1>Results</h1><p role="alert">{loadError}</p><p><button className="btn" onClick={() => { setLoadError(''); setDr(getRoom(roomId)); }}>Retry</button></p></div>;
  if (!liveMode && !dr) return <div aria-busy="true"><h1>Reconciling the match…</h1><div className="skeleton skeleton-lg" aria-hidden="true" /><div className="skeleton" style={{ width: '70%' }} aria-hidden="true" /><div className="skeleton" style={{ width: '45%' }} aria-hidden="true" /><p>Results skeleton — the outcome appears once the match state loads.</p></div>;

  // --- live view (from the server snapshot) or demo view. Never both. ---
  if (liveMode && liveRoom) {
    return <LiveResults room={liveRoom} players={livePlayers} me={me} conn={conn} connDetail={connDetail} creating={creating} setCreating={setCreating} actionMsg={actionMsg} setActionMsg={setActionMsg} socketRef={socketRef} />;
  }
  if (!dr) return <div><h1>Results</h1><p role="alert">Could not load results.</p></div>;
  return <DemoResults dr={dr} me={me} offline={offline} roomId={roomId} />;
}

function LiveResults({ room, players, me, conn, connDetail, creating, setCreating, actionMsg, setActionMsg, socketRef }: {
  room: Room; players: PlayerView[]; me: string | null;
  conn: PakdamSocketState; connDetail: string;
  creating: boolean; setCreating: (b: boolean) => void;
  actionMsg: string; setActionMsg: (s: string) => void;
  socketRef: React.RefObject<PakdamSocket | null>;
}) {
  const result = room.result;
  const nameOf = (id: string): string => players.find((p) => p.playerId === id)?.displayName ?? 'Unknown player';
  const caughtIds = result?.caughtRunnerIds ?? [];
  const survivorIds = result?.survivingRunnerIds ?? [];
  const survivors = survivorIds.map(nameOf);
  const ejectedPlayers = players.filter((p) => p.ejectedAt);
  const totalRunners = caughtIds.length + survivorIds.length;
  const outcome = result?.outcome ?? (room.phase === 'COMPLETED' ? 'no-result' : 'in progress');
  const outcomeLabel = outcome === 'hunters-win' ? 'Hunters win' : outcome === 'runners-win' ? 'Runners win' : outcome === 'cancelled' ? 'Match cancelled' : outcome === 'abandoned' ? 'Match abandoned' : outcome === 'no-result' ? 'Match over — no result recorded' : 'Match in progress';
  const durationLabel = result?.durationSeconds ? `${Math.round(result.durationSeconds / 60)} min` : 'not recorded';
  const caughtPct = totalRunners > 0 ? Math.round((caughtIds.length / totalRunners) * 100) : 0;
  const turns = modeTurnsRunner(room.config.mode);
  const caughtWord = turns ? 'Turned' : 'Caught';
  // Clean sweep needs every Runner CAUGHT — but an ejected player may
  // have been a Runner (roles are hidden), so it cannot be confirmed
  // live while anyone was ejected.
  const cleanSweep = survivorIds.length === 0 && caughtIds.length > 0 && ejectedPlayers.length === 0;
  const cleanSweepUnknown = survivorIds.length === 0 && caughtIds.length > 0 && ejectedPlayers.length > 0;
  const selectedHunterNames = room.config.selectedHunterIds.map((id) => nameOf(id));
  const mePlayer = players.find((p) => p.playerId === me);

  const roundCardText = [
    'PAKDAM — round recap',
    `${outcomeLabel} · Room ${room.roomCode}`,
    `${turns ? 'Turned Runners' : 'Caught Runners'}: ${caughtIds.length} of ${totalRunners} · Survivors: ${survivors.join(', ') || 'none'}${ejectedPlayers.length > 0 ? ` · Ejected: ${ejectedPlayers.map((e) => e.displayName).join(', ')}` : ''}`,
    `Confirmed catches: ${caughtIds.length}`,
    `${survivors.length > 0 ? `Never caught: ${survivors.join(', ')}` : 'Never caught: nobody — every Runner was caught'}`,
    `${cleanSweep ? 'Clean sweep — every Runner caught' : cleanSweepUnknown ? 'Clean sweep: cannot confirm — an ejected player may have been a Runner' : 'No clean sweep this round'}`,
    `Duration: ${durationLabel}`,
    'No locations or routes are shared — locations are deleted at match end.',
  ].join('\n');

  const trailCardText = [
    'PAKDAM — trail card',
    `${outcomeLabel} · ${describeMode(room.config.mode).label} · Room ${room.roomCode}`,
    `${players.length} players · Duration: ${durationLabel}`,
    `${caughtWord}: ${caughtIds.length} of ${totalRunners} Runners · Still free: ${survivorIds.length}${ejectedPlayers.length > 0 ? ` · Ejected: ${ejectedPlayers.length}` : ''}`,
    'Most tags: not shown live — the server snapshot does not include per-Hunter tag counts',
    `${survivors.length > 0 ? `Never caught: ${survivors.join(', ')}` : 'Never caught: nobody'}`,
    `${cleanSweep ? 'Clean sweep — every Runner caught' : ''}`,
    'No locations or routes — location data is deleted at match end.',
  ].filter((l) => l !== '').join('\n');

  /** New live room with the same rules (a new game, not a rematch).
   *  The seat from the 201 response is saved before navigating, so
   *  the lobby opens already joined as host. */
  const playAgainLive = async () => {
    const apiUrl = getWorkerUrl();
    if (!apiUrl || creating) return;
    setCreating(true);
    setActionMsg('');
    try {
      const r = await fetch(`${apiUrl}/v1/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: (mePlayer?.displayName ?? 'Host').slice(0, 30), kind: 'guest', config: room.config, ageGatePassed: true }),
      });
      if (!r.ok) throw new Error(`Could not create a new live room (${r.status}).`);
      const j = await r.json() as { roomId?: unknown; hostPlayerId?: unknown; reconnectToken?: unknown };
      if (typeof j.roomId !== 'string' || typeof j.hostPlayerId !== 'string' || typeof j.reconnectToken !== 'string') {
        throw new Error('The server answered without a new room to join.');
      }
      saveLiveSeat(j.roomId, { playerId: j.hostPlayerId, reconnectToken: j.reconnectToken });
      setCurrentPlayerId(j.hostPlayerId);
      window.location.href = `/room/${j.roomId}`;
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : 'Could not create a new live room.');
    } finally {
      setCreating(false);
    }
  };
  const leaveLive = () => {
    if (!window.confirm('Leave now? Your results stay recorded for this match, but you will leave the room.')) return;
    const sock = socketRef.current;
    if (sock && sock.getState() === 'connected') sock.sendCommand('leave', { reason: null });
    window.location.href = '/';
  };


  return (
    <div>
      <div style={{ background: '#7A1212', color: '#fff', borderRadius: 12, padding: '16px', margin: '12px 0' }}>
        <h1 style={{ margin: '0 0 4px', color: '#fff' }}>{outcomeLabel}</h1>
        <p style={{ margin: 0, opacity: 0.92 }}>Room {room.roomCode} · {players.length} players · Duration: {durationLabel}</p>
      </div>
      <p className="small">Live results — from the server snapshot. {conn === 'connected' ? 'Connected — updates arrive live.' : conn === 'connecting' || conn === 'reconnecting' ? 'Live updates reconnecting — these results are from the last server snapshot.' : connDetail ? `${connDetail}.` : 'Live updates are not connected — these results are from the last server snapshot.'}</p>
      <p>Mode: {describeMode(room.config.mode).label} · {teamAssignmentLabel(room.config.teamAssignment)}{room.config.teamAssignment === 'selected' ? ` — the host picked the Hunters: ${selectedHunterNames.join(', ') || 'none picked'}` : room.config.teamAssignment === 'random' ? ' — Hunters were drawn at random when the game started' : ''}. {turns ? 'In this mode, confirmed catches flipped Runners to Hunters.' : 'In this mode, a confirmed catch took the Runner out.'}</p>
      {!result ? <div className="banner" role="status"><strong>No result recorded yet.</strong> The server has not recorded a final result for this room — the outcome above is not final until it does.</div> : null}

      <section aria-label="Scoreboard" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '12px 0' }}>
        <div className="score-card">
          <div style={{ fontSize: 28, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{caughtIds.length}</div>
          <div className="score-label">{caughtWord}</div>
        </div>
        <div className="score-card">
          <div style={{ fontSize: 28, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{survivorIds.length}</div>
          <div className="score-label">Still free</div>
        </div>
        <div className="score-card">
          <div style={{ fontSize: 28, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{caughtIds.length}</div>
          <div className="score-label">Confirmed catches</div>
        </div>
      </section>
      <p>Outcome: <strong>{outcomeLabel}</strong></p>
      <p>{caughtWord} Runners: {caughtIds.length} · Surviving Runners: {survivors.join(', ') || 'none'}</p>
      {ejectedPlayers.length > 0 ? <p><strong>Ejected:</strong> {ejectedPlayers.map((p) => `${p.displayName} — outside the play zone for 30 seconds`).join(', ')}</p> : null}
      <div role="progressbar" aria-valuenow={caughtPct} aria-valuemin={0} aria-valuemax={100} aria-label={`${caughtIds.length} of ${totalRunners} Runners ${turns ? 'turned' : 'caught'}`} style={{ height: 12, borderRadius: 999, background: '#E8CFCF', overflow: 'hidden' }}>
        <div style={{ width: `${caughtPct}%`, height: '100%', background: '#B91C1C' }} />
      </div>
      <p className="small">Duration: {durationLabel}. No routes or coordinate trails are kept (HNT-069). One-tap rematch is P1 (HNT-031) — not in Phase 0, so no rematch button is shown. Locations are deleted at match end.</p>

      <section className="card" aria-label="Recap timeline">
        <h2>Recap timeline</h2>
        <p><strong>No per-catch timeline is shown live.</strong> The server snapshot carries no event timeline — only the match start and end below. Nothing is invented here.</p>
        <ol style={{ paddingLeft: 20 }}>
          {room.startedAt ? <li style={{ padding: '6px 0', borderBottom: '1px solid #E8CFCF' }}><strong>{new Date(room.startedAt).toLocaleTimeString()}</strong> — match started</li> : null}
          {room.endsAt ? <li style={{ padding: '6px 0', borderBottom: '1px solid #E8CFCF' }}><strong>{new Date(room.endsAt).toLocaleTimeString()}</strong> — match ended</li> : <li style={{ padding: '6px 0' }}>Match end time not recorded yet.</li>}
        </ol>
        <p className="small">Only non-sensitive events are shown: catches, zone shrinks and pauses. No locations, no routes.</p>
      </section>

      <section className="card" aria-label="Standout players">
        <h2>Standout players</h2>
        <ul>
          <li><strong>Most tags:</strong> Not shown live — the server snapshot does not include confirmed catches or per-Hunter tag counts.</li>
          <li><strong>Never caught:</strong> {survivors.length > 0 ? `${survivors.join(', ')} — never caught in this match` : 'Nobody — every Runner was caught.'}</li>
          <li><strong>Clean sweep:</strong> {cleanSweep ? `Yes — every Runner was ${turns ? 'turned' : 'caught'}. Awarded to the Hunters as a team.` : cleanSweepUnknown ? 'Cannot confirm — an ejected player may have been a Runner, and the server hides other players’ roles.' : 'No — at least one Runner survived.'}</li>
          <li><strong>Longest survivor / last Runner standing:</strong> {survivorIds.length === 1 ? `${survivors[0]} — the only Runner still free` : survivorIds.length > 1 ? `${survivors.join(', ')} — still free when the match ended` : 'No Runner survived — every Runner was caught.'}</li>
          <li><strong>First catch:</strong> Not shown live — the server snapshot carries no catch times.</li>
          {ejectedPlayers.length > 0 ? <li><strong>Ejected:</strong> {ejectedPlayers.map((p) => p.displayName).join(', ')} — outside the play zone for 30 seconds. Ejected players are out, never survivors and never “caught”.</li> : null}
        </ul>
        <p className="small">Awards are computed from the server’s final result for this match only. No other stats are claimed.</p>
      </section>

      <section className="card" aria-label="End-of-round reveal">
        <h2>Reveal — where Runners were hiding</h2>
        <p><strong>No hiding positions were recorded.</strong> No coordinates are kept after the match (HNT-068/069), so there is nothing to reveal — and nothing is invented here.</p>
      </section>

      <RoundCard text={roundCardText} />

      <TrailCard text={trailCardText} />

      {/* AllSafeCheck only reads playerId and displayName; the live
          PlayerView has both. The reconnect-token hash is never
          fabricated to satisfy the Player type — the cast below is
          that statement, not a data claim. */}
      <AllSafeCheck players={players as unknown as Player[]} meId={me} />

      {/* One primary action first, then the exits: the thing most
          players want after results is another game, not leaving. */}
      <p>
        <button type="button" className="btn" disabled={creating} onClick={() => void playAgainLive()}>{creating ? 'Creating your new game…' : 'Play again — start a fresh game'}</button>{' '}
        <a className="btn btn-secondary" href="/">Back to home</a>{' '}
        <button type="button" className="btn btn-secondary" onClick={leaveLive}>Leave</button>
      </p>
      {actionMsg ? <p role="status">{actionMsg}</p> : null}
      <p className="small">“Play again” creates a new live room with the same rules — one-tap rematch is P1 (HNT-031), so there is no rematch button here. “Leave” tells the live room you left, then takes you home.</p>
    </div>
  );
}

function DemoResults({ dr, me, offline, roomId }: { dr: DemoRoom; me: string | null; offline: boolean; roomId: string }) {
  const confirmed = dr.catches.filter((c) => c.state === 'confirmed');
  const caught = confirmed.map((c) => c.runnerPlayerId);
  const runners = dr.players.filter((p) => p.matchRole === 'runner');
  const hunters = dr.players.filter((p) => p.matchRole === 'hunter');
  // Survivors are Runners still free: neither caught nor ejected. An
  // ejected Runner is out of play — never a survivor, never "caught".
  const survivors = runners.filter((r) => !caught.includes(r.playerId) && !r.ejectedAt);
  const ejectedRunners = runners.filter((r) => r.ejectedAt);
  const ejectedPlayers = dr.players.filter((p) => p.ejectedAt);
  const disputed = dr.catches.filter((c) => c.state === 'disputed');
  const outcome = dr.room.result?.outcome ?? (runners.length > 0 && survivors.length === 0 ? 'hunters-win' : dr.room.phase === 'COMPLETED' ? 'runners-win' : 'in progress');
  const outcomeLabel = outcome === 'hunters-win' ? 'Hunters win' : outcome === 'runners-win' ? 'Runners win' : outcome === 'cancelled' ? 'Match cancelled' : outcome === 'abandoned' ? 'Match abandoned' : 'Match in progress';
  // Timeline: non-sensitive events only — catches, ejections, zone shrinks, pauses.
  // Join/leave and check-in lines are match administration, not recap moments.
  const timeline = dr.events.filter((e) => /catch|eject|zone|shrink|paus|resum|sos|safe/i.test(e.text));
  // Awards computed from the data — no invented stats.
  const catchCounts = new Map<string, number>();
  for (const c of confirmed) catchCounts.set(c.hunterPlayerId, (catchCounts.get(c.hunterPlayerId) ?? 0) + 1);
  const topHunterEntry = [...catchCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  const topHunter = topHunterEntry ? dr.players.find((p) => p.playerId === topHunterEntry[0]) : null;
  const firstCatch = [...confirmed].sort((a, b) => new Date(a.requestedAt).getTime() - new Date(b.requestedAt).getTime())[0];
  const firstCaughtRunner = firstCatch ? runners.find((r) => r.playerId === firstCatch.runnerPlayerId) : null;
  const firstCatchHunter = firstCatch ? hunters.find((h) => h.playerId === firstCatch.hunterPlayerId) : null;
  const durationLabel = dr.room.result?.durationSeconds ? `${Math.round(dr.room.result.durationSeconds / 60)} min` : 'not recorded';
  const caughtPct = runners.length > 0 ? Math.round((caught.length / runners.length) * 100) : 0;
  const turns = modeTurnsRunner(dr.room.config.mode);
  const caughtWord = turns ? 'Turned' : 'Caught';
  // Awards, computed from real data only — never invented.
  // A clean sweep needs every Runner CAUGHT: ejected Runners are out,
  // not caught, so they break the sweep.
  const cleanSweep = runners.length > 0 && survivors.length === 0 && ejectedRunners.length === 0;
  const neverCaught = survivors.map((s) => s.displayName);
  const selectedHunterNames = dr.room.config.selectedHunterIds.map((id) => dr.players.find((p) => p.playerId === id)?.displayName ?? 'Unknown player');

  const roundCardText = [
    'PAKDAM — round recap',
    `${outcomeLabel} · Room ${dr.room.roomCode}`,
    `${turns ? 'Turned Runners' : 'Caught Runners'}: ${caught.length} of ${runners.length} · Survivors: ${survivors.map((s) => s.displayName).join(', ') || 'none'}${ejectedRunners.length > 0 ? ` · Ejected: ${ejectedRunners.map((e) => e.displayName).join(', ')}` : ''}`,
    `Confirmed catches: ${confirmed.length}${topHunter && topHunterEntry ? ` · Most tags: ${topHunter.displayName} (${topHunterEntry[1]})` : ''}`,
    `${neverCaught.length > 0 ? `Never caught: ${neverCaught.join(', ')}` : 'Never caught: nobody — every Runner was caught'}`,
    `${cleanSweep ? 'Clean sweep — every Runner caught' : 'No clean sweep this round'}`,
    `Duration: ${durationLabel}`,
    'No locations or routes are shared — locations are deleted at match end.',
  ].join('\n');

  // Trail card (Worker 3): a shareable round summary, local only. No
  // route is stored or shown — the demo keeps no coordinates after the
  // match — so the "trail" is moments and counts, never a path.
  const trailCardText = [
    'PAKDAM — trail card',
    `${outcomeLabel} · ${describeMode(dr.room.config.mode).label} · Room ${dr.room.roomCode}`,
    `${dr.players.length} players · Duration: ${durationLabel}`,
    `${caughtWord}: ${caught.length} of ${runners.length} Runners · Still free: ${survivors.length}${ejectedRunners.length > 0 ? ` · Ejected: ${ejectedRunners.length}` : ''}`,
    `${topHunter && topHunterEntry ? `Most tags: ${topHunter.displayName} (${topHunterEntry[1]})` : 'Most tags: none'}`,
    `${neverCaught.length > 0 ? `Never caught: ${neverCaught.join(', ')}` : 'Never caught: nobody'}`,
    `${cleanSweep ? 'Clean sweep — every Runner caught' : ''}`,
    'No locations or routes — location data is deleted at match end.',
  ].filter((l) => l !== '').join('\n');


  return (
    <div>
      <div style={{ background: '#7A1212', color: '#fff', borderRadius: 12, padding: '16px', margin: '12px 0' }}>
        <h1 style={{ margin: '0 0 4px', color: '#fff' }}>{outcomeLabel}</h1>
        <p style={{ margin: 0, opacity: 0.92 }}>Room {dr.room.roomCode} · {dr.players.length} players · Duration: {durationLabel}</p>
      </div>
      <p className="small">Demo results — local only, not a live game.</p>
      <p>Mode: {describeMode(dr.room.config.mode).label} · {teamAssignmentLabel(dr.room.config.teamAssignment)}{dr.room.config.teamAssignment === 'selected' ? ` — the host picked the Hunters: ${selectedHunterNames.join(', ') || 'none picked'}` : dr.room.config.teamAssignment === 'random' ? ' — Hunters were drawn at random when the game started' : ''}. {turns ? 'In this mode, confirmed catches flipped Runners to Hunters.' : 'In this mode, a confirmed catch took the Runner out.'}</p>
      {offline ? <div className="banner" role="status"><strong>Results from the last load — reconnect to confirm.</strong> These results are cached and are not presented as final while offline.</div> : null}
      {disputed.length > 0 ? <div className="banner" role="status"><strong>Result pending dispute review.</strong> {disputed.length} disputed catch{disputed.length === 1 ? '' : 'es'} await{disputed.length === 1 ? 's' : ''} host review — the outcome above is not final until they are resolved.</div> : null}

      <section aria-label="Scoreboard" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '12px 0' }}>
        <div className="score-card">
          <div style={{ fontSize: 28, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{caught.length}</div>
          <div className="score-label">{caughtWord}</div>
        </div>
        <div className="score-card">
          <div style={{ fontSize: 28, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{survivors.length}</div>
          <div className="score-label">Still free</div>
        </div>
        <div className="score-card">
          <div style={{ fontSize: 28, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{confirmed.length}</div>
          <div className="score-label">Confirmed catches</div>
        </div>
      </section>
      <p>Outcome: <strong>{outcomeLabel}</strong></p>
      <p>{caughtWord} Runners: {caught.length} · Surviving Runners: {survivors.map((s) => s.displayName).join(', ') || 'none'}</p>
      {ejectedPlayers.length > 0 ? <p><strong>Ejected:</strong> {ejectedPlayers.map((p) => `${p.displayName} (${p.matchRole ?? 'no role'} — outside the play zone for 30 seconds)`).join(', ')}</p> : null}
      <div role="progressbar" aria-valuenow={caughtPct} aria-valuemin={0} aria-valuemax={100} aria-label={`${caught.length} of ${runners.length} Runners ${turns ? 'turned' : 'caught'}`} style={{ height: 12, borderRadius: 999, background: '#E8CFCF', overflow: 'hidden' }}>
        <div style={{ width: `${caughtPct}%`, height: '100%', background: '#B91C1C' }} />
      </div>
      <p className="small">Duration: {durationLabel}. No routes or coordinate trails are kept (HNT-069). One-tap rematch is P1 (HNT-031) — not in Phase 0, so no rematch button is shown. Locations are deleted at match end.</p>

      <section className="card" aria-label="Recap timeline">
        <h2>Recap timeline</h2>
        {timeline.length === 0 ? <p>No key moments were recorded — the match may have been cancelled before it started.</p> : (
          <ol style={{ paddingLeft: 20 }}>{timeline.map((e, i) => (
            <li key={i} style={{ padding: '6px 0', borderBottom: '1px solid #E8CFCF' }}>
              <strong>{new Date(e.at).toLocaleTimeString()}</strong> · {pingAgeLabel(e.at)} — {e.text}
            </li>
          ))}</ol>
        )}
        <p className="small">Only non-sensitive events are shown: catches, zone shrinks and pauses. No locations, no routes.</p>
      </section>

      <section className="card" aria-label="Standout players">
        <h2>Standout players</h2>
        <ul>
          <li><strong>Most tags:</strong> {topHunter ? `${topHunter.displayName} — ${topHunterEntry?.[1]} confirmed tag${topHunterEntry?.[1] === 1 ? '' : 's'}` : 'No confirmed catches in this match.'}</li>
          <li><strong>Never caught:</strong> {neverCaught.length > 0 ? `${neverCaught.join(', ')} — never caught in this match` : 'Nobody — every Runner was caught.'}</li>
          <li><strong>Clean sweep:</strong> {cleanSweep ? `Yes — every Runner was ${turns ? 'turned' : 'caught'}. Awarded to the Hunters as a team${topHunter ? `, led by ${topHunter.displayName}` : ''}.` : 'No — at least one Runner survived.'}</li>
          <li><strong>Longest survivor / last Runner standing:</strong> {survivors.length === 1 ? `${survivors[0]?.displayName} — the only Runner still free` : survivors.length > 1 ? `${survivors.map((s) => s.displayName).join(', ')} — still free when the match ended` : 'No Runner survived — every Runner was caught.'}</li>
          <li><strong>First catch:</strong> {firstCatch && firstCaughtRunner ? `${firstCatchHunter?.displayName ?? 'A Hunter'} caught ${firstCaughtRunner.displayName} at ${new Date(firstCatch.requestedAt).toLocaleTimeString()}` : 'No confirmed catches in this match.'}</li>
          {ejectedPlayers.length > 0 ? <li><strong>Ejected:</strong> {ejectedPlayers.map((p) => p.displayName).join(', ')} — outside the play zone for 30 seconds. Ejected players are out, never survivors and never “caught”.</li> : null}
          {disputed.length > 0 ? <li><strong>Disputed catches:</strong> {disputed.length} — awaiting host review.</li> : null}
        </ul>
        <p className="small">Awards are computed from confirmed catches and survivors in this match only. No other stats are claimed.</p>
      </section>

      <section className="card" aria-label="End-of-round reveal">
        <h2>Reveal — where Runners were hiding</h2>
        <p><strong>No hiding positions were recorded.</strong> No coordinates are kept after the match (HNT-068/069), so there is nothing to reveal — and nothing is invented here.</p>
      </section>

      <RoundCard text={roundCardText} />

      <TrailCard text={trailCardText} />

      <AllSafeCheck players={dr.players} meId={me} />

      {/* One primary action first, then the exits: the thing most
          players want after results is another game, not leaving. */}
      <p>
        <a className="btn" href="/create">Play again — start a fresh game</a>{' '}
        <a className="btn btn-secondary" href="/">Back to home</a>{' '}
        <button type="button" className="btn btn-secondary" onClick={() => { if (!window.confirm('Leave now? Your results stay recorded for this match, but you will leave the room.')) return; if (me) leaveRoom(roomId, me); window.location.href = '/'; }}>Leave</button>
      </p>
      <p className="small">“Play again” starts a fresh host setup — one-tap rematch is P1 (HNT-031), so there is no rematch button here.</p>
    </div>
  );
}
