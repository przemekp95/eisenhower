import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import LanguageSwitcher from '../components/LanguageSwitcher';
import { LanguageProvider, useLanguage } from './LanguageContext';

function ReadLanguage() {
  const { language } = useLanguage();
  return <span>{language}</span>;
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

  it('throws when used without a provider', () => {
    expect(() => render(<ReadLanguage />)).toThrow('useLanguage must be used within a LanguageProvider');
  });
});
