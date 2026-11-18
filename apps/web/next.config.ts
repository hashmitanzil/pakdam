import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs/config';
import withSerwist from '@serwist/next';
// LOW-1 (fix round): the canonical/sitemap base URL defaults to the
// placeholder https://pakdam.example (no real domain exists yet — do NOT
// invent one). A production build FAILS by default if the placeholder is
// still in place, so the site can never be published on it. The ONLY
// escape is the explicit env var PAKDAM_ALLOW_PLACEHOLDER_URL=1, which
// is for local development and CI verification builds ONLY — it must
// never be set in a real production deploy. Dev builds (NODE_ENV !=
// production) are unaffected.
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://pakdam.example';
if (
  process.env.NODE_ENV === 'production'
  && SITE_URL === 'https://pakdam.example'
  && process.env.PAKDAM_ALLOW_PLACEHOLDER_URL !== '1'
) {
  throw new Error(
    'Refusing production build: NEXT_PUBLIC_SITE_URL is still the placeholder https://pakdam.example. '
    + 'Set NEXT_PUBLIC_SITE_URL to the real production domain (after the trademark gate clears) and rebuild. '
    + 'PAKDAM_ALLOW_PLACEHOLDER_URL=1 is a dev/CI-only escape and must never be set in a real deploy.',
  );
}
// Serwist via the documented @serwist/next (webpack) path with Next 15.5.
// The Turbopack/Next 16 Serwist path is NOT assumed (see docs/DECISIONS.md).
const withSerwistConfig = withSerwist({
  swSrc: 'src/app/sw.ts',
  swDest: 'public/sw.js',
  disable: process.env.NODE_ENV === 'development',
});
const nextConfig: NextConfig = {
  reactStrictMode: true,
  async headers() {
    return [{ source: '/(.*)', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'Permissions-Policy', value: 'camera=(self), geolocation=(self)' },
    ] }];
  },
};
export default withSentryConfig(withSerwistConfig(nextConfig), {
  // For all available options, see the @sentry/nextjs docs.
  // No source-map upload is configured here: the build does not
  // upload source maps to Sentry (no auth token exists), so stack
  // traces arrive minified. Uploading source maps is a separate,
  // later decision — it needs a Sentry auth token, which is a
  // credential and must never be committed.
  silent: true,
});
