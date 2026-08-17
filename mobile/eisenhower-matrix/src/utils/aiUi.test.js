import {
  AI_TABS,
  QUADRANT_ACCENTS,
  getQuadrantOptions,
  getQuadrantTitleByValue,
  getSuggestedQuadrant,
  resolveAIActionNotice,
  resolveOCRNotice,
  resolveSuggestionNotice,
} from './aiUi';
import { translations } from '../i18n/translations';

describe('aiUi helpers', () => {
  const t = translations.pl;

  it('returns quadrant options with the expected order and accents', () => {
    const options = getQuadrantOptions(t);

    expect(AI_TABS).toEqual(['analysis', 'grounded', 'ocr', 'batch']);
    expect(options).toHaveLength(4);
    expect(options.map((entry) => entry.value)).toEqual([0, 1, 2, 3]);
    expect(options.map((entry) => entry.accent)).toEqual(QUADRANT_ACCENTS);
    expect(options[0].title).toBe('Zrób teraz');
    expect(options[1].title).toBe('Deleguj');
    expect(options[1].hint).toBe('Pilne, ale nieważne');
  });

  it('maps notices for suggestion and OCR failures', () => {
    expect(resolveSuggestionNotice({ code: 'provider_disabled' }, t)).toBe(
      `${t.aiSuggestDisabled}. ${t.aiManualFallback}`
    );
    expect(resolveSuggestionNotice(new Error('x'), t)).toBe(
      t.aiManualFallback
    );
    expect(resolveSuggestionNotice({ code: 'request_timeout' }, t)).toBe(t.aiRequestTimedOut);
    expect(resolveAIActionNotice({ code: 'request_cancelled' }, t)).toBe('');
    expect(resolveAIActionNotice({ code: 'request_timeout' }, t)).toBe(t.aiRequestTimedOut);
    expect(resolveAIActionNotice({ code: 'ai_unavailable' }, t)).toBe(t.aiManualFallback);
    expect(resolveAIActionNotice(new Error('x'), t, 'business fallback')).toBe('business fallback');
    expect(resolveAIActionNotice(new Error('x'), t)).toBe(t.aiManualFallback);

    expect(resolveOCRNotice({ code: 'provider_disabled' }, t)).toBe('Skanowanie notatek jest chwilowo niedostępne');
    expect(resolveOCRNotice({ code: 'provider_unavailable' }, t)).toBe(
      'Skanowanie notatek jest chwilowo niedostępne'
    );
    expect(resolveOCRNotice({ code: 'ocr_request_failed' }, t)).toBe(
      'Nie udało się odczytać obrazu, więc nic nie dodano'
    );
    expect(resolveOCRNotice({ code: 'camera_permission_denied' }, t)).toBe(
      t.aiOcrCameraPermissionDenied
    );
    expect(resolveOCRNotice({ code: 'library_permission_denied' }, t)).toBe(
      t.aiOcrLibraryPermissionDenied
    );
    expect(resolveOCRNotice({ code: 'media_offline' }, t)).toBe(t.aiOcrOffline);
    expect(resolveOCRNotice({ code: 'request_timeout' }, t)).toBe(t.aiRequestTimedOut);
    expect(resolveOCRNotice({ code: 'request_cancelled' }, t)).toBe('');
    expect(resolveOCRNotice(new Error('x'), t)).toBe('Skanowanie notatek jest chwilowo niedostępne');
  });

  it('resolves the suggested quadrant and display title', () => {
    const options = getQuadrantOptions(t);

    expect(
      getSuggestedQuadrant({ rag_classification: { quadrant: 2 }, langchain_analysis: { quadrant: 0 } })
    ).toBe(2);
    expect(getSuggestedQuadrant({ langchain_analysis: { quadrant: 1 } })).toBe(1);
    expect(getSuggestedQuadrant({})).toBe(3);

    expect(getQuadrantTitleByValue(options, 2, t.quadrantEliminate)).toBe('Zaplanuj');
    expect(getQuadrantTitleByValue(options, 99, t.quadrantEliminate)).toBe('Usuń (kwadrant, nie kasowanie)');
  });
});
