import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Page not found — PAKDAM',
  description: 'That page does not exist. Go back home or join a game with a room code.',
};

/** Plain-language 404: a mistyped link or an old URL lands here, never
 *  on a blank page or a stack trace. One primary action (back home),
 *  plus the two ways into a game. */
export default function NotFound() {
  return (
    <div>
      <h1>That page does not exist</h1>
      <div className="card">
        <p>The link may be mistyped, or the page may have moved. Nothing is broken on your side.</p>
        <p>
          <Link className="btn" href="/">Back to home</Link>{' '}
          <Link className="btn btn-secondary" href="/join">Join a Game</Link>{' '}
          <Link className="btn btn-secondary" href="/create">Host a Game</Link>
        </p>
        <p className="small">If you followed a room link, check the room code with your host — rooms are private and invite-only, so a wrong code will not find a game.</p>
      </div>
    </div>
  );
}
