/**
 * Pick a side — Hunter vs Runner cards.
 * Shape + letter + words, never colour alone: Hunters are ◆ "H" solid,
 * Runners are ▲ "R". Copy is original Pakdam wording.
 */
export default function PickASide() {
  return (
    <section className="section" aria-labelledby="pick-a-side">
      <p className="section-kicker">Pick a side</p>
      <h2 className="section-title" id="pick-a-side">Two ways to play. One rule: get caught in person, or not at all.</h2>
      <div className="pick-grid">
        <article className="pick-card pick-card-hunter">
          <div className="pick-role">
            <span className="pick-mark pick-mark-hunter" aria-hidden="true">◆ H</span>
            <h3>Hunter</h3>
          </div>
          <p className="pick-tagline">Track the pings. Close the distance.</p>
          <ul>
            <li>Follow coarse-area pings — never an exact dot, never a live trail.</li>
            <li>Read the compass, cut off escape routes, work the shrinking zone.</li>
            <li>Tag in person: the Runner taps &ldquo;Got tagged&rdquo; to show their QR and you scan it to complete the tag — or they confirm manually if your camera can&apos;t scan. GPS alone never counts as a catch.</li>
          </ul>
          <p className="pick-cta"><a className="btn" href="/create">Host a Game</a></p>
        </article>
        <article className="pick-card pick-card-runner">
          <div className="pick-role">
            <span className="pick-mark pick-mark-runner" aria-hidden="true">▲ R</span>
            <h3>Runner</h3>
          </div>
          <p className="pick-tagline">Stay gone. Outlast the clock.</p>
          <ul>
            <li>Scatter on the head start while Hunters wait.</li>
            <li>Hunters see only a coarse area, minutes old — your exact spot stays yours.</li>
            <li>A catch needs your own confirmation. Nobody can tag you from a screen.</li>
          </ul>
          <p className="pick-cta"><a className="btn btn-secondary" href="/join">Join a Game</a></p>
        </article>
      </div>
    </section>
  );
}
