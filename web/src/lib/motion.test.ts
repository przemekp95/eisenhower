import { shouldDisableMotion } from './motion';

describe('shouldDisableMotion', () => {
  const originalMatchMedia = window.matchMedia;
  const originalUserAgent = window.navigator.userAgent;

  afterEach(() => {
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      value: originalUserAgent,
    });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: originalMatchMedia,
    });
  });

  it('returns true for jsdom user agents', () => {
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      value: 'jsdom-test-runner',
    });

    expect(shouldDisableMotion()).toBe(true);
  });

  it('returns false when matchMedia is unavailable outside jsdom', () => {
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0',
    });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: undefined,
    });

    expect(shouldDisableMotion()).toBe(false);
  });

  it('returns the reduced-motion media query result outside jsdom', () => {
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0',
    });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: jest.fn().mockReturnValue({ matches: true }),
    });

    expect(shouldDisableMotion()).toBe(true);
  });
});
