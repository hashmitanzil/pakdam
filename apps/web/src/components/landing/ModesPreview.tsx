/**
 * Modes preview — two modes are playable in the pilot, picked
 * in host setup: Classic Manhunt and Infection. Breach and Zombie
 * are later, not now. Copy is Pakdam's own, from the engine's
 * MODE_INFO rules.
 */
const MODES: {
  name: string;
  statusLabel: string;
  text: string;
  note?: string;
}[] = [
  {
    name: 'Classic Manhunt',
    statusLabel: 'In the pilot',
    text: 'Hunters chase Runners across a real place. Runners get a head start, pings show a coarse area, the zone shrinks, and a catch only counts in person — the Runner shows their QR and the Hunter scans it (or the Runner confirms manually).',
  },
  {
    name: 'Infection',
    statusLabel: 'In the pilot',
    text: 'The hunt grows as Runners fall: every tagged Runner joins the Hunters instead of being out, and each flip shows live in the HUD. The round ends when every Runner has flipped — or the clock runs out first.',
  },
];

export default function ModesPreview() {
  return (
    <section className="section" aria-labelledby="modes-preview">
      <p className="section-kicker">Game modes</p>
      <h2 className="section-title" id="modes-preview">Two modes to play now.</h2>
      <p className="section-lede">Classic Manhunt and Infection — both playable in the pilot, picked in host setup.</p>
      <div className="mode-preview-grid">
        {MODES.map((mode) => (
          <article
            className="mode-preview-card mode-preview-card-live"
            key={mode.name}
          >
            <span className="mode-status mode-status-live">{mode.statusLabel}</span>
            <h3>{mode.name}</h3>
            <p>{mode.text}</p>
            {mode.note ? <p className="small">{mode.note}</p> : null}
            <p className="pick-cta"><a className="btn btn-secondary" href="/create">Host a Game</a></p>
          </article>
        ))}
      </div>
      <p className="cta-row"><a className="btn btn-secondary" href="/game-modes">See all game modes</a></p>
    </section>
  );
}
