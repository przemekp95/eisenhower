/** @jest-environment node */

jest.mock('pixi.js', () => {
  class CanvasSource {}

  class Texture {
    static EMPTY = new Texture();
    static WHITE = new Texture();

    destroy() {
      return undefined;
    }
  }

  return {
    CanvasSource,
    Texture,
  };
});

describe('pixiFirefoxWorkarounds in node', () => {
  it('skips firefox patching when browser globals are unavailable', async () => {
    const {
      installPixiFirefoxWorkarounds,
      needsPixiFirefoxWorkarounds,
      resetPixiFirefoxWorkaroundsForTests,
    } = await import('./pixiFirefoxWorkarounds');
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

    resetPixiFirefoxWorkaroundsForTests();

    try {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: undefined,
      });

      expect(needsPixiFirefoxWorkarounds()).toBe(false);
      expect(
        installPixiFirefoxWorkarounds(
          'Mozilla/5.0 (X11; Linux x86_64; rv:136.0) Gecko/20100101 Firefox/136.0'
        )
      ).toBe(false);
    } finally {
      if (originalNavigator) {
        Object.defineProperty(globalThis, 'navigator', originalNavigator);
      }
    }
  });
});
