export const QUADRANT_ACCENTS = ['#fb7185', '#38bdf8', '#f59e0b', '#94a3b8'];
export const AI_TABS = ['analysis', 'ocr', 'batch', 'manage'];

export function getQuadrantOptions(t) {
  return [
    { value: 0, title: t.quadrantDoNow, hint: t.quadrantDoNowHint, accent: QUADRANT_ACCENTS[0] },
    { value: 2, title: t.quadrantSchedule, hint: t.quadrantScheduleHint, accent: QUADRANT_ACCENTS[1] },
    { value: 1, title: t.quadrantDelegate, hint: t.quadrantDelegateHint, accent: QUADRANT_ACCENTS[2] },
    { value: 3, title: t.quadrantEliminate, hint: t.quadrantEliminateHint, accent: QUADRANT_ACCENTS[3] },
  ];
}

export function getProviderLabel(providerName, t) {
  return providerName === 'local_model' ? t.aiProviderLocalModel : t.aiProviderTesseract;
}

export function getProviderStatus(control, t) {
  if (!control) {
    return t.aiProviderStatusUnavailable;
  }

  if (control.active) {
    return t.aiProviderStatusActive;
  }

  if (!control.enabled) {
    return t.aiProviderStatusDisabled;
  }

  return t.aiProviderStatusUnavailable;
}

export function getProviderTone(control) {
  if (!control) {
    return '#475569';
  }

  if (control.active) {
    return '#14b8a6';
  }

  if (!control.enabled) {
    return '#f59e0b';
  }

  return '#475569';
}

export function resolveSuggestionNotice(error, t) {
  return error?.code === 'provider_disabled' ? t.aiSuggestDisabled : t.aiSuggestUnavailable;
}

export function resolveOCRNotice(error, t) {
  if (error?.code === 'provider_disabled') {
    return t.ocrDisabled;
  }

  if (error?.code === 'provider_unavailable') {
    return t.ocrUnavailable;
  }

  if (error?.code === 'ocr_request_failed') {
    return t.ocrFailed;
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
