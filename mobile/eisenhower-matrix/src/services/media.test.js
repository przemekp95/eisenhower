import * as ImagePicker from 'expo-image-picker';
import * as Network from 'expo-network';
import { mobileConfig } from '../config';
import {
  extractTasksFromSelectedImage,
  mapOcrResponseToTasks,
  scanTasksFromImage,
  selectImageForOcr,
} from './media';

jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
}));

jest.mock('expo-network', () => ({
  getNetworkStateAsync: jest.fn(),
}), { virtual: true });

const quadrantNames = { 0: 'Do Now', 1: 'Delegate', 2: 'Schedule', 3: 'Delete' };

const ocrFixture = (filename, tasks) => {
  const counts = { 0: 0, 1: 0, 2: 0, 3: 0 };
  tasks.forEach(({ quadrant }) => {
    counts[quadrant] += 1;
  });
  const total = tasks.length;

  return {
    filename,
    image_info: { size_bytes: 128, shape: 'unknown' },
    ocr: {
      extracted_text: tasks.map(({ text }) => text).join('\n'),
      raw_tasks_detected: total,
      method: 'tesseract',
    },
    classified_tasks: tasks.map((task) => ({
      ...task,
      quadrant_name: quadrantNames[task.quadrant],
      confidence: 0.9,
    })),
    summary: {
      total_tasks: total,
      quadrant_distribution: {
        counts,
        percentages: Object.fromEntries(
          Object.entries(counts).map(([quadrant, count]) => [
            quadrant,
            total === 0 ? 0 : (count / total) * 100,
          ])
        ),
        quadrant_names: quadrantNames,
      },
    },
    timestamp: '2026-08-11T12:00:00Z',
  };
};

describe('media service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
    Network.getNetworkStateAsync.mockResolvedValue({
      isConnected: true,
      isInternetReachable: true,
    });
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
        remoteId: null,
        syncState: 'pending_create',
        clientOperationId: 'mobile-ocr-123-0',
        lifecycleState: 'active',
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
      json: async () => ocrFixture('scan.png', [
        { text: 'exercise twice a week', quadrant: 2 },
      ]),
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
        remoteId: null,
        syncState: 'pending_create',
        clientOperationId: expect.stringMatching(/^mobile-ocr-\d+-0$/),
        lifecycleState: 'active',
      },
    ]);
  });

  it('reports library permission denial and returns empty list when picker is cancelled', async () => {
    ImagePicker.requestMediaLibraryPermissionsAsync.mockResolvedValue({ granted: false });
    await expect(scanTasksFromImage()).rejects.toMatchObject({
      code: 'library_permission_denied',
    });

    ImagePicker.requestMediaLibraryPermissionsAsync.mockResolvedValue({ granted: true });
    ImagePicker.launchImageLibraryAsync.mockResolvedValue({ canceled: true, assets: [] });
    await expect(scanTasksFromImage('pl')).resolves.toEqual([]);
  });

  it('treats a picker result without assets as a cancelled selection', async () => {
    ImagePicker.requestMediaLibraryPermissionsAsync.mockResolvedValue({ granted: true });
    ImagePicker.launchImageLibraryAsync.mockResolvedValue({ canceled: false });

    await expect(selectImageForOcr('library')).resolves.toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
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
      json: async () => ocrFixture('default-picker.png', [
        { text: 'critical production incident', quadrant: 0 },
      ]),
    });

    await expect(scanTasksFromImage('pl')).resolves.toEqual([
      {
        id: expect.stringMatching(/^ocr-\d+-0$/),
        title: 'critical production incident',
        description: '',
        urgent: true,
        important: true,
        locale: 'pl',
        remoteId: null,
        syncState: 'pending_create',
        clientOperationId: expect.stringMatching(/^mobile-ocr-\d+-0$/),
        lifecycleState: 'active',
      },
    ]);
  });

  it('captures a camera image only after explicit permission without requesting EXIF metadata', async () => {
    ImagePicker.requestCameraPermissionsAsync.mockResolvedValue({ granted: true });
    ImagePicker.launchCameraAsync.mockResolvedValue({
      canceled: false,
      assets: [{
        uri: 'file:///tmp/camera.jpg',
        fileName: 'camera.jpg',
        mimeType: 'image/jpeg',
        exif: { GPSLatitude: 52.1 },
      }],
    });

    await expect(selectImageForOcr('camera')).resolves.toEqual({
      uri: 'file:///tmp/camera.jpg',
      name: 'camera.jpg',
      type: 'image/jpeg',
      source: 'camera',
    });
    expect(ImagePicker.launchCameraAsync).toHaveBeenCalledWith(expect.objectContaining({
      exif: false,
      mediaTypes: ['images'],
    }));
  });

  it('returns a typed camera permission error so the user can retry', async () => {
    ImagePicker.requestCameraPermissionsAsync.mockResolvedValue({ granted: false });

    await expect(selectImageForOcr('camera')).rejects.toMatchObject({
      code: 'camera_permission_denied',
    });
    expect(ImagePicker.launchCameraAsync).not.toHaveBeenCalled();
  });

  it('keeps the selected image local while offline instead of uploading it', async () => {
    Network.getNetworkStateAsync.mockResolvedValue({
      isConnected: false,
      isInternetReachable: false,
    });
    const image = {
      uri: 'file:///tmp/offline.jpg',
      name: 'offline.jpg',
      type: 'image/jpeg',
      source: 'camera',
    };

    await expect(extractTasksFromSelectedImage(image, 'pl')).rejects.toMatchObject({
      code: 'media_offline',
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('uses default asset name and mime type when the picker omits them', async () => {
    ImagePicker.requestMediaLibraryPermissionsAsync.mockResolvedValue({ granted: true });
    ImagePicker.launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///tmp/scan-no-meta.jpg' }],
    });
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ocrFixture('scan-123.jpg', [
        { text: 'filed receipt', quadrant: 3 },
      ]),
    });

    await expect(scanTasksFromImage('pl')).resolves.toEqual([
      expect.objectContaining({ title: 'filed receipt', urgent: false, important: false }),
    ]);
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
