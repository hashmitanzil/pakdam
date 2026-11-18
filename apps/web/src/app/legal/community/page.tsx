import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Community Guidelines (draft) — PAKDAM',
  description: 'Pakdam Community Guidelines (draft). Expected behaviour, prohibited conduct, reporting, and how reports are handled. Lawyer review required before publication.',
  alternates: { canonical: '/legal/community' },
};

export default function CommunityPage() {
  return (
    <div>
      <h1>Community Guidelines</h1>
      <div className="banner"><strong>Draft — lawyer review required, do not publish as-is.</strong><br />This page is an issue-spotting draft, NOT legal advice and NOT final legal text. Written legal review is a mandatory gate before the external pilot. Version 1, 16 November 2026.</div>
      <p><a href="/legal">← Legal index</a> · Also see the <a href="/legal/terms">Terms of Use (draft)</a> and <a href="/legal/privacy">Privacy Policy (draft)</a>.</p>

      <section className="journey-card" aria-labelledby="plain-words">
        <h2 id="plain-words">In plain words</h2>
        <ul>
          <li><strong>Play safely.</strong> Stay in the play zone, stay off roads, railways, water edges, rooftops and private property, and stop if you feel unwell or unsafe.</li>
          <li><strong>Treat people well.</strong> No harassment, threats, hateful conduct, or sharing someone else&apos;s personal details or photos without their permission.</li>
          <li><strong>Play fairly.</strong> No faking your location, no touching someone else&apos;s phone or game, no rigging the result.</li>
          <li><strong>Anyone can leave at any time.</strong> Nobody can make you keep playing.</li>
          <li><strong>If something goes wrong, say so.</strong> Tell the host in person, report in the app, or file a formal grievance (Rule 20). A bug report is different — that is for something broken in the app.</li>
          <li><strong>How reports are handled is still partly OPEN</strong> — who reviews them, how long it takes, and what happens afterwards. Counsel and the founder must settle that before the public pilot (see §7).</li>
        </ul>
      </section>

      <p>Pakdam is a real-world game played in person, in a bounded venue, with people you were invited to play with. These guidelines apply to every player and host in a match, and to reports and grievances after a match. 18+ only, private invite-only, Classic Manhunt only in Phase 0.</p>

      <h2>1. Play safely</h2>
      <ul>
        <li>No roads, railways, water edges, rooftops, construction sites, or trespass.</li>
        <li>No running while looking at your phone, and no crossing roads while playing.</li>
        <li>No grabbing, blocking, tackling, or forced phone handling.</li>
        <li>Follow the host&apos;s instructions and the host check-ins. If you feel unwell or unsafe, stop playing and tell the host.</li>
        <li>Keep the app open and your screen on while you play. If you lock your phone or switch apps, safety pause, SOS, and Leave stop working until you reopen the app.</li>
      </ul>

      <h2>2. Treat other players well</h2>
      <ul>
        <li>No harassment, threats, intimidation, or unwanted contact — in the game, in person, or in messages about the game.</li>
        <li>No discrimination or hateful conduct.</li>
        <li>No sharing another player&apos;s personal information, location, or photos without their permission.</li>
        <li>No pressuring anyone to keep playing when they want to stop. Anyone can leave a match at any time.</li>
      </ul>

      <h2>3. Play fairly</h2>
      <ul>
        <li>No spoofing or faking your location, and no using another player&apos;s device or account to gain an advantage.</li>
        <li>No interfering with another player&apos;s phone, app, or game.</li>
        <li>No colluding to rig the outcome of a match in a way the host has not agreed to.</li>
      </ul>

      <h2>4. What is not allowed in a match</h2>
      <p>Unsafe play (§1), harassment or hateful conduct (§2), and cheating (§3) are not allowed. Anything that breaks the law is not allowed. If you are unsure whether something is allowed, ask the host before you do it — do not do it first and ask later.</p>

      <h2>5. Safety tools — and their limits</h2>
      <p>Any player can trigger an immediate safety pause, which stops competitive timers and actions. SOS alerts your host. Leave / Stop sharing stops location collection and sharing immediately. All of these work only while the app is open and your screen is on. Pakdam is not an emergency service: SOS does not contact emergency services. For a real emergency, contact your local emergency services directly. Full detail: <a href="/safety">Safety</a>.</p>

      <h2>6. Reporting a player or a safety concern</h2>
      <ul>
        <li>Tell the host in person during a match — the host is on site in the venue-only pilot.</li>
        <li>Report a player or a safety concern in-app, or file a formal grievance on the <a href="/grievance">Grievance page</a>.</li>
        <li>A bug report is for something broken in the app — that goes to the <a href="/help">Help page</a>. A grievance is for a complaint about content, conduct, or a decision — that goes to the <a href="/grievance">Grievance page</a>.</li>
      </ul>

      <h2>7. How reports are handled — OPEN in part</h2>
      <p>Reports are reviewed. Restrictions and appeals follow a documented process. The exact process is not final, and no timeline is promised:</p>
      <ul>
        <li><strong>Who reviews a report:</strong> OPEN — evidence needed: founder confirms who reviews reports in the pilot (host, staff, or a named reviewer) and how a report reaches them.</li>
        <li><strong>Response and resolution timelines:</strong> OPEN — evidence needed: counsel confirms the timelines that apply; no timeline is promised until then.</li>
        <li><strong>Possible outcomes:</strong> OPEN — evidence needed: founder and counsel confirm the range of outcomes (warning, removal from a match, restriction from future matches) and when each applies. No outcome is guaranteed for any particular report.</li>
        <li><strong>Appeals:</strong> OPEN — evidence needed: founder and counsel confirm whether and how a player can appeal a restriction, and to whom.</li>
        <li><strong>Records:</strong> OPEN — evidence needed: founder and counsel confirm what is recorded about a report and for how long (see the <a href="/legal/privacy">Privacy Policy (draft)</a> §6).</li>
      </ul>

      <h2>8. Grievance officer — OPEN</h2>
      <p>No grievance officer has been appointed yet, and no grievance contact details exist yet. Do not treat any name, email, phone number, postal address, or response timeline on this site as real — none is published, and none is promised here.</p>
      <ul>
        <li><strong>Officer name:</strong> OPEN — evidence needed: founder appoints a named individual; counsel confirms the appointment in writing.</li>
        <li><strong>Email:</strong> OPEN — evidence needed: a real, monitored inbox address confirmed by counsel.</li>
        <li><strong>Phone:</strong> OPEN — evidence needed: a real number confirmed by counsel, or a written decision that no phone route is offered.</li>
        <li><strong>Postal address:</strong> OPEN — evidence needed: a real address confirmed by counsel.</li>
        <li><strong>Acknowledgement and resolution timelines:</strong> OPEN — evidence needed: counsel confirms the timelines that apply and they are published here; no timeline is promised until then.</li>
      </ul>
      <p>Until those items are confirmed, file a formal grievance on the <a href="/grievance">Grievance page</a>. The grievance form collects no location and no file upload in Phase 0.</p>
      <p className="small">Related: <a href="/legal">Legal index</a> · <a href="/legal/terms">Terms of Use (draft)</a> · <a href="/legal/privacy">Privacy Policy (draft)</a> · <a href="/safety">Safety</a> · <a href="/grievance">Grievance</a> · <a href="/help">Help</a></p>
    </div>
  );
}
