import { act, render, waitFor } from '@testing-library/react';
import useSmoothScroll from './useSmoothScroll';

const mockShouldDisableMotion = jest.fn(() => true);
const mockLenisDestroy = jest.fn();
const mockLenisRaf = jest.fn();
const mockLenisConstructor = jest.fn();

jest.mock('../lib/motion', () => ({
  shouldDisableMotion: () => mockShouldDisableMotion(),
}));
jest.mock('lenis', () => ({
  __esModule: true,
  default: function MockLenis(...args: unknown[]) {
    return mockLenisConstructor(...args);
  },
}));

function HookHarness() {
  useSmoothScroll();
  return null;
}

describe('useSmoothScroll', () => {
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const originalCancelAnimationFrame = window.cancelAnimationFrame;
  const frameCallbacks: FrameRequestCallback[] = [];

  beforeEach(() => {
    jest.clearAllMocks();
    frameCallbacks.length = 0;
    mockShouldDisableMotion.mockReturnValue(true);
    mockLenisConstructor.mockImplementation(() => ({
      destroy: mockLenisDestroy,
      raf: mockLenisRaf,
    }));
    window.requestAnimationFrame = jest.fn((callback: FrameRequestCallback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    window.cancelAnimationFrame = jest.fn();
  });

  afterAll(() => {
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  it('skips lenis setup when motion is disabled', () => {
    render(<HookHarness />);

    expect(mockLenisConstructor).not.toHaveBeenCalled();
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('starts and cleans up lenis when motion is enabled', async () => {
    mockShouldDisableMotion.mockReturnValue(false);

    const { unmount } = render(<HookHarness />);

    await waitFor(() => expect(mockLenisConstructor).toHaveBeenCalledTimes(1));
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);

    await act(async () => {
      frameCallbacks[0]?.(16);
    });

    expect(mockLenisRaf).toHaveBeenCalledWith(16);

    unmount();

    expect(window.cancelAnimationFrame).toHaveBeenCalled();
    expect(mockLenisDestroy).toHaveBeenCalledTimes(1);
  });

  it('abandons lenis setup when the hook unmounts before the module resolves', async () => {
    mockShouldDisableMotion.mockReturnValue(false);

    const { unmount } = render(<HookHarness />);
    unmount();

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockLenisConstructor).not.toHaveBeenCalled();
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
  });
});
