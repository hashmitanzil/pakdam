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
 '/how-it-works', '/game-modes', '/about', '/contact', '/faq',
  '/grievance', '/accessibility', '/safety', '/legal', '/install', '/help',
] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  // Public pages only: no app routes (/create, /join, /room, /host),
  // no /admin, no /profile (personal surface), no grievance submissions.
  return PUBLIC_ROUTES.map((route) => ({
    url: `${SITE_URL}${route}`,
    lastModified: LAST_MOD,
    changeFrequency: route === '/' ? 'weekly' : 'monthly',
    priority: route === '/' ? 1 : 0.7,
  }));
}
