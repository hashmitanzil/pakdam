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
      "img-src 'self' data: blob: https://api.olamaps.io https://app.olamaps.io",
      `connect-src 'self' ${workerOrigins.join(' ')} https://api.olamaps.io https://app.olamaps.io`,
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      // MapLibre GL JS runs its tile parsing in a Web Worker that it builds
      // from a Blob URL (installed maplibre-gl 5.24.1 sets its worker URL
      // via URL.createObjectURL(new Blob(...))). A CSP of `worker-src
      // 'self'` alone BLOCKS that worker, so the map never renders — this
      // is the regression that broke the map after the v4 CSP landed (the
      // map worked in the morning with no CSP at all). MapLibre's own docs
      // require `worker-src blob:` (and `child-src blob:` as the fallback
      // for browsers that use child-src for workers). Allowing `blob:`
      // here only lets same-origin scripts create workers from blob URLs —
      // no new code can run — so the security intent of the CSP is kept.
      "worker-src 'self' blob:",
      "child-src 'self' blob:",
      "manifest-src 'self'",
    ].join('; ');
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          {
            key: 'Strict-Transport-Security',
            // HSTS: the web origin is HTTPS-only in production; force it
            // for a year, including subdomains. No preload (deliberate —
            // preload is a one-way commitment for a personal project).
            value: 'max-age=31536000; includeSubDomains',
          },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Referrer-Policy',
            // strict-origin-when-cross-origin (NOT no-referrer): Ola's
            // domain whitelist is checked against the request's origin /
            // referer, and `no-referrer` strips the Referer entirely — so
            // Ola rejected the style/tiles even though the key and the
            // domain were correct. This is the remaining map blocker
            // after the v8 CSP blob-worker fix: the map worked in the
            // morning (v1, no headers at all) and broke once v4 added
            // `no-referrer`. Sending only the origin (no path, no query)
            // satisfies Ola's domain check while leaking nothing.
            value: 'strict-origin-when-cross-origin',
          },
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
    optimizePackageImports: ['@pakdam/shared', '@pakdam/engine'],
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
