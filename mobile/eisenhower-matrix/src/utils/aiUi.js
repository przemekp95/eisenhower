export const QUADRANT_ACCENTS = ['#fb7185', '#38bdf8', '#f59e0b', '#94a3b8'];
export const AI_TABS = ['analysis', 'grounded', 'ocr', 'batch'];

export function getQuadrantOptions(t) {
  return [
    { value: 0, title: t.quadrantDoNow, hint: t.quadrantDoNowHint, accent: QUADRANT_ACCENTS[0] },
    { value: 1, title: t.quadrantDelegate, hint: t.quadrantDelegateHint, accent: QUADRANT_ACCENTS[1] },
    { value: 2, title: t.quadrantSchedule, hint: t.quadrantScheduleHint, accent: QUADRANT_ACCENTS[2] },
    { value: 3, title: t.quadrantEliminate, hint: t.quadrantEliminateHint, accent: QUADRANT_ACCENTS[3] },
  ];
}

export function resolveSuggestionNotice(error, t) {
  if (error?.code === 'provider_disabled') {
    return `${t.aiSuggestDisabled}. ${t.aiManualFallback}`;
  }
  if (error?.code === 'request_timeout') {
    return t.aiRequestTimedOut;
  }
  return t.aiManualFallback;
}

export function resolveAIActionNotice(error, t, fallback) {
  if (error?.code === 'request_cancelled') {
    return '';
  }
  if (error?.code === 'request_timeout') {
    return t.aiRequestTimedOut;
  }
  if (['provider_disabled', 'provider_unavailable', 'ai_unavailable'].includes(error?.code)) {
    return t.aiManualFallback;
  }
  return fallback || t.aiManualFallback;
}

export function resolveOCRNotice(error, t) {
  if (error?.code === 'camera_permission_denied') {
    return t.aiOcrCameraPermissionDenied;
  }

  if (error?.code === 'library_permission_denied') {
    return t.aiOcrLibraryPermissionDenied;
  }

  if (error?.code === 'media_offline') {
    return t.aiOcrOffline;
  }
  if (error?.code === 'provider_disabled') {
    return t.ocrDisabled;
  }

  if (error?.code === 'provider_unavailable') {
    return t.ocrUnavailable;
  }

  if (error?.code === 'ocr_request_failed') {
    return t.ocrFailed;
  }

  if (error?.code === 'request_cancelled') {
    return '';
  }

  if (error?.code === 'request_timeout') {
    return t.aiRequestTimedOut;
  }

  return t.ocrUnavailable;
}

export function getSuggestedQuadrant(analysis) {
  if (typeof analysis?.rag_classification?.quadrant === 'number') {
    return analysis.rag_classification.quadrant;
  }

  if (typeof analysis?.langchain_analysis?.quadrant === 'number') {
    return analysis.langchain_analysis.quadrant;
  }

  return 3;
}

export function getQuadrantTitleByValue(quadrantOptions, value, fallbackTitle) {
  return quadrantOptions.find((entry) => entry.value === value)?.title || fallbackTitle;
}
