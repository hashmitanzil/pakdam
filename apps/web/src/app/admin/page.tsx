'use client';
import { useEffect, useState } from 'react';
import { listRooms } from '@/lib/demo-store';
import type { DemoRoom } from '@/lib/demo-store';
import { getWorkerUrl } from '@/lib/websocket';
import type { OfflineQueueItem } from '@/lib/offline-queue';
import type { GrievanceRecord } from '@/app/grievance/page';

/** P0 platform admin: safety / grievance / incident / bug queues ONLY.
 *  Super-admin is a SEPARATE staff surface (separate app/deployment,
 *  MFA, server-enforced permissions) — NOT this page and NOT a hidden
 *  local queue view over data on this device. No live location is shown
 *  anywhere here — support cannot access precise live location by default.
 *  localStorage keys read: pakdam.demo.rooms.v1, pakdam.grievances.v1,
 *  pakdam.offline-queue.v1, pakdam.admin.bugs-resolved.v1. */
type GrievanceStatus = GrievanceRecord['status'];
const GRIEVANCE_STATUSES: GrievanceStatus[] = ['received', 'acknowledged', 'in-review', 'resolved', 'escalated'];
const BUGS_RESOLVED_KEY = 'pakdam.admin.bugs-resolved.v1';

export default function AdminPage() {
  const [rooms, setRooms] = useState<DemoRoom[]>([]);
  const [grievances, setGrievances] = useState<GrievanceRecord[]>([]);
  const [bugs, setBugs] = useState<OfflineQueueItem[]>([]);
  const [resolvedBugs, setResolvedBugs] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  /** LIVE mode is configured (NEXT_PUBLIC_WORKER_URL is set) — but the
   *  Worker has NO admin read route: no room list, no grievance list,
   *  no bug list, no safety-event feed (verified in workers/src:
   *  routes are create/join/start/ws-ticket/get-state/WS only; the
   *  POST /v1/support/grievances + /v1/support/bugs routes spec'd in
   *  docs/API.md are NOT implemented). So every queue on this page
   *  stays device-local demo data, clearly labelled, even in live
   *  mode. Live admin reads also need staff auth first — this page's
   *  own rule is that super-admin is a separate P1 staff surface, so
   *  no live admin data is wired here until that exists. Never mix
   *  demo and live queue rows. */
  const [workerUrl, setWorkerUrl] = useState<string | null>(null);

  useEffect(() => {
    setRooms(listRooms());
    setWorkerUrl(getWorkerUrl());
    try { setGrievances(JSON.parse(localStorage.getItem('pakdam.grievances.v1') ?? '[]') as GrievanceRecord[]); } catch { setGrievances([]); }
    try { setBugs(JSON.parse(localStorage.getItem('pakdam.offline-queue.v1') ?? '[]') as OfflineQueueItem[]); } catch { setBugs([]); }
    try { setResolvedBugs(JSON.parse(localStorage.getItem(BUGS_RESOLVED_KEY) ?? '[]') as string[]); } catch { setResolvedBugs([]); }
    setLoaded(true);
  }, []);

  function setGrievanceStatus(ref: string, status: GrievanceStatus) {
    const next = grievances.map((g) => (g.ref === ref ? { ...g, status, updatedAt: new Date().toISOString() } : g));
    setGrievances(next);
    localStorage.setItem('pakdam.grievances.v1', JSON.stringify(next));
  }
  function resolveBug(queueId: string) {
    const next = [...resolvedBugs, queueId];
    setResolvedBugs(next);
    localStorage.setItem(BUGS_RESOLVED_KEY, JSON.stringify(next));
  }

  // Events are listed by room code — there is no place name anywhere.
  const events = rooms.flatMap((r) => r.events.map((e) => ({ ...e, roomCode: r.room.roomCode })));
  const openBugs = bugs.filter((b) => b.command === 'bug-report' && !resolvedBugs.includes(b.queueId));
  const queuedGrievances = bugs.filter((b) => b.command === 'grievance');

  return (
    <div>
      <h1>Platform admin — P0 queues</h1>
      <div className="banner">
        <strong>Super-admin is NOT this page.</strong>
        <p>Super-admin is a separate staff surface: a separate staff app and deployment, separate sessions, MFA required, and server-enforced permissions. It is not a hidden nav item in the player app and no staff capability is reachable from a player or guest credential. Staff auth, role management, and platform configuration are P1 — they do not exist here.</p>
      </div>
      <p className="small">Safety, grievance, incident and bug-report queues only. {workerUrl ? 'Live mode is configured, but the Worker has no admin read route — every queue below is still data on this device only (demo fallback), never live server data.' : 'Data on this device only — no live backend is connected yet.'} No live location is shown anywhere on this page: support cannot access precise live location by default, and route history is never stored.</p>

      <h2>Service status (read-only, honest)</h2>
      <div className="card">
        <ul>
          <li><strong>Mode:</strong> {workerUrl ? 'Live configured — game traffic goes to the Worker when a room is live; this page’s queues are still device-local (see below).' : 'Local — the game engine runs locally in the browser.'}</li>
          <li><strong>Cloudflare Worker:</strong> {workerUrl ? 'Configured (NEXT_PUBLIC_WORKER_URL is set) — deployment itself not verified from this page.' : 'Not deployed.'}</li>
          <li><strong>Supabase:</strong> Not connected.</li>
          <li><strong>Backup / restore drill:</strong> {workerUrl ? 'Not verified — no drill has run against the live backend.' : 'Not verified — no backend exists yet.'}</li>
        </ul>
        <p className="small">No green lights are shown for services that do not exist. Status changes only when a real backend is connected and verified.</p>
      </div>

      <h2>Live admin data — not available yet</h2>
      <div className="card">
        <p className="small">No Worker route returns admin data, so nothing below is live — the queues are the device-local demo fallback, labelled as such. What is needed before any queue here can go live (exact contracts): POST /v1/support/grievances and POST /v1/support/bugs must first be implemented (spec’d in docs/API.md, not in workers/src/index.ts), plus staff-authenticated read routes — e.g. GET /v1/admin/grievances, GET /v1/admin/bugs, GET /v1/admin/rooms, GET /v1/admin/events — on the separate P1 staff surface, not in this player app. Until then, do not treat any row below as a server record.</p>
      </div>

      <h2>Safety / incident events</h2>
      {!loaded ? <p>Loading…</p> : events.length === 0 ? (
        <p>No events yet. Play a game to generate room events, or check back after a match.</p>
      ) : (
        <ul>{events.map((e, i) => <li key={i}>{new Date(e.at).toLocaleTimeString()} — Room {e.roomCode} — {e.text}</li>)}</ul>
      )}

      <h2>Grievance queue (Rule 20)</h2>
      {!loaded ? <p>Loading…</p> : grievances.length === 0 ? (
        <p>No grievances filed on this device yet. Grievances are filed on the <a href="/grievance">Grievance page</a> or the <a href="/help">Help page</a> and are distinct from bug reports.</p>
      ) : (
        <ul>
          {grievances.map((g) => (
            <li key={g.ref}>
              <strong>{g.ref}</strong> — {g.type} — filed {new Date(g.at).toLocaleDateString()}
              {g.roomRef ? ` — room ${g.roomRef}` : ''} — status: {g.status}
              <br />
              <span className="small">{g.description.slice(0, 200)}{g.description.length > 200 ? '…' : ''}</span>
              <br />
              <label className="small" htmlFor={`grv-status-${g.ref}`}>Status: </label>
              <select id={`grv-status-${g.ref}`} value={g.status} onChange={(e) => setGrievanceStatus(g.ref, e.target.value as GrievanceStatus)}>
                {GRIEVANCE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </li>
          ))}
        </ul>
      )}
      {queuedGrievances.length > 0 ? <p className="small">{queuedGrievances.length} grievance(s) also sit in the offline queue (filed before structured storage). They are listed above once filed through the Grievance or Help page.</p> : null}

      <h2>Bug-report queue (HNT-117)</h2>
      {!loaded ? <p>Loading…</p> : openBugs.length === 0 ? (
        <p>No open bug reports. Bug reports are filed on the <a href="/help">Help page</a> and contain device info only — no location, no secrets.</p>
      ) : (
        <ul>
          {openBugs.map((b) => (
            <li key={b.queueId}>
              {new Date(b.queuedAt).toLocaleString()} — {typeof b.payload === 'object' && b.payload !== null ? String((b.payload as Record<string, unknown>).description ?? '') : ''}
              <br />
              <button className="btn btn-secondary" onClick={() => resolveBug(b.queueId)}>Mark resolved</button>
            </li>
          ))}
        </ul>
      )}

      <h2>What is NOT here (P1 / later)</h2>
      <ul className="small">
        <li>Super-admin: staff/role management, platform config, feature flags — separate staff app, P1.</li>
        <li>Account management (deletion/export fulfilment) — P1.</li>
        <li>Moderation at scale and appeals tooling — P1.</li>
        <li>Match oversight beyond the host dashboard — scope to be defined in P1.</li>
        <li>Break-glass exact-location access — does not exist until an ADR + legal review exist.</li>
      </ul>
    </div>
  );
}
