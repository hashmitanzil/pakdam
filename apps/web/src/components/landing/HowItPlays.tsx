/**
 * How a Pakdam round plays — 4 steps, original Pakdam wording.
 * Location-first: the host starts from where they are standing; the zone
 * sizes itself to the player count. No naming step anywhere.
 */
const STEPS: { title: string; text: string }[] = [
  {
    title: 'Start where you stand',
    text: 'The host uses their location as the centre. The play zone sizes itself to the player count, and the host can adjust it with a slider. No name, no typing — just a place on the map.',
  },
  {
    title: 'Invite your people',
    text: 'Share a private room code or link with friends. Games are invite-only — there are no public lobbies and no strangers.',
  },
  {
    title: 'Scatter, then hunt',
    text: 'Runners get a head start to hide while Hunters wait. Then the chase begins: pings show a coarse area, the zone slowly shrinks, and the clock runs down.',
  },
  {
    title: 'Caught — in person',
    text: 'A Hunter tags a Runner in person. The Runner taps “Got tagged” to show their QR and the Hunter scans it — or the Runner confirms manually if the camera can’t scan. Only then is it a catch. GPS alone never decides one.',
  },
];

export default function HowItPlays() {
  return (
    <section className="section" aria-labelledby="how-it-plays">
      <p className="section-kicker">How it plays</p>
      <h2 className="section-title" id="how-it-plays">Four steps from standing around to running for your life.</h2>
      <div className="steps-grid">
        {STEPS.map((step, i) => (
          <article className="step-card" key={step.title}>
            <span className="step-num" aria-hidden="true">{i + 1}</span>
            <h3><span className="sr-only">Step {i + 1} of {STEPS.length}: </span>{step.title}</h3>
            <p>{step.text}</p>
          </article>
        ))}
      </div>
      <p className="cta-row"><a className="btn btn-secondary" href="/how-it-works">The full how-it-works</a></p>
    </section>
  );
}
