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
