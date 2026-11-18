import { SOS_COPY } from '@pakdam/engine';
import type { Metadata } from 'next';
import PageHero from '@/components/landing/PageHero';
import BlockedList from './blocked-list';

export const metadata: Metadata = {
  title: 'Safety — PAKDAM',
  description:
    'Pakdam safety rules, SOS, safety pause, tell-everyone hold-to-reveal, leave, host check-ins, and location privacy. Foreground-only: safety features work while the app is open.',
  alternates: { canonical: '/safety' },
};

export default function SafetyPage() {
  return (
    <div className="subpage">
      <PageHero
        kicker="Safety"
        title="The game stops for safety. No exceptions."
        lede="Pakdam is played in the real world, with real people, in real streets. These rules are not flavour text — they are how every game is run."
      />

      <div className="callout" role="note">
        <strong>Read this first.</strong> Safety pause, SOS, &ldquo;Tell everyone&rdquo;
        and Leave work <strong>only while this app is open and your screen is
        on</strong>. If you lock your phone or switch apps, you cannot trigger
        them until you reopen the app. Keep the app open and your screen on
        while you play.
      </div>

      <section className="journey-card" aria-labelledby="unsafe-now">
        <h2 id="unsafe-now">If you feel unsafe right now</h2>
        <ol>
          <li>
            <strong>Stop playing.</strong> Step somewhere safe and put your
            phone away if you need to.
          </li>
          <li>
            <strong>Tell your host.</strong> Your host is on site at every
            game. If the app is open, tap <strong>SOS</strong> — it alerts
            your host and pauses the match.
          </li>
          <li>
            <strong>For a real emergency, call your local emergency number
            directly — in India, 112.</strong> Pakdam does not call anyone
            for you.
          </li>
        </ol>
      </section>

      <h2>Your safety tools — what each button does</h2>
      <p>
        These buttons are always on screen while you play, at the bottom of
        the play screen, where your thumb can reach them. They work only
        while the app is open and your screen is on.
      </p>

      <div className="safety-grid">
        <section className="journey-card" aria-labelledby="sos">
          <h2 id="sos">SOS</h2>
          <p>
            Tap <strong>SOS</strong>, then confirm. It alerts your host, shares
            your position with your host, and pauses the match — so nobody
            keeps playing while you need help.
          </p>
          <p>{SOS_COPY}</p>
          <p>
            SOS asks you to confirm first, so a tap in your pocket cannot
            set it off by accident.
          </p>
        </section>

        <section className="journey-card" aria-labelledby="safety-pause">
          <h2 id="safety-pause">Safety pause</h2>
          <p>
            Any player can pause the game at any time, for any reason. The
            match clock stops for everyone — no timers run, no catches count
            — until the game is resumed.
          </p>
          <p>
            In the lobby, a pause holds the start: the host cannot start the
            game while it is paused. The host — or the player who paused —
            resumes the game.
          </p>
        </section>

        <section className="journey-card" aria-labelledby="tell-everyone">
          <h2 id="tell-everyone">Tell everyone in the game</h2>
          <p>
            Lost, separated from the group, or need help finding you? Press
            and <strong>hold this button for 2 seconds</strong>. It shares
            your exact position with every player in the game, so they can
            come to you.
          </p>
          <p>
            The 2-second hold is on purpose: a quick tap cannot share your
            exact position by accident. This is the one button that shares
            your exact position with other players — nothing else in the game
            does.
          </p>
        </section>

        <section className="journey-card" aria-labelledby="leave">
          <h2 id="leave">Leave / Stop sharing</h2>
          <p>
            Always available while the app is open. Leaving stops location
            collection and sharing immediately, and takes you out of the
            match. Anyone can leave at any time, for any reason — nobody can
            make you keep playing.
          </p>
        </section>

        <section className="journey-card" aria-labelledby="im-safe">
          <h2 id="im-safe">&ldquo;I&rsquo;m safe&rdquo; check-in</h2>
          <p>
            A quiet check-in, not an alarm. Tap it to tell your host you are
            OK — for example at a host check-in — without raising an SOS or
            pausing the game.
          </p>
        </section>

        <section className="journey-card" aria-labelledby="not-emergency">
          <h2 id="not-emergency">Not an emergency service</h2>
          <p>
            Pakdam is not an emergency-response service. SOS alerts your host
            in this game — it does not contact emergency services, and it does
            not guarantee that anyone will respond. Nobody at Pakdam watches
            your game live. For a real emergency, contact your local emergency
            services directly.
          </p>
        </section>
      </div>

      <h2>Before you play — the ground rules</h2>
      <ul>
        <li>
          <strong>Play in daylight, or in places you know well and can see
          clearly.</strong> If you cannot see where you are stepping, stop
          and wait.
        </li>
        <li>
          <strong>Stay inside the play zone</strong> — the bounded area your
          host set for this game. Outside it, a 30-second countdown starts:
          get back inside before it ends, or you are ejected from the game.
        </li>
        <li>
          <strong>No roads, railways, water edges, rooftops, construction
          sites, or private property.</strong> Never enter a place you are
          not allowed to be in, and never cross a road while looking at your
          phone.
        </li>
        <li>
          <strong>Walk, don&rsquo;t run blind.</strong> No running while looking
          at your phone. Look up, watch where you are going, and stop moving
          to check the screen.
        </li>
        <li>
          <strong>No grabbing, blocking, tackling, or forced phone
          handling.</strong> A catch happens face to face: the Runner shows
          their QR and the Hunter scans it (or the Runner confirms manually)
          — never by grabbing someone or their phone.
        </li>
        <li>
          <strong>Keep your phone charged and the app open.</strong> If your
          phone dies, or you lock it or switch apps, you are out of contact
          until you come back — and your safety buttons will not work until
          then.
        </li>
        <li>
          <strong>Games run only in a known, bounded play area with the host
          on site.</strong> That is the pilot rule: no host on site, no game.
        </li>
        <li>
          <strong>If you feel unwell or unsafe, stop playing and tell the
          host.</strong> You do not need a reason, and nobody will ask you
          for one.
        </li>
      </ul>

      <h2>Host check-ins</h2>
      <p>
        Your host checks in with everyone at four points: in the lobby,
        during the head start, in the middle of the match, and at the end.
        If a player is missing at a check-in, the host pauses the game and
        follows up — the game does not carry on without knowing where
        everyone is.
      </p>

      <h2>Your location — what other players can and cannot see</h2>
      <ul>
        <li>
          <strong>Hunters never see your exact position.</strong> They see
          only coarse pings — a rough area, not a pin — with how long ago
          each ping was sent.
        </li>
        <li>
          <strong>Your exact position is shared only if you choose to share
          it</strong> — with your host when you tap SOS, or with everyone
          when you hold &ldquo;Tell everyone in the game&rdquo; for 2 seconds.
        </li>
        <li>
          <strong>We don&rsquo;t keep your route.</strong> Only your latest
          position is used during the game. Route history is not stored, and
          your location is deleted when the match ends. Only totals
          (duration, catches, survivors) are kept after the game.
        </li>
        <li>
          Positions are never sold, never shown publicly, and never shared
          with advertisers. Full detail: <a href="/legal/privacy">Privacy
          Policy (draft)</a>.
        </li>
      </ul>

      <h2>What Pakdam does NOT do</h2>
      <ul>
        <li>It does not call the police, an ambulance, or any emergency service.</li>
        <li>Nobody at Pakdam watches your game or your location live.</li>
        <li>It does not track you when the app is closed, your phone is locked, or you have left the match.</li>
        <li>It does not decide a catch by GPS. A catch needs the Runner&rsquo;s QR scan (or their manual confirmation), in person.</li>
        <li>It does not keep a record of where you went. Your route is never stored.</li>
      </ul>

      <h2>Report or block a player</h2>
      <p>
        In a lobby, tap a player&rsquo;s name to report them or block them. A
        report goes to the host in the room log — the player is never told.
        Blocking is local to this device: it hides them from your friends
        and &ldquo;Played with&rdquo; lists and marks them &ldquo;Blocked by
        you&rdquo; in the lobby. It does not remove them from the game and
        does not tell them.
      </p>
      <p>
        Only the host can remove a player — and only from the lobby, before
        the game starts. From the{' '}
        <a href="/leaderboards">leaderboard</a> you can report a board entry
        the same way.
      </p>
      <p>
        A formal complaint about conduct or a decision is a{' '}
        <a href="/grievance">grievance (Rule 20)</a>, with a GRV tracking
        reference. No grievance officer has been appointed yet, and no
        grievance contact is published yet — see the{' '}
        <a href="/grievance">Grievance page</a> for the honest position.
      </p>

      <h2>Your blocked players (this device only)</h2>
      <BlockedList />

      <p>
        Safety questions, or something that felt wrong in a game?{' '}
        <a href="/help">Get help</a> · <a href="/grievance">File a
        grievance</a> · <a href="/accessibility">Accessibility settings</a>
      </p>

      <p className="cta-row">
        <a className="btn btn-lg" href="/create">Create a game (host)</a>{' '}
        <a className="btn btn-lg btn-secondary" href="/how-it-works">How it works</a>
      </p>
    </div>
  );
}
