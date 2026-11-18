'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createRoom, setCurrentPlayerId } from '@/lib/demo-store';
import { createLiveRoom, isLiveEnabled, storeLiveSeat } from '@/lib/live-client';
import { saveDemoSession } from '@/lib/session-credentials';
import HostSetupForm from '@/components/host-setup/HostSetupForm';
import { defaultDraft, draftToConfig, roomSummaryStrip, validateDraft } from '@/components/host-setup/draft';
import type { HostSetupDraft } from '@/components/host-setup/draft';

/** Host setup (location-first redesign, Nov 2026): ONE scrolling
 *  screen, in the order the host thinks — mode, play area (real map,
 *  GPS centre, radius stepper + slider), players, timing, rules,
 *  discovery, presets — with a sticky CREATE LOBBY bar at the bottom
 *  showing the live room summary. The game starts from LOCATION:
 *  there is no area/place-name field anywhere in this flow. Every
 *  numeric value is a calibration placeholder (OPEN), labelled as
 *  such — no invented thresholds. Everything is free: no payment, no
 *  membership, no paywall. */
export default function CreatePage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [draft, setDraft] = useState<HostSetupDraft>(() => defaultDraft());
  const [areaChecked, setAreaChecked] = useState(false);
  const [onSite, setOnSite] = useState(false);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [creating, setCreating] = useState(false);
  // Live when a Worker URL is configured; otherwise the local demo
  // loop (clearly labelled below). Never mixed in one room.
  const live = isLiveEnabled();

  const draftErrors = validateDraft(draft);
  const zoneReady = !draft.playZoneEnabled || (draft.centreLat != null && draft.centreLng != null);
  // Leaving with a half-filled setup loses it: warn before the tab
  // is closed or reloaded, and confirm the Cancel link below.
  // A fresh form (no codename, default rules) needs no warning.
  const isDirty = name.trim().length > 0 || JSON.stringify(draft) !== JSON.stringify(defaultDraft());
  useEffect(() => {
    if (!isDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isDirty]);
  const canCreate =
    name.trim().length >= 2 && zoneReady &&
    areaChecked && onSite && draftErrors.length === 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (creating) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) { setOffline(true); setError('You are offline — room creation needs a connection.'); return; }
    if (!zoneReady) { setFieldError('Set the zone centre first — tap “Use my location” or tap the map.'); return; }
    if (!canCreate) { setFieldError('Check the highlighted fields — a codename, a real zone centre on the map (unless the play zone is off), and the two safety confirmations are all required.'); return; }
    setCreating(true);
    setError('');
    if (live) {
      // Live: the room is created on the Worker; the host + reconnect
      // tokens go to sessionStorage (per-tab only) and the host token
      // is the proof of host — never the display name alone.
      try {
        const res = await createLiveRoom({
          displayName: name.trim(),
          config: draftToConfig(draft, { hostOnSiteConfirmed: true }),
          ageGatePassed: true,
        });
        storeLiveSeat(res, name.trim());
        setCurrentPlayerId(res.hostPlayerId);
        router.push(`/room/${res.roomId}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not create the room');
        setCreating(false);
      }
      return;
    }
    try {
      const dr = createRoom(name.trim(), draftToConfig(draft, { hostOnSiteConfirmed: true }));
      saveDemoSession({
        roomId: dr.room.roomId, playerId: dr.room.hostPlayerId,
        displayName: name.trim(), isHost: true, roomCode: dr.room.roomCode,
      });
      setCurrentPlayerId(dr.room.hostPlayerId);
      router.push(`/room/${dr.room.roomId}`);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not create the room'); setCreating(false); }
  };

  return (
    <div>
      <h1>Create a game — host setup</h1>
      <p>The game starts from where you are standing — no place name to type. Your GPS sets the centre, the map shows the zone, and the size is suggested from your player count.</p>
      <p className="small">Every rule below is yours to set — no hidden defaults. Your codename is stored on this device only. Guest-only for now: no account, no sign-in — you join with a display name and a room code. All parameters are calibration placeholders, not measured values. Everything is free: no payment, no membership, no paywall.</p>
      {live
        ? <p className="small"><strong>Live game</strong> — your lobby is created on the Pakdam game server, and other players join it from their own devices.</p>
        : <p className="small"><strong>Demo game</strong> — played on this device only, not connected to a game server. Set the game server address to create a live game.</p>}
      {offline ? <div className="banner" role="status"><strong>You are offline — room creation needs a connection.</strong> Your draft is preserved on this device; tap Create again when you reconnect. Nothing is submitted silently.</div> : null}

      <form onSubmit={submit}>
        <div className="card">
          <label className="label" htmlFor="name">Your codename (2–30 characters)</label>
          <input id="name" className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={30} autoComplete="off" aria-describedby="name-hint" placeholder="The name other players see" />
          <p className="small" id="name-hint">Players in your game see only this codename — never your real name, exact location, or positions. Games are private invite-only by room code.</p>
        </div>

        <HostSetupForm value={draft} onChange={setDraft} />

        <div className="card">
          <h2>Safety briefing</h2>
          <p>No roads, railways, water edges, rooftops, construction sites or trespass. No unsafe running. No grabbing, blocking, tackling or forced phone handling. Pakdam is not an emergency service — if anyone is in danger, call the local emergency number.</p>
          <p>
            <label><input type="checkbox" checked={areaChecked} onChange={(e) => setAreaChecked(e.target.checked)} required /> I have checked the venue for roads, water, and private land.</label>
          </p>
          <p>
            <label><input type="checkbox" checked={onSite} onChange={(e) => setOnSite(e.target.checked)} required /> I will be on site at the venue, and I confirm players are 18+.</label>
          </p>
          <p className="small">Play is foreground-only: keep the app open and your screen on. SOS, Safety Pause and Leave only work while the app is open and your screen is on.</p>
        </div>

        {fieldError ? <p role="alert" className="error-text">{fieldError}</p> : null}
        {error ? <p role="alert" className="error-text">{error}</p> : null}
        {draftErrors.length > 0 ? <p role="alert" className="error-text">{draftErrors[0]}</p> : null}

        <div style={{ position: 'sticky', bottom: 0, zIndex: 10, background: 'var(--paper, #fff)', padding: '12px 0 calc(12px + env(safe-area-inset-bottom, 0px))', borderTop: '2px solid var(--line, #E8CFCF)' }}>
          <p className="small" style={{ margin: '0 0 8px', textAlign: 'center' }} aria-live="polite">{roomSummaryStrip(draft)}</p>
          {/* Never disabled (founder bug, 2026-11-17): a disabled Create
              button silently did nothing while the host waited on GPS —
              the room creation was gated on a fix that never arrived and
              the tap gave no feedback at all. The button always works;
              submit() explains exactly what is missing (codename, zone
              centre, safety confirmations) or creates the room. */}
          <button className="btn btn-lg" type="submit" aria-disabled={!canCreate} style={{ width: '100%' }}>{creating ? 'Creating…' : 'CREATE LOBBY'}</button>
          {!canCreate ? <p className="small" style={{ textAlign: 'center' }}>Tap Create and it will tell you what is missing: a codename{zoneReady ? '' : ', a real zone centre on the map (unless the play zone is off)'}, and the two safety confirmations. If GPS is stuck, tap the map to place the zone — no need to wait for it.</p> : null}
        </div>
      </form>
      <p style={{ textAlign: 'center' }}>
        <a
          href="/"
          onClick={(e) => {
            if (isDirty && !window.confirm('Leave without creating the game? Your codename and settings will be lost.')) e.preventDefault();
          }}
        >
          Cancel — back to home
        </a>
      </p>
      <div className="banner"><strong>Venue-only pilot:</strong> games run only in a known, bounded venue with the host on site. Host check-ins happen at lobby, head start, mid-match and end.</div>
    </div>
  );
}
