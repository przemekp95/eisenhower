import { mobileConfig } from '../config';
import { classifyTaskFallback } from '../utils/taskUtils';

export async function suggestTaskQuadrant(title) {
  try {
    const response = await fetch(
      `${mobileConfig.aiApiUrl}/classify?title=${encodeURIComponent(title)}&use_rag=true`
    );

    if (!response.ok) {
      throw new Error('AI request failed');
    }

    const data = await response.json();
    return {
      urgent: data.urgent,
      important: data.important,
    };
  } catch {
    return classifyTaskFallback(title);
  }
}
