import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Host a game — Pakdam',
  description: 'Pick a game mode — Classic Manhunt or Infection — then set up your lobby. 18+, private invite-only by room code. Everything is free.',
  alternates: { canonical: '/create/mode' },
};

/** Mode picker — the step HOST A GAME leads to (video: MANHUNT /
 *  BREACH (beta) / ZOMBIE (beta) cards). Only the two playable modes
 *  exist here: Classic and Infection. Breach and Zombie are never
 *  built — no dead buttons, no beta cards. Pakdam terms throughout:
 *  Hunter / Runner, never ShadowHunt's "Shadow". Picking a mode goes
 *  to host setup with that mode pre-selected (?mode=). */
export default function ModePicker() {
  return (
    <div>
      <p><a href="/">← Home</a></p>
      <h1>Host a game</h1>
      <p>Pick a mode — the full setup comes next.</p>

      <article className="card" aria-labelledby="mode-classic">
        <h2 id="mode-classic">Classic</h2>
        <p><strong>Classic Manhunt</strong> — Hunters chase, Runners survive. Tagged Runners are out and watch live.</p>
        <p><a className="btn btn-lg" href="/create?mode=classic">Choose Classic</a></p>
        <p><a href="/game-modes">How to play</a></p>
      </article>

      <article className="card" aria-labelledby="mode-infection">
        <h2 id="mode-infection">Infection</h2>
        <p><strong>Infection</strong> — Hunters chase, Runners survive. Tagged Runners join the Hunters.</p>
        <p><a className="btn btn-lg" href="/create?mode=infection">Choose Infection</a></p>
        <p><a href="/game-modes">How to play</a></p>
      </article>

      <p className="small">Both modes are free — no payment, no membership, no paywall. 3–30 players, 18+, private invite-only by room code.</p>
    </div>
  );
}
