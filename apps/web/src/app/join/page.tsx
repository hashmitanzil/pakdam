'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { getRoomByCode, joinRoom, setCurrentPlayerId } from '@/lib/demo-store';
import {
  isLiveEnabled, joinLiveRoom, resolveRoomByCode, storeLiveSeat,
} from '@/lib/live-client';
import { saveDemoSession } from '@/lib/session-credentials';
import styles from './join.module.css';

/** Join a game — redesigned 2026-11-17.
 *  One clear primary action ("Join lobby"). The room code is entered in
 *  six boxes that auto-advance, handle backspace, and spread a pasted
 *  code across the boxes. The first box carries the "Room code" label so
 *  assistive tech and the e2e suite find it; the other five are labelled
 *  as code characters. Same join logic as before: code → room, name →
 *  guest seat, no account needed, 18+ only. */
const CODE_LEN = 6;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function cleanCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .split('')
    .filter((c) => CODE_CHARS.includes(c))
    .join('')
    .slice(0, CODE_LEN);
}

export default function JoinPage() {
  const router = useRouter();
  const [boxes, setBoxes] = useState<string[]>(Array(CODE_LEN).fill(''));
  const [name, setName] = useState('');
  const [ageChecked, setAgeChecked] = useState(false);
  const [error, setError] = useState('');
  const [joining, setJoining] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  // Live when a Worker URL is configured; otherwise the local demo
  // loop (clearly labelled below). Never mixed in one room.
  const live = isLiveEnabled();

  const code = boxes.join('');

  const setBoxAt = (index: number, value: string) => {
    const next = [...boxes];
    const cleaned = cleanCode(value);
    if (cleaned.length > 1) {
      // Paste / autofill: spread the characters across the boxes.
      for (let i = 0; i < cleaned.length && index + i < CODE_LEN; i++) {
        next[index + i] = cleaned[i] ?? '';
      }
      setBoxes(next);
      const focusAt = Math.min(index + cleaned.length, CODE_LEN - 1);
      inputRefs.current[focusAt]?.focus();
      return;
    }
    next[index] = cleaned;
    setBoxes(next);
    if (cleaned && index < CODE_LEN - 1) inputRefs.current[index + 1]?.focus();
  };

  const onKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !boxes[index] && index > 0) {
      e.preventDefault();
      const next = [...boxes];
      next[index - 1] = '';
      setBoxes(next);
      inputRefs.current[index - 1]?.focus();
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (joining) return;
    if (code.length !== CODE_LEN) {
      setError('Enter the full 6-character room code.');
      return;
    }
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
        const { roomId } = await resolveRoomByCode(code);
        const res = await joinLiveRoom({ roomId, roomCode: code, displayName: name.trim() });
        storeLiveSeat(res, name.trim());
        setCurrentPlayerId(res.playerId);
        router.push(`/room/${res.roomId}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not join');
        setJoining(false);
      }
      return;
    }
    const dr = getRoomByCode(code);
    if (!dr) {
      setError('Room not found or code expired — check with your host.');
      setJoining(false);
      return;
    }
    try {
      const p = joinRoom(dr.room.roomId, name.trim());
      saveDemoSession({
        roomId: dr.room.roomId, playerId: p.playerId,
        displayName: name.trim(), isHost: p.isHost, roomCode: code,
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
        <span className={styles.eyebrow}>Pakdam · Join</span>
        <h1>Join a game</h1>
        <p>Your host shared a 6-letter code. Type it in, pick the name everyone will see, and you are in — no account needed.</p>
        {live
          ? <p><strong>Live game</strong> — this joins the game on the server, with the other players.</p>
          : <p><strong>Demo game</strong> — this joins a game on this device only, not a game on the server.</p>}
      </div>
      <form onSubmit={submit} noValidate>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <label className={styles.fieldLabel} htmlFor="code-0">Room code (6 characters)</label>
          <div className={styles.codeBoxes}>
            {boxes.map((value, i) => (
              <input
                key={i}
                id={i === 0 ? 'code-0' : `code-${i}`}
                ref={(el) => {
                  inputRefs.current[i] = el;
                }}
                aria-label={i === 0 ? 'Room code, character 1 of 6' : `Code character ${i + 1} of 6`}
                inputMode="text"
                autoComplete={i === 0 ? 'one-time-code' : 'off'}
                autoCapitalize="characters"
                value={value}
                maxLength={i === 0 ? CODE_LEN : 1}
                onChange={(e) => setBoxAt(i, e.target.value)}
                onKeyDown={(e) => onKeyDown(i, e)}
                onPaste={(e) => {
                  e.preventDefault();
                  setBoxAt(0, e.clipboardData.getData('text'));
                }}
                className={value ? styles.filled : ''}
              />
            ))}
          </div>
          <p className={styles.codeHint}>Tip: paste the whole code — it fills all six boxes. Codes never use 0, 1, I or O.</p>
        </fieldset>

        <label className={styles.fieldLabel} htmlFor="name">Your display name — a codename is fine</label>
        <input id="name" className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={30} placeholder="What should everyone call you?" autoComplete="nickname" />
        <p className={styles.codeHint}>Use a codename if you like — your real name is never needed. Everyone in the game sees this name only.</p>

        <p className={styles.codeHint}>The host decides who is a Hunter and who is a Runner when the game starts — you do not pick your own side.</p>

        <label className={styles.ageBox}>
          <input type="checkbox" required checked={ageChecked} onChange={(e) => setAgeChecked(e.target.checked)} />
          <span>
            <strong>I am 18 or older</strong>, and I have read the safety briefing in the host setup. Pakdam is 18+ only.
          </span>
        </label>

        <div className="banner"><strong>Foreground-only:</strong> keep this app open and your screen on while you play. Location, safety pause, SOS and Leave stop working if you lock your phone or switch apps.</div>
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
        <div className={styles.primaryAction}>
          <button className="btn" type="submit" disabled={joining || code.length !== CODE_LEN}>
            {joining ? 'Joining…' : 'Join lobby'}
          </button>
        </div>
      </form>
      <p className={styles.center}>
        <span className="small">No code yet? Ask your host for the 6-letter room code — games are private invite-only.</span>
      </p>
      <p className={styles.center}>
        <span className="small">Hosting instead? </span>
        <Link href="/create/mode">Create a game</Link>
      </p>
    </div>
  );
}
