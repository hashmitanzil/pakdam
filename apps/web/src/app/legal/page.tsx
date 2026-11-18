import type { Metadata } from 'next';
import PageHero from '@/components/landing/PageHero';

export const metadata: Metadata = {
  title: 'Legal — PAKDAM',
  description:
    'Pakdam legal index (draft). Terms of Use, Privacy Policy, and Community Guidelines. 18+, private invite-only. Lawyer review required before publication.',
  alternates: { canonical: '/legal' },
};

export default function LegalPage() {
  return (
    <div className="subpage">
      <PageHero
        kicker="Legal"
        title="The rules, in plain words first."
        lede="Pakdam is a real-world game played in person, for adults only, by private invitation. These pages are drafts — a lawyer must review them before the public pilot."
      />
      <div className="banner">
        <strong>Draft — lawyer review required, do not publish as-is.</strong>
        <br />
        These pages are issue-spotting drafts, NOT legal advice and NOT final
        legal text. Written legal review is a mandatory gate before the
        external pilot (Gaming Act 2025 / Rules 2026, DPDP, CERT-In).
        Version 1, 16 November 2026.
      </div>

      <section className="journey-card" aria-labelledby="plain-words">
        <h2 id="plain-words">In plain words</h2>
        <ul>
          <li>
            <strong>18+ only, private invite-only.</strong> You play with
            people you were invited to play with, in a place your host knows,
            with the host on site.
          </li>
          <li>
            <strong>Pakdam is not an emergency service.</strong> SOS alerts
            your host — it does not call emergency services.
          </li>
          <li>
            <strong>Your location is used only while a match is running and
            the app is open.</strong> It is deleted when the match ends. Your
            route is never kept. Other players never see your exact position.
          </li>
          <li>
            <strong>We never ask for Aadhaar or any ID document.</strong> No
            identity documents are collected.
          </li>
          <li>
            <strong>No payment, no membership.</strong> There is no purchase
            flow in Phase 0.
          </li>
          <li>
            <strong>If something goes wrong, you can complain formally.</strong>{' '}
            See the <a href="/grievance">Grievance page</a> (Rule 20). No
            grievance officer has been appointed yet — that is still open,
            and this site does not pretend otherwise.
          </li>
        </ul>
      </section>

      <h2>Documents</h2>
      <ul>
        <li>
          <a href="/legal/terms">Terms of Use (draft)</a> — who can play,
          what Pakdam is and is not, your responsibilities, and what is
          still open.
        </li>
        <li>
          <a href="/legal/privacy">Privacy Policy (draft)</a> — what
          location and other data we collect, what we do not keep, and DPDP
          review notes.
        </li>
        <li>
          <a href="/legal/community">Community Guidelines (draft)</a> —
          expected behaviour, prohibited conduct, reporting, and how reports
          are handled.
        </li>
      </ul>

      <h2>Grievance officer — OPEN</h2>
      <p>
        No grievance officer has been appointed yet, and no grievance contact
        details exist yet. Do not treat any name, email, phone number, postal
        address, or response timeline on this site as real — none is
        published, and none is promised here.
      </p>
      <ul>
        <li>
          <strong>Officer name:</strong> OPEN — evidence needed: founder
          appoints a named individual; counsel confirms the appointment in
          writing.
        </li>
        <li>
          <strong>Email:</strong> OPEN — evidence needed: a real, monitored
          inbox address confirmed by counsel.
        </li>
        <li>
          <strong>Phone:</strong> OPEN — evidence needed: a real number
          confirmed by counsel, or a written decision that no phone route is
          offered.
        </li>
        <li>
          <strong>Postal address:</strong> OPEN — evidence needed: a real
          address confirmed by counsel.
        </li>
        <li>
          <strong>Acknowledgement and resolution timelines:</strong> OPEN —
          evidence needed: counsel confirms the timelines that apply and they
          are published here; no timeline is promised until then.
        </li>
      </ul>
      <p>
        Until those items are confirmed, file a formal grievance on the{' '}
        <a href="/grievance">Grievance page</a> (distinct from a bug report,
        which goes to the <a href="/help">Help page</a>). The grievance form
        collects no location and no file upload in Phase 0.
      </p>

      <h2>DPDP review note</h2>
      <p className="small">
        Issue-spotting only, NOT legal advice. The DPDP Act&apos;s main
        provisions are scheduled to come into force on 13 May 2027. What
        notices, consent, data-principal rights, and grievance handling
        Pakdam must provide — and by when — is for counsel to confirm before
        the external pilot. See the DPDP review notes on the{' '}
        <a href="/legal/privacy">Privacy Policy (draft)</a> page.
      </p>

      <h2>Foreground-only — please read</h2>
      <p>
        Pakdam works only while the app is open and your screen is on. If
        you lock your phone or switch apps, location sharing, SOS, safety
        pause, and Leave stop working until you reopen the app. Pakdam is not
        an emergency service: SOS alerts your host — it does not contact
        emergency services. For a real emergency, contact your local
        emergency services directly. Full detail: <a href="/safety">Safety</a>.
      </p>
    </div>
  );
}
