import type { Metadata } from 'next';
import PageHero from '@/components/landing/PageHero';
import GrievanceForm from '@/components/grievance/GrievanceForm';

export const metadata: Metadata = {
  title: 'Grievance — Pakdam formal grievance channel',
  description:
    'Raise a formal grievance with Pakdam (Rule 20). Track your case by its reference number.',
  alternates: { canonical: '/grievance' },
};

/** Re-exported so the admin queue page can keep importing the record type
 *  from this route (`@/app/grievance/page`). Type-only: erased at compile,
 *  so it adds no runtime export to the page module. */
export type { GrievanceRecord } from '@/components/grievance/GrievanceForm';

export default function GrievancePage() {
  return (
    <div className="subpage">
      <PageHero
        kicker="Grievance · Rule 20"
        title="Something went wrong? Tell us properly."
        lede="A grievance is a formal complaint — about content, conduct, or a decision. It is different from a bug report, and it gets a tracking reference you can check."
      />

      <div className="callout" role="note">
        <strong>Please read before you file.</strong> No grievance officer
        has been appointed yet, and no grievance contact or response timeline
        exists yet. Nothing on this page invents one. In this pilot build
        your grievance is stored on this device only, until a real grievance
        queue exists — it has not been sent to a real team yet. What happens
        next, and how fast, is decided by counsel and the founder before the
        public pilot.
      </div>

      <section className="journey-card" aria-labelledby="how-it-works">
        <h2 id="how-it-works">How it works — four steps</h2>
        <ol>
          <li>
            <strong>File below.</strong> Tell us your name, an email we can
            reply to, what kind of grievance it is, and what happened. The
            form asks for no location and no file upload.
          </li>
          <li>
            <strong>Keep your reference.</strong> You will get a tracking
            reference like <strong>GRV-1234</strong>. Write it down — you
            need it, with the email you filed with, to check your case.
          </li>
          <li>
            <strong>Check your status below</strong> with your reference and
            email. Your grievances filed on this device are also listed at
            the bottom of this page.
          </li>
          <li>
            <strong>Wait for a documented response.</strong> A grievance is
            meant to end with a written answer. No timeline is promised here
            yet — the timelines that apply are confirmed by counsel before
            the public pilot.
          </li>
        </ol>
      </section>

      <h2>Grievance or bug report?</h2>
      <ul>
        <li>
          <strong>Grievance (this page):</strong> you were removed unfairly,
          you reported a player and nothing happened, or you disagree with a
          decision about you.
        </li>
        <li>
          <strong>Bug report (<a href="/help">Help page</a>):</strong>{' '}
          something is broken in the app — a button does nothing, the map
          will not load, the game froze.
        </li>
        <li>
          <strong>Unsafe right now:</strong> stop playing and tell your
          host. SOS alerts your host in the game. For a real emergency, call
          your local emergency number directly — in India, 112. See{' '}
          <a href="/safety">Safety</a>.
        </li>
      </ul>

      <GrievanceForm />

      <p className="small">
        Related: <a href="/legal">Legal index</a> ·{' '}
        <a href="/legal/community">Community Guidelines (draft)</a> ·{' '}
        <a href="/safety">Safety</a> · <a href="/help">Help &amp; support</a>
      </p>
    </div>
  );
}
