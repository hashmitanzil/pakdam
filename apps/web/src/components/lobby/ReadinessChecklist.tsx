'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Player } from '@pakdam/shared';
import { hostCheckin } from '@/lib/demo-store';
import { locationPrecisionLabel } from '@/lib/geolocation';
import { lastReportedLabel } from '../match/freshness';
import styles from './lobby.module.css';

/** Pre-game readiness checklist (23 §5A, 24 S04). Per player:
 *  location permission, GPS quality, screen-on / Wake Lock, briefing
 *  confirmed, pre-match warning acknowledged. Every player must
 *  acknowledge the warning before start; acknowledgement is recorded in
 *  the room event log via hostCheckin (the demo store's event mechanism).
 *  Items the host cannot know for another player are shown from that
 *  player's ready/connection state — never invented per-item.
 *
 *  LIVE (Worker 2, 2026-11-17): in live mode the tick-box is kept on
 *  this device only. `announcement.send` is host-only on the server,
 *  so a guest has no channel for the acknowledgement, and the server's
 *  briefing record is briefing.confirm (sent with "I'm ready"). The
 *  host's acknowledgement IS announced to the room via
 *  onAcknowledgeLive (the lobby page sends it only when the player is
 *  the host). The ack line says which it is — it never claims a server
 *  record that did not happen. */
export const PRE_MATCH_WARNING =
  'SOS, Safety Pause and Leave only work while this app is open and your screen is on. If you lock your phone, they cannot be used until you unlock and reopen.';

type CheckStatus = 'pass' | 'fail' | 'checking' | 'unknown';

function CheckRow({ label, status, detail }: { label: string; status: CheckStatus; detail: string }) {
  const icon = status === 'pass' ? '✓' : status === 'fail' ? '✕' : status === 'checking' ? '…' : '?';
  const word = status === 'pass' ? 'Done' : status === 'fail' ? 'Not ready' : status === 'checking' ? 'Checking…' : 'Not checked yet';
  const iconClass = status === 'pass' ? styles.checkIconPass : status === 'fail' ? styles.checkIconFail : '';
  return (
    <li className={styles.checkRow}>
      <span className={`${styles.checkIcon} ${iconClass}`} aria-hidden="true">{icon}</span>
      <div className={styles.checkBody}>
        <div className={styles.checkLabel}>{label} — {word}</div>
        <div className={styles.checkDetail}>{detail}</div>
      </div>
    </li>
  );
}

export default function ReadinessChecklist({ players, meId, roomId, mode = 'demo', onAcknowledgeLive }: {
  players: Player[];
  meId: string | null;
  roomId: string;
  /** 'live' = the tick-box stays on this device (no server channel for
   *  a guest's acknowledgement); 'demo' = recorded via hostCheckin. */
  mode?: 'live' | 'demo';
  /** Live only: called with the acknowledgement note; the lobby page
   *  announces it when the player is the host and ignores it for
   *  guests (announcement.send is host-only on the server). */
  onAcknowledgeLive?: (note: string) => void;
}) {
  const me = players.find((p) => p.playerId === meId) ?? null;
  const [perm, setPerm] = useState<CheckStatus>('unknown');
  const [gps, setGps] = useState<{ status: CheckStatus; detail: string }>({ status: 'unknown', detail: 'Not checked yet — tap “Run checks” to take a foreground fix.' });
  const [wake, setWake] = useState<{ status: CheckStatus; detail: string }>({ status: 'unknown', detail: 'Not checked yet.' });
  const [online, setOnline] = useState<CheckStatus>(typeof navigator !== 'undefined' && navigator.onLine ? 'pass' : 'fail');
  const [ack, setAck] = useState(false);
  const [ackLogged, setAckLogged] = useState(false);
  const [running, setRunning] = useState(false);
  const ackKey = `pakdam.ack.${roomId}.${meId ?? 'none'}`;
  const loggedRef = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setAck(localStorage.getItem(ackKey) === 'yes');
    const onOnline = () => setOnline('pass');
    const onOffline = () => setOnline('fail');
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); };
  }, [ackKey]);

  const runChecks = useCallback(() => {
    setRunning(true);
    // Location permission: Permissions API where available; iOS Safari has
    // none for geolocation, so fall back to try-and-prompt.
    const nav = navigator as Navigator & { permissions?: { query: (q: { name: string }) => Promise<{ state: string }> } };
    if (nav.permissions?.query) {
      nav.permissions.query({ name: 'geolocation' }).then(
        (r) => setPerm(r.state === 'granted' ? 'pass' : r.state === 'denied' ? 'fail' : 'unknown'),
        () => setPerm('unknown'),
      );
    } else {
      setPerm('unknown');
    }
    // Wake Lock: supported on this browser?
    const wnav = navigator as Navigator & { wakeLock?: unknown };
    setWake(wnav.wakeLock
      ? { status: 'pass', detail: 'Wake Lock is available on this browser — it is requested during play, but it is a convenience, never a guarantee. Keep your screen on.' }
      : { status: 'fail', detail: 'Wake Lock is unavailable on this browser — keep your screen on yourself. Play still works.' });
    // GPS quality: one foreground fix.
    if (!('geolocation' in navigator)) {
      setGps({ status: 'fail', detail: 'Geolocation is not available in this browser.' });
      setRunning(false);
      return;
    }
    setGps({ status: 'checking', detail: 'Taking a foreground fix…' });
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const acc = Math.round(pos.coords.accuracy);
        // Thresholds are calibration OPEN — the words follow the shared
        // classifier's placeholder bands (good ≤10 m, fair ≤25 m, poor ≤60 m).
        // (D-M3) The detail also names the Precise / Approximate mode via
        // locationPrecisionLabel — the same words as the create + play
        // maps (good/fair ≤25 m is Precise, coarser is Approximate).
        // No fix yet / error states name no mode — it is never guessed.
        const quality = acc <= 10 ? 'good' : acc <= 25 ? 'fair' : 'poor';
        setGps({
          status: quality === 'poor' ? 'fail' : 'pass',
          detail: quality === 'good'
            ? `Accuracy ~${acc} m — good enough. ${locationPrecisionLabel(acc)}`
            : quality === 'fair'
              ? `Accuracy ~${acc} m — fair. Move outdoors if you can. ${locationPrecisionLabel(acc)}`
              : `Accuracy poor (~${acc} m) — move outdoors and wait a moment. ${locationPrecisionLabel(acc)}`,
        });
        setPerm('pass');
        setRunning(false);
      },
      (err) => {
        setGps({ status: 'fail', detail: err.code === 1 ? 'Location is off — allow it in your browser settings, then tap Retry.' : 'GPS is too rough here — try again.' });
        setPerm((p) => (err.code === 1 ? 'fail' : p));
        setRunning(false);
      },
      { enableHighAccuracy: true, timeout: 15000 },
    );
  }, []);

  const acknowledge = () => {
    setAck(true);
    if (typeof window !== 'undefined') localStorage.setItem(ackKey, 'yes');
    if (!loggedRef.current && !ackLogged && me) {
      loggedRef.current = true;
      setAckLogged(true);
      const note = `${me.displayName} acknowledged the pre-match warning and safety rules`;
      if (mode === 'live') onAcknowledgeLive?.(note);
      else hostCheckin(roomId, note);
    }
  };

  const myChecksPass = perm === 'pass' && gps.status === 'pass' && online === 'pass';
  const checks: { status: CheckStatus }[] = [
    { status: perm },
    { status: gps.status },
    { status: wake.status },
    { status: online },
    { status: me?.briefingConfirmed ? 'pass' : 'fail' },
  ];
  const passedCount = checks.filter((c) => c.status === 'pass').length;

  return (
    <section className="card" aria-label="Pre-game readiness checklist">
      <h2 className={styles.sectionTitle}>Get ready to play</h2>
      <p className={styles.sectionSub}>Five quick checks before the game can start. Nothing here shares your exact location — the host only sees whether each check passed.</p>
      {!me ? (
        <p>You are not signed in as a player on this device. Your own checklist runs on your own phone; the host sees each player’s ready state below.</p>
      ) : (
        <>
          <p><strong>Your checks ({me.displayName}) — {passedCount} of {checks.length} done</strong></p>
          <div className={styles.progressBar} role="progressbar" aria-valuenow={passedCount} aria-valuemin={0} aria-valuemax={checks.length} aria-label={`${passedCount} of ${checks.length} readiness checks done`}>
            <div className={styles.progressFill} style={{ width: `${(passedCount / checks.length) * 100}%` }} />
          </div>
          <ul className={styles.checkList}>
            <CheckRow label="Location permission" status={perm} detail={perm === 'pass' ? 'Granted.' : perm === 'fail' ? 'Denied — allow it in your browser settings, then tap Retry.' : 'Not confirmed yet — run the checks; on iOS Safari the browser asks when the fix is taken.'} />
            <CheckRow label="GPS quality" status={gps.status} detail={gps.detail} />
            <CheckRow label="Screen-on / Wake Lock" status={wake.status} detail={wake.detail} />
            <CheckRow label="Network" status={online} detail={online === 'pass' ? 'Connected.' : 'Offline — you cannot start until you reconnect.'} />
            <CheckRow label="Briefing confirmed" status={me.briefingConfirmed ? 'pass' : 'fail'} detail={me.briefingConfirmed ? 'You confirmed the rules and briefing.' : 'Not confirmed yet — tap “I’m ready” to confirm the briefing.'} />
          </ul>
          <p><button type="button" className="btn btn-secondary" onClick={runChecks} disabled={running}>{running ? 'Running checks…' : 'Run checks / Retry'}</button></p>
          <h3>Before you play — read this</h3>
          <p>{PRE_MATCH_WARNING}</p>
          <label className={styles.ackBox}>
            <input type="checkbox" checked={ack} onChange={(e) => { if (e.target.checked) acknowledge(); else { setAck(false); localStorage.removeItem(ackKey); } }} />{' '}
            <span><strong>I understand the rules and the screen-on warning.</strong><br /><span className="small">Every player must tick this before the game can start.</span></span>
          </label>
          {ack ? (
            <p role="status">
              {mode === 'live'
                ? '✓ Acknowledged — kept on this device. The live server records your readiness when you tap “I’m ready”; this tick-box itself is not sent to the server.'
                : '✓ Acknowledged — recorded in the room event log.'}
            </p>
          ) : (
            <p className="small">
              {mode === 'live'
                ? 'The host starts when everyone is ready; this tick-box is your own record.'
                : 'Start stays disabled until every player has acknowledged.'}
            </p>
          )}
          {!myChecksPass ? <p className="small">Your checks are not all passing yet — the host sees which item failed, not your raw location.</p> : null}
        </>
      )}
      <h3>All players</h3>
      <ul>
        {players.map((p) => (
          <li key={p.playerId}>
            <strong>{p.displayName}</strong> {p.isHost ? <span className="tag">Host</span> : null} —{' '}
            {p.connectionState === 'suspended'
              ? `Suspended — location unknown · ${lastReportedLabel(p.lastFixAt)}`
              : p.isReady
                ? 'Ready (briefing confirmed)'
                : 'Not ready yet'}{' '}
            · {p.connectionState}
            {p.playerId === meId && ack ? ' · warning acknowledged' : ''}
          </li>
        ))}
      </ul>
      <p className="small">The host may start without a player who is not ready (minimum 3 players). A player who returns is shown as “Back — re-checking” until this checklist passes again.</p>
    </section>
  );
}
