'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';

/**
 * Site header. Desktop keeps the normal tab row. On phone width
 * (<=767px) the tab row is replaced by a hamburger button that opens
 * a slide-over menu with every section (founder decision, 2026-11-17
 * — the wrapping tab row sat idle and ate vertical space on phones).
 * The menu closes on tap outside (backdrop), on Escape, on the
 * hamburger/close button, or by following a link; the current section
 * is highlighted and focus returns to the hamburger button on close.
 * No dead space on phones: the header is one row — brand + menu.
 */

const MAIN_LINKS = [
  { href: '/how-it-works', label: 'How it works' },
  { href: '/game-modes', label: 'Game modes' },
  { href: '/safety', label: 'Safety' },
  { href: '/faq', label: 'FAQ' },
  { href: '/help', label: 'Help' },
];

const MENU_SECTIONS: { heading: string; links: { href: string; label: string }[] }[] = [
  {
    heading: 'Play',
    links: [
      { href: '/create/mode', label: 'Host a Game' },
      { href: '/join', label: 'Join a Game' },
      { href: '/how-it-works', label: 'How it works' },
      { href: '/game-modes', label: 'Game modes' },
      { href: '/install', label: 'Install the PWA' },
    ],
  },
  {
    heading: 'Trust & safety',
    links: [
      { href: '/safety', label: 'Safety' },
      { href: '/faq', label: 'FAQ' },
      { href: '/help', label: 'Help & support' },
      { href: '/grievance', label: 'File a grievance' },
      { href: '/accessibility', label: 'Accessibility' },
    ],
  },
  {
    heading: 'About',
    links: [
      { href: '/about', label: 'About Pakdam' },
      { href: '/contact', label: 'Contact' },
      { href: '/legal', label: 'Terms & privacy' },
      { href: '/profile', label: 'Your profile' },
      { href: '/admin', label: 'Admin (Staff)' },
    ],
  },
];

export default function TopBar() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const closeMenu = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  };

  // While the menu is open: focus the panel's close button, lock body
  // scroll, and close on Escape. Cleanup restores scroll.
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu(true);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open ]);

  // Resize to desktop while the menu is open: the tab row returns at
  // >=768px, so the fixed panel and its backdrop must go with it —
  // otherwise the backdrop covers the desktop page with no way to
  // dismiss it (the hamburger is display:none on desktop). No focus
  // restore: focusing the hidden hamburger would strand focus.
  useEffect(() => {
    if (!open) return;
    const onResize = () => {
      if (window.innerWidth >= 768) setOpen(false);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [open ]);

  const isCurrent = (href: string) => pathname === href;

  return (
    <header className="topbar">
      <a className="brand" href="/" aria-label="Pakdam — home">
        <span className="brand-mark" aria-hidden="true">P</span>
        PAKDAM
      </a>
      <nav aria-label="Main" className="topbar-nav">
        {MAIN_LINKS.map((link) => (
          <a key={link.href} href={link.href} aria-current={isCurrent(link.href) ? 'page' : undefined}>
            {link.label}
          </a>
        ))}
        <a className="topbar-cta" href="/create/mode">Host a Game</a>
      </nav>
      <button
        type="button"
        ref={buttonRef}
        className="menu-button"
        aria-expanded={open}
        aria-controls="mobile-menu"
        aria-label={open ? 'Close menu' : 'Open menu'}
        onClick={() => (open ? closeMenu(true) : setOpen(true))}
      >
        <span aria-hidden="true">{open ? '✕' : '☰'}</span>
        <span className="menu-button-label">{open ? 'Close' : 'Menu'}</span>
      </button>
      {open ? (
        <>
          <div
            className="mobile-menu-backdrop"
            aria-hidden="true"
            onClick={() => closeMenu(true)}
          />
          <nav id="mobile-menu" className="mobile-menu" aria-label="Menu">
            <div className="mobile-menu-head">
              <span className="mobile-menu-title">Menu</span>
              <button
                type="button"
                ref={closeRef}
                className="mobile-menu-close"
                aria-label="Close"
                onClick={() => closeMenu(true)}
              >
                ✕ Close
              </button>
            </div>
            <p className="mobile-menu-cta">
              <a className="btn btn-lg" href="/create/mode" onClick={() => closeMenu(false)}>
                Host a Game
              </a>
            </p>
            {MENU_SECTIONS.map((section) => (
              <div className="mobile-menu-section" key={section.heading}>
                <h2>{section.heading}</h2>
                <ul>
                  {section.links.map((link) => (
                    <li key={link.href}>
                      <a
                        href={link.href}
                        aria-current={isCurrent(link.href) ? 'page' : undefined}
                        className={isCurrent(link.href) ? 'active' : undefined}
                        onClick={() => closeMenu(false)}
                      >
                        {link.label}
                        {isCurrent(link.href) ? <span aria-hidden="true"> — you are here</span> : null}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <p className="small mobile-menu-foot">Pakdam · English only · 18+ only · Private invite-only</p>
          </nav>
        </>
      ) : null}
    </header>
  );
}
