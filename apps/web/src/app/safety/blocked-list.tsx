'use client';
import { useEffect, useState } from 'react';
import { loadBlockedNames, unblockPlayer } from '@/components/lobby/report-block';

/**
 * Your blocked players (this device only). Blocking is local: it hides
 * a player from your friends and "Played with" lists and marks them
 * "Blocked by you" in the lobby. It never removes them from a game and
 * never tells them. Unblock any time.
 */
export default function BlockedList() {
  const [blocked, setBlocked] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setBlocked(loadBlockedNames());
    setLoaded(true);
  }, []);

  if (!loaded) return <p>Loading…</p>;
  if (blocked.length === 0) {
    return <p>You have not blocked anyone. Blocking is local to this device — it changes what you see, not the game.</p>;
  }
  return (
    <ul>
      {blocked.map((name) => (
        <li key={name}>
          <strong>{name}</strong>{' '}
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setBlocked(unblockPlayer(name))}
          >
            Unblock
          </button>
        </li>
      ))}
    </ul>
  );
}
