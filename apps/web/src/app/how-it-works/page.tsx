import type { Metadata } from 'next';
import PageHero from '@/components/landing/PageHero';

export const metadata: Metadata = {
  title: 'How it works — PAKDAM',
  description: 'How a Pakdam game works: the host creates a game, friends join in the browser, and Hunters chase Runners in a real place. Foreground-only PWA.',
  alternates: { canonical: '/how-it-works' },
};

export default function HowItWorksPage() {
  return (
    <div className="subpage">
      <PageHero
        kicker="How it works"
        title="From standing around to running for your life."
        lede="Pakdam is real-world hide-and-seek. A host starts a game from where they are standing, friends join with a code, and Hunters chase Runners in person. There is no download and no account for guests."
      />

      <section className="journey-card" aria-labelledby="host-journey">
        <h2 id="host-journey">The host journey</h2>
        <ol>
          <li><span><strong>Host a game.</strong> Pick Quick or Custom, start from your location on the map, and set the rules. The play zone sizes itself to the player count and can be adjusted with a slider. Games run only in a known, bounded play area with the host on site (host-on-site pilot).</span></li>
          <li><span><strong>Share the invite.</strong> Send the room code or link to your friends. Invite links are private and host-shared only — there are no public games.</span></li>
          <li><span><strong>Brief everyone.</strong> Every player confirms the rules, the boundary, and the safety briefing before the game starts.</span></li>
          <li><span><strong>Run the game.</strong> Confirm players are accounted for at lobby, head start, mid-match, and end. A missing player triggers a safety pause and host follow-up.</span></li>
          <li><span><strong>End and review.</strong> See the results recap and the all-safe check at the end.</span></li>
        </ol>
      </section>

      <section className="journey-card" aria-labelledby="player-journey">
        <h2 id="player-journey">The player journey</h2>
        <ol>
          <li><span><strong>Join in the browser.</strong> Open the invite link — no download, no account for guests. Choose a display name, confirm you are 18 or older, and allow location permission.</span></li>
          <li><span><strong>Get ready.</strong> Confirm the rules, the boundary, and the safety briefing in the lobby.</span></li>
          <li><span><strong>Play.</strong> Runners get a head start and hide. Hunters get approximate-area pings — never an exact pin.</span></li>
          <li><span><strong>Get caught — in person.</strong> The Runner taps &ldquo;Got tagged&rdquo; to show their QR and the Hunter scans it — or the Runner confirms manually if the camera can&apos;t scan. Only then is it a catch. GPS alone never decides a catch.</span></li>
          <li><span><strong>Stay safe.</strong> Anyone can trigger a safety pause, send an SOS to the host, or leave at any time — while the app is open and the screen is on. See <a href="/safety">Safety</a>.</span></li>
        </ol>
      </section>

      <section className="journey-card" aria-labelledby="full-round">
        <h2 id="full-round">A full round, step by step</h2>
        <ol>
          <li><span>Lobby and readiness checklist</span></li>
          <li><span>Role briefing — Hunter or Runner</span></li>
          <li><span>Countdown, then the Runners&apos; head start</span></li>
          <li><span>Live play (foreground only — keep the app open and your screen on)</span></li>
          <li><span>Catch: two-step, visible claim state — Runner shows their QR, Hunter scans it (or the Runner confirms manually)</span></li>
          <li><span>Results recap and all-safe check</span></li>
        </ol>
      </section>

      <div className="callout">
        <strong>What Pakdam can&apos;t do (yet)</strong>
        <p style={{ margin: '6px 0 0' }}>Play with your screen locked. Track you in the background. Prove a catch by GPS alone. Background play arrives with the native apps in Phase 1. This is a foreground-only PWA: location stops if you lock your phone or switch apps, and safety pause, SOS and Leave only work while the app is open.</p>
      </div>

      <h2>Questions?</h2>
      <p><a href="/faq#locked-screen">Does it work with my screen locked?</a> · <a href="/faq#catch">How does a catch work?</a> · <a href="/faq#exact-location">Can Hunters see exactly where I am?</a> · <a href="/faq#iphone">Does it work on iPhone?</a> · <a href="/faq">All FAQs</a></p>
      <p className="cta-row"><a className="btn btn-lg" href="/create">Host a Game</a> <a className="btn btn-lg btn-secondary" href="/join">Join a Game</a></p>
    </div>
  );
}
