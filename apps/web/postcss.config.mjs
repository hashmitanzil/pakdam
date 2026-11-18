/**
 * PostCSS config — Tailwind v4 via @tailwindcss/postcss (installed
 * 2026-11-17, tailwindcss@4.3.5 + @tailwindcss/postcss@4.3.5).
 * Foundation only: `src/styles/tailwind.css` is the Tailwind entry
 * and is NOT imported by layout.tsx yet — tokens.css stays the source
 * of truth until the restyle decision (see tailwind.css header).
 */
export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};
