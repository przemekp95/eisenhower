import * as ImagePicker from 'expo-image-picker';
import { mobileConfig } from '../config';
import { createTaskRecord, quadrantToFlags } from '../utils/taskUtils';

async function readJson(response) {
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || 'OCR request failed');
  }

  return response.json();
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

  const formData = new FormData();
  formData.append('file', {
    uri: image.uri,
    name: image.name,
    type: image.type,
  });

  const response = await fetch(`${mobileConfig.aiApiUrl}/extract-tasks-from-image`, {
    method: 'POST',
    body: formData,
  });

  return mapOcrResponseToTasks(language, await readJson(response));
}
