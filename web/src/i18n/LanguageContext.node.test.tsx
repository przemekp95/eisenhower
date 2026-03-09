/** @jest-environment node */

import React from 'react';
import { renderToString } from 'react-dom/server';
import { LanguageProvider, useLanguage } from './LanguageContext';

function ReadLanguage() {
  const { language } = useLanguage();
  return <span>{language}</span>;
}

describe('LanguageContext in node', () => {
  it('falls back to polish when window is unavailable', () => {
    expect(
      renderToString(
        <LanguageProvider>
          <ReadLanguage />
        </LanguageProvider>
      )
    ).toContain('pl');
  });
});
