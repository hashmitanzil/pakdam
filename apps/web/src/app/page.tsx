import type { Metadata } from 'next';
import PickASide from '@/components/landing/PickASide';
import HowItPlays from '@/components/landing/HowItPlays';
import ModesPreview from '@/components/landing/ModesPreview';
import TrustStrip from '@/components/landing/TrustStrip';
import SafetyStrip from '@/components/landing/SafetyStrip';

export const metadata: Metadata = {
  title: 'PAKDAM — Real-world hide and seek',
  description: 'Pakdam is a real-world GPS hide-and-seek game. Your city is the playing field. Web PWA, foreground-only play. 18+, private invite-only, Classic Manhunt.',
  alternates: { canonical: '/' },
};

export default function Landing() {
  return (
    <div className="landing">
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-grid">
          <div>
            <p className="hero-eyebrow">Real-world hide and seek</p>
            <h1 className="hero-title" id="hero-title">
              Pakdam — your city is the playing field. <span className="accent">Run from real Hunters.</span>
            </h1>
            <p className="hero-sub">
              Pakdam turns the place you&apos;re standing in into the game board. Runners scatter and
              stay gone; Hunters follow coarse-area pings and close in. A catch only counts when it
              happens in person — the Runner taps &ldquo;Got tagged&rdquo; to show their QR and the Hunter
              scans it (or the Runner confirms manually if the camera can&apos;t scan). GPS alone never
              proves a catch.
            </p>
            <div className="hero-ctas">
              <a className="btn btn-lg btn-ember-glow" href="/create">Host a Game</a>
              <a className="btn btn-lg btn-ghost-light" href="/join">Join a Game</a>
            </div>
            <p className="hero-note"><strong>Everything is free — no payment, no membership, no paywall.</strong> Free · No download · 3–30 players · 18+ · Private invite-only</p>
          </div>
          <figure className="zone-illustration" aria-label="Illustration of an example Pakdam play zone" style={{ margin: 0 }}>
            <svg viewBox="0 0 400 340" role="img" aria-label="Illustrated map of an example play zone: a red boundary circle, a shaded blue coarse ping area, one Hunter marker and two Runner markers. Illustration — not a live game." style={{ display: 'block', width: '100%', height: 'auto', borderRadius: 'var(--radius-lg)', border: '1px solid var(--line)', background: 'var(--paper)' }}>
              <rect width="400" height="340" fill="#FFF7F5" />
              {/* stylised streets */}
              <g stroke="#EFE3E1" strokeWidth="10" strokeLinecap="round">
                <line x1="0" y1="70" x2="400" y2="70" />
                <line x1="0" y1="180" x2="400" y2="180" />
                <line x1="0" y1="280" x2="400" y2="280" />
                <line x1="80" y1="0" x2="80" y2="340" />
                <line x1="210" y1="0" x2="210" y2="340" />
                <line x1="320" y1="0" x2="320" y2="340" />
              </g>
              <g stroke="#E8CFCF" strokeWidth="2">
                <line x1="0" y1="125" x2="400" y2="125" />
                <line x1="0" y1="230" x2="400" y2="230" />
                <line x1="145" y1="0" x2="145" y2="340" />
                <line x1="265" y1="0" x2="265" y2="340" />
              </g>
              {/* play zone boundary */}
              <circle cx="200" cy="170" r="118" fill="#B91C1C" fillOpacity="0.07" stroke="#B91C1C" strokeWidth="3" />
              {/* coarse ping area — an area, never an exact pin */}
              <circle cx="252" cy="128" r="46" fill="#1D4ED8" fillOpacity="0.15" stroke="#1D4ED8" strokeWidth="2" strokeDasharray="5 4" />
              {/* Hunter marker (diamond + H) and Runner markers (triangle + R) */}
              <g fontFamily="inherit" fontWeight="800" textAnchor="middle">
                <polygon points="118,196 132,210 118,224 104,210" fill="#1D4ED8" />
                <text x="118" y="215" fontSize="11" fill="#FFFFFF">H</text>
                <polygon points="252,112 264,132 240,132" fill="#9A3412" />
                <text x="252" y="129" fontSize="10" fill="#FFFFFF">R</text>
                <polygon points="168,252 180,272 156,272" fill="#9A3412" />
                <text x="168" y="269" fontSize="10" fill="#FFFFFF">R</text>
              </g>
              {/* labels */}
              <g fontFamily="inherit" fontSize="12" fontWeight="700" fill="#1A0E0E">
                <text x="200" y="52" textAnchor="middle">Play zone</text>
                <text x="252" y="92" textAnchor="middle" fill="#1D4ED8">Coarse ping area</text>
                <text x="118" y="244" textAnchor="middle" fill="#1D4ED8">Hunter ◆ H</text>
                <text x="168" y="292" textAnchor="middle" fill="#9A3412">Runner ▲ R</text>
              </g>
            </svg>
            <figcaption className="small" style={{ marginTop: 'var(--space-2)', textAlign: 'center' }}>
              Illustration — an example play zone. Not a live game: no real players, no real locations, no clock.
            </figcaption>
          </figure>
        </div>
      </section>

      <div className="callout" role="note">
        <strong>Play in your browser — no download. But keep this app open and your screen on while you play.</strong>
        <p style={{ margin: '6px 0 0' }}>Location stops if you lock your phone or switch apps. Safety pause, SOS and Leave only work while the app is open. This is a foreground-only PWA — it is not a native app.</p>
      </div>

      <TrustStrip />
      <PickASide />
      <HowItPlays />
      <ModesPreview />
      <SafetyStrip />

      <section className="section" aria-labelledby="features-title">
        <h2 id="features-title">Everything in one game — free</h2>
        <p>Pakdam brings together the best of real-world hide and seek in one free game. No payment, no membership, no paywall — everything below is free, and anything marked planned is not playable yet.</p>
        <div className="teaser-grid">
          <article className="teaser-card">
            <h3>In the pilot now</h3>
            <ul>
              <li>Free browser game — no download, no account for guests</li>
              <li>3–30 players, adults only 18+, private invite-only</li>
              <li>Room code to create and join; host presets — Quick, Standard, Big Park, Custom</li>
              <li>Two game modes — Classic Manhunt and Infection — picked in host setup</li>
              <li>Private invite-only by room code — no public lobbies, no nearby-rooms list</li>
              <li>Friends and &ldquo;Played with&rdquo; — see who you have played with recently</li>
              <li>Host-picked or Random teams — the host picks the Hunters, or Random fills them</li>
              <li>House-rule presets — save your rules on your device and reuse them</li>
              <li>Outside-zone rule: 30 seconds to get back inside, or you are ejected from the game</li>
              <li>Location-first zone: your GPS sets the centre, the size is suggested from your player count and adjustable on the map — no place name to type</li>
              <li>Head start for Runners, then the hunt</li>
              <li>Coarse-area pings, compass and hot/cold readout — never an exact pin</li>
              <li>Shrinking zone with the next edge previewed</li>
              <li>In-person tag — the Runner shows their QR and the Hunter scans it; GPS alone never proves a catch</li>
              <li>Team Radio text quick signals, teammates only</li>
              <li>Live host dashboard with check-ins through the match</li>
              <li>Shareable text round card and a monthly leaderboard — points from real finished matches only</li>
              <li>Safety always in reach: SOS, safety pause and leave, host on site</li>
            </ul>
          </article>
          <article className="teaser-card">
            <h3>Planned after the pilot</h3>
            <ul>
              <li>Voice radio for your team, if it can be done honestly in the browser</li>
            </ul>
            <p className="small">Planned means planned: no dates are promised here, and nothing on this list can be played or booked now.</p>
            <p><a className="btn btn-secondary" href="/game-modes">See all game modes</a></p>
          </article>
        </div>
      </section>

      <section className="cta-band" aria-labelledby="final-cta">
        <h2 id="final-cta">Your street. Your friends. One clock.</h2>
        <p>Start where you stand — the zone builds itself around you. No download, no account for guests.</p>
        <p><a className="btn btn-lg btn-light" href="/create">Host a Game</a></p>
        <p><a className="btn btn-lg btn-ghost-light" href="/join">Join a Game</a></p>
      </section>

      <p className="small questions-links" style={{ marginTop: 24 }}>
        <span>Questions?</span>
        <a href="/faq">FAQ</a>
        <span aria-hidden="true">·</span>
        <a href="/how-it-works">How it works</a>
        <span aria-hidden="true">·</span>
        <a href="/about">About Pakdam</a>
        <span aria-hidden="true">·</span>
        <a href="/help">Help &amp; grievance</a>
      </p>
      <p className="small">Pakdam is free — no payment, no membership, no paywall. Play in your browser; the game runs while this app is open and your screen is on.</p>
    </div>
  );
}
