import React, { createContext, useContext, useState } from 'react';
import { translations, Language, TranslationKey } from './translations';

interface LanguageContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: TranslationKey) => string;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

export function resolveInitialLanguage(storage: Pick<Storage, 'getItem'> | null | undefined): Language {
  if (!storage) {
    return 'pl';
  }

  const savedLang = storage.getItem('eisenhower-language') as Language | null;
  return savedLang === 'en' || savedLang === 'pl' ? savedLang : 'pl';
}

export const LanguageProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [language, setLanguageState] = useState<Language>(() => {
    return resolveInitialLanguage(typeof window === 'undefined' ? null : localStorage);
  });

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
    localStorage.setItem('eisenhower-language', lang);
  };

  const t = (key: TranslationKey): string => {
    return translations[language][key] || key;
  };

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  );
};

export const useLanguage = (): LanguageContextType => {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error('useLanguage must be used within a LanguageProvider');
  }
  return context;
};
