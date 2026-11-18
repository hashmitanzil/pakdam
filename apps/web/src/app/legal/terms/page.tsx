import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Terms of Use (draft) — PAKDAM',
  description: 'Pakdam Terms of Use (draft). 18+, private invite-only, foreground-only PWA. Lawyer review required before publication.',
  alternates: { canonical: '/legal/terms' },
};

export default function TermsPage() {
  return (
    <div>
      <h1>Terms of Use</h1>
      <div className="banner"><strong>Draft — lawyer review required, do not publish as-is.</strong><br />This page is an issue-spotting draft, NOT legal advice and NOT final legal text. It does not create a binding agreement in this form. Written legal review is a mandatory gate before the external pilot. Version 1, 16 November 2026.</div>
      <p><a href="/legal">← Legal index</a> · Also see the <a href="/legal/privacy">Privacy Policy (draft)</a> and <a href="/legal/community">Community Guidelines (draft)</a>.</p>

      <section className="journey-card" aria-labelledby="plain-words">
        <h2 id="plain-words">In plain words</h2>
        <ul>
          <li><strong>You must be 18 or older</strong> and playing by private invitation, in a place your host knows, with the host on site.</li>
          <li><strong>The app only works while it is open and your screen is on.</strong> Lock your phone or switch apps, and location, SOS, safety pause and Leave stop until you come back.</li>
          <li><strong>Pakdam is not an emergency service.</strong> SOS tells your host — it does not call emergency services.</li>
          <li><strong>Play safely and fairly.</strong> Stay in the play zone, stay off roads, railways, water edges, rooftops and private property, and never grab anyone or their phone. No faking your location.</li>
          <li><strong>We never ask for Aadhaar or any ID document.</strong> How age is checked without identity documents is still an open question for counsel (see §9).</li>
          <li><strong>This is a pilot.</strong> Things may change or be unavailable at times, and several items below are still OPEN — a lawyer and the founder must settle them before the public pilot.</li>
        </ul>
      </section>

      <h2>1. What Pakdam is</h2>
      <p>Pakdam is a real-world GPS hide-and-seek game, played in person in a bounded venue. Phase 0 offers Classic Manhunt only, in English only, for adults aged 18 and over, by private invitation only. Pakdam is a work in progress — a pilot.</p>

      <h2>2. Foreground-only — a hard limit, not a feature</h2>
      <p>Pakdam is a web PWA. Location sharing, SOS, safety pause, and Leave work only while the app is open and your screen is on. If you lock your phone, switch apps, or lose signal, those features stop working until you reopen the app. Do not rely on Pakdam to track you, find you, or keep you safe while it is not open.</p>

      <h2>3. Not an emergency service</h2>
      <p>Pakdam is not an emergency-response or emergency-dispatch service. SOS alerts your host — it does not contact emergency services, and it does not guarantee that anyone will respond. For a real emergency, contact your local emergency services directly.</p>

      <h2>4. Who can play</h2>
      <ul>
        <li>18+ only. Pakdam does not knowingly admit players under 18 in the pilot.</li>
        <li>Private invite-only. Games run only in a known, bounded venue with the host on site (venue-only pilot).</li>
        <li>Play only if you are physically able to do so safely, and stop playing if you feel unwell or unsafe.</li>
      </ul>

      <h2>5. Your responsibilities</h2>
      <ul>
        <li>Follow the venue rules and the host&apos;s instructions, including host check-ins.</li>
        <li>No roads, railways, water edges, rooftops, construction sites, or trespass. No running while looking at your phone, and no crossing roads while playing.</li>
        <li>No grabbing, blocking, tackling, or forced phone handling.</li>
        <li>Play fairly: do not spoof your location, use another player&apos;s device or account to gain an advantage, or interfere with another player&apos;s game. See the <a href="/legal/community">Community Guidelines (draft)</a>.</li>
        <li>Keep your device charged and the app open while you play. If your phone dies or you leave the app, you are out of contact until you return.</li>
      </ul>

      <h2>6. Host responsibilities</h2>
      <p>The host runs the match in person, checks players in, and follows up on a missing player or a safety pause. The host is not a substitute for emergency services. The exact host duties and what happens if a host is absent are OPEN — see §9.</p>

      <h2>7. Accounts, rooms, and fair play</h2>
      <p>Rooms are private and invite-only. A player who breaks these terms or the Community Guidelines may be removed from a match or restricted from future matches, under the process described in the <a href="/legal/community">Community Guidelines (draft)</a>. No removal or restriction process is final until counsel confirms it.</p>

      <h2>8. Availability and changes</h2>
      <p>This is a pilot. Features, game modes, and these terms may change, and the service may be unavailable at times. Nothing on this page promises that any particular feature, mode, or event will be available. Any change that affects players&apos; rights or data will be flagged to players before it takes effect — the exact notice mechanism is OPEN (see §9).</p>

      <h2>9. What is OPEN — do not treat this page as final</h2>
      <p>Each item below needs a named decision and written evidence before the external pilot. Nothing here invents the answer.</p>
      <ul>
        <li><strong>Grievance officer (name, email, phone, postal address):</strong> OPEN — no officer has been appointed and no contact details exist. Evidence needed: founder appoints a named individual; counsel confirms the appointment and every contact detail in writing. No timeline is promised until counsel confirms the timelines that apply.</li>
        <li><strong>Governing law, jurisdiction, and dispute resolution:</strong> OPEN — evidence needed: counsel confirms the governing law and forum, and whether any dispute process applies before a grievance can be escalated.</li>
        <li><strong>Liability and warranties:</strong> OPEN — evidence needed: counsel drafts the liability, warranty, and indemnity wording. This draft promises nothing about liability either way.</li>
        <li><strong>Host duties and host absence:</strong> OPEN — evidence needed: founder and counsel confirm the host&apos;s duties and the fallback if a host leaves or is unreachable.</li>
        <li><strong>Change notice:</strong> OPEN — evidence needed: founder confirms how players are told about material changes (in-app notice, email, or other) and how much notice is given.</li>
        <li><strong>Age verification:</strong> OPEN — evidence needed: counsel confirms what, if any, age check is required for an 18+ invite-only pilot, and how it is done without collecting identity documents.</li>
        <li><strong>Final acceptance:</strong> OPEN — evidence needed: written lawyer review of this page and the other two legal pages, plus founder sign-off, before publication.</li>
      </ul>

      <h2>10. Grievances</h2>
      <p>If you disagree with a decision about you, or want to complain about content, conduct, or a decision, file a formal grievance on the <a href="/grievance">Grievance page</a> — distinct from a bug report, which goes to the <a href="/help">Help page</a>. The designated grievance contact and response timelines are confirmed by counsel before the external pilot; no timeline is promised here.</p>
      <p className="small">Related: <a href="/legal">Legal index</a> · <a href="/legal/privacy">Privacy Policy (draft)</a> · <a href="/legal/community">Community Guidelines (draft)</a> · <a href="/safety">Safety</a> · <a href="/grievance">Grievance</a></p>
    </div>
  );
}
