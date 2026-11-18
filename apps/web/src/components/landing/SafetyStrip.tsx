/**
 * Safety strip — the safety facts, in plain language, on the landing page.
 * Pakdam is not an emergency service. Safety pause, SOS and Leave only
 * work while the app is open and the screen is on (foreground-only PWA).
 */
const ITEMS: { title: string; text: string }[] = [
  { title: 'SOS alerts your host', text: 'One tap sends an SOS to the host. Pakdam is not an emergency service — in a real emergency, call local emergency services first.' },
  { title: 'Anyone can pause', text: 'Any player can trigger a safety pause. The game stops until the host checks in and everyone is accounted for.' },
  { title: 'Leave anytime', text: 'You can leave a game at any time, for any reason, no questions asked.' },
  { title: 'Host on site', text: 'Games run in a known, bounded play area with the host present, start to finish.' },
  { title: '18+ only', text: 'Every player is 18 or older, playing with people they know in a private, invite-only game.' },
  { title: 'No exact locations, ever', text: 'Hunters see a coarse area, never an exact dot. Your route is never stored, and a catch is never decided by GPS alone.' },
];

export default function SafetyStrip() {
  return (
    <section className="section" aria-labelledby="safety-strip">
      <div className="safety-strip">
        <p className="section-kicker" style={{ color: 'var(--ember-light)' }}>Safety first, always</p>
        <h2 id="safety-strip">Real streets. Real rules. Real people looking out for each other.</h2>
        <p className="section-lede">No roads, railways, water edges, rooftops or trespass. No grabbing or forced phone handling. <a href="/safety">Read the full safety rules</a>.</p>
        <div className="safety-strip-grid">
          {ITEMS.map((item) => (
            <div className="safety-strip-item" key={item.title}>
              <strong>{item.title}</strong>
              <p>{item.text}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
