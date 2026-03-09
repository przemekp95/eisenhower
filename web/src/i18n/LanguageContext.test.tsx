import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import LanguageSwitcher from '../components/LanguageSwitcher';
import { LanguageProvider, resolveInitialLanguage, useLanguage } from './LanguageContext';

function ReadLanguage() {
  const { language } = useLanguage();
  return <span>{language}</span>;
}

function ReadMissingTranslation() {
  const { t } = useLanguage();
  return <span>{t('missing.translation.key' as never)}</span>;
}

describe('LanguageContext', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('uses saved language and updates localStorage through the switcher', async () => {
    localStorage.setItem('eisenhower-language', 'en');

    render(
      <LanguageProvider>
        <ReadLanguage />
        <LanguageSwitcher />
      </LanguageProvider>
    );

    await waitFor(() => expect(screen.getByText('en')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Polski'));
    expect(localStorage.getItem('eisenhower-language')).toBe('pl');
  });

  it('falls back to polish for invalid saved values, switches to english, and falls back for missing keys', async () => {
    localStorage.setItem('eisenhower-language', 'de');

    render(
      <LanguageProvider>
        <ReadLanguage />
        <ReadMissingTranslation />
        <LanguageSwitcher />
      </LanguageProvider>
    );

    await waitFor(() => expect(screen.getByText('pl')).toBeInTheDocument());
    expect(screen.getByText('missing.translation.key')).toBeInTheDocument();

    fireEvent.click(screen.getByText('English'));

    await waitFor(() => expect(screen.getByText('en')).toBeInTheDocument());
    expect(localStorage.getItem('eisenhower-language')).toBe('en');
  });

  it('throws when used without a provider', () => {
    expect(() => render(<ReadLanguage />)).toThrow('useLanguage must be used within a LanguageProvider');
  });

  it('defaults to polish when rendered without window access', () => {
    expect(resolveInitialLanguage(undefined)).toBe('pl');
    expect(resolveInitialLanguage(null)).toBe('pl');
    expect(
      renderToString(
        <LanguageProvider>
          <ReadLanguage />
        </LanguageProvider>
      )
    ).toContain('pl');
  });
});
