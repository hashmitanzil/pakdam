import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy Policy (draft) — PAKDAM',
  description: 'Pakdam Privacy Policy (draft). Location only while a match is active and in foreground; no route history kept. DPDP review notes. Lawyer review required before publication.',
  alternates: { canonical: '/legal/privacy' },
};

export default function PrivacyPage() {
  return (
    <div>
      <h1>Privacy Policy</h1>
      <div className="banner"><strong>Draft — lawyer review required, do not publish as-is.</strong><br />This page is an issue-spotting draft, NOT legal advice and NOT final legal text. Written legal review is a mandatory gate before the external pilot. Version 1, 16 November 2026.</div>
      <p><a href="/legal">← Legal index</a> · Also see the <a href="/legal/terms">Terms of Use (draft)</a> and <a href="/legal/community">Community Guidelines (draft)</a>.</p>

      <section className="journey-card" aria-labelledby="plain-words">
        <h2 id="plain-words">In plain words</h2>
        <ul>
          <li><strong>Your precise location is used only while a match is running and the app is open.</strong> It is deleted when the match ends. Your route is never kept.</li>
          <li><strong>Other players never see your exact position.</strong> Hunters see only coarse pings — a rough area, with how long ago each ping was sent.</li>
          <li><strong>We never ask for Aadhaar or any ID document.</strong> No identity documents are collected, ever.</li>
          <li><strong>We do not sell your data, show it publicly, or share it with advertisers.</strong></li>
          <li><strong>Leaving stops location sharing immediately</strong> — tap Leave / Stop sharing, close the app, or turn off location permission.</li>
          <li><strong>Several details are still OPEN</strong> — how long match records are kept, who processes data on our behalf, and what DPDP notices and rights apply. Counsel must settle them before the public pilot (see §9).</li>
        </ul>
      </section>

      <h2>1. The short version</h2>
      <p>Precise location is used only while a match is active, only in the foreground, and only while the match is in an active state. It is never written to the permanent database, never kept as history, and purged at match end. Other players never receive your exact coordinates. Positions are never sold, never shown publicly, and never shared with advertisers.</p>

      <h2>2. What we collect</h2>
      <ul>
        <li><strong>Precise location, during a match only:</strong> your latest position, used to run the game while the app is open and your screen is on. Location collection stops when you leave the match, close the app, lock your phone, or switch apps — and it stops immediately when you tap Leave / Stop sharing.</li>
        <li><strong>Contact and account details you give us:</strong> name and email when you use the contact form, file a grievance, or report a player. We use your email only to reply to that message or grievance.</li>
        <li><strong>Match records, without coordinate trails:</strong> who played and the outcome (for example duration, catches, survivors), safety events, reports, and grievances.</li>
      </ul>

      <h2>3. What we do NOT collect or keep</h2>
      <ul>
        <li>No route history. We do not keep where you have been during a match.</li>
        <li>No permanent location records. Location is not written to the permanent database.</li>
        <li>No location in grievance or contact forms. The grievance form collects no location and no file upload in Phase 0.</li>
        <li>No Aadhaar, and no identity document of any kind. We never ask for one, and we never collect one.</li>
        <li>No sale, no public display, no advertising sharing of your location.</li>
      </ul>

      <h2>4. Why we use location, and consent</h2>
      <p>Location is used only to run the match you joined — to show the game state to players in that match. You give location access through your device permission and by joining a match with the app open. You can withdraw it at any time by leaving the match, closing the app, or turning off location permission for the site; leaving stops location collection and sharing immediately. If you refuse location permission, you cannot play a match that needs it — the app will tell you so rather than playing without it. The exact consent wording, the notice shown before a match starts, and what happens on each permission state are OPEN — see §9.</p>

      <h2>5. Minimisation</h2>
      <p>We collect the latest position only, not a trail, and only while a match is active. Match totals (duration, catches, survivors) are kept; coordinate trails are not. Any further minimisation — for example whether the host or other roles need any position at all, and in what form — is for engineering and counsel to confirm (§9).</p>

      <h2>6. Retention and deletion</h2>
      <p>Location is purged at match end. How long match records, safety events, reports, and grievances are kept, and how you ask for a copy or deletion of your data, are OPEN — no retention period is stated here because none has been decided. Evidence needed: founder and counsel confirm a retention schedule and a deletion-request route, and engineering confirms deletion is actually carried out (including backups, if any). Until then, do not assume any specific retention period.</p>

      <h2>7. Who we share data with</h2>
      <p>Other players in your match see game state, never your exact coordinates. We do not sell personal data. Whether any service provider processes data on our behalf (for example hosting or maps), and where that data is processed, is OPEN — no provider is named here because none has been confirmed for the pilot. Evidence needed: engineering lists every processor and its location; counsel confirms the list and any notices or contracts it requires.</p>

      <h2>8. Security</h2>
      <p>No security claim is made on this page. What protections apply to personal data in transit and at rest, who can access it, and how a breach is handled are OPEN — evidence needed: engineering confirms the actual controls, and counsel confirms the breach-notification duties that apply. Do not treat this draft as a promise about security.</p>

      <h2>9. DPDP review notes — issue-spotting only, NOT legal advice</h2>
      <p>The Digital Personal Data Protection Act (DPDP) main provisions are scheduled to come into force on 13 May 2027. The notes below flag what counsel must decide before the external pilot; they are not a statement of what the law requires of Pakdam, and they do not promise compliance by any date.</p>
      <ul>
        <li><strong>Notices:</strong> OPEN — counsel confirms what notice a player must receive before location and contact data are collected, in what language (pilot is English only), and where it is shown (before joining a match, at account creation, or both).</li>
        <li><strong>Consent:</strong> OPEN — counsel confirms whether consent is the right basis for location and contact data, what counts as valid consent here, and how withdrawal works in practice (device permission off, Leave, or a separate in-app control).</li>
        <li><strong>Data-principal rights:</strong> OPEN — counsel confirms which rights apply and by when (access, correction, erasure, grievance redressal, nominating another person), and what route a player uses to exercise each one.</li>
        <li><strong>Children&apos;s data:</strong> OPEN — Pakdam is 18+ only in the pilot and does not knowingly collect data from under-18s; counsel confirms whether any additional check or safeguard is required, and how age is handled without collecting identity documents.</li>
        <li><strong>Data fiduciary and processors:</strong> OPEN — counsel confirms who the data fiduciary is (legal entity name — not stated here because none has been confirmed) and what contracts or notices any processor needs.</li>
        <li><strong>Retention and deletion:</strong> OPEN — see §6. Counsel confirms the schedule and the deletion route.</li>
        <li><strong>Breach notification:</strong> OPEN — counsel confirms the notification duties and timelines that apply, and who is responsible for notifying whom. No timeline is stated here.</li>
        <li><strong>Grievance handling:</strong> OPEN — see §10. Counsel confirms the grievance route and timelines under DPDP and under the Gaming Act rules.</li>
        <li><strong>Timing:</strong> OPEN — counsel confirms what must be in place before the external pilot and what, if anything, can wait until the DPDP main provisions take effect. Do not read this draft as a compliance deadline.</li>
      </ul>

      <h2>10. Grievance officer and privacy questions — OPEN</h2>
      <p>No grievance officer has been appointed yet, and no privacy contact email, phone number, or postal address exists yet. Do not treat any such contact as real — none is published, and no response timeline is promised here.</p>
      <ul>
        <li><strong>Grievance officer name:</strong> OPEN — evidence needed: founder appoints a named individual; counsel confirms the appointment in writing.</li>
        <li><strong>Grievance / privacy email:</strong> OPEN — evidence needed: a real, monitored inbox address confirmed by counsel.</li>
        <li><strong>Phone:</strong> OPEN — evidence needed: a real number confirmed by counsel, or a written decision that no phone route is offered.</li>
        <li><strong>Postal address:</strong> OPEN — evidence needed: a real address confirmed by counsel.</li>
        <li><strong>Response timelines:</strong> OPEN — evidence needed: counsel confirms the timelines that apply and they are published here; no timeline is promised until then.</li>
      </ul>
      <p>Until those items are confirmed, use the <a href="/contact">Contact form</a> for a privacy question or the <a href="/grievance">Grievance page</a> for a formal complaint. Note the contact and grievance forms in this pilot store submissions on your device only until a real support inbox and grievance queue exist — nothing has been sent to a real team yet.</p>
      <p className="small">Related: <a href="/legal">Legal index</a> · <a href="/legal/terms">Terms of Use (draft)</a> · <a href="/legal/community">Community Guidelines (draft)</a> · <a href="/safety">Safety</a> · <a href="/grievance">Grievance</a></p>
    </div>
  );
}
