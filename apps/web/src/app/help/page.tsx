'use client';
import { useState } from 'react';
import PageHero from '@/components/landing/PageHero';
import { queueNonCompetitive } from '@/lib/offline-queue';

/**
 * Help & support — three kinds of help, kept separate on purpose:
 *  - How to play: the answers, right here (host, join, catches, the zone,
 *    pings, location sharing). Fuller answers are on the FAQ page.
 *  - Bug report: something broken in the app. Device info only — no
 *    location, no secrets.
 *  - Formal grievance: a complaint about content, conduct, or a decision.
 *    The full form, with a GRV tracking reference and status lookup, is
 *    on the Grievance page; the short form below files the same way.
 *  Safety help lives on the Safety page. Nothing here invents a support
 *  contact or a response timeline — none is published yet.
 */
export default function HelpPage() {
  const [bug, setBug] = useState('');
  const [grievance, setGrievance] = useState('');
  const [msg, setMsg] = useState('');
  return (
    <div className="subpage">
      <PageHero
        kicker="Help & support"
        title="Stuck? Start here."
        lede="How to play, how to report something broken, and how to complain formally. Pick the kind of help you need — they go to different places."
      />

      <section className="journey-card" aria-labelledby="which-help">
        <h2 id="which-help">Which help do you need?</h2>
        <ol>
          <li>
            <strong>How do I play?</strong> — the answers are below, and in
            full on the <a href="/faq">FAQ page</a>.
          </li>
          <li>
            <strong>Something is broken in the app</strong> — file a bug
            report below.
          </li>
          <li>
            <strong>I want to complain about conduct or a decision</strong>{' '}
            — that is a formal grievance (Rule 20), on the{' '}
            <a href="/grievance">Grievance page</a>. It gives you a GRV
            tracking reference.
          </li>
          <li>
            <strong>I feel unsafe</strong> — stop playing and tell your host.
            SOS alerts your host in the game. For a real emergency, call your
            local emergency number directly — in India, 112. See{' '}
            <a href="/safety">Safety</a>.
          </li>
        </ol>
      </section>

      <h2>How to play</h2>
      <details className="faq-item" open>
        <summary>How do I host a game?</summary>
        <p>
          Tap &ldquo;Host a Game&rdquo;, set up your match — the play zone,
          the players, and the house rules — and share the invite code or
          link. Games run only in a known, bounded play area with you, the
          host, on site. You check players in at the lobby, the head start,
          mid-match, and the end.
        </p>
      </details>
      <details className="faq-item">
        <summary>How do I join a game?</summary>
        <p>
          Open your host&rsquo;s invite link, or type in the 6-letter code.
          Pick the name everyone will see, confirm you are 18 or older, and
          you are in the lobby. There is no account to create and no login —
          you join as a guest with a display name.
        </p>
      </details>
      <details className="faq-item">
        <summary>How does a catch work?</summary>
        <p>
          In person, face to face. A Hunter finds you, you tap
          &ldquo;Got tagged&rdquo; to show your QR, and the Hunter scans it —
          only then is it a catch. If the camera can&rsquo;t scan, you confirm
          it yourself instead. GPS alone never decides a catch.
        </p>
      </details>
      <details className="faq-item">
        <summary>What happens if I go outside the play zone?</summary>
        <p>
          A 30-second countdown starts on your screen. Get back inside the
          zone before it ends, or you are ejected from the game. Stay inside
          the red boundary on the map.
        </p>
      </details>
      <details className="faq-item">
        <summary>What do Hunters see about where I am?</summary>
        <p>
          Only coarse pings — a rough area, never an exact pin — with how
          long ago each ping was sent. A ping stays on the Hunter&rsquo;s map
          until the next ping replaces it. Your exact position is shared only
          if you choose to share it: with your host on SOS, or with everyone
          by holding &ldquo;Tell everyone in the game&rdquo; for 2 seconds.
          Your location is deleted when the match ends.
        </p>
      </details>
      <details className="faq-item">
        <summary>Does the game work with my phone locked?</summary>
        <p>
          No. This is a foreground-only PWA — location, safety pause, SOS
          and Leave stop when the app is suspended. Keep the app open and
          your screen on while you play.
        </p>
      </details>

      <h2>Bug report</h2>
      <p className="small">
        Bug reports contain device info only — no location, no secrets. A bug
        report is for something broken in the app. For a complaint about
        conduct or a decision, use the grievance form below or the{' '}
        <a href="/grievance">Grievance page</a>.
      </p>
      <label className="label" htmlFor="bug-desc">
        What went wrong? Which screen?
      </label>
      <textarea
        id="bug-desc"
        className="input"
        rows={3}
        value={bug}
        onChange={(e) => setBug(e.target.value)}
        placeholder="What went wrong? Which screen?"
      />
      <p>
        <button
          className="btn btn-lg btn-secondary"
          onClick={() => {
            queueNonCompetitive('bug-report', {
              description: bug,
              deviceInfo: navigator.userAgent,
            });
            setMsg('Bug report saved (queued as a non-competitive action).');
            setBug('');
          }}
        >
          Send bug report
        </button>
      </p>

      <h2>Formal grievance (Gaming Act, Rule 20)</h2>
      <p className="small">
        A grievance is a formal complaint, distinct from a bug report. It is
        meant to end with a documented response. No grievance officer has
        been appointed yet and no response timeline is promised — the officer
        contact and timelines are confirmed by counsel before the public
        pilot. The full form, with status lookup, is on the{' '}
        <a href="/grievance">Grievance page</a>.
      </p>
      <label className="label" htmlFor="grievance-desc">
        Your grievance
      </label>
      <textarea
        id="grievance-desc"
        className="input"
        rows={3}
        value={grievance}
        onChange={(e) => setGrievance(e.target.value)}
        placeholder="Your grievance…"
      />
      <p>
        <button
          className="btn btn-lg btn-secondary"
          onClick={() => {
            const ref = 'GRV-' + String(Math.floor(1000 + Math.random() * 9000));
            const now = new Date().toISOString();
            const items = JSON.parse(
              localStorage.getItem('pakdam.grievances.v1') ?? '[]',
            ) as {
              ref: string;
              name: string;
              email: string;
              type: string;
              roomRef: string;
              description: string;
              status: string;
              at: string;
              updatedAt: string;
            }[];
            items.push({
              ref,
              name: '',
              email: '',
              type: 'Other',
              roomRef: '',
              description: grievance,
              status: 'received',
              at: now,
              updatedAt: now,
            });
            localStorage.setItem('pakdam.grievances.v1', JSON.stringify(items));
            queueNonCompetitive('grievance', { ref, summary: grievance });
            setMsg(
              `Grievance filed (stored on this device). Your tracking reference is ${ref}. Check it on the Grievance page.`,
            );
            setGrievance('');
          }}
        >
          File grievance
        </button>
      </p>
      {msg ? <p role="status">{msg}</p> : null}

      <p>
        More answers: <a href="/faq">FAQ</a> · <a href="/safety">Safety</a>{' '}
        · <a href="/grievance">Grievance</a> ·{' '}
        <a href="/accessibility">Accessibility</a> ·{' '}
        <a href="/contact">Contact us</a>
      </p>
    </div>
  );
}
