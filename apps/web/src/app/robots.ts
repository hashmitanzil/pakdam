import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        // App routes are not public content; robots exclusion is
        // defence-in-depth only — it is not the access control.
        disallow: ['/app', '/host', '/create', '/join', '/room'],
      },
    ],
    // No sitemap URL is hard-coded until the production domain is defined.
  };
}
