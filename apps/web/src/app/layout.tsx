import type { Metadata, Viewport } from 'next';
import './globals.css';
// MapLibre GL JS requires its stylesheet for the map canvas to render.
// Without it the style and tiles load but the canvas paints blank.
import 'maplibre-gl/dist/maplibre-gl.css';

export const metadata: Metadata = {
  title: 'Pakdam — Hide. Run. Don\'t get caught.',
  description:
    'A real-world GPS hide-and-seek game. Free · No download · 2–30 players · No account needed.',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Pakdam',
  },
  icons: {
    icon: '/icon.svg',
    apple: '/icon.svg',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  themeColor: '#0A0A0B',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
