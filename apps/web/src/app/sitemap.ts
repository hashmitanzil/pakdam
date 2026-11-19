import type { MetadataRoute } from 'next';

/** Placeholder base URL — replace with the production domain when it is
 *  defined (M00/ADR). No domain is hard-coded as real; do not publish
 *  this sitemap until publishing is decided — trademark clearance and
 *  public-pilot legal work are DEFERRED (personal use only, founder
 *  2026-11-17), so the sitemap stays minimal. */
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://pakdam.example';
const LAST_MOD = new Date('2026-11-16');

const PUBLIC_ROUTES = [
  '/',
] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  // Home only (2026-11-19 strip-down): the info pages are gone and the
  // app routes (/create, /join, /room, /host) are not public content.
  return PUBLIC_ROUTES.map((route) => ({
    url: `${SITE_URL}${route}`,
    lastModified: LAST_MOD,
    changeFrequency: route === '/' ? 'weekly' : 'monthly',
    priority: route === '/' ? 1 : 0.7,
  }));
}
