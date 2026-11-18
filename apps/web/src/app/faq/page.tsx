import type { Metadata } from 'next';
import PageHero from '@/components/landing/PageHero';

export const metadata: Metadata = {
  title: 'FAQ — PAKDAM',
  description:
    'Pakdam questions answered: hosting, joining, catches, pings, the play zone, locked screens, iPhone, GPS, signal loss, data, age, reporting, and cost.',
  alternates: { canonical: '/faq' },
};

const QA: { id: string; q: string; a: string }[] = [
  {
    id: 'host',
    q: 'How do I host a game?',
    a: 'Tap “Host a Game”, set up your match — the play zone, the players, and the house rules — and share the invite code or link with your players. Games run only in a known, bounded play area with you, the host, on site. You check players in at the lobby, the head start, mid-match, and the end.',
  },
  {
    id: 'join',
    q: 'How do I join a game?',
    a: 'Your host sends you an invite link or a 6-letter code. Open the link or type the code in, pick the name everyone will see, confirm you are 18 or older, and you are in the lobby. There is no account to create and no login — you join as a guest with a display name.',
  },
  {
    id: 'download',
    q: 'Do I need to download anything?',
    a: 'No. Pakdam is a browser PWA — you open the invite link and play. Installing it to your home screen is optional; see the Install page.',
  },
  {
    id: 'locked-screen',
    q: 'Does it work with my screen locked?',
    a: 'No. In Phase 0 Pakdam is foreground-only. Location, safety pause, SOS and Leave stop if you lock your phone or switch apps. Keep the app open and your screen on while you play.',
  },
  {
    id: 'iphone',
    q: 'Does it work on iPhone?',
    a: 'Yes, in Safari or as an installed PWA. Background location does not work on iPhone in the PWA — see the Install page.',
  },
  {
    id: 'catch',
    q: 'How does a catch work — how do I get tagged?',
    a: 'In person, face to face. A Hunter finds you, you show your QR, and you confirm it — only then is it a catch. GPS alone never decides a catch, and nobody can tag you by grabbing you or your phone.',
  },
  {
    id: 'outside-zone',
    q: 'What happens if I go outside the play zone?',
    a: 'A 30-second countdown starts on your screen. Get back inside the zone before it ends, or you are ejected from the game. Ejected players are out — they are never survivors and never “caught”. Stay inside the red boundary on the map.',
  },
  {
    id: 'pings',
    q: 'What are pings, and how fresh are they?',
    a: 'Pings are coarse location hints for Hunters — a rough area, never an exact pin. A ping stays on the Hunter’s map until the next ping replaces it, and it always shows how long ago it was sent ("0:27 ago", counting up), so Hunters can tell how stale it is. Other players never receive your exact coordinates.',
  },
  {
    id: 'location-sharing',
    q: 'Who sees my location while a round is running?',
    a: 'Only the game itself, while the round is running and the app is open. Hunters see coarse pings, never your exact position. Your exact position is shared only if you choose to share it — with your host when you tap SOS, or with everyone when you hold “Tell everyone in the game” for 2 seconds. Your location is deleted when the match ends, and your route is never kept.',
  },
  {
    id: 'exact-location',
    q: 'Can Hunters see exactly where I am?',
    a: 'No. Hunters see only a coarse area / hot-cold pings, with “last reported X min ago”. Other players never receive your exact coordinates.',
  },
  {
    id: 'signal',
    q: 'What happens if I lose signal?',
    a: 'You are marked suspended. Nothing is decided while you are offline — a catch cannot complete while the Runner is suspended; they must reopen the PWA first.',
  },
  {
    id: 'sos',
    q: 'What do SOS and Safety Pause do?',
    a: 'SOS alerts your host, shares your position with your host, and pauses the match — but it does not call emergency services. Safety Pause stops the match clock for everyone and can be tapped by any player, for any reason. Both work only while the app is open and your screen is on. Full detail on the Safety page.',
  },
  {
    id: 'data',
    q: 'What data do you keep?',
    a: 'No route history. Precise location is used only while a match is active, only in the foreground, and is purged at match end. Only totals (duration, catches, survivors) are kept after the game. We never ask for Aadhaar or any ID document. See the Privacy Policy on the Legal page.',
  },
  {
    id: 'age',
    q: 'How old do I have to be?',
    a: '18 or older. Pakdam is 18+ only, and private invite-only.',
  },
  {
    id: 'report',
    q: 'How do I report someone?',
    a: 'In a lobby, tap the player’s name to report or block them — the player is never told. Blocking only changes what you see on your device. For a formal complaint about conduct or a decision, file a grievance on the Grievance page and keep your GRV tracking reference.',
  },
  {
    id: 'cost',
    q: 'How much does it cost?',
    a: 'Free hosting to 30 players. There is no purchase flow — no payment, no membership.',
  },
];

export default function FaqPage() {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: QA.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a },
    })),
  };
  return (
    <div className="subpage">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <PageHero
        kicker="FAQ"
        title="Asked, answered — honestly."
        lede="Hosting, joining, catches, pings, the play zone, locked screens, iPhone, GPS, signal loss, data, age, reporting, and cost. If it is not answered here, ask on the Help page."
      />
      {QA.map((item) => (
        <details className="faq-item" key={item.id} id={item.id}>
          <summary>{item.q}</summary>
          <p>{item.a}</p>
        </details>
      ))}
      <p>
        Still stuck? <a href="/help">Help &amp; support</a> ·{' '}
        <a href="/contact">Contact us</a> ·{' '}
        <a href="/grievance">File a grievance</a> ·{' '}
        <a href="/safety">Safety</a>
      </p>
    </div>
  );
}
