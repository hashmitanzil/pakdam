import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Install the app — PAKDAM',
  description: 'Install the Pakdam PWA on Android or iPhone. Installing is optional and does not enable background location or locked-screen play.',
  alternates: { canonical: '/install' },
};

export default function InstallPage() {
  return (
    <div>
      <h1>Install the PWA</h1>
      <p>Installing is optional — Pakdam works in your browser. Installing adds it to your home screen so it opens like an app.</p>
      <h2>Android (Chrome)</h2><ol><li>Open Pakdam in Chrome.</li><li>Tap the menu (⋮) → &quot;Add to Home screen&quot; / &quot;Install app&quot;.</li></ol>
      <h2>iPhone (Safari)</h2><ol><li>Open Pakdam in Safari.</li><li>Tap Share → &quot;Add to Home Screen&quot;.</li></ol>
      <p className="small">iOS Web Push (16.4+) does not enable background GPS. Installing does not change the foreground-only limit.</p>
      <div className="banner"><strong>Honest install notes:</strong> installing is optional — the PWA works in the browser without installing. Installing does NOT enable background location or locked-screen play. If the install button does not appear, the browser does not offer it — this page never shows a fake install button.</div>
      <h2>Troubleshooting</h2>
      <ul>
        <li><strong>I don&apos;t see &quot;Add to Home Screen&quot;:</strong> check your browser and version — install is offered by Chrome on Android and Safari on iOS, not by every in-app browser.</li>
        <li><strong>The app opened in the browser, not full-screen:</strong> re-add it from Safari or Chrome, not from an in-app browser.</li>
        <li><strong>I cleared my browser data and lost my game:</strong> rejoining needs the host to re-admit you.</li>
      </ul>
    </div>
  );
}
