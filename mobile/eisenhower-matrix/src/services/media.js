import { createAiApi, stripJpegMetadata } from '@eisenhower/api-client';
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import * as Network from 'expo-network';
import { createTaskRecord, quadrantToFlags } from '../utils/taskUtils';
import { mobileConfig } from '../config';
import { clearApiToken, getApiToken } from '../authSession';

function getAiApi() {
  return createAiApi(mobileConfig.aiApiUrl, {
    accessToken: getApiToken,
    onUnauthorized: clearApiToken,
  });
}

function mediaError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeAsset(asset, source) {
  return {
    uri: asset.uri,
    name: asset.fileName || `scan-${Date.now()}.jpg`,
    type: asset.mimeType || 'image/jpeg',
    source,
  };
}

async function createPrivateOcrUpload(image) {
  const context = ImageManipulator.manipulate(image.uri);
  const rendered = await context.renderAsync();
  const result = await rendered.saveAsync({
    compress: 1,
    format: SaveFormat.JPEG,
  });
  const temporaryFile = new File(result.uri);

  try {
    temporaryFile.write(stripJpegMetadata(await temporaryFile.bytes()));
  } catch (error) {
    temporaryFile.delete();
    throw error;
  }

  return {
    image: {
      uri: result.uri,
      name: `${image.name.replace(/\.[^.]+$/, '') || 'scan'}-sanitized.jpg`,
      type: 'image/jpeg',
    },
    temporaryFile,
  };
}

export async function selectImageForOcr(source = 'library') {
  if (!['camera', 'library'].includes(source)) {
    throw mediaError('invalid_media_source', 'Unsupported image source');
  }
  const camera = source === 'camera';
  const permission = camera
    ? await ImagePicker.requestCameraPermissionsAsync()
    : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    throw mediaError(
      camera ? 'camera_permission_denied' : 'library_permission_denied',
      camera ? 'Camera permission denied' : 'Photo library permission denied'
    );
  }

  const launch = camera ? ImagePicker.launchCameraAsync : ImagePicker.launchImageLibraryAsync;
  const result = await launch({
    mediaTypes: ['images'],
    quality: 1,
    allowsEditing: false,
    exif: false,
  });

  if (result.canceled || !result.assets?.length) {
    return null;
  }

  return normalizeAsset(result.assets[0], source);
}

export async function extractTasksFromSelectedImage(image, language = 'pl', options = {}) {
  const network = await Network.getNetworkStateAsync();
  if (network.isConnected !== true || network.isInternetReachable === false) {
    throw mediaError('media_offline', 'Image upload requires an internet connection');
  }
  const upload = await createPrivateOcrUpload(image);
  try {
    return mapOcrResponseToTasks(
      language,
      await getAiApi().extractTasksFromImage(upload.image, options)
    );
  } finally {
    upload.temporaryFile.delete();
  }
}

export function mapOcrResponseToTasks(language, payload, idFactory = Date.now) {
  return (payload.classified_tasks || []).map((entry, index) =>
    createTaskRecord(
      language,
      {
        title: entry.text,
        description: '',
        ...quadrantToFlags(entry.quadrant),
      },
      `ocr-${idFactory()}-${index}`
    )
  );
}

export async function scanTasksFromImage(language = 'pl', adapter = null, options = {}) {
  if (adapter && typeof adapter.scan === 'function') {
    return adapter.scan();
  }

  const image = adapter && typeof adapter.pickImage === 'function'
    ? await adapter.pickImage()
    : await selectImageForOcr('library');

  if (!image) {
    return [];
  }

  return extractTasksFromSelectedImage(image, language, options);
}
