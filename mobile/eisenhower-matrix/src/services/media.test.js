import * as ImagePicker from 'expo-image-picker';
import { mobileConfig } from '../config';
import { mapOcrResponseToTasks, scanTasksFromImage } from './media';

jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));

describe('media service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  it('maps OCR responses to local task records', () => {
    expect(
      mapOcrResponseToTasks('pl', {
        classified_tasks: [{ text: 'critical incident', quadrant: 0 }],
      }, () => 123)
    ).toEqual([
      {
        id: 'ocr-123-0',
        title: 'critical incident',
        description: '',
        urgent: true,
        important: true,
        locale: 'pl',
      },
    ]);
  });

  it('returns injected scan results without touching Expo APIs', async () => {
    const adapter = { scan: jest.fn().mockResolvedValue([{ id: '1' }]) };
    await expect(scanTasksFromImage('pl', adapter)).resolves.toEqual([{ id: '1' }]);
    expect(adapter.scan).toHaveBeenCalled();
  });

  it('uploads a picked image to OCR and returns classified tasks', async () => {
    const adapter = {
      pickImage: jest.fn().mockResolvedValue({
        uri: 'file:///tmp/scan.png',
        name: 'scan.png',
        type: 'image/png',
      }),
    };
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        classified_tasks: [
          { text: 'exercise twice a week', quadrant: 2 },
        ],
      }),
    });

    const tasks = await scanTasksFromImage('en', adapter);

    expect(global.fetch).toHaveBeenCalledWith(
      `${mobileConfig.aiApiUrl}/extract-tasks-from-image`,
      expect.objectContaining({
        method: 'POST',
        body: expect.any(FormData),
      })
    );
    expect(tasks).toEqual([
      {
        id: expect.stringMatching(/^ocr-\d+-0$/),
        title: 'exercise twice a week',
        description: '',
        urgent: false,
        important: true,
        locale: 'en',
      },
    ]);
  });

  it('returns empty list when permission is denied or picker is cancelled', async () => {
    ImagePicker.requestMediaLibraryPermissionsAsync.mockResolvedValue({ granted: false });
    await expect(scanTasksFromImage('pl')).resolves.toEqual([]);

    ImagePicker.requestMediaLibraryPermissionsAsync.mockResolvedValue({ granted: true });
    ImagePicker.launchImageLibraryAsync.mockResolvedValue({ canceled: true, assets: [] });
    await expect(scanTasksFromImage('pl')).resolves.toEqual([]);
  });

  it('uses the default Expo picker when no adapter is provided', async () => {
    ImagePicker.requestMediaLibraryPermissionsAsync.mockResolvedValue({ granted: true });
    ImagePicker.launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: 'file:///tmp/default-picker.png',
          fileName: 'default-picker.png',
          mimeType: 'image/png',
        },
      ],
    });
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        classified_tasks: [{ text: 'critical production incident', quadrant: 0 }],
      }),
    });

    await expect(scanTasksFromImage('pl')).resolves.toEqual([
      {
        id: expect.stringMatching(/^ocr-\d+-0$/),
        title: 'critical production incident',
        description: '',
        urgent: true,
        important: true,
        locale: 'pl',
      },
    ]);
  });

  it('uses default asset name and mime type when the picker omits them', async () => {
    ImagePicker.requestMediaLibraryPermissionsAsync.mockResolvedValue({ granted: true });
    ImagePicker.launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///tmp/scan-no-meta.jpg' }],
    });
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ classified_tasks: [] }),
    });

    await expect(scanTasksFromImage('pl')).resolves.toEqual([]);
    expect(global.fetch).toHaveBeenCalledWith(
      `${mobileConfig.aiApiUrl}/extract-tasks-from-image`,
      expect.objectContaining({
        method: 'POST',
        body: expect.any(FormData),
      })
    );
  });

  it('throws when OCR upload fails', async () => {
    const adapter = {
      pickImage: jest.fn().mockResolvedValue({
        uri: 'file:///tmp/scan.png',
        name: 'scan.png',
        type: 'image/png',
      }),
    };
    global.fetch.mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'OCR exploded' }),
    });

    await expect(scanTasksFromImage('pl', adapter)).rejects.toThrow('OCR exploded');
  });

  it('returns an empty list when OCR responds without classified tasks', () => {
    expect(mapOcrResponseToTasks('pl', {})).toEqual([]);
  });
});
