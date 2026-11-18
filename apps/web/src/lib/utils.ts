/**
 * `cn` — join class names, skipping falsy values.
 *
 * STOPGAP until `clsx` + `tailwind-merge` are installed (blocked:
 * no cached tarballs, network install EPERM-blocked in this sandbox).
 * This version does NOT merge conflicting Tailwind classes — there
 * is no Tailwind in the app yet, and the classes below are the plain
 * CSS tokens in `apps/web/src/styles/tokens.css`. Callers must not
 * pass conflicting utilities (e.g. two different `btn-*` variants)
 * and expect one to win. When clsx + tailwind-merge land, replace
 * this body with `twMerge(clsx(...inputs))` and delete this note.
 */
export function cn(...inputs: (string | false | null | undefined)[]): string {
  return inputs.filter(Boolean).join(' ');
}
