import type { Metadata, Viewport } from 'next';
import AccessibilityProvider from '@/components/accessibility/AccessibilityProvider';
import TopBar from '@/components/ui/TopBar';
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
      {/* One dark theme (2026-11-18, simplification): the dark tokens are
       * the base tokens in tokens.css — no light theme, no toggle, no
       * theme-init script, so a light flash on first paint is
       * impossible. suppressHydrationWarning stays: the
       * AccessibilityProvider applies large-text / high-contrast to
       * <html> in a client effect, which the server cannot know. */}
      <body>
        <AccessibilityProvider>
        <TopBar />
        <SwRegister />
        <main>{children}</main>
        </AccessibilityProvider>
      </body>
    </html>
  );
}
