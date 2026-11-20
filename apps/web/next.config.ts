import type { NextConfig } from 'next';
import withSerwistInit from '@serwist/next';

const withSerwist = withSerwistInit({
  // Service-worker source lives at src/app/sw.ts; the built worker is served
  // from /sw.js. Offline shell only — map tiles are Ola live tiles and are
  // out of scope for offline caching in this rebuild.
  swSrc: 'src/app/sw.ts',
  swDest: 'public/sw.js',
  disable: process.env.NODE_ENV === 'development',
});

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Security headers (Zara P1): the web app previously sent none of its
  // own — CSP / nosniff / frame options all absent on the live site.
  // The Worker already locks its own responses down; this is the web side.
  //
  // External origins the app actually talks to (allow-listed, nothing
  // else): the Worker (REST + WS, origin from NEXT_PUBLIC_WORKER_URL) and
  // api.olamaps.io (Ola map style + vector tiles). No webfonts, no
  // analytics/CDN scripts, no Sentry DSN configured — if one is ever
  // wired, its ingest origin must be added to connect-src here first.
  //
  // 'unsafe-inline' on script-src / style-src is a deliberate tradeoff:
  // Next.js App Router emits inline bootstrap scripts and Tailwind emits
  // inline styles; a nonce-based CSP would need middleware + nonce
  // plumbing. What this CSP still blocks: any script/style/image/fetch
  // from an origin not listed above — i.e. injected third-party code.
  async headers() {
    const workerRaw = (
      process.env.NEXT_PUBLIC_WORKER_URL ?? 'https://pakdam.bgmi42573.workers.dev'
    ).trim();
    let workerOrigins = [
      'https://pakdam.bgmi42573.workers.dev',
      'wss://pakdam.bgmi42573.workers.dev',
    ];
    try {
      const http = new URL(workerRaw);
      const ws = new URL(workerRaw);
      ws.protocol = http.protocol === 'http:' ? 'ws:' : 'wss:';
      workerOrigins = [http.origin, ws.origin];
    } catch {
      // Unparseable env value: fall back to the production Worker origin.
    }
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://api.olamaps.io",
      `connect-src 'self' ${workerOrigins.join(' ')} https://api.olamaps.io`,
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "worker-src 'self'",
      "manifest-src 'self'",
    ].join('; ');
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          {
            key: 'Permissions-Policy',
            // The game needs these three for itself (GPS, QR camera, voice
            // radio); every other origin is denied them by default.
            value: 'geolocation=(self), camera=(self), microphone=(self)',
          },
        ],
      },
    ];
  },
  // The web app never reads Supabase directly — all durable reads go through
  // the Worker (BEHAVIOUR.md §3.1). No Supabase client is bundled here.
  experimental: {
    optimizePackageImports: ['@pakdam/shared'],
  },
  // @pakdam/shared and @pakdam/engine import each other with Node-style
  // `.js` specifiers (`./calibration.js` for `./calibration.ts`). tsc and
  // the Worker's esbuild resolve those to the `.ts` sources, but webpack
  // does not — map `.js` back to the TypeScript sources so the workspace
  // packages bundle without a separate build step.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
      '.cjs': ['.cts', '.cjs'],
    };
    return config;
  },
};

export default withSerwist(nextConfig);
