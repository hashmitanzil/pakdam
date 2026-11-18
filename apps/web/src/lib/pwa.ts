/** PWA install + service-worker registration. Installing is OPTIONAL. */
export function registerServiceWorker(): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => { void navigator.serviceWorker.register('/sw.js').catch(() => { /* SW is best-effort in demo */ }); });
}
