import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
import AccessibilityProvider from './accessibility/AccessibilityProvider';
import TopBar from '@/components/ui/TopBar';
import ThemeControls from '@/components/match/ThemeControls';
import SwRegister from '@/components/ui/SwRegister';
import '@/styles/tokens.css';
export const metadata: Metadata = {
  title: 'Pakdam — real-world hide and seek',
  description: 'Pakdam is a real-world GPS hide-and-seek game. Web PWA, foreground-only play. 18+, private invite-only, Classic Manhunt.',
  // Placeholder base URL — replace with the production domain when it is
  // defined (M00/ADR). Needed so per-page canonicals resolve.
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'https://pakdam.example'),
  manifest: '/manifest.webmanifest',
};
export const viewport: Viewport = { themeColor: '#7F1D1D', width: 'device-width', initialScale: 1 };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      {/* Dark mode before first paint (2026-11-17, UI worker): the `dark`
       * class used to be applied only in a client useEffect, so every
       * visit with dark mode on flashed light first. This blocking
       * beforeInteractive script reads the same pakdam.dark-mode key
       * and adds the class while the page is still parsing, before
       * React hydrates. suppressHydrationWarning on <html> is the
       * standard companion: the server renders without the class and
       * the client legitimately has it before hydration. */}
      <Script id="pakdam-theme-init" strategy="beforeInteractive">
        {`try{if(localStorage.getItem('pakdam.dark-mode')==='on'){document.documentElement.classList.add('dark')}}catch(e){}`}
      </Script>
      <body>
        <AccessibilityProvider>
        <TopBar />
        <nav aria-label="Accessibility settings" className="a11y-bar">
          <ThemeControls />
        </nav>
        <SwRegister />
        <main>{children}</main>
        <footer className="site-footer">
          <div className="site-footer-inner">
            <div>
              <p className="footer-brand">PAK<span>DAM</span></p>
              <p>Real-world hide-and-seek with your friends, played on a map. Hunters chase Runners. A catch happens in person — the Runner shows their QR and the Hunter scans it (or the Runner confirms manually) — never by GPS alone.</p>
              <p><a className="btn btn-light" href="/create">Host a Game</a></p>
            </div>
            <nav aria-label="Play">
              <h3>Play</h3>
              <ul>
                <li><a href="/create">Host a Game</a></li>
                <li><a href="/join">Join a Game</a></li>
                <li><a href="/how-it-works">How it works</a></li>
                <li><a href="/game-modes">Game modes</a></li>
                <li><a href="/install">Install the PWA</a></li>
              </ul>
            </nav>
            <nav aria-label="Trust and safety">
              <h3>Trust &amp; safety</h3>
              <ul>
                <li><a href="/safety">Safety</a></li>
                <li><a href="/faq">FAQ</a></li>
                <li><a href="/help">Help &amp; support</a></li>
                <li><a href="/grievance">File a grievance</a></li>
                <li><a href="/accessibility">Accessibility</a></li>
              </ul>
            </nav>
            <nav aria-label="About Pakdam">
              <h3>About</h3>
              <ul>
                <li><a href="/about">About Pakdam</a></li>
                <li><a href="/contact">Contact</a></li>
                <li><a href="/legal">Terms &amp; privacy</a></li>
                <li><a href="/profile">Your profile</a></li>
                <li><a href="/admin">Admin (Staff — P0 queues)</a></li>
              </ul>
            </nav>
          </div>
          <div className="site-footer-bottom">
            <p>Pakdam · English only · 18+ only · Private invite-only</p>
            <p>Foreground-only PWA — keep the app open and your screen on while you play. Pakdam is not an emergency service.</p>
            <p>PAKDAM is a work in progress — pilot.</p>
          </div>
        </footer>
        </AccessibilityProvider>
      </body>
    </html>
  );
}
