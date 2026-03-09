jest.mock('pixi.js', () => {
  class CanvasSource {
    resource: HTMLCanvasElement;
    width: number;
    height: number;
    alphaMode: string;
    label: string;

    constructor(options: {
      resource: HTMLCanvasElement;
      width: number;
      height: number;
      alphaMode: string;
      label: string;
    }) {
      this.resource = options.resource;
      this.width = options.width;
      this.height = options.height;
      this.alphaMode = options.alphaMode;
      this.label = options.label;
    }
  }

  class Texture {
    source: CanvasSource | { label: string; resource: unknown };
    label: string;

    static EMPTY = new Texture({
      source: { label: 'ORIGINAL_EMPTY', resource: null },
      label: 'EMPTY',
    });

    static WHITE = new Texture({
      source: { label: 'ORIGINAL_WHITE', resource: new Uint8Array([255, 255, 255, 255]) },
      label: 'WHITE',
    });

    constructor(options: { source: CanvasSource | { label: string; resource: unknown }; label: string }) {
      this.source = options.source;
      this.label = options.label;
    }

    destroy() {
      return 'destroyed';
    }
  }

  return {
    CanvasSource,
    Texture,
  };
});

import { CanvasSource, Texture } from 'pixi.js';
import {
  installPixiFirefoxWorkarounds,
  needsPixiFirefoxWorkarounds,
  resetPixiFirefoxWorkaroundsForTests,
} from './pixiFirefoxWorkarounds';

describe('pixiFirefoxWorkarounds', () => {
  const originalEmpty = Texture.EMPTY;
  const originalWhite = Texture.WHITE;
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  let mockedContext: {
    clearRect: jest.Mock;
    fillRect: jest.Mock;
    fillStyle: string;
  };

  beforeEach(() => {
    mockedContext = {
      clearRect: jest.fn(),
      fillRect: jest.fn(),
      fillStyle: '',
    };
    HTMLCanvasElement.prototype.getContext = jest
      .fn()
      .mockImplementation(() => mockedContext as unknown as CanvasRenderingContext2D);

    resetPixiFirefoxWorkaroundsForTests();
    Object.assign(Texture, {
      EMPTY: originalEmpty,
      WHITE: originalWhite,
    });
  });

  afterAll(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
  });

  it('detects firefox user agents', () => {
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      value:
        'Mozilla/5.0 (X11; Linux x86_64; rv:136.0) Gecko/20100101 Firefox/136.0',
    });

    expect(needsPixiFirefoxWorkarounds()).toBe(true);
    expect(
      needsPixiFirefoxWorkarounds(
        'Mozilla/5.0 (X11; Linux x86_64; rv:136.0) Gecko/20100101 Firefox/136.0'
      )
    ).toBe(true);
    expect(
      needsPixiFirefoxWorkarounds(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36'
      )
    ).toBe(false);
  });

  it('replaces EMPTY and WHITE textures with canvas-backed sources on firefox', () => {
    const installed = installPixiFirefoxWorkarounds('Mozilla/5.0 Firefox/136.0');

    expect(installed).toBe(true);
    expect(Texture.EMPTY).not.toBe(originalEmpty);
    expect(Texture.WHITE).not.toBe(originalWhite);
    expect(Texture.EMPTY.source).toBeInstanceOf(CanvasSource);
    expect(Texture.WHITE.source).toBeInstanceOf(CanvasSource);
    expect(Texture.EMPTY.source.resource).toBeInstanceOf(HTMLCanvasElement);
    expect(Texture.WHITE.source.resource).toBeInstanceOf(HTMLCanvasElement);
    expect(Texture.EMPTY.source.alphaMode).toBe('premultiplied-alpha');
    expect(Texture.WHITE.source.alphaMode).toBe('premultiplied-alpha');
    expect(mockedContext.clearRect).toHaveBeenCalledTimes(2);
    expect(mockedContext.fillRect).toHaveBeenCalledTimes(2);
    expect(Texture.EMPTY.destroy()).toBeUndefined();
    expect(Texture.WHITE.destroy()).toBeUndefined();
  });

  it('does not reinstall or run outside firefox', () => {
    expect(
      installPixiFirefoxWorkarounds(
        'Mozilla/5.0 AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36',
        document
      )
    ).toBe(false);
    expect(Texture.EMPTY).toBe(originalEmpty);
    expect(Texture.WHITE).toBe(originalWhite);

    expect(
      installPixiFirefoxWorkarounds('Mozilla/5.0 Firefox/136.0', null)
    ).toBe(false);

    expect(
      installPixiFirefoxWorkarounds('Mozilla/5.0 Firefox/136.0', document)
    ).toBe(true);
    expect(
      installPixiFirefoxWorkarounds('Mozilla/5.0 Firefox/136.0', document)
    ).toBe(false);
  });

  it('bails out when canvas 2d is unavailable', () => {
    const emptyContextDoc = {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => null,
      }),
    } as unknown as Document;

    expect(
      installPixiFirefoxWorkarounds('Mozilla/5.0 Firefox/136.0', emptyContextDoc)
    ).toBe(false);
    expect(Texture.EMPTY).toBe(originalEmpty);
    expect(Texture.WHITE).toBe(originalWhite);
  });
});
