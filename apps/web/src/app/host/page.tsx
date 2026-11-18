'use client';
import { useEffect, useState } from 'react';
import { listRooms, updateRoomConfig } from '@/lib/demo-store';
import type { DemoRoom } from '@/lib/demo-store';
import { currentZoneBoundary, zoneSizeLabel } from '@/components/match/freshness';
import HostSettingsSheet from '@/components/host-setup/HostSettingsSheet';
import { draftFromConfig, roomSummaryStrip } from '@/components/host-setup/draft';
import type { PlayerView, Room, RoomConfig } from '@pakdam/shared';
import { getWorkerUrl, isLiveTransportEnabled } from '@/lib/websocket';

/** Host dashboard. Hosts see only permitted room state — never hidden
 *  player coordinates. Rooms are listed by room code, not by a place
 *  name — the game starts from the host's location on the map. Each
 *  lobby room shows its live summary strip and a Settings button that
 *  re-opens the same host-setup controls (DONE to save); settings can
 *  only change while the room is still in the lobby.
 *
 *  TWO MODES, never mixed (Worker 2, live wiring 2026-11-17):
 *  - DEMO (default): rooms from the local demo store, as before.
 *  - LIVE (only when NEXT_PUBLIC_WORKER_URL is set): the Worker has no
 *    room-list endpoint, so this page lists only the live rooms saved
 *    on this device (see the reader below — same sessionStorage key
 *    as the lobby page's live-session adapter, and the contract
 *    lib/session-credentials.ts is expected to keep when it lands)
 *    and fetches each one's state over HTTPS
 *    (GET /v1/rooms/:id?playerId=). Settings cannot be changed live —
 *    the server has no config-update endpoint — so the Settings button
 *    says so instead of opening the sheet. Check-ins are not tracked
 *    by the live snapshot, so live cards show no check-in count.
 *    "Open lobby" / "Open game" go to the live-wired pages. */

interface LiveHostRoom {
  roomId: string;
  room: Room;
  players: PlayerView[];
}

/** Minimal live-session reader — duplicated from the lobby page's
 *  adapter (apps/web/src/app/room/[roomId]/page.tsx) so this page does
 *  not import a route file. Both move to lib/session-credentials.ts
 *  when Worker 1 lands it; the storage key is the contract to keep:
 *  sessionStorage['pakdam.live.session.<roomId>']
 *    = JSON { playerId, reconnectToken } */
const LIVE_SESSION_PREFIX = 'pakdam.live.session.';
function loadAllLiveSessions(): { roomId: string; playerId: string; reconnectToken: string }[] {
  if (typeof window === 'undefined') return [];
  const out: { roomId: string; playerId: string; reconnectToken: string }[] = [];
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (!key || !key.startsWith(LIVE_SESSION_PREFIX)) continue;
      const roomId = key.slice(LIVE_SESSION_PREFIX.length);
      const parsed = JSON.parse(sessionStorage.getItem(key) ?? 'null') as { playerId?: unknown; reconnectToken?: unknown } | null;
      if (parsed && typeof parsed.playerId === 'string' && typeof parsed.reconnectToken === 'string') {
        out.push({ roomId, playerId: parsed.playerId, reconnectToken: parsed.reconnectToken });
      }
    }
  } catch {
    return out;
  }
  return out;
}

export default function HostPage() {
  const [mode, setMode] = useState<'live' | 'demo' | null>(null);
  const [rooms, setRooms] = useState<DemoRoom[]>([]);
  const [sheetRoom, setSheetRoom] = useState<DemoRoom | null>(null);
  const [sheetError, setSheetError] = useState('');
  const [liveRooms, setLiveRooms] = useState<LiveHostRoom[]>([]);
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveFailed, setLiveFailed] = useState<string[]>([]);
  const [liveSettingsNote, setLiveSettingsNote] = useState<string | null>(null);

  useEffect(() => {
    setMode(isLiveTransportEnabled() ? 'live' : 'demo');
  }, []);

  useEffect(() => {
    if (mode === 'demo') setRooms(listRooms());
  }, [mode]);

  useEffect(() => {
    if (mode !== 'live') return;
    const url = getWorkerUrl();
    const sessions = loadAllLiveSessions();
    if (!url || sessions.length === 0) { setLiveRooms([]); return; }
    let cancelled = false;
    setLiveLoading(true);
    void (async () => {
      const rows: LiveHostRoom[] = [];
      const failed: string[] = [];
      for (const s of sessions) {
        try {
          // FIX 2026-11-18: the Worker requires the seat's reconnect
          // token (Authorization: Bearer) for GET room state — playerId
          // alone 400s, so every live room silently landed in `failed`.
          const r = await fetch(`${url}/v1/rooms/${s.roomId}?playerId=${encodeURIComponent(s.playerId)}`, {
            headers: { Authorization: `Bearer ${s.reconnectToken}` },
          });
          if (!r.ok) { failed.push(s.roomId); continue; }
          const j = await r.json() as { room: Room; players: PlayerView[]; version: number };
          rows.push({ roomId: s.roomId, room: j.room, players: j.players });
        } catch {
          failed.push(s.roomId);
        }
      }
      if (cancelled) return;
      setLiveRooms(rows);
      setLiveFailed(failed);
      setLiveLoading(false);
    })();
    return () => { cancelled = true; };
  }, [mode]);

  const saveSettings = (roomId: string, next: RoomConfig) => {
    try {
      updateRoomConfig(roomId, next);
      setRooms(listRooms());
      setSheetRoom(null);
      setSheetError('');
    } catch (err) {
      setSheetError(err instanceof Error ? err.message : 'Could not save the settings');
    }
  };

  if (mode === 'live') {
    return (
      <div>
        <h1>Host dashboard</h1>
        <p className="small">Hosts see only permitted room state — never hidden player coordinates. Rooms are listed by room code, not by a place name — the game starts from the host&apos;s location on the map.</p>
        <div className="banner" role="status"><strong>Live</strong> — only live rooms saved on this device are shown (the server has no room-list endpoint). Demo rooms on this device are separate and are not listed here.</div>
        {liveLoading ? <p aria-busy="true">Loading live rooms…</p> : null}
        {!liveLoading && liveRooms.length === 0 ? <p>No live rooms saved on this device yet. Rooms you create or join live will appear here.</p> : null}
        {liveFailed.length > 0 ? <p role="alert">Could not load {liveFailed.length} saved live room(s) — they may have ended or been removed. The rest are shown below.</p> : null}
        {liveRooms.map(({ roomId, room, players }) => (
          <div className="card" key={roomId}>
            <h2>Room {room.roomCode}</h2>
            <p>Phase: {room.phase} · Players: {players.length} · Live</p>
            <p className="small">Zone: {zoneSizeLabel(currentZoneBoundary(room.config.zone, room.startedAt, Date.now()))}</p>
            <p className="small">{roomSummaryStrip(draftFromConfig(room.config))}</p>
            <p>
              <a href={`/room/${roomId}`}>Open lobby</a> · <a href={`/room/${roomId}/play`}>Open game</a>
              {room.phase === 'LOBBY' ? (
                <> · <button type="button" className="btn btn-secondary" onClick={() => setLiveSettingsNote(roomId)}>Settings</button></>
              ) : null}
            </p>
            {liveSettingsNote === roomId ? <p role="status">Settings can’t be changed on the live server yet — they were fixed when the room was created. The live server has no settings-update endpoint.</p> : null}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div>
      <h1>Host dashboard</h1>
      <p className="small">Hosts see only permitted room state — never hidden player coordinates. Rooms are listed by room code, not by a place name — the game starts from the host&apos;s location on the map.</p>
      {mode === 'demo' ? <div className="banner" role="status"><strong>Demo</strong> — rooms stored on this device only, not on a server. Set NEXT_PUBLIC_WORKER_URL at build time to see live rooms.</div> : null}
      {rooms.length === 0 ? <p>No rooms yet. <a href="/create">Create one</a>.</p> : null}
      {rooms.map((dr) => (
        <div className="card" key={dr.room.roomId}>
          <h2>Room {dr.room.roomCode}</h2>
          <p>Phase: {dr.room.phase} · Players: {dr.players.length} · Check-ins: {dr.checkins.length}</p>
          <p className="small">Zone: {zoneSizeLabel(currentZoneBoundary(dr.room.config.zone, dr.room.startedAt, Date.now()))}</p>
          <p className="small">{roomSummaryStrip(draftFromConfig(dr.room.config))}</p>
          <p>
            <a href={`/room/${dr.room.roomId}`}>Open lobby</a> · <a href={`/room/${dr.room.roomId}/play`}>Open game</a>
            {dr.room.phase === 'LOBBY' ? (
              <> · <button type="button" className="btn btn-secondary" onClick={() => { setSheetRoom(dr); setSheetError(''); }}>Settings</button></>
            ) : null}
          </p>
        </div>
      ))}
      {sheetError ? <p role="alert">{sheetError}</p> : null}
      {sheetRoom ? (
        <HostSettingsSheet
          open
          config={sheetRoom.room.config}
          onDone={(next) => saveSettings(sheetRoom.room.roomId, next)}
          onClose={() => setSheetRoom(null)}
        />
      ) : null}
    </div>
  );
}
