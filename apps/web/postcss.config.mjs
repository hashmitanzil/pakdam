// PostCSS config for the Pakdam web app (Tailwind CSS v4).
//
// This file was MISSING: without it Next.js never runs
// `@tailwindcss/postcss`, so `@import 'tailwindcss'` in globals.css was
// inlined verbatim (the built CSS literally contained `@tailwind
// utilities`) and the production bundle shipped ZERO Tailwind utilities —
// every component rendered unstyled (e.g. every Toggle measured 0 px
// wide, so no switch was clickable). Tailwind v4 + Next.js requires this
// file; see https://tailwindcss.com/docs/installation/framework-guides/nextjs
export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};
