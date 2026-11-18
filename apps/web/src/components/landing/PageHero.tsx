/**
 * Shared dark header band for the landing sub-pages.
 */
export default function PageHero({ kicker, title, lede }: { kicker: string; title: string; lede: string }) {
  return (
    <header className="page-hero">
      <p className="section-kicker">{kicker}</p>
      <h1>{title}</h1>
      <p className="lede">{lede}</p>
    </header>
  );
}
