import {
  AI_TABS,
  QUADRANT_ACCENTS,
  getProviderLabel,
  getProviderStatus,
  getProviderTone,
  getQuadrantOptions,
  getQuadrantTitleByValue,
  getSuggestedQuadrant,
  resolveOCRNotice,
  resolveSuggestionNotice,
} from './aiUi';
import { translations } from '../i18n/translations';

describe('aiUi helpers', () => {
  const t = translations.pl;

  it('returns quadrant options with the expected order and accents', () => {
    const options = getQuadrantOptions(t);

    expect(AI_TABS).toEqual(['analysis', 'ocr', 'batch', 'manage']);
    expect(options).toHaveLength(4);
    expect(options.map((entry) => entry.value)).toEqual([0, 2, 1, 3]);
    expect(options.map((entry) => entry.accent)).toEqual(QUADRANT_ACCENTS);
    expect(options[0].title).toBe('Zrób teraz');
    expect(options[1].hint).toBe('Ważne, ale niepilne');
  });

  it('resolves provider labels, tones and statuses', () => {
    expect(getProviderLabel('local_model', t)).toBe('Model lokalny');
    expect(getProviderLabel('tesseract', t)).toBe('Tesseract OCR');

    expect(getProviderStatus(null, t)).toBe('Niedostępny');
    expect(getProviderStatus({ enabled: true, active: true }, t)).toBe('Aktywny');
    expect(getProviderStatus({ enabled: false, active: false }, t)).toBe('Wyłączony');
    expect(getProviderStatus({ enabled: true, active: false }, t)).toBe('Niedostępny');

    expect(getProviderTone(null)).toBe('#475569');
    expect(getProviderTone({ enabled: true, active: true })).toBe('#14b8a6');
    expect(getProviderTone({ enabled: false, active: false })).toBe('#f59e0b');
    expect(getProviderTone({ enabled: true, active: false })).toBe('#475569');
  });

  it('maps notices for suggestion and OCR failures', () => {
    expect(resolveSuggestionNotice({ code: 'provider_disabled' }, t)).toBe(
      'Centralny model AI jest wyłączony'
    );
    expect(resolveSuggestionNotice(new Error('x'), t)).toBe(
      'Centralna sugestia AI jest niedostępna'
    );

    expect(resolveOCRNotice({ code: 'provider_disabled' }, t)).toBe('Centralny OCR jest wyłączony');
    expect(resolveOCRNotice({ code: 'provider_unavailable' }, t)).toBe(
      'Centralny OCR jest niedostępny'
    );
    expect(resolveOCRNotice({ code: 'ocr_request_failed' }, t)).toBe(
      'Wysyłka do OCR nie powiodła się, nic nie dodano'
    );
    expect(resolveOCRNotice(new Error('x'), t)).toBe('Centralny OCR jest niedostępny');
  });

  it('resolves the suggested quadrant and display title', () => {
    const options = getQuadrantOptions(t);

    expect(
      getSuggestedQuadrant({ rag_classification: { quadrant: 2 }, langchain_analysis: { quadrant: 0 } })
    ).toBe(2);
    expect(getSuggestedQuadrant({ langchain_analysis: { quadrant: 1 } })).toBe(1);
    expect(getSuggestedQuadrant({})).toBe(3);

    expect(getQuadrantTitleByValue(options, 2, t.quadrantEliminate)).toBe('Zaplanuj');
    expect(getQuadrantTitleByValue(options, 99, t.quadrantEliminate)).toBe('Usuń');
  });
});
