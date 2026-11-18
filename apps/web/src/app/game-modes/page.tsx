import type { Metadata } from 'next';
import PageHero from '@/components/landing/PageHero';
import { MODE_INFO } from '@pakdam/engine';
import type { MatchMode } from '@pakdam/shared';

export const metadata: Metadata = {
  title: 'Game modes — PAKDAM',
  description: 'Pakdam game modes: Classic Manhunt and Infection — both playable, picked in host setup. 3–30 players, 18+, private invite-only by room code. Everything is free — no payment, no membership.',
  alternates: { canonical: '/game-modes' },
};

/** Mode cards read the engine's own rulebook (MODE_INFO) so the page
 *  can never disagree with host setup about what a mode does.
 *  Two modes are playable in the pilot, picked in host setup:
 *  Classic Manhunt and Infection. Breach and Zombie are later, not
 *  now — they are not offered anywhere in the app. */
const MODES: MatchMode[] = ['classic', 'infection'];

export default function GameModesPage() {
  return (
    <div className="subpage">
      <PageHero
        kicker="Game modes"
        title="Two modes in the pilot — both playable."
        lede="Classic Manhunt and Infection are both playable from host setup in the pilot. The host sets every rule: mode, teams, round length, head start, pings, zone shrink and the outside-zone rule (30 seconds to get back inside, or you are ejected)."
      />

      <p><strong>Everything is free — no payment, no membership, no paywall.</strong></p>

      <div className="mode-card">
        <h2 style={{ marginTop: 0 }}>Every mode, same ground rules</h2>
        <ul>
          <li>3–30 players, adults-only 18+</li>
          <li>Private invite-only by room code — no public listing</li>
          <li>One host, Hunters vs Runners</li>
          <li>Teams: the host picks the Hunters in the lobby, or lets Random fill them</li>
          <li>Shrinking zone, scheduled pings, in-person catch</li>
          <li>In-person tag first — then the Runner shows their QR and the Hunter scans it to complete the catch (or the Runner confirms manually if the camera is unavailable). Unless the host turned confirmation off, in which case the tag counts at once and the Runner may still dispute it afterwards</li>
          <li>Outside the zone? A 30-second countdown appears on your screen — get back inside before it ends, or you are ejected from the game</li>
          <li>Foreground-only PWA: keep the app open and your screen on while you play</li>
        </ul>
      </div>

      {MODES.map((mode) => {
        const info = MODE_INFO[mode];
        return (
          <div className="mode-card" key={mode}>
            <p>
              <span className="mode-status mode-status-live">
                In the pilot
              </span>
            </p>
            <h2 style={{ marginTop: 0 }}>{info.label} — available now</h2>
            <p>{info.short}</p>
            <p>{info.catchRule}</p>
            <p>{info.winRule}</p>
            <p className="cta-row"><a className="btn btn-lg" href="/create">Host a Game</a></p>
          </div>
        );
      })}

      <p className="small">Everything in Pakdam is free — no payment, no membership, no paywall.</p>
      <p className="cta-row"><a className="btn btn-lg" href="/create">Host a Game</a> <a className="btn btn-lg btn-secondary" href="/join">Join a Game</a></p>
    </div>
  );
}
