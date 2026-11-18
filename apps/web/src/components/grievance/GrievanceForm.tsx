'use client';
import { useEffect, useState } from 'react';
import { queueNonCompetitive } from '@/lib/offline-queue';

/** Grievance intake (Gaming Act, Rule 20). Distinct from bug reports.
 *  Stored on this device only (demo) — localStorage key: pakdam.grievances.v1
 *  Reference format: GRV-XXXX. Status tracking: reference + email lookup.
 *  No response timeline is promised — timelines are OPEN until counsel
 *  confirms them. No location, no file upload in Phase 0. */
export interface GrievanceRecord {
  ref: string; name: string; email: string; type: string; roomRef: string;
  description: string; status: 'received' | 'acknowledged' | 'in-review' | 'resolved' | 'escalated';
  at: string; updatedAt: string;
}
const KEY = 'pakdam.grievances.v1';
function loadGrievances(): GrievanceRecord[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') as GrievanceRecord[]; } catch { return []; }
}

export default function GrievanceForm() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [type, setType] = useState('');
  const [roomRef, setRoomRef] = useState('');
  const [description, setDescription] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [ref, setRef] = useState('');
  const [fail, setFail] = useState('');
  const [lookupRef, setLookupRef] = useState('');
  const [lookupEmail, setLookupEmail] = useState('');
  const [lookupResult, setLookupResult] = useState<string>('');
  const [mine, setMine] = useState<GrievanceRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { setMine(loadGrievances()); setLoaded(true); }, []);

  function submit() {
    const errs: string[] = [];
    if (name.trim().length < 2 || name.trim().length > 50) errs.push('Enter your name');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errs.push('Enter a valid email address so we can reply');
    if (!type) errs.push('Choose a grievance type');
    if (description.trim().length < 20) errs.push('Describe what happened — at least 20 characters');
    if (description.trim().length > 5000) errs.push('Description is too long — 5000 characters or fewer');
    if (!confirm) errs.push('Confirm this is about Pakdam');
    setErrors(errs);
    if (errs.length) return;
    setFail('');
    try {
      const reference = 'GRV-' + String(Math.floor(1000 + Math.random() * 9000));
      const now = new Date().toISOString();
      const items = loadGrievances();
      items.push({ ref: reference, name: name.trim(), email: email.trim(), type, roomRef: roomRef.trim(), description: description.trim(), status: 'received', at: now, updatedAt: now });
      localStorage.setItem(KEY, JSON.stringify(items));
      queueNonCompetitive('grievance', { ref: reference, type });
      setMine(items);
      setRef(reference);
      setName(''); setEmail(''); setType(''); setRoomRef(''); setDescription(''); setConfirm(false);
    } catch {
      setFail('Could not file — try again. Your draft is kept above.');
    }
  }

  function lookup() {
    const found = loadGrievances().find(
      (g) => g.ref.toUpperCase() === lookupRef.trim().toUpperCase() && g.email.toLowerCase() === lookupEmail.trim().toLowerCase(),
    );
    setLookupResult(found ? `${found.ref} — status: ${found.status}. Filed ${new Date(found.at).toLocaleDateString()}.` : 'No grievance matches that reference and email on this device.');
  }

  return (
    <div>
      <h1>Grievance</h1>
      <p><strong>A bug report is for something broken in the app. A grievance is for a complaint about content, conduct, or a decision</strong> — for example, you were removed unfairly, or you reported a player and nothing happened. Bug reports go to the <a href="/help">Help page</a>; grievances go here.</p>
      <p className="small">Formal grievance route under the applicable grievance rules (Gaming Act, Rule 20). The designated grievance contact and response timelines are confirmed by counsel before the external pilot — no timeline is promised here. This form collects no location and no file upload.</p>

      {ref ? (
        <div className="banner" role="status">
          <strong>Grievance received. Your tracking reference is {ref}.</strong>
          <p>Keep this reference — you need it, with your email, to check the status below. Your grievance is acknowledged, tracked, and resolved with a documented response. Escalation, including to the Authority, is available where applicable.</p>
          <p className="small">Note: your grievance is stored on this device only. In production it goes to the grievance officer queue.</p>
        </div>
      ) : null}
      {fail ? <p role="alert">{fail}</p> : null}
      {errors.length > 0 ? (
        <div role="alert"><ul>{errors.map((e) => <li key={e}>{e}</li>)}</ul></div>
      ) : null}

      <label className="label" htmlFor="grv-name">Name</label>
      <input id="grv-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
      <label className="label" htmlFor="grv-email">Email</label>
      <input id="grv-email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <label className="label" htmlFor="grv-type">Grievance type</label>
      <select id="grv-type" className="input" value={type} onChange={(e) => setType(e.target.value)}>
        <option value="">Choose a type</option>
        <option value="Safety">Safety</option>
        <option value="Conduct">Conduct</option>
        <option value="Removal or ban">Removal or ban</option>
        <option value="Privacy">Privacy</option>
        <option value="Other">Other</option>
      </select>
      <label className="label" htmlFor="grv-room">Match / room reference (optional)</label>
      <input id="grv-room" className="input" value={roomRef} onChange={(e) => setRoomRef(e.target.value)} placeholder="Room code or match ID, if you have it" />
      <label className="label" htmlFor="grv-desc">Description</label>
      <textarea id="grv-desc" className="input" rows={5} value={description} onChange={(e) => setDescription(e.target.value)} />
      <p className="small">{description.length}/5000 characters. At least 20 characters.</p>
      <p><label><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> I confirm this is about Pakdam</label></p>
      <p><button className="btn" onClick={submit}>File grievance</button></p>

      <h2>Check your grievance</h2>
      <p className="small">Enter your tracking reference and the email you filed with.</p>
      <label className="label" htmlFor="lookup-ref">Tracking reference</label>
      <input id="lookup-ref" className="input" value={lookupRef} onChange={(e) => setLookupRef(e.target.value)} placeholder="GRV-XXXX" />
      <label className="label" htmlFor="lookup-email">Email</label>
      <input id="lookup-email" className="input" type="email" value={lookupEmail} onChange={(e) => setLookupEmail(e.target.value)} />
      <p><button className="btn btn-secondary" onClick={lookup}>Check status</button></p>
      {lookupResult ? <p role="status">{lookupResult}</p> : null}

      <h2>Your grievances on this device</h2>
      {!loaded ? <p>Loading…</p> : mine.length === 0 ? (
        <p>No grievances filed on this device yet.</p>
      ) : (
        <ul>{mine.map((g) => <li key={g.ref}>{g.ref} — {g.type} — {g.status} — filed {new Date(g.at).toLocaleDateString()}</li>)}</ul>
      )}
    </div>
  );
}
