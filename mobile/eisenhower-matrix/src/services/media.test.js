import { scanTasksFromImage } from './media';

describe('media service', () => {
  it('returns empty array without adapter', async () => {
    await expect(scanTasksFromImage()).resolves.toEqual([]);
  });

  it('delegates to an injected adapter', async () => {
    const adapter = { scan: jest.fn().mockResolvedValue([{ id: '1' }]) };
    await expect(scanTasksFromImage(adapter)).resolves.toEqual([{ id: '1' }]);
  });
});
