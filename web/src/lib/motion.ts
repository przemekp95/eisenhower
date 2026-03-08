export function shouldDisableMotion() {
  if (typeof window === 'undefined') {
    return true;
  }

  if (/jsdom/i.test(window.navigator.userAgent)) {
    return true;
  }

  if (typeof window.matchMedia !== 'function') {
    return false;
  }

  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
