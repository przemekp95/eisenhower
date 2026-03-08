import { mobileConfig } from '../config';
import { suggestTaskQuadrant } from './ai';

describe('ai service', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('uses remote AI when available', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ urgent: true, important: false }),
    });

    await expect(suggestTaskQuadrant('urgent')).resolves.toEqual({ urgent: true, important: false });
    expect(global.fetch).toHaveBeenCalledWith(
      `${mobileConfig.aiApiUrl}/classify?title=urgent&use_rag=true`
    );
  });

  it('falls back when fetch fails', async () => {
    global.fetch.mockRejectedValue(new Error('offline'));

    await expect(suggestTaskQuadrant('urgent client deadline')).resolves.toEqual({
      urgent: true,
      important: true,
    });
  });
});
