import { createAiApi } from '@eisenhower/api-client';
import * as ImagePicker from 'expo-image-picker';
import { createTaskRecord, quadrantToFlags } from '../utils/taskUtils';
import { mobileConfig } from '../config';

function getAiApi() {
  return createAiApi(mobileConfig.aiApiUrl);
}

async function pickImageWithExpo() {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    return null;
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: 1,
    allowsEditing: false,
  });

  if (result.canceled || !result.assets?.length) {
    return null;
  }

  const asset = result.assets[0];
  return {
    uri: asset.uri,
    name: asset.fileName || `scan-${Date.now()}.jpg`,
    type: asset.mimeType || 'image/jpeg',
  };
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

export async function scanTasksFromImage(language = 'pl', adapter = null) {
  if (adapter && typeof adapter.scan === 'function') {
    return adapter.scan();
  }

  const image = adapter && typeof adapter.pickImage === 'function'
    ? await adapter.pickImage()
    : await pickImageWithExpo();

  if (!image) {
    return [];
  }

  return mapOcrResponseToTasks(
    language,
    await getAiApi().extractTasksFromImage({
      uri: image.uri,
      name: image.name,
      type: image.type,
    })
  );
}
