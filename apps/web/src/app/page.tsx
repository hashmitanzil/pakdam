import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'PAKDAM — Real-world hide and seek',
  description: 'Pakdam is a real-world GPS hide-and-seek game. Your city is the playing field. Web PWA, foreground-only play. 18+, private invite-only, Classic Manhunt.',
  alternates: { canonical: '/' },
};

/** Home — video structure only: big headline, HOST A GAME (primary,
 *  leads to the mode picker) and Join Room. No "Find a Room" / nearby
 *  discovery anywhere: games are private invite-only, joined by the
 *  6-letter code the host shares. No footer link row: the old
 *  "Create a game" / "How it works" footer overlapped at 390px and
 *  is gone with the old landing. Colours and theme untouched. */
export default function Home() {
  return (
    <div className="landing">
      <section className="hero" aria-labelledby="hero-title">
        <p className="hero-eyebrow">Real-world hide and seek</p>
        <h1 className="hero-title" id="hero-title">
          Pakdam — your city is the playing field. <span className="accent">Run from real Hunters.</span>
        </h1>
        <p className="hero-sub">
          Runners scatter and stay gone; Hunters follow coarse-area pings and close in.
          A catch only counts when it happens in person — the Runner taps &ldquo;Got tagged&rdquo;
          to show their QR and the Hunter scans it (or the Runner confirms manually if the
          camera can&apos;t scan). GPS alone never proves a catch.
        </p>
        <div className="hero-ctas">
          <a className="btn btn-lg btn-ember-glow" href="/create/mode">Host a Game</a>
          <a className="btn btn-lg btn-ghost-light" href="/join">Join Room</a>
        </div>
        <p className="small" style={{ marginTop: 16 }}>
          <strong>Everything is free — no payment, no membership, no paywall.</strong>
          {' '}Free · No download · 3–30 players · 18+ · Private invite-only
        </p>
        <p className="small">
          Games are private invite-only — join with the 6-letter room code your host shares.
          No public lobbies, no nearby-rooms list.
        </p>
      </section>

      <div className="callout" role="note">
        <strong>Play in your browser — no download. But keep this app open and your screen on while you play.</strong>
        <p style={{ margin: '6px 0 0' }}>Location stops if you lock your phone or switch apps. Safety pause, SOS and Leave only work while the app is open. This is a foreground-only PWA — it is not a native app.</p>
      </div>

      <p className="small">Pakdam is free — no payment, no membership, no paywall. Play in your browser; the game runs while this app is open and your screen is on.</p>
    </div>
  );
}
