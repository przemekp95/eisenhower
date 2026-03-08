/** @jest-environment node */

describe('shouldDisableMotion in a node runtime', () => {
  it('returns true when window is unavailable', async () => {
    const { shouldDisableMotion } = await import('./motion');

    expect(shouldDisableMotion()).toBe(true);
  });
});
