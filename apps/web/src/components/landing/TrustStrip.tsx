/**
 * Trust strip — the four things that make a Pakdam match work.
 * Plain language, no invented stats or timings. Privacy first:
 * pings are coarse areas, never an exact dot, never a live trail.
 */
const ITEMS: { icon: string; title: string; text: string }[] = [
  { icon: '◉', title: 'Live GPS pings', text: 'Hunters get a coarse area, minutes old — never an exact dot, never a live trail. Your exact spot stays yours.' },
  { icon: '◎', title: 'Shrinking zone', text: 'The play area closes in as the clock runs down, with the next edge previewed — so every match ends, and hiding gets harder.' },
  { icon: '➤', title: 'Compass', text: 'A compass and a hot/cold readout point Hunters toward the area — not toward a person. No one is tracked step by step.' },
  { icon: '#', title: 'Room codes', text: 'Every game is private and invite-only. The room code is the only way in — no public lobbies, no strangers.' },
];

export default function TrustStrip() {
  return (
    <section className="section" aria-labelledby="how-it-works-strip">
      <p className="section-kicker">How a match works</p>
      <h2 className="section-title" id="how-it-works-strip">Four things running every match.</h2>
      <div className="trust-strip trust-strip-4">
        {ITEMS.map((item) => (
          <div className="trust-item" key={item.title}>
            <span className="trust-icon" aria-hidden="true">{item.icon}</span>
            <div>
              <strong>{item.title}</strong>
              <p>{item.text}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
