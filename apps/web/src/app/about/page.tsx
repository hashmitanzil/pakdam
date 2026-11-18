import type { Metadata } from 'next';
import PageHero from '@/components/landing/PageHero';

export const metadata: Metadata = {
  title: 'About — PAKDAM',
  description: 'About Pakdam: real-world hide-and-seek, built from scratch, India-first. Free, private invite-only, 3–30 players, 18+.',
  alternates: { canonical: '/about' },
};

export default function AboutPage() {
  return (
    <div className="subpage">
      <PageHero
        kicker="About Pakdam"
        title="Friends, a real place, and a phone in your pocket."
        lede="Pakdam is a real-world hide-and-seek game. Hunters chase Runners. A catch happens in person — the Runner shows their QR and the Hunter scans it (or the Runner confirms manually) — never by GPS alone."
      />

      <h2>Why it exists</h2>
      <p>Pakdam is built for real-world play: getting people outside, together, in a place they know. Games are private and invite-only — you play with people you know, in a bounded play area your host has set on the map, with the host on site.</p>

      <h2>India-first</h2>
      <p>Pakdam is built for India first: English for now, free hosting to 30 players, and a browser-first PWA so there is nothing to download. Hindi/Hinglish support is planned for a later phase.</p>

      <h2>Built from scratch</h2>
      <p>Pakdam is built completely from scratch. No copied code, no copied design, no copied text from any other product.</p>

      <div className="callout">
        <strong>Honest limits, up front:</strong>
        <p style={{ margin: '6px 0 0' }}>Pakdam is a foreground-only PWA. Keep the app open and your screen on while you play — location stops if you lock your phone or switch apps. Pakdam is not an emergency service. Players must be 18 or older.</p>
      </div>

      <p><a href="/contact">Contact us</a> · <a href="/safety">Safety</a> · <a href="/how-it-works">How it works</a></p>
      <p className="cta-row"><a className="btn btn-lg" href="/create">Host a Game</a> <a className="btn btn-lg btn-secondary" href="/join">Join a Game</a></p>
    </div>
  );
}
