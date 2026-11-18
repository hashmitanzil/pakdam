'use client';
import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { getRoomByCode, joinRoom, setCurrentPlayerId } from '@/lib/demo-store';
import {
  isLiveEnabled, joinLiveRoom, resolveRoomByCode, storeLiveSeat,
} from '@/lib/live-client';
import { saveDemoSession } from '@/lib/session-credentials';
import styles from '../join.module.css';

/** Invite landing — redesigned 2026-11-17.
 *  A shared link (/join/ABC123) now joins directly: the code is shown
 *  big, the guest only enters a display name and confirms 18+, then
 *  lands in the lobby. No account needed. Invalid or closed invites get
 *  a plain-language error and a way to type a different code. */
export default function JoinCodePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const inviteCode = code.toUpperCase();
  const router = useRouter();
  const [name, setName] = useState('');
  const [ageChecked, setAgeChecked] = useState(false);
  const [error, setError] = useState('');
  const [joining, setJoining] = useState(false);
  const [copied, setCopied] = useState('');
  // Live when a Worker URL is configured; otherwise the local demo
  // loop (clearly labelled below). Never mixed in one room.
  const live = isLiveEnabled();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (joining) return;
    if (!name.trim()) {
      setError('Enter your display name.');
      return;
    }
    if (!ageChecked) {
      setError('Confirm you are 18 or older and have read the safety briefing.');
      return;
    }
    setJoining(true);
    setError('');
    if (live) {
      try {
        // Code-only live join: resolve the 6-letter code to its roomId
        // on the server (GET /v1/rooms/by-code/:code), then join that
        // room with the code as invite proof. A bad code throws a
        // plain-words LiveApiError (404 → "could not be found…",
        // 429 → "Too many tries…"), caught below.
        const { roomId } = await resolveRoomByCode(inviteCode);
        const res = await joinLiveRoom({ roomId, roomCode: inviteCode, displayName: name.trim() });
        storeLiveSeat(res, name.trim());
        setCurrentPlayerId(res.playerId);
        router.push(`/room/${res.roomId}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not join');
        setJoining(false);
      }
      return;
    }
    const dr = getRoomByCode(inviteCode);
    if (!dr) {
      setError('This invite doesn’t match an open game — the code may be wrong, or the game may have already started or ended. Check with your host, or type a different code.');
      setJoining(false);
      return;
    }
    try {
      const p = joinRoom(dr.room.roomId, name.trim());
      saveDemoSession({
        roomId: dr.room.roomId, playerId: p.playerId,
        displayName: name.trim(), isHost: p.isHost, roomCode: inviteCode,
      });
      setCurrentPlayerId(p.playerId);
      router.push(`/room/${dr.room.roomId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not join');
      setJoining(false);
    }
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.hero}>
        <span className={styles.eyebrow}>Pakdam · You’re invited</span>
        <h1>You’re invited to a game</h1>
        <p>Someone sent you this invite. Enter the name everyone will see, and you’ll join the lobby — no account needed.</p>
        {live
          ? <p><strong>Live game</strong> — this joins the game on the server, with the other players.</p>
          : <p><strong>Demo game</strong> — this joins a game on this device only, not a game on the server.</p>}
      </div>
      <div className={`card ${styles.center}`} aria-label="Invite code">
        <p className="small" style={{ margin: '4px 0' }}>Your invite code</p>
        <p className={styles.inviteCode}>{inviteCode}</p>
        <p>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              void navigator.clipboard?.writeText(inviteCode).then(
                () => setCopied('Code copied ✓'),
                () => setCopied('Copy didn’t work in this browser — long-press the code to copy it.'),
              );
            }}
          >
            Copy code
          </button>
        </p>
        {copied ? <p className="small" role="status">{copied}</p> : null}
      </div>
      <form onSubmit={submit} noValidate>
        <label className={styles.fieldLabel} htmlFor="invite-name">Your display name — a codename is fine</label>
        <input id="invite-name" className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={30} placeholder="What should everyone call you?" autoComplete="nickname" />
        <p className={styles.codeHint}>Use a codename if you like — your real name is never needed. Everyone in the game sees this name only.</p>
        <p className={styles.codeHint}>The host decides who is a Hunter and who is a Runner when the game starts — you do not pick your own side.</p>
        <label className={styles.ageBox}>
          <input type="checkbox" required checked={ageChecked} onChange={(e) => setAgeChecked(e.target.checked)} />
          <span>
            <strong>I am 18 or older</strong>, and I have read the{' '}
            <Link href="/safety">safety briefing</Link>. Pakdam is 18+ only.
          </span>
        </label>
        <div className="banner"><strong>Foreground-only:</strong> keep this app open and your screen on while you play. Location, safety pause, SOS and Leave stop working if you lock your phone or switch apps.</div>
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
        <div className={styles.primaryAction}>
          <button className="btn" type="submit" disabled={joining}>{joining ? 'Joining…' : 'Join lobby'}</button>
        </div>
      </form>
      <p className={styles.center}>
        <span className="small">Wrong code? </span><Link href="/join">Type a different code</Link>
        {' · '}<Link href="/how-it-works">How it works</Link>
      </p>
    </div>
  );
}
